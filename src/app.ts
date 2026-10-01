import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { API_PREFIX, createSnowflakeGenerator, GATEWAY_PATH } from '@getjolt/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { setupActivityPub } from './activitypub/index.js';
import { connectDatabase, migrateToLatest } from './db/connect.js';
import { guildTopic, LocalEventBus, userTopic } from './events/EventBus.js';
import { Gateway } from './gateway/Gateway.js';
import { registerErrorHandler } from './http/errors.js';
import { channelRoutes } from './routes/channels.js';
import { federationRoutes, wellKnownRoutes } from './routes/federation.js';
import { guildRoutes } from './routes/guilds.js';
import { imageRoutes } from './routes/media.js';
import { pageRoutes } from './routes/pages.js';
import { linkRoutes, oauthRoutes } from './routes/links.js';
import { loadSecretBox } from './links/secrets.js';
import { installCrossposting } from './links/crosspost.js';
import { Jobs } from './jobs.js';
import { publicLinks } from './links/accounts.js';
import { socialRoutes } from './routes/social.js';
import { userRoutes } from './routes/users.js';
import { createFederationState, ensureInstanceKey } from './services/federation.js';
import { PermissionCache } from './services/permissions.js';
import { PresenceTracker } from './services/presence.js';
import { userGuildIds } from './services/users.js';
import { SqlMessageStore } from './stores/MessageStore.js';

export interface JoltServer {
  app: FastifyInstance;
  ctx: AppContext;
  gateway: Gateway;
}

export async function buildServer(
  config: Config,
  options: { logger?: boolean | object } = {},
): Promise<JoltServer> {
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  const { db, dialect } = connectDatabase(config.database);
  await migrateToLatest(db);

  const ctx: AppContext = {
    config,
    db,
    dialect,
    messages: new SqlMessageStore(db),
    bus: new LocalEventBus(),
    perms: new PermissionCache(db),
    presence: new PresenceTracker(),
    federation: createFederationState(),
    nextId: createSnowflakeGenerator(config.workerId),
    hooks: { publicLinks: (userId: string) => publicLinks(ctx, userId) },
    ap: null,
    secrets: loadSecretBox(config),

    log: app.log,
  };
  await ensureInstanceKey(ctx);

  ctx.presence.onChange((userId, status) => {
    const event = { t: 'PRESENCE_UPDATE', d: { userId, status } } as const;
    ctx.bus.publish(userTopic(userId), event);
    userGuildIds(ctx, userId)
      .then((guildIds) => {
        for (const guildId of guildIds) ctx.bus.publish(guildTopic(guildId), event);
      })
      .catch((err) => app.log.warn(err, 'Presence broadcast failed'));
  });

  const gateway = new Gateway(ctx);

  await app.register(helmet, { contentSecurityPolicy: false });
  // Auth is a bearer token rather than a cookie, so allowing any origin can't be abused for CSRF; desktop,
  // web and third-party clients all need to reach any instance.
  await app.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  // ActivityPub answers its own routes before rate limiting: busy servers deliver from one address, and every
  // inbox request is already checked against the sender's signature.
  if (config.federation !== 'disabled') await setupActivityPub(app, ctx);
  const jobs = new Jobs(db, app.log, config.devInsecure ? 200 : 1000);
  installCrossposting(ctx, jobs);
  jobs.start();

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization?.split('.')[0] ?? req.ip,
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  registerErrorHandler(app);
  wellKnownRoutes(app, ctx);
  app.get('/health', async () => ({ ok: true }));
  pageRoutes(app, ctx);
  oauthRoutes(app, ctx);
  app.get(GATEWAY_PATH, { websocket: true }, (socket) => gateway.handleConnection(socket));

  await app.register(
    async (api) => {
      imageRoutes(api, ctx);
      userRoutes(api, ctx, gateway);
      socialRoutes(api, ctx);
      linkRoutes(api, ctx);
      guildRoutes(api, ctx);
      channelRoutes(api, ctx);
      federationRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  app.addHook('onClose', async () => {
    await jobs.stop();
    ctx.presence.onChange(() => {});
    gateway.close();
    await db.destroy();
  });

  return { app, ctx, gateway };
}
