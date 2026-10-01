import {
  ErrorCode,
  hasPermission,
  Permission,
  type CreateInviteBody,
  type GuildSnapshot,
  type Invite,
} from '@getjolt/protocol';
import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { id, num, optId, optNum } from '../db/values.js';
import { ApiError, forbidden } from '../http/errors.js';
import { getChannelRow } from './channels.js';
import { addMember, getGuild, isBanned } from './guilds.js';
import { requireChannelPermission, requireGuildPermission } from './permissions.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function newInviteCode(length = 8): string {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

const invalidInvite = () =>
  new ApiError(404, ErrorCode.InviteInvalid, 'This invite is invalid or has expired.');

async function serializeInvite(
  ctx: AppContext,
  row: {
    code: string;
    guild_id: string | bigint;
    channel_id: string | bigint;
    inviter_id: string | bigint | null;
    uses: number | bigint | string;
    max_uses: number | bigint | string | null;
    expires_at: number | bigint | string | null;
  },
): Promise<Invite> {
  const guildId = id(row.guild_id);
  const guild = await getGuild(ctx, guildId);
  const count = await ctx.db
    .selectFrom('guild_members')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('guild_id', '=', guildId)
    .executeTakeFirstOrThrow();
  return {
    code: row.code,
    instance: ctx.config.domain,
    guild: {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconUrl,
      description: guild.description,
      memberCount: num(count.n as number),
    },
    channelId: id(row.channel_id),
    inviterId: optId(row.inviter_id),
    uses: num(row.uses),
    maxUses: optNum(row.max_uses),
    expiresAt: optNum(row.expires_at),
  };
}

async function findUsableInvite(ctx: AppContext, code: string) {
  const row = await ctx.db.selectFrom('invites').selectAll().where('code', '=', code).executeTakeFirst();
  if (!row) return null;
  const expiresAt = optNum(row.expires_at);
  const maxUses = optNum(row.max_uses);
  if ((expiresAt !== null && expiresAt < Date.now()) || (maxUses !== null && num(row.uses) >= maxUses)) {
    await ctx.db.deleteFrom('invites').where('code', '=', code).execute();
    return null;
  }
  return row;
}

export async function createInvite(
  ctx: AppContext,
  userId: string,
  channelId: string,
  body: CreateInviteBody,
) {
  const channel = await getChannelRow(ctx, channelId);
  const guildId = id(channel.guild_id);
  await requireChannelPermission(ctx.perms, guildId, channelId, userId, Permission.CREATE_INVITE);

  const row = {
    code: newInviteCode(),
    guild_id: guildId,
    channel_id: channelId,
    inviter_id: userId,
    uses: 0,
    max_uses: body.maxUses ?? null,
    expires_at: body.maxAgeSeconds ? Date.now() + body.maxAgeSeconds * 1000 : null,
    created_at: Date.now(),
  };
  await ctx.db.insertInto('invites').values(row).execute();
  return serializeInvite(ctx, row);
}

export async function getInvite(ctx: AppContext, code: string): Promise<Invite> {
  const row = await findUsableInvite(ctx, code);
  if (!row) throw invalidInvite();
  return serializeInvite(ctx, row);
}

export async function acceptInvite(ctx: AppContext, userId: string, code: string): Promise<GuildSnapshot> {
  const row = await findUsableInvite(ctx, code);
  if (!row) throw invalidInvite();
  const guildId = id(row.guild_id);

  if (await ctx.perms.isMember(guildId, userId)) return addMember(ctx, guildId, userId);
  if (await isBanned(ctx, guildId, userId))
    throw new ApiError(403, ErrorCode.Banned, "You're banned from this server.");

  await ctx.db
    .updateTable('invites')
    .set({ uses: sql<number>`uses + 1` })
    .where('code', '=', code)
    .execute();
  return addMember(ctx, guildId, userId);
}

export async function listInvites(ctx: AppContext, userId: string, guildId: string): Promise<Invite[]> {
  await requireGuildPermission(ctx.perms, guildId, userId, Permission.MANAGE_GUILD);
  const rows = await ctx.db.selectFrom('invites').selectAll().where('guild_id', '=', guildId).execute();
  return Promise.all(rows.map((row) => serializeInvite(ctx, row)));
}

export async function deleteInvite(ctx: AppContext, userId: string, code: string): Promise<void> {
  const row = await ctx.db.selectFrom('invites').selectAll().where('code', '=', code).executeTakeFirst();
  if (!row) throw invalidInvite();
  const guildId = id(row.guild_id);
  const permissions = await ctx.perms.guildPermissions(guildId, userId);
  if (optId(row.inviter_id) !== userId && !hasPermission(permissions, Permission.MANAGE_GUILD))
    throw forbidden();
  await ctx.db.deleteFrom('invites').where('code', '=', code).execute();
}
