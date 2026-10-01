import {
  ALL_PERMISSIONS,
  computeBasePermissions,
  highestRolePosition,
  Limits,
  parsePermissions,
  Permission,
  type CreateRoleBody,
  type ReorderBody,
  type Role,
  type UpdateRoleBody,
} from '@jolt/protocol';
import type { AppContext } from '../context.js';
import type { RoleRow } from '../db/schema.js';
import { flag, id, num, optNum, toFlag } from '../db/values.js';
import { guildTopic } from '../events/EventBus.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { requestResync, requireGuildPermission } from './permissions.js';

export function serializeRole(row: RoleRow): Role {
  return {
    id: id(row.id),
    guildId: id(row.guild_id),
    name: row.name,
    color: optNum(row.color),
    position: num(row.position),
    permissions: row.permissions,
    hoist: flag(row.hoist),
    mentionable: flag(row.mentionable),
  };
}

export async function listRoles(ctx: AppContext, guildId: string): Promise<Role[]> {
  const rows = await ctx.db
    .selectFrom('roles')
    .selectAll()
    .where('guild_id', '=', guildId)
    .orderBy('position')
    .execute();
  return rows.map(serializeRole);
}

async function getRole(ctx: AppContext, guildId: string, roleId: string): Promise<Role> {
  const row = await ctx.db
    .selectFrom('roles')
    .selectAll()
    .where('guild_id', '=', guildId)
    .where('id', '=', roleId)
    .executeTakeFirst();
  if (!row) throw notFound('That role');
  return serializeRole(row);
}

/** Role managers can only touch roles below their own highest role, and can't grant what they lack. */
async function assertCanManage(
  ctx: AppContext,
  guildId: string,
  actorId: string,
  role?: Role,
  permissions?: string,
) {
  const member = await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_ROLES);
  if (member.userId === member.ownerId) return;
  if (role && role.position >= highestRolePosition(member)) {
    throw forbidden('You can only manage roles below your highest role.');
  }
  if (permissions !== undefined) {
    const granted = computeBasePermissions(member);
    if ((parsePermissions(permissions) & ~granted & ALL_PERMISSIONS) !== 0n) {
      throw forbidden("You can't grant permissions you don't have.");
    }
  }
}

export async function createRole(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  body: CreateRoleBody,
): Promise<Role> {
  await assertCanManage(ctx, guildId, actorId, undefined, body.permissions);
  const existing = await listRoles(ctx, guildId);
  if (existing.length >= Limits.rolesPerGuild) throw badRequest('This server has too many roles.');

  const roleId = ctx.nextId();
  await ctx.db.transaction().execute(async (trx) => {
    // New roles go directly above @everyone, matching what people expect from Discord.
    for (const role of existing) {
      if (role.position >= 1) {
        await trx
          .updateTable('roles')
          .set({ position: role.position + 1 })
          .where('id', '=', role.id)
          .execute();
      }
    }
    await trx
      .insertInto('roles')
      .values({
        id: roleId,
        guild_id: guildId,
        name: body.name ?? 'new role',
        color: body.color ?? null,
        position: 1,
        permissions: body.permissions ?? '0',
        hoist: toFlag(body.hoist ?? false),
        mentionable: toFlag(body.mentionable ?? false),
      })
      .execute();
  });

  const role = await getRole(ctx, guildId, roleId);
  ctx.perms.invalidate(guildId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_ROLE_CREATE', d: role });
  for (const other of await listRoles(ctx, guildId)) {
    if (other.id !== roleId && other.position > 1)
      ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_ROLE_UPDATE', d: other });
  }
  return role;
}

export async function updateRole(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  roleId: string,
  body: UpdateRoleBody,
): Promise<Role> {
  const role = await getRole(ctx, guildId, roleId);
  await assertCanManage(ctx, guildId, actorId, roleId === guildId ? undefined : role, body.permissions);
  if (roleId === guildId && body.name !== undefined) throw badRequest("The @everyone role can't be renamed.");

  const changes: Partial<{
    name: string;
    color: number | null;
    permissions: string;
    hoist: number;
    mentionable: number;
  }> = {};
  if (body.name !== undefined) changes.name = body.name;
  if (body.color !== undefined) changes.color = body.color;
  if (body.permissions !== undefined) changes.permissions = body.permissions;
  if (body.hoist !== undefined) changes.hoist = toFlag(body.hoist);
  if (body.mentionable !== undefined) changes.mentionable = toFlag(body.mentionable);

  if (Object.keys(changes).length > 0) {
    await ctx.db.updateTable('roles').set(changes).where('id', '=', roleId).execute();
  }
  const updated = await getRole(ctx, guildId, roleId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_ROLE_UPDATE', d: updated });
  if (body.permissions !== undefined) requestResync(ctx, guildId);
  else ctx.perms.invalidate(guildId);
  return updated;
}

export async function deleteRole(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  roleId: string,
): Promise<void> {
  if (roleId === guildId) throw badRequest("The @everyone role can't be deleted.");
  const role = await getRole(ctx, guildId, roleId);
  await assertCanManage(ctx, guildId, actorId, role);

  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom('member_roles').where('role_id', '=', roleId).execute();
    await trx.deleteFrom('permission_overwrites').where('target_id', '=', roleId).execute();
    await trx.deleteFrom('roles').where('id', '=', roleId).execute();
  });

  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_ROLE_DELETE', d: { id: roleId, guildId } });
  requestResync(ctx, guildId);
}

export async function reorderRoles(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  body: ReorderBody,
): Promise<Role[]> {
  const member = await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_ROLES);
  const isOwner = member.userId === member.ownerId;
  const ceiling = isOwner ? Infinity : highestRolePosition(member);
  const roles = new Map((await listRoles(ctx, guildId)).map((r) => [r.id, r]));

  for (const item of body.items) {
    const role = roles.get(item.id);
    if (!role) throw notFound('That role');
    if (item.id === guildId) throw badRequest('@everyone always stays at the bottom.');
    if (item.position < 1) throw badRequest('Roles must stay above @everyone.');
    if (role.position >= ceiling || item.position >= ceiling) {
      throw forbidden('You can only move roles below your highest role.');
    }
  }

  await ctx.db.transaction().execute(async (trx) => {
    for (const item of body.items) {
      await trx.updateTable('roles').set({ position: item.position }).where('id', '=', item.id).execute();
    }
  });

  const updated = await listRoles(ctx, guildId);
  for (const role of updated) {
    if (body.items.some((i) => i.id === role.id))
      ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_ROLE_UPDATE', d: role });
  }
  requestResync(ctx, guildId);
  return updated;
}
