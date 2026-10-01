import { Limits, type Notification, type NotificationPage, type NotificationType } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { NotificationRow } from '../db/schema.js';
import { flag, id, num, optId } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';
import { getUserRow, getUsers } from '../services/users.js';
import type { Page } from './page.js';
import { serializePosts } from './posts.js';

interface NotifyInput {
  userId: string;
  type: NotificationType;
  actorId: string;
  postId?: string | null;
}

/** Records a notification for a local user and pushes it to their open sessions. */
export async function notify(ctx: AppContext, input: NotifyInput): Promise<void> {
  if (input.userId === input.actorId) return;
  const recipient = await getUserRow(ctx, input.userId);
  if (!recipient || !flag(recipient.is_local)) return;

  // Liking, unliking and liking again shouldn't stack up three notifications.
  let existing = ctx.db
    .deleteFrom('notifications')
    .where('user_id', '=', input.userId)
    .where('type', '=', input.type)
    .where('actor_id', '=', input.actorId);
  existing = input.postId
    ? existing.where('post_id', '=', input.postId)
    : existing.where('post_id', 'is', null);
  await existing.execute();

  const row = {
    id: ctx.nextId(),
    user_id: input.userId,
    type: input.type,
    actor_id: input.actorId,
    post_id: input.postId ?? null,
    read: 0,
    created_at: Date.now(),
  };
  await ctx.db.insertInto('notifications').values(row).execute();
  const [notification] = await serializeNotifications(ctx, [row], input.userId);
  if (notification) ctx.bus.publish(userTopic(input.userId), { t: 'NOTIFICATION_CREATE', d: notification });
}

export async function listNotifications(
  ctx: AppContext,
  userId: string,
  query: Page,
): Promise<NotificationPage> {
  const limit = query.limit ?? Limits.postsPerPage;
  let select = ctx.db.selectFrom('notifications').selectAll().where('user_id', '=', userId);
  if (query.before) select = select.where('id', '<', query.before);
  const rows = await select.orderBy('id', 'desc').limit(limit).execute();
  const unread = await ctx.db
    .selectFrom('notifications')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('read', '=', 0)
    .executeTakeFirstOrThrow();
  return {
    items: await serializeNotifications(ctx, rows, userId),
    cursor: rows.length === limit ? id(rows.at(-1)!.id) : null,
    unread: num(unread.n),
  };
}

export async function markNotificationsRead(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db
    .updateTable('notifications')
    .set({ read: 1 })
    .where('user_id', '=', userId)
    .where('read', '=', 0)
    .execute();
}

async function serializeNotifications(
  ctx: AppContext,
  rows: Array<Omit<NotificationRow, 'id'> & { id: string | bigint }>,
  viewerId: string,
): Promise<Notification[]> {
  const actors = await getUsers(
    ctx,
    rows.map((row) => id(row.actor_id)),
  );
  const postIds = rows.map((row) => optId(row.post_id)).filter((v): v is string => v !== null);
  const postRows = postIds.length
    ? await ctx.db.selectFrom('posts').selectAll().where('id', 'in', postIds).execute()
    : [];
  const posts = new Map(
    (await serializePosts(ctx, postRows, viewerId)).map((post) => [post.id, post] as const),
  );

  const result: Notification[] = [];
  for (const row of rows) {
    const actor = actors.get(id(row.actor_id));
    if (!actor) continue;
    result.push({
      id: id(row.id),
      type: row.type,
      actor,
      post: row.post_id === null ? null : (posts.get(id(row.post_id)) ?? null),
      createdAt: num(row.created_at),
      read: flag(row.read),
    });
  }
  return result;
}
