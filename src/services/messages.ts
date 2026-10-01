import {
  extractUserMentions,
  hasPermission,
  mentionsEveryone,
  Permission,
  snowflakeTime,
  type CreateMessageBody,
  type Message,
  type ReadState,
  type UpdateMessageBody,
} from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import { id, num, optId } from '../db/values.js';
import { guildTopic, userTopic } from '../events/EventBus.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import type { ListOptions, StoredMessage } from '../stores/MessageStore.js';
import { getChannelRow } from './channels.js';
import { requireChannelPermission } from './permissions.js';
import { getUsers } from './users.js';

const REPLY_PREVIEW_LENGTH = 200;

export async function serializeMessages(ctx: AppContext, stored: StoredMessage[]): Promise<Message[]> {
  if (stored.length === 0) return [];
  const channelId = stored[0]!.channelId;

  const replyIds = [...new Set(stored.flatMap((m) => (m.replyToId ? [m.replyToId] : [])))];
  const replies = new Map((await ctx.messages.getMany(channelId, replyIds)).map((m) => [m.id, m]));
  const users = await getUsers(ctx, [
    ...stored.map((m) => m.authorId),
    ...[...replies.values()].map((m) => m.authorId),
  ]);

  return stored.flatMap((m) => {
    const author = users.get(m.authorId);
    if (!author) return [];
    const reply = m.replyToId ? replies.get(m.replyToId) : undefined;
    return [
      {
        id: m.id,
        channelId: m.channelId,
        guildId: m.guildId,
        author,
        content: m.content,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        replyTo: m.replyToId
          ? {
              id: m.replyToId,
              author: reply ? (users.get(reply.authorId) ?? null) : null,
              content: reply ? reply.content.slice(0, REPLY_PREVIEW_LENGTH) : '',
              deleted: !reply,
            }
          : null,
        mentionIds: m.mentionIds,
        mentionEveryone: m.mentionEveryone,
        encryption: null,
      },
    ];
  });
}

async function textChannel(ctx: AppContext, channelId: string) {
  const row = await getChannelRow(ctx, channelId);
  if (row.type !== 'text') throw badRequest("That channel doesn't hold messages.");
  return { guildId: id(row.guild_id), row };
}

export async function listMessages(ctx: AppContext, userId: string, channelId: string, query: ListOptions) {
  const { guildId } = await textChannel(ctx, channelId);
  await requireChannelPermission(
    ctx.perms,
    guildId,
    channelId,
    userId,
    Permission.VIEW_CHANNEL | Permission.READ_MESSAGE_HISTORY,
  );
  return serializeMessages(ctx, await ctx.messages.list(channelId, query));
}

async function resolveMentions(ctx: AppContext, guildId: string, content: string, permissions: bigint) {
  const members = new Set(await ctx.perms.memberIds(guildId));
  const mentionIds = extractUserMentions(content).filter((uid) => members.has(uid));
  const everyone = mentionsEveryone(content) && hasPermission(permissions, Permission.MENTION_EVERYONE);
  return { mentionIds, everyone };
}

export async function createMessage(
  ctx: AppContext,
  userId: string,
  channelId: string,
  body: CreateMessageBody,
): Promise<Message> {
  const { guildId } = await textChannel(ctx, channelId);
  const permissions = await requireChannelPermission(
    ctx.perms,
    guildId,
    channelId,
    userId,
    Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
  );

  if (body.replyToId && !(await ctx.messages.get(channelId, body.replyToId))) {
    throw badRequest('The message you replied to was deleted.');
  }

  const { mentionIds, everyone } = await resolveMentions(ctx, guildId, body.content, permissions);
  const messageId = ctx.nextId();
  const stored: StoredMessage = {
    id: messageId,
    channelId,
    guildId,
    authorId: userId,
    content: body.content,
    createdAt: snowflakeTime(messageId),
    editedAt: null,
    replyToId: body.replyToId ?? null,
    mentionIds,
    mentionEveryone: everyone,
  };

  await ctx.messages.insert(stored);
  await ctx.db
    .updateTable('channels')
    .set({ last_message_id: messageId })
    .where('id', '=', channelId)
    .execute();

  const [message] = await serializeMessages(ctx, [stored]);
  ctx.bus.publish(guildTopic(guildId), {
    t: 'MESSAGE_CREATE',
    d: { ...message!, nonce: body.nonce ?? null },
    channelId,
  });

  await setReadState(ctx, userId, channelId, messageId, { resetMentions: true });
  const notified = everyone ? await ctx.perms.memberIds(guildId) : mentionIds;
  await bumpMentionCounts(
    ctx,
    channelId,
    notified.filter((uid) => uid !== userId),
  );

  return { ...message!, nonce: body.nonce ?? null };
}

export async function updateMessage(
  ctx: AppContext,
  userId: string,
  channelId: string,
  messageId: string,
  body: UpdateMessageBody,
): Promise<Message> {
  const { guildId } = await textChannel(ctx, channelId);
  const permissions = await requireChannelPermission(
    ctx.perms,
    guildId,
    channelId,
    userId,
    Permission.VIEW_CHANNEL,
  );
  const existing = await ctx.messages.get(channelId, messageId);
  if (!existing) throw notFound('That message');
  if (existing.authorId !== userId) throw forbidden('You can only edit your own messages.');

  const { mentionIds } = await resolveMentions(ctx, guildId, body.content, permissions);
  const editedAt = Date.now();
  await ctx.messages.edit(channelId, messageId, body.content, mentionIds, editedAt);

  const [message] = await serializeMessages(ctx, [
    { ...existing, content: body.content, mentionIds, editedAt },
  ]);
  ctx.bus.publish(guildTopic(guildId), { t: 'MESSAGE_UPDATE', d: message!, channelId });
  return message!;
}

export async function deleteMessage(
  ctx: AppContext,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const { guildId } = await textChannel(ctx, channelId);
  const permissions = await requireChannelPermission(
    ctx.perms,
    guildId,
    channelId,
    userId,
    Permission.VIEW_CHANNEL,
  );
  const existing = await ctx.messages.get(channelId, messageId);
  if (!existing) throw notFound('That message');
  if (existing.authorId !== userId && !hasPermission(permissions, Permission.MANAGE_MESSAGES))
    throw forbidden();

  await ctx.messages.delete(channelId, messageId);
  ctx.bus.publish(guildTopic(guildId), {
    t: 'MESSAGE_DELETE',
    d: { id: messageId, channelId, guildId },
    channelId,
  });
}

export async function sendTyping(ctx: AppContext, userId: string, channelId: string): Promise<void> {
  const { guildId } = await textChannel(ctx, channelId);
  await requireChannelPermission(
    ctx.perms,
    guildId,
    channelId,
    userId,
    Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES,
  );
  ctx.bus.publish(guildTopic(guildId), {
    t: 'TYPING_START',
    d: { guildId, channelId, userId, timestamp: Date.now() },
    channelId,
  });
}

export async function acknowledge(
  ctx: AppContext,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<ReadState> {
  const { guildId } = await textChannel(ctx, channelId);
  await requireChannelPermission(ctx.perms, guildId, channelId, userId, Permission.VIEW_CHANNEL);
  return setReadState(ctx, userId, channelId, messageId, { resetMentions: true });
}

async function setReadState(
  ctx: AppContext,
  userId: string,
  channelId: string,
  messageId: string,
  { resetMentions }: { resetMentions: boolean },
): Promise<ReadState> {
  const values = { last_read_message_id: messageId, ...(resetMentions ? { mention_count: 0 } : {}) };
  await ctx.db
    .insertInto('read_states')
    .values({ user_id: userId, channel_id: channelId, last_read_message_id: messageId, mention_count: 0 })
    .onConflict((oc) => oc.columns(['user_id', 'channel_id']).doUpdateSet(values))
    .execute();
  const state = await getReadState(ctx, userId, channelId);
  ctx.bus.publish(userTopic(userId), { t: 'READ_STATE_UPDATE', d: state });
  return state;
}

async function bumpMentionCounts(ctx: AppContext, channelId: string, userIds: string[]) {
  for (const userId of userIds) {
    await ctx.db
      .insertInto('read_states')
      .values({ user_id: userId, channel_id: channelId, last_read_message_id: null, mention_count: 1 })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'channel_id'])
          .doUpdateSet((eb) => ({ mention_count: eb('read_states.mention_count', '+', 1) })),
      )
      .execute();
    ctx.bus.publish(userTopic(userId), {
      t: 'READ_STATE_UPDATE',
      d: await getReadState(ctx, userId, channelId),
    });
  }
}

async function getReadState(ctx: AppContext, userId: string, channelId: string): Promise<ReadState> {
  const row = await ctx.db
    .selectFrom('read_states')
    .selectAll()
    .where('user_id', '=', userId)
    .where('channel_id', '=', channelId)
    .executeTakeFirst();
  return {
    channelId,
    lastReadMessageId: row ? optId(row.last_read_message_id) : null,
    mentionCount: row ? num(row.mention_count) : 0,
  };
}

export async function listReadStates(ctx: AppContext, userId: string): Promise<ReadState[]> {
  const rows = await ctx.db.selectFrom('read_states').selectAll().where('user_id', '=', userId).execute();
  return rows.map((row) => ({
    channelId: id(row.channel_id),
    lastReadMessageId: optId(row.last_read_message_id),
    mentionCount: num(row.mention_count),
  }));
}
