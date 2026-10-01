import {
  banBodySchema,
  createChannelBodySchema,
  createGuildBodySchema,
  createRoleBodySchema,
  reorderBodySchema,
  updateGuildBodySchema,
  updateMemberBodySchema,
  updateRoleBodySchema,
} from '@jolt/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { flag } from '../db/values.js';
import { forbidden, parse } from '../http/errors.js';
import { requireAuth } from '../services/auth.js';
import { createChannel, reorderChannels } from '../services/channels.js';
import {
  banMember,
  buildSnapshot,
  createGuild,
  deleteGuild,
  getMember,
  kickMember,
  leaveGuild,
  listBans,
  unbanMember,
  updateGuild,
  updateMember,
} from '../services/guilds.js';
import { listInvites } from '../services/invites.js';
import { requireMember } from '../services/permissions.js';
import { createRole, deleteRole, reorderRoles, updateRole } from '../services/roles.js';

type GuildParams = { Params: { guildId: string } };
type MemberParams = { Params: { guildId: string; userId: string } };
type RoleParams = { Params: { guildId: string; roleId: string } };

export function guildRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post(
    '/guilds',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { userId, user } = await requireAuth(ctx, req);
      if (!flag(user.is_local) && !ctx.config.allowRemoteGuildCreation) {
        throw forbidden(
          'Create servers on your home instance. This one only hosts servers for its own users.',
        );
      }
      reply.status(201);
      return createGuild(ctx, userId, parse(createGuildBodySchema, req.body));
    },
  );

  app.get<GuildParams>('/guilds/:guildId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    await requireMember(ctx.perms, req.params.guildId, userId);
    return buildSnapshot(ctx, req.params.guildId, userId);
  });

  app.patch<GuildParams>('/guilds/:guildId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return updateGuild(ctx, userId, req.params.guildId, parse(updateGuildBodySchema, req.body));
  });

  app.delete<GuildParams>('/guilds/:guildId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await deleteGuild(ctx, userId, req.params.guildId);
    reply.status(204);
  });

  app.post<GuildParams>('/guilds/:guildId/channels', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    reply.status(201);
    return createChannel(ctx, userId, req.params.guildId, parse(createChannelBodySchema, req.body));
  });

  app.patch<GuildParams>('/guilds/:guildId/channels', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await reorderChannels(ctx, userId, req.params.guildId, parse(reorderBodySchema, req.body));
    reply.status(204);
  });

  app.post<GuildParams>('/guilds/:guildId/roles', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    reply.status(201);
    return createRole(ctx, userId, req.params.guildId, parse(createRoleBodySchema, req.body));
  });

  app.patch<GuildParams>('/guilds/:guildId/roles', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return reorderRoles(ctx, userId, req.params.guildId, parse(reorderBodySchema, req.body));
  });

  app.patch<RoleParams>('/guilds/:guildId/roles/:roleId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return updateRole(
      ctx,
      userId,
      req.params.guildId,
      req.params.roleId,
      parse(updateRoleBodySchema, req.body),
    );
  });

  app.delete<RoleParams>('/guilds/:guildId/roles/:roleId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await deleteRole(ctx, userId, req.params.guildId, req.params.roleId);
    reply.status(204);
  });

  app.get<MemberParams>('/guilds/:guildId/members/:userId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    await requireMember(ctx.perms, req.params.guildId, userId);
    return getMember(ctx, req.params.guildId, req.params.userId === '@me' ? userId : req.params.userId);
  });

  app.patch<MemberParams>('/guilds/:guildId/members/:userId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    const target = req.params.userId === '@me' ? userId : req.params.userId;
    return updateMember(ctx, userId, req.params.guildId, target, parse(updateMemberBodySchema, req.body));
  });

  app.delete<MemberParams>('/guilds/:guildId/members/:userId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    if (req.params.userId === '@me' || req.params.userId === userId) {
      await leaveGuild(ctx, userId, req.params.guildId);
    } else {
      await kickMember(ctx, userId, req.params.guildId, req.params.userId);
    }
    reply.status(204);
  });

  app.get<GuildParams>('/guilds/:guildId/bans', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return listBans(ctx, userId, req.params.guildId);
  });

  app.put<MemberParams>('/guilds/:guildId/bans/:userId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    const { reason } = parse(banBodySchema, req.body);
    await banMember(ctx, userId, req.params.guildId, req.params.userId, reason);
    reply.status(204);
  });

  app.delete<MemberParams>('/guilds/:guildId/bans/:userId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await unbanMember(ctx, userId, req.params.guildId, req.params.userId);
    reply.status(204);
  });

  app.get<GuildParams>('/guilds/:guildId/invites', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return listInvites(ctx, userId, req.params.guildId);
  });
}
