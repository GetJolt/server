import {
  guildIndexBodySchema,
  handleSchema,
  issueCertBodySchema,
  Limits,
  loginBodySchema,
  registerBodySchema,
  updateProfileBodySchema,
} from '@getjolt/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { flag } from '../db/values.js';
import type { Gateway } from '../gateway/Gateway.js';
import { badRequest, notFound, parse } from '../http/errors.js';
import {
  listSessions,
  login,
  register,
  requireAuth,
  requireLocalAuth,
  revokeSession,
} from '../services/auth.js';
import { removeAvatar, setAvatar } from '../services/avatars.js';
import { getGuildIndex, issueCert, refreshRemoteProfile, setGuildIndex } from '../services/federation.js';
import { getLocalUserByHandle, getUser, serializeUser, updateProfile } from '../services/users.js';

const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export function userRoutes(app: FastifyInstance, ctx: AppContext, gateway: Gateway) {
  app.post('/auth/register', { config: strict }, async (req, reply) => {
    reply.status(201);
    return register(ctx, parse(registerBodySchema, req.body));
  });

  app.post('/auth/login', { config: strict }, async (req) => login(ctx, parse(loginBodySchema, req.body)));

  app.post('/auth/logout', async (req, reply) => {
    const { userId, session } = await requireAuth(ctx, req);
    await revokeSession(ctx, userId, session.id);
    gateway.closeAuthSession(session.id);
    reply.status(204);
  });

  app.get('/users/@me', async (req) => serializeUser((await requireAuth(ctx, req)).user));

  app.patch('/users/@me', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return updateProfile(ctx, userId, parse(updateProfileBodySchema, req.body));
  });

  app.put('/users/@me/avatar', { config: strict, bodyLimit: Limits.avatarBytes }, async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as the request body.');
    return setAvatar(ctx, userId, req.body);
  });

  app.delete('/users/@me/avatar', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return removeAvatar(ctx, userId);
  });

  /** Remote users call this on foreign instances after editing their profile at home. */
  app.post('/users/@me/sync', { config: strict }, async (req) => {
    const { user } = await requireAuth(ctx, req);
    if (flag(user.is_local)) return serializeUser(user);
    return serializeUser(await refreshRemoteProfile(ctx, user, true));
  });

  app.get('/users/@me/sessions', async (req) => {
    const { userId, session } = await requireLocalAuth(ctx, req);
    return listSessions(ctx, userId, session.id);
  });

  app.delete<{ Params: { sessionId: string } }>('/users/@me/sessions/:sessionId', async (req, reply) => {
    const { userId } = await requireLocalAuth(ctx, req);
    await revokeSession(ctx, userId, req.params.sessionId);
    gateway.closeAuthSession(req.params.sessionId);
    reply.status(204);
  });

  app.get('/users/@me/guild-index', async (req) =>
    getGuildIndex(ctx, (await requireLocalAuth(ctx, req)).userId),
  );

  app.put('/users/@me/guild-index', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return setGuildIndex(ctx, userId, parse(guildIndexBodySchema, req.body).entries);
  });

  app.post('/identity/certs', { config: strict }, async (req) => {
    const auth = await requireLocalAuth(ctx, req);
    return { cert: await issueCert(ctx, auth, parse(issueCertBodySchema, req.body).devicePublicKey) };
  });

  app.get<{ Params: { userId: string } }>('/users/:userId', async (req) => {
    await requireAuth(ctx, req);
    return getUser(ctx, req.params.userId);
  });

  /** Public profile of a local account, fetched by other instances. */
  app.get<{ Params: { handle: string } }>('/users/:handle/profile', async (req) => {
    const handle = handleSchema.safeParse(req.params.handle);
    const row = handle.success ? await getLocalUserByHandle(ctx, handle.data) : undefined;
    if (!row) throw notFound('That user');
    return serializeUser(row);
  });
}
