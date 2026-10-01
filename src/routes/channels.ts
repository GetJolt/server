import {
  createInviteBodySchema,
  createMessageBodySchema,
  listMessagesQuerySchema,
  Permission,
  updateChannelBodySchema,
  updateMessageBodySchema,
} from '@getjolt/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { id } from '../db/values.js';
import { parse } from '../http/errors.js';
import { requireAuth } from '../services/auth.js';
import { deleteChannel, getChannel, getChannelRow, updateChannel } from '../services/channels.js';
import { acceptInvite, createInvite, deleteInvite, getInvite } from '../services/invites.js';
import {
  acknowledge,
  createMessage,
  deleteMessage,
  listMessages,
  sendTyping,
  updateMessage,
} from '../services/messages.js';
import { requireChannelPermission } from '../services/permissions.js';

type ChannelParams = { Params: { channelId: string } };
type MessageParams = { Params: { channelId: string; messageId: string } };
type InviteParams = { Params: { code: string } };

export function channelRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<ChannelParams>('/channels/:channelId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    const row = await getChannelRow(ctx, req.params.channelId);
    await requireChannelPermission(
      ctx.perms,
      id(row.guild_id),
      req.params.channelId,
      userId,
      Permission.VIEW_CHANNEL,
    );
    return getChannel(ctx, req.params.channelId);
  });

  app.patch<ChannelParams>('/channels/:channelId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return updateChannel(ctx, userId, req.params.channelId, parse(updateChannelBodySchema, req.body));
  });

  app.delete<ChannelParams>('/channels/:channelId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await deleteChannel(ctx, userId, req.params.channelId);
    reply.status(204);
  });

  app.get<ChannelParams>('/channels/:channelId/messages', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return listMessages(ctx, userId, req.params.channelId, parse(listMessagesQuerySchema, req.query));
  });

  app.post<ChannelParams>(
    '/channels/:channelId/messages',
    { config: { rateLimit: { max: 20, timeWindow: '10 seconds' } } },
    async (req, reply) => {
      const { userId } = await requireAuth(ctx, req);
      reply.status(201);
      return createMessage(ctx, userId, req.params.channelId, parse(createMessageBodySchema, req.body));
    },
  );

  app.patch<MessageParams>('/channels/:channelId/messages/:messageId', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    const body = parse(updateMessageBodySchema, req.body);
    return updateMessage(ctx, userId, req.params.channelId, req.params.messageId, body);
  });

  app.delete<MessageParams>('/channels/:channelId/messages/:messageId', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await deleteMessage(ctx, userId, req.params.channelId, req.params.messageId);
    reply.status(204);
  });

  app.post<MessageParams>('/channels/:channelId/messages/:messageId/ack', async (req) => {
    const { userId } = await requireAuth(ctx, req);
    return acknowledge(ctx, userId, req.params.channelId, req.params.messageId);
  });

  app.post<ChannelParams>(
    '/channels/:channelId/typing',
    { config: { rateLimit: { max: 10, timeWindow: '10 seconds' } } },
    async (req, reply) => {
      const { userId } = await requireAuth(ctx, req);
      await sendTyping(ctx, userId, req.params.channelId);
      reply.status(204);
    },
  );

  app.post<ChannelParams>('/channels/:channelId/invites', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    reply.status(201);
    return createInvite(ctx, userId, req.params.channelId, parse(createInviteBodySchema, req.body));
  });

  app.get<InviteParams>('/invites/:code', async (req) => getInvite(ctx, req.params.code));

  app.post<InviteParams>(
    '/invites/:code',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { userId } = await requireAuth(ctx, req);
      return acceptInvite(ctx, userId, req.params.code);
    },
  );

  app.delete<InviteParams>('/invites/:code', async (req, reply) => {
    const { userId } = await requireAuth(ctx, req);
    await deleteInvite(ctx, userId, req.params.code);
    reply.status(204);
  });
}
