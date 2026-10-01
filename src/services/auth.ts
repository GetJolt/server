import { createHash, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import {
  ErrorCode,
  randomToken,
  type AuthResponse,
  type LoginBody,
  type RegisterBody,
  type SessionInfo,
} from '@jolt/protocol';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { id, num, optNum } from '../db/values.js';
import { ApiError, notFound, unauthorized } from '../http/errors.js';
import { getLocalUserByHandle, serializeUser } from './users.js';

export interface AuthedSession {
  id: string;
  kind: 'local' | 'federated';
  certSerial: string | null;
  revocationCheckedAt: number | null;
}

export interface Auth {
  user: UserRow;
  userId: string;
  session: AuthedSession;
}

// Verified against when the handle doesn't exist, so login timing doesn't reveal which handles are taken.
const DUMMY_HASH = await hash('jolt-dummy-password');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function createSession(
  ctx: AppContext,
  userId: string,
  options: { kind: 'local' | 'federated'; deviceName?: string; certSerial?: string; expiresAt?: number },
): Promise<string> {
  const sessionId = randomToken(12);
  const secret = randomToken(32);
  const now = Date.now();
  await ctx.db
    .insertInto('sessions')
    .values({
      id: sessionId,
      token_hash: sha256(secret),
      user_id: userId,
      device_name: options.deviceName?.trim() || 'Unknown device',
      kind: options.kind,
      cert_serial: options.certSerial ?? null,
      created_at: now,
      last_used_at: now,
      expires_at: options.expiresAt ?? null,
      revocation_checked_at: options.kind === 'federated' ? now : null,
    })
    .execute();
  return `${sessionId}.${secret}`;
}

export async function register(ctx: AppContext, body: RegisterBody): Promise<AuthResponse> {
  const { registration, registrationCodes } = ctx.config;
  if (registration === 'closed') {
    throw new ApiError(403, ErrorCode.RegistrationClosed, 'This instance is not accepting new accounts.');
  }
  if (registration === 'invite' && !(body.inviteCode && registrationCodes.includes(body.inviteCode))) {
    throw new ApiError(403, ErrorCode.RegistrationClosed, 'This instance needs an invite code to sign up.', {
      inviteCode: 'Enter a valid invite code.',
    });
  }

  if (await getLocalUserByHandle(ctx, body.handle)) {
    throw new ApiError(409, ErrorCode.Conflict, 'That handle is taken.', { handle: 'That handle is taken.' });
  }

  const userId = ctx.nextId();
  const passwordHash = await hash(body.password);
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('users')
      .values({
        id: userId,
        handle: body.handle,
        instance: ctx.config.domain,
        display_name: body.displayName ?? body.handle,
        avatar_url: null,
        bio: '',
        is_local: 1,
        remote_id: null,
        created_at: Date.now(),
        profile_fetched_at: null,
      })
      .execute();
    await trx.insertInto('credentials').values({ user_id: userId, password_hash: passwordHash }).execute();
  });

  const token = await createSession(ctx, userId, { kind: 'local', deviceName: body.deviceName });
  const user = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return { token, user: serializeUser(user) };
}

export async function login(ctx: AppContext, body: LoginBody): Promise<AuthResponse> {
  const user = await getLocalUserByHandle(ctx, body.handle);
  const credentials = user
    ? await ctx.db
        .selectFrom('credentials')
        .select('password_hash')
        .where('user_id', '=', user.id)
        .executeTakeFirst()
    : undefined;

  const valid = await verify(credentials?.password_hash ?? DUMMY_HASH, body.password);
  if (!user || !credentials || !valid) {
    throw new ApiError(401, ErrorCode.InvalidCredentials, 'That handle and password combination is wrong.');
  }

  const token = await createSession(ctx, id(user.id), { kind: 'local', deviceName: body.deviceName });
  return { token, user: serializeUser(user) };
}

export async function authenticateToken(ctx: AppContext, token: string): Promise<Auth | null> {
  const [sessionId, secret] = token.split('.');
  if (!sessionId || !secret) return null;

  const session = await ctx.db
    .selectFrom('sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!session) return null;

  const expected = Buffer.from(session.token_hash, 'hex');
  const actual = Buffer.from(sha256(secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const now = Date.now();
  const expiresAt = optNum(session.expires_at);
  if (expiresAt !== null && expiresAt < now) {
    await ctx.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
    return null;
  }

  const user = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', session.user_id)
    .executeTakeFirst();
  if (!user) return null;

  if (now - num(session.last_used_at) > 60_000) {
    await ctx.db.updateTable('sessions').set({ last_used_at: now }).where('id', '=', sessionId).execute();
  }

  return {
    user,
    userId: id(user.id),
    session: {
      id: session.id,
      kind: session.kind,
      certSerial: session.cert_serial,
      revocationCheckedAt: optNum(session.revocation_checked_at),
    },
  };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export async function requireAuth(ctx: AppContext, request: FastifyRequest): Promise<Auth> {
  const token = bearerToken(request);
  const auth = token ? await authenticateToken(ctx, token) : null;
  if (!auth) throw unauthorized();
  return auth;
}

export async function requireLocalAuth(ctx: AppContext, request: FastifyRequest): Promise<Auth> {
  const auth = await requireAuth(ctx, request);
  if (auth.session.kind !== 'local')
    throw new ApiError(403, ErrorCode.Forbidden, 'Only available on your home instance.');
  return auth;
}

export async function listSessions(
  ctx: AppContext,
  userId: string,
  currentId: string,
): Promise<SessionInfo[]> {
  const rows = await ctx.db
    .selectFrom('sessions')
    .select(['id', 'device_name', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId)
    .where('kind', '=', 'local')
    .orderBy('last_used_at', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    createdAt: num(r.created_at),
    lastUsedAt: num(r.last_used_at),
    current: r.id === currentId,
  }));
}

export async function revokeSession(ctx: AppContext, userId: string, sessionId: string): Promise<void> {
  const result = await ctx.db
    .deleteFrom('sessions')
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) throw notFound('That session');
  // Certificates handed to that device stop being honored by other instances on their next check.
  await ctx.db
    .updateTable('identity_certs')
    .set({ revoked: 1 })
    .where('session_id', '=', sessionId)
    .execute();
}
