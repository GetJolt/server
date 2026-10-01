import {
  computeChannelPermissions,
  DEFAULT_EVERYONE_PERMISSIONS,
  highestRolePosition,
  Limits,
  outranks,
  Permission,
  hasPermission,
  computeBasePermissions,
  type Ban,
  type CreateGuildBody,
  type Guild,
  type GuildSnapshot,
  type Member,
  type PresenceStatus,
  type UpdateGuildBody,
  type UpdateMemberBody,
} from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { GuildRow } from '../db/schema.js';
import { id, num } from '../db/values.js';
import { guildTopic, userTopic } from '../events/EventBus.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { listGuildChannels } from './channels.js';
import { requestResync, requireGuildPermission, requireMember } from './permissions.js';
import { listRoles } from './roles.js';
import { getUser, getUsers } from './users.js';

export function serializeGuild(row: GuildRow): Guild {
  return {
    id: id(row.id),
    name: row.name,
    description: row.description,
    iconUrl: row.icon_url,
    ownerId: id(row.owner_id),
    createdAt: num(row.created_at),
  };
}

export async function getGuild(ctx: AppContext, guildId: string): Promise<Guild> {
  const row = await ctx.db.selectFrom('guilds').selectAll().where('id', '=', guildId).executeTakeFirst();
  if (!row) throw notFound('That server');
  return serializeGuild(row);
}

export async function listMembers(ctx: AppContext, guildId: string, userIds?: string[]): Promise<Member[]> {
  let query = ctx.db.selectFrom('guild_members').selectAll().where('guild_id', '=', guildId);
  if (userIds) query = query.where('user_id', 'in', userIds.length ? userIds : ['0']);
  const [rows, roleRows] = await Promise.all([
    query.execute(),
    ctx.db
      .selectFrom('member_roles')
      .select(['user_id', 'role_id'])
      .where('guild_id', '=', guildId)
      .execute(),
  ]);

  const users = await getUsers(
    ctx,
    rows.map((r) => id(r.user_id)),
  );
  const roles = new Map<string, string[]>();
  for (const r of roleRows) {
    const list = roles.get(id(r.user_id)) ?? [];
    list.push(id(r.role_id));
    roles.set(id(r.user_id), list);
  }

  return rows.flatMap((row) => {
    const user = users.get(id(row.user_id));
    if (!user) return [];
    return [
      {
        guildId,
        user,
        nickname: row.nickname,
        roleIds: roles.get(user.id) ?? [],
        joinedAt: num(row.joined_at),
      },
    ];
  });
}

export async function getMember(ctx: AppContext, guildId: string, userId: string): Promise<Member> {
  const [member] = await listMembers(ctx, guildId, [userId]);
  if (!member) throw notFound('That member');
  return member;
}

/** The guild as one member sees it: channels they can't view are left out. */
export async function buildSnapshot(
  ctx: AppContext,
  guildId: string,
  userId: string,
): Promise<GuildSnapshot | null> {
  const permissionCtx = await ctx.perms.memberContext(guildId, userId);
  if (!permissionCtx) return null;

  const [guild, channels, roles, members] = await Promise.all([
    getGuild(ctx, guildId),
    listGuildChannels(ctx, guildId),
    listRoles(ctx, guildId),
    listMembers(ctx, guildId),
  ]);

  const visible = channels.filter((c) => computeChannelPermissions(permissionCtx, c.overwrites) !== 0n);
  const presences: Record<string, PresenceStatus> = {};
  for (const member of members) {
    const status = ctx.presence.get(member.user.id);
    if (status !== 'offline') presences[member.user.id] = status;
  }
  return { guild, channels: visible, roles, members, presences };
}

export async function createGuild(
  ctx: AppContext,
  userId: string,
  body: CreateGuildBody,
): Promise<GuildSnapshot> {
  const owned = await ctx.db
    .selectFrom('guild_members')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  if (num(owned.n as number) >= Limits.guildsPerUser)
    throw badRequest("You've joined the maximum number of servers.");

  const guildId = ctx.nextId();
  const categoryId = ctx.nextId();
  const generalId = ctx.nextId();
  const now = Date.now();

  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('guilds')
      .values({
        id: guildId,
        name: body.name,
        description: body.description ?? '',
        icon_url: null,
        owner_id: userId,
        created_at: now,
      })
      .execute();
    await trx
      .insertInto('roles')
      .values({
        id: guildId,
        guild_id: guildId,
        name: '@everyone',
        color: null,
        position: 0,
        permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(),
        hoist: 0,
        mentionable: 0,
      })
      .execute();
    await trx
      .insertInto('channels')
      .values([
        {
          id: categoryId,
          guild_id: guildId,
          type: 'category',
          name: 'Text channels',
          topic: '',
          position: 0,
          parent_id: null,
          last_message_id: null,
          created_at: now,
        },
        {
          id: generalId,
          guild_id: guildId,
          type: 'text',
          name: 'general',
          topic: '',
          position: 1,
          parent_id: categoryId,
          last_message_id: null,
          created_at: now,
        },
      ])
      .execute();
    await trx
      .insertInto('guild_members')
      .values({ guild_id: guildId, user_id: userId, nickname: null, joined_at: now })
      .execute();
  });

  const snapshot = (await buildSnapshot(ctx, guildId, userId))!;
  ctx.bus.publish(userTopic(userId), { t: 'GUILD_CREATE', d: snapshot });
  return snapshot;
}

export async function updateGuild(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  body: UpdateGuildBody,
): Promise<Guild> {
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.MANAGE_GUILD);
  const changes: Partial<{ name: string; description: string; icon_url: string | null }> = {};
  if (body.name !== undefined) changes.name = body.name;
  if (body.description !== undefined) changes.description = body.description;
  if (body.iconUrl !== undefined) changes.icon_url = body.iconUrl;
  if (Object.keys(changes).length > 0) {
    await ctx.db.updateTable('guilds').set(changes).where('id', '=', guildId).execute();
  }
  const guild = await getGuild(ctx, guildId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_UPDATE', d: guild });
  return guild;
}

export async function deleteGuild(ctx: AppContext, actorId: string, guildId: string): Promise<void> {
  const guild = await getGuild(ctx, guildId);
  if (guild.ownerId !== actorId) throw forbidden('Only the owner can delete a server.');

  const channels = await ctx.db.selectFrom('channels').select('id').where('guild_id', '=', guildId).execute();
  for (const channel of channels) await ctx.messages.deleteChannel(id(channel.id));
  await ctx.db.deleteFrom('guilds').where('id', '=', guildId).execute();

  ctx.perms.invalidate(guildId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_DELETE', d: { id: guildId } });
}

export async function addMember(ctx: AppContext, guildId: string, userId: string): Promise<GuildSnapshot> {
  const existing = await buildSnapshot(ctx, guildId, userId);
  if (existing) return existing;

  await ctx.db
    .insertInto('guild_members')
    .values({ guild_id: guildId, user_id: userId, nickname: null, joined_at: Date.now() })
    .execute();
  ctx.perms.invalidate(guildId);

  const member = await getMember(ctx, guildId, userId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_MEMBER_ADD', d: member });
  const snapshot = (await buildSnapshot(ctx, guildId, userId))!;
  ctx.bus.publish(userTopic(userId), { t: 'GUILD_CREATE', d: snapshot });
  return snapshot;
}

export async function removeMember(ctx: AppContext, guildId: string, userId: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('member_roles')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .execute();
    await trx
      .deleteFrom('guild_members')
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .execute();
    await trx
      .deleteFrom('read_states')
      .where('user_id', '=', userId)
      .where('channel_id', 'in', (eb) =>
        eb.selectFrom('channels').select('id').where('guild_id', '=', guildId),
      )
      .execute();
  });
  ctx.perms.invalidate(guildId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_MEMBER_REMOVE', d: { guildId, userId } });
  ctx.bus.publish(userTopic(userId), { t: 'GUILD_DELETE', d: { id: guildId } });
}

export async function leaveGuild(ctx: AppContext, userId: string, guildId: string): Promise<void> {
  const member = await requireMember(ctx.perms, guildId, userId);
  if (member.ownerId === userId) {
    throw badRequest('Transfer ownership or delete the server before leaving it.');
  }
  await removeMember(ctx, guildId, userId);
}

async function requireModeration(
  ctx: AppContext,
  guildId: string,
  actorId: string,
  targetId: string,
  permission: bigint,
) {
  const actor = await requireGuildPermission(ctx.perms, guildId, actorId, permission);
  const target = await ctx.perms.memberContext(guildId, targetId);
  if (
    target &&
    !outranks(
      actor,
      { userId: actorId, roleIds: actor.memberRoleIds },
      { userId: targetId, roleIds: target.memberRoleIds },
    )
  ) {
    throw forbidden('You can only act on members below your highest role.');
  }
  return { actor, target };
}

export async function kickMember(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  userId: string,
): Promise<void> {
  const { target } = await requireModeration(ctx, guildId, actorId, userId, Permission.KICK_MEMBERS);
  if (!target) throw notFound('That member');
  await removeMember(ctx, guildId, userId);
}

export async function banMember(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  userId: string,
  reason = '',
) {
  const { target } = await requireModeration(ctx, guildId, actorId, userId, Permission.BAN_MEMBERS);
  await getUser(ctx, userId);

  await ctx.db
    .insertInto('bans')
    .values({ guild_id: guildId, user_id: userId, reason, moderator_id: actorId, created_at: Date.now() })
    .onConflict((oc) => oc.columns(['guild_id', 'user_id']).doUpdateSet({ reason }))
    .execute();
  await ctx.db
    .deleteFrom('invites')
    .where('guild_id', '=', guildId)
    .where('inviter_id', '=', userId)
    .execute();
  if (target) await removeMember(ctx, guildId, userId);
}

export async function unbanMember(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  userId: string,
): Promise<void> {
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.BAN_MEMBERS);
  await ctx.db.deleteFrom('bans').where('guild_id', '=', guildId).where('user_id', '=', userId).execute();
}

export async function listBans(ctx: AppContext, actorId: string, guildId: string): Promise<Ban[]> {
  await requireGuildPermission(ctx.perms, guildId, actorId, Permission.BAN_MEMBERS);
  const rows = await ctx.db
    .selectFrom('bans')
    .selectAll()
    .where('guild_id', '=', guildId)
    .orderBy('created_at', 'desc')
    .execute();
  const users = await getUsers(
    ctx,
    rows.map((r) => id(r.user_id)),
  );
  return rows.flatMap((row) => {
    const user = users.get(id(row.user_id));
    return user ? [{ user, reason: row.reason, createdAt: num(row.created_at) }] : [];
  });
}

export async function isBanned(ctx: AppContext, guildId: string, userId: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('bans')
    .select('user_id')
    .where('guild_id', '=', guildId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Boolean(row);
}

export async function updateMember(
  ctx: AppContext,
  actorId: string,
  guildId: string,
  userId: string,
  body: UpdateMemberBody,
): Promise<Member> {
  const actor = await requireMember(ctx.perms, guildId, actorId);
  const target = await ctx.perms.memberContext(guildId, userId);
  if (!target) throw notFound('That member');
  const actorPerms = computeBasePermissions(actor);
  const isSelf = actorId === userId;
  const isOwner = actor.ownerId === actorId;
  const canActOnTarget =
    isSelf ||
    outranks(
      actor,
      { userId: actorId, roleIds: actor.memberRoleIds },
      { userId, roleIds: target.memberRoleIds },
    );

  if (body.nickname !== undefined) {
    const allowed = isSelf
      ? hasPermission(actorPerms, Permission.CHANGE_NICKNAME) ||
        hasPermission(actorPerms, Permission.MANAGE_NICKNAMES)
      : hasPermission(actorPerms, Permission.MANAGE_NICKNAMES) && canActOnTarget;
    if (!allowed) throw forbidden("You can't change that nickname.");
    await ctx.db
      .updateTable('guild_members')
      .set({ nickname: body.nickname || null })
      .where('guild_id', '=', guildId)
      .where('user_id', '=', userId)
      .execute();
  }

  if (body.roleIds !== undefined) {
    if (!hasPermission(actorPerms, Permission.MANAGE_ROLES)) throw forbidden();
    if (!isSelf && !canActOnTarget) throw forbidden('You can only manage members below your highest role.');

    const roles = await listRoles(ctx, guildId);
    const byId = new Map(roles.map((r) => [r.id, r]));
    const ceiling = isOwner ? Infinity : highestRolePosition(actor);
    const next = new Set(body.roleIds.filter((r) => r !== guildId));
    const current = new Set(target.memberRoleIds);

    for (const roleId of new Set([...next, ...current])) {
      if (next.has(roleId) === current.has(roleId)) continue;
      const role = byId.get(roleId);
      if (!role) throw badRequest('One of those roles does not exist.');
      if (role.position >= ceiling) throw forbidden(`You can't assign or remove ${role.name}.`);
    }

    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('member_roles')
        .where('guild_id', '=', guildId)
        .where('user_id', '=', userId)
        .execute();
      if (next.size > 0) {
        await trx
          .insertInto('member_roles')
          .values([...next].map((roleId) => ({ guild_id: guildId, user_id: userId, role_id: roleId })))
          .execute();
      }
    });
  }

  const member = await getMember(ctx, guildId, userId);
  ctx.bus.publish(guildTopic(guildId), { t: 'GUILD_MEMBER_UPDATE', d: member });
  if (body.roleIds !== undefined) requestResync(ctx, guildId);
  return member;
}
