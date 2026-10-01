// Permission checks happen on every request and every fanned-out gateway event, so each guild's roles,
// overwrites and member roles are cached in memory and dropped whenever any of them change.

import {
  computeBasePermissions,
  computeChannelPermissions,
  hasPermission,
  type PermissionContext,
  type PermissionOverwrite,
  type PermissionRole,
} from '@getjolt/protocol';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema.js';
import { id, num } from '../db/values.js';
import { guildTopic, type EventBus } from '../events/EventBus.js';
import { forbidden, notFound } from '../http/errors.js';

interface GuildPermissionData {
  guildId: string;
  ownerId: string;
  roles: PermissionRole[];
  memberRoles: Map<string, string[]>;
  overwrites: Map<string, PermissionOverwrite[]>;
}

export class PermissionCache {
  private readonly cache = new Map<string, Promise<GuildPermissionData | null>>();

  constructor(private readonly db: Kysely<Database>) {}

  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  private load(guildId: string): Promise<GuildPermissionData | null> {
    let entry = this.cache.get(guildId);
    if (!entry) {
      entry = this.fetch(guildId);
      this.cache.set(guildId, entry);
      entry.catch(() => this.cache.delete(guildId));
    }
    return entry;
  }

  private async fetch(guildId: string): Promise<GuildPermissionData | null> {
    const guild = await this.db
      .selectFrom('guilds')
      .select('owner_id')
      .where('id', '=', guildId)
      .executeTakeFirst();
    if (!guild) return null;

    const [roles, members, memberRoles, overwrites] = await Promise.all([
      this.db
        .selectFrom('roles')
        .select(['id', 'permissions', 'position'])
        .where('guild_id', '=', guildId)
        .execute(),
      this.db.selectFrom('guild_members').select('user_id').where('guild_id', '=', guildId).execute(),
      this.db
        .selectFrom('member_roles')
        .select(['user_id', 'role_id'])
        .where('guild_id', '=', guildId)
        .execute(),
      this.db
        .selectFrom('permission_overwrites')
        .innerJoin('channels', 'channels.id', 'permission_overwrites.channel_id')
        .select(['channel_id', 'target_id', 'target_type', 'allow', 'deny'])
        .where('channels.guild_id', '=', guildId)
        .execute(),
    ]);

    const memberRoleMap = new Map<string, string[]>(members.map((m) => [id(m.user_id), []]));
    for (const row of memberRoles) memberRoleMap.get(id(row.user_id))?.push(id(row.role_id));

    const overwriteMap = new Map<string, PermissionOverwrite[]>();
    for (const row of overwrites) {
      const channelId = id(row.channel_id);
      const list = overwriteMap.get(channelId) ?? [];
      list.push({ id: id(row.target_id), type: row.target_type, allow: row.allow, deny: row.deny });
      overwriteMap.set(channelId, list);
    }

    return {
      guildId,
      ownerId: id(guild.owner_id),
      roles: roles.map((r) => ({ id: id(r.id), permissions: r.permissions, position: num(r.position) })),
      memberRoles: memberRoleMap,
      overwrites: overwriteMap,
    };
  }

  /** Null when the user isn't a member of the guild (or the guild doesn't exist). */
  async memberContext(guildId: string, userId: string): Promise<PermissionContext | null> {
    const data = await this.load(guildId);
    const roleIds = data?.memberRoles.get(userId);
    if (!data || !roleIds) return null;
    return { guildId, ownerId: data.ownerId, userId, memberRoleIds: roleIds, roles: data.roles };
  }

  async isMember(guildId: string, userId: string): Promise<boolean> {
    return (await this.memberContext(guildId, userId)) !== null;
  }

  async guildPermissions(guildId: string, userId: string): Promise<bigint> {
    const ctx = await this.memberContext(guildId, userId);
    return ctx ? computeBasePermissions(ctx) : 0n;
  }

  async channelPermissions(guildId: string, channelId: string, userId: string): Promise<bigint> {
    const ctx = await this.memberContext(guildId, userId);
    if (!ctx) return 0n;
    const data = await this.load(guildId);
    return computeChannelPermissions(ctx, data?.overwrites.get(channelId) ?? []);
  }

  async memberIds(guildId: string): Promise<string[]> {
    const data = await this.load(guildId);
    return data ? [...data.memberRoles.keys()] : [];
  }
}

export function requestResync(ctx: { perms: PermissionCache; bus: EventBus }, guildId: string): void {
  ctx.perms.invalidate(guildId);
  ctx.bus.publish(guildTopic(guildId), { t: 'RESYNC', guildId });
}

export async function requireMember(perms: PermissionCache, guildId: string, userId: string) {
  const ctx = await perms.memberContext(guildId, userId);
  if (!ctx) throw notFound('That server');
  return ctx;
}

export async function requireGuildPermission(
  perms: PermissionCache,
  guildId: string,
  userId: string,
  permission: bigint,
) {
  const ctx = await requireMember(perms, guildId, userId);
  if (!hasPermission(computeBasePermissions(ctx), permission)) throw forbidden();
  return ctx;
}

export async function requireChannelPermission(
  perms: PermissionCache,
  guildId: string,
  channelId: string,
  userId: string,
  permission: bigint,
) {
  await requireMember(perms, guildId, userId);
  const granted = await perms.channelPermissions(guildId, channelId, userId);
  if (granted === 0n) throw notFound('That channel');
  if (!hasPermission(granted, permission)) throw forbidden();
  return granted;
}
