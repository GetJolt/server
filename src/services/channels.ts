import {
  Limits,
  Permission,
  type Channel,
  type CreateChannelBody,
  type Overwrite,
  type ReorderBody,
  type UpdateChannelBody,
} from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { ChannelRow, OverwriteRow } from '../db/schema.js';
import { id, num, optId } from '../db/values.js';
import { guildTopic } from '../events/EventBus.js';
import { badRequest, notFound } from '../http/errors.js';
import { requestResync, requireGuildPermission } from './permissions.js';

export function serializeChannel(row: ChannelRow, overwrites: Overwrite[]): Channel {
  return {
    id: id(row.id),
    guildId: id(row.guild_id),
    type: row.type,
    name: row.name,
    topic: row.topic,
    position: num(row.position),
    parentId: optId(row.parent_id),
    overwrites,
    lastMessageId: optId(row.last_message_id),
    e2ee: false,
  };
}

const serializeOverwrite = (row: OverwriteRow): Overwrite => ({
  id: id(row.target_id),
  type: row.target_type,
  allow: row.allow,
  deny: row.deny,
});

export async function getChannelRow(ctx: AppContext, channelId: string): Promise<ChannelRow> {
  const row = await ctx.db.selectFrom('channels').selectAll().where('id', '=', channelId).executeTakeFirst();
  if (!row) throw notFound('That channel');
  return row;
}

export async function getChannel(ctx: AppContext, channelId: string): Promise<Channel> {
  const row = await getChannelRow(ctx, channelId);
  const overwrites = await ctx.db
    .selectFrom('permission_overwrites')
    .selectAll()
    .where('channel_id', '=', channelId)
    .execute();
  return serializeChannel(row, overwrites.map(serializeOverwrite));
}

export async function listGuildChannels(ctx: AppContext, guildId: string): Promise<Channel[]> {
  const [rows, overwrites] = await Promise.all([
    ctx.db.selectFrom('channels').selectAll().where('guild_id', '=', guildId).orderBy('position').execute(),
    ctx.db
      .selectFrom('permission_overwrites')
      .innerJoin('channels', 'channels.id', 'permission_overwrites.channel_id')
      .selectAll('permission_overwrites')
      .where('channels.guild_id', '=', guildId)
      .execute(),
  ]);
  const byChannel = new Map<string, Overwrite[]>();
  for (const row of overwrites) {
    const list = byChannel.get(id(row.channel_id)) ?? [];
    list.push(serializeOverwrite(row));
    byChannel.set(id(row.channel_id), list);
  }
  return rows.map((row) => serializeChannel(row, byChannel.get(id(row.id)) ?? []));
}

/** Lowercase, dash-separated names like Discord's, so links and mentions stay readable. */
export function normalizeChannelName(name: string, type: 'text' | 'category'): string {
  if (type === 'category') return name.trim();
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-');
  if (!slug) throw badRequest('Channel names need at least one letter or number.');
  return slug;
}

async function assertValidParent(ctx: AppContext, guildId: string, parentId: string | null | undefined) {
  if (!parentId) return;
  const parent = await ctx.db
    .selectFrom('channels')
    .select(['type', 'guild_id'])
    .where('id', '=', parentId)
    .executeTakeFirst();
  if (!parent || id(parent.guild_id) !== guildId || parent.type !== 'category') {
    throw badRequest('That category does not exist.');
  }
}

function publishChannel(ctx: AppContext, event: 'CHANNEL_CREATE' | 'CHANNEL_UPDATE', channel: Channel) {
  ctx.bus.publish(guildTopic(channel.guildId), { t: event, d: channel, channelId: channel.id });
}

export async function createChannel(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  body: CreateChannelBody,
): Promise<Channel> {
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_CHANNELS);
  const type = body.type ?? 'text';
  const parentId = type === 'category' ? null : (body.parentId ?? null);
  await assertValidParent(ctx, guildId, parentId);

  const count = await ctx.db
    .selectFrom('channels')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('guild_id', '=', guildId)
    .executeTakeFirstOrThrow();
  if (num(count.n as number) >= Limits.channelsPerGuild)
    throw badRequest('This server has too many channels.');

  const max = await ctx.db
    .selectFrom('channels')
    .select((eb) => eb.fn.max('position').as('max'))
    .where('guild_id', '=', guildId)
    .executeTakeFirst();

  const channelId = ctx.nextId();
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('channels')
      .values({
        id: channelId,
        guild_id: guildId,
        type,
        name: normalizeChannelName(body.name, type),
        topic: body.topic ?? '',
        position: max?.max === null || max?.max === undefined ? 0 : num(max.max) + 1,
        parent_id: parentId,
        last_message_id: null,
        created_at: Date.now(),
      })
      .execute();

    // New channels start in sync with their category's permissions.
    if (parentId) {
      const inherited = await trx
        .selectFrom('permission_overwrites')
        .selectAll()
        .where('channel_id', '=', parentId)
        .execute();
      if (inherited.length > 0) {
        await trx
          .insertInto('permission_overwrites')
          .values(inherited.map((o) => ({ ...o, channel_id: channelId, target_id: id(o.target_id) })))
          .execute();
      }
    }
  });

  ctx.perms.invalidate(guildId);
  const channel = await getChannel(ctx, channelId);
  publishChannel(ctx, 'CHANNEL_CREATE', channel);
  return channel;
}

export async function updateChannel(
  ctx: AppContext,
  actorId: string,
  channelId: string,
  body: UpdateChannelBody,
): Promise<Channel> {
  const row = await getChannelRow(ctx, channelId);
  const guildId = id(row.guild_id);
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_CHANNELS);

  const changes: Partial<{ name: string; topic: string; parent_id: string | null }> = {};
  if (body.name !== undefined) changes.name = normalizeChannelName(body.name, row.type);
  if (body.topic !== undefined) changes.topic = body.topic;
  if (body.parentId !== undefined && row.type === 'text') {
    await assertValidParent(ctx, guildId, body.parentId);
    changes.parent_id = body.parentId;
  }

  await ctx.db.transaction().execute(async (trx) => {
    if (Object.keys(changes).length > 0) {
      await trx.updateTable('channels').set(changes).where('id', '=', channelId).execute();
    }
    if (body.overwrites) {
      await trx.deleteFrom('permission_overwrites').where('channel_id', '=', channelId).execute();
      const unique = new Map(body.overwrites.map((o) => [o.id, o]));
      if (unique.size > 0) {
        await trx
          .insertInto('permission_overwrites')
          .values(
            [...unique.values()].map((o) => ({
              channel_id: channelId,
              target_id: o.id,
              target_type: o.type,
              allow: o.allow,
              deny: o.deny,
            })),
          )
          .execute();
      }
    }
  });

  const channel = await getChannel(ctx, channelId);
  if (body.overwrites) {
    requestResync(ctx, guildId);
  } else {
    publishChannel(ctx, 'CHANNEL_UPDATE', channel);
  }
  return channel;
}

export async function deleteChannel(ctx: AppContext, actorId: string, channelId: string): Promise<void> {
  const row = await getChannelRow(ctx, channelId);
  const guildId = id(row.guild_id);
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_CHANNELS);

  await ctx.messages.deleteChannel(channelId);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable('channels').set({ parent_id: null }).where('parent_id', '=', channelId).execute();
    await trx.deleteFrom('channels').where('id', '=', channelId).execute();
  });

  ctx.perms.invalidate(guildId);
  ctx.bus.publish(guildTopic(guildId), { t: 'CHANNEL_DELETE', d: { id: channelId, guildId } });
  if (row.type === 'category') requestResync(ctx, guildId);
}

export async function reorderChannels(ctx: AppContext, actorId: string, guildId: string, body: ReorderBody) {
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_CHANNELS);
  const channels = await listGuildChannels(ctx, guildId);
  const byId = new Map(channels.map((c) => [c.id, c]));

  for (const item of body.items) {
    const channel = byId.get(item.id);
    if (!channel) throw notFound('That channel');
    if (item.parentId !== undefined && channel.type === 'text')
      await assertValidParent(ctx, guildId, item.parentId);
  }

  await ctx.db.transaction().execute(async (trx) => {
    for (const item of body.items) {
      const channel = byId.get(item.id)!;
      const changes: { position: number; parent_id?: string | null } = { position: item.position };
      if (item.parentId !== undefined && channel.type === 'text') changes.parent_id = item.parentId;
      await trx.updateTable('channels').set(changes).where('id', '=', item.id).execute();
    }
  });

  for (const item of body.items) publishChannel(ctx, 'CHANNEL_UPDATE', await getChannel(ctx, item.id));
}
