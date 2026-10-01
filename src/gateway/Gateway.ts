import {
  clientFrameSchema,
  GatewayCloseCode,
  HEARTBEAT_INTERVAL_MS,
  hasPermission,
  Permission,
  randomToken,
  type ClientFrame,
  type DispatchFrame,
  type GatewayEventName,
  type GatewayEvents,
  type GuildSnapshot,
  type ServerFrame,
} from '@jolt/protocol';
import type { WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { guildTopic, userTopic, type BusEvent } from '../events/EventBus.js';
import { authenticateToken, type Auth } from '../services/auth.js';
import { checkRemoteRevocation } from '../services/federation.js';
import { buildSnapshot } from '../services/guilds.js';
import { listReadStates } from '../services/messages.js';
import { serializeUser, userGuildIds } from '../services/users.js';

const IDENTIFY_TIMEOUT_MS = 10_000;
const RESUME_WINDOW_MS = 60_000;
const REPLAY_BUFFER_SIZE = 1000;
const FRAME_LIMIT_PER_MINUTE = 120;

class GatewaySession {
  readonly id = randomToken(16);
  private socket: WebSocket | null = null;
  private seq = 0;
  private buffer: DispatchFrame[] = [];
  private readonly subscriptions = new Map<string, () => void>();
  private queue: Promise<void> = Promise.resolve();
  private expiryTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly gateway: Gateway,
    readonly auth: Auth,
  ) {}

  get userId() {
    return this.auth.userId;
  }

  async start(socket: WebSocket): Promise<void> {
    this.attach(socket);
    this.subscribe(userTopic(this.userId));
    const guildIds = await userGuildIds(this.ctx, this.userId);
    guildIds.forEach((guildId) => this.subscribe(guildTopic(guildId)));

    const guilds = (await Promise.all(guildIds.map((g) => buildSnapshot(this.ctx, g, this.userId)))).filter(
      (g): g is GuildSnapshot => g !== null,
    );
    this.dispatch('READY', {
      sessionId: this.id,
      user: serializeUser(this.auth.user),
      guilds,
      readStates: await listReadStates(this.ctx, this.userId),
    });
    this.ctx.presence.connect(this.userId);
  }

  attach(socket: WebSocket): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const previous = this.socket;
    this.socket = socket;
    previous?.close(GatewayCloseCode.Normal);
  }

  /** Keeps buffering events for a while so a dropped client can resume without losing any. */
  detach(socket: WebSocket): void {
    // A stale socket closing late must not detach a session that already resumed elsewhere.
    if (this.destroyed || this.socket !== socket) return;
    this.socket = null;
    this.expiryTimer = setTimeout(() => this.destroy(), RESUME_WINDOW_MS);
  }

  resume(socket: WebSocket, seq: number): boolean {
    const oldest = this.buffer[0]?.s ?? this.seq + 1;
    if (seq > this.seq || seq < oldest - 1) return false;
    this.attach(socket);
    for (const frame of this.buffer) if (frame.s > seq) this.send(frame);
    this.dispatch('RESUMED', {});
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.ctx.presence.disconnect(this.userId);
    this.gateway.forget(this);
    this.socket?.close(GatewayCloseCode.Normal);
    this.socket = null;
  }

  send(frame: ServerFrame): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }

  private dispatch<K extends GatewayEventName>(t: K, d: GatewayEvents[K]): void {
    const frame = { op: 'dispatch', t, s: ++this.seq, d } as DispatchFrame;
    this.buffer.push(frame);
    if (this.buffer.length > REPLAY_BUFFER_SIZE) this.buffer.shift();
    this.send(frame);
  }

  private subscribe(topic: string): void {
    if (this.subscriptions.has(topic)) return;
    this.subscriptions.set(
      topic,
      // Handling is async (permission lookups), so events are queued to keep their order.
      this.ctx.bus.subscribe(topic, (event) => {
        this.queue = this.queue.then(() => this.handle(event)).catch((err) => this.ctx.log.error(err));
      }),
    );
  }

  private unsubscribe(topic: string): void {
    this.subscriptions.get(topic)?.();
    this.subscriptions.delete(topic);
  }

  private async handle(event: BusEvent): Promise<void> {
    if (event.t === 'RESYNC') {
      const snapshot = await buildSnapshot(this.ctx, event.guildId, this.userId);
      if (snapshot) this.dispatch('GUILD_CREATE', snapshot);
      return;
    }

    if (event.t === 'GUILD_CREATE') this.subscribe(guildTopic(event.d.guild.id));
    if (event.t === 'GUILD_DELETE') this.unsubscribe(guildTopic(event.d.id));

    if (event.channelId && 'guildId' in event.d) {
      const permissions = await this.ctx.perms.channelPermissions(
        event.d.guildId,
        event.channelId,
        this.userId,
      );
      if (!hasPermission(permissions, Permission.VIEW_CHANNEL)) {
        if (event.t === 'CHANNEL_UPDATE')
          this.dispatch('CHANNEL_DELETE', { id: event.d.id, guildId: event.d.guildId });
        return;
      }
    }

    this.dispatch(event.t, event.d as never);
  }
}

export class Gateway {
  private readonly sessions = new Map<string, GatewaySession>();

  constructor(private readonly ctx: AppContext) {}

  forget(session: GatewaySession): void {
    this.sessions.delete(session.id);
  }

  /** Disconnects every gateway session opened with the given auth session, e.g. after signing a device out. */
  closeAuthSession(authSessionId: string): void {
    for (const session of this.sessions.values()) {
      if (session.auth.session.id === authSessionId) session.destroy();
    }
  }

  close(): void {
    for (const session of [...this.sessions.values()]) session.destroy();
  }

  handleConnection(socket: WebSocket): void {
    let session: GatewaySession | null = null;
    let frames = 0;
    let lastHeartbeat = Date.now();

    const send = (frame: ServerFrame) => socket.readyState === 1 && socket.send(JSON.stringify(frame));
    const close = (code: number, reason: string) => socket.close(code, reason);

    send({ op: 'hello', d: { heartbeatInterval: HEARTBEAT_INTERVAL_MS } });

    const identifyTimer = setTimeout(() => {
      if (!session) close(GatewayCloseCode.NotAuthenticated, 'Identify timeout');
    }, IDENTIFY_TIMEOUT_MS);
    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS * 1.5)
        close(GatewayCloseCode.SessionTimedOut, 'Missed heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
    const rateTimer = setInterval(() => (frames = 0), 60_000);

    const handleFrame = async (frame: ClientFrame) => {
      switch (frame.op) {
        case 'heartbeat':
          lastHeartbeat = Date.now();
          send({ op: 'heartbeat_ack' });
          return;

        case 'identify': {
          if (session) return close(GatewayCloseCode.AlreadyAuthenticated, 'Already identified');
          const auth = await this.authenticate(frame.d.token);
          if (!auth) return close(GatewayCloseCode.AuthenticationFailed, 'Invalid token');
          session = new GatewaySession(this.ctx, this, auth);
          this.sessions.set(session.id, session);
          await session.start(socket);
          return;
        }

        case 'resume': {
          if (session) return close(GatewayCloseCode.AlreadyAuthenticated, 'Already identified');
          const auth = await this.authenticate(frame.d.token);
          if (!auth) return close(GatewayCloseCode.AuthenticationFailed, 'Invalid token');
          const existing = this.sessions.get(frame.d.sessionId);
          if (!existing || existing.userId !== auth.userId || !existing.resume(socket, frame.d.seq)) {
            send({ op: 'invalid_session', d: { resumable: false } });
            return;
          }
          session = existing;
          return;
        }

        case 'presence_update':
          if (session) this.ctx.presence.setStatus(session.userId, frame.d.status);
          return;
      }
    };

    let pending: Promise<void> = Promise.resolve();
    socket.on('message', (raw) => {
      if (++frames > FRAME_LIMIT_PER_MINUTE) return close(GatewayCloseCode.RateLimited, 'Too many frames');
      let frame: ClientFrame;
      try {
        frame = clientFrameSchema.parse(JSON.parse(raw.toString()));
      } catch {
        return close(GatewayCloseCode.InvalidPayload, 'Invalid payload');
      }
      if (frame.op !== 'heartbeat' && frame.op !== 'presence_update' && session) {
        return close(GatewayCloseCode.AlreadyAuthenticated, 'Already identified');
      }
      pending = pending
        .then(() => handleFrame(frame))
        .catch((err) => {
          this.ctx.log.error(err, 'Gateway frame failed');
          close(GatewayCloseCode.UnknownError, 'Internal error');
        });
    });

    socket.on('close', () => {
      clearTimeout(identifyTimer);
      clearInterval(heartbeatTimer);
      clearInterval(rateTimer);
      // Wait for an in-flight identify so we detach the session it creates.
      void pending.then(() => (session as GatewaySession | null)?.detach(socket));
    });
  }

  private async authenticate(token: string): Promise<Auth | null> {
    const auth = await authenticateToken(this.ctx, token);
    if (!auth) return null;
    return (await checkRemoteRevocation(this.ctx, auth)) ? auth : null;
  }
}
