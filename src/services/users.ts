import type { UpdateProfileBody, User } from '@jolt/protocol';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { flag, id } from '../db/values.js';
import { guildTopic, userTopic } from '../events/EventBus.js';
import { notFound } from '../http/errors.js';

export function serializeUser(row: UserRow): User {
  return {
    id: id(row.id),
    handle: row.handle,
    instance: row.instance,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    local: flag(row.is_local),
  };
}

export async function getUserRow(ctx: AppContext, userId: string): Promise<UserRow | undefined> {
  return ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
}

export async function getUser(ctx: AppContext, userId: string): Promise<User> {
  const row = await getUserRow(ctx, userId);
  if (!row) throw notFound('That user');
  return serializeUser(row);
}

export async function getUsers(ctx: AppContext, userIds: Iterable<string>): Promise<Map<string, User>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await ctx.db.selectFrom('users').selectAll().where('id', 'in', ids).execute();
  return new Map(rows.map((row) => [id(row.id), serializeUser(row)]));
}

export async function getLocalUserByHandle(ctx: AppContext, handle: string): Promise<UserRow | undefined> {
  return ctx.db
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', handle)
    .where('instance', '=', ctx.config.domain)
    .executeTakeFirst();
}

export async function userGuildIds(ctx: AppContext, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom('guild_members')
    .select('guild_id')
    .where('user_id', '=', userId)
    .execute();
  return rows.map((r) => id(r.guild_id));
}

export async function broadcastUserUpdate(ctx: AppContext, user: User): Promise<void> {
  ctx.bus.publish(userTopic(user.id), { t: 'USER_UPDATE', d: user });
  for (const guildId of await userGuildIds(ctx, user.id)) {
    ctx.bus.publish(guildTopic(guildId), { t: 'USER_UPDATE', d: user });
  }
}

export async function updateProfile(ctx: AppContext, userId: string, body: UpdateProfileBody): Promise<User> {
  const changes: { display_name?: string; bio?: string; avatar_url?: string | null } = {};
  if (body.displayName !== undefined) changes.display_name = body.displayName;
  if (body.bio !== undefined) changes.bio = body.bio;
  if (body.avatarUrl !== undefined) changes.avatar_url = body.avatarUrl;

  if (Object.keys(changes).length > 0) {
    await ctx.db.updateTable('users').set(changes).where('id', '=', userId).execute();
  }
  const user = await getUser(ctx, userId);
  await broadcastUserUpdate(ctx, user);
  return user;
}
