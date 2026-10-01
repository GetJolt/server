// Likes and reposts. Counts live on the post row so timelines don't need to count on every read.

import type { Post } from '@getjolt/protocol';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import type { PostRow } from '../db/schema.js';
import { id } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';
import { badRequest, notFound } from '../http/errors.js';
import { getUser } from '../services/users.js';
import { localFollowerIds } from './follows.js';
import { notify } from './notifications.js';
import { serializePosts, visiblePostRow } from './posts.js';

async function loadPost(ctx: AppContext, postId: string, userId: string): Promise<PostRow> {
  const row = await visiblePostRow(ctx, postId, userId);
  if (!row) throw notFound('That post');
  return row;
}

/** Sends the actor a fresh copy of the post, so their other devices see the new counts and button state. */
async function refresh(ctx: AppContext, postId: string, userId: string): Promise<Post> {
  const row = await ctx.db.selectFrom('posts').selectAll().where('id', '=', postId).executeTakeFirstOrThrow();
  const [post] = await serializePosts(ctx, [row], userId);
  ctx.bus.publish(userTopic(userId), { t: 'POST_UPDATE', d: post! });
  return post!;
}

const bump = (ctx: AppContext, postId: string, column: 'like_count' | 'repost_count', by: 1 | -1) =>
  ctx.db
    .updateTable('posts')
    .set({ [column]: sql<number>`${sql.ref(column)} + ${by}` })
    .where('id', '=', postId)
    .where(column, '>=', by < 0 ? 1 : 0)
    .execute();

export async function like(ctx: AppContext, userId: string, postId: string): Promise<Post> {
  const row = await loadPost(ctx, postId, userId);
  const result = await ctx.db
    .insertInto('likes')
    .values({ user_id: userId, post_id: postId, created_at: Date.now() })
    .onConflict((oc) => oc.columns(['user_id', 'post_id']).doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) {
    await bump(ctx, postId, 'like_count', 1);
    await notify(ctx, { userId: id(row.author_id), type: 'like', actorId: userId, postId });
    await ctx.hooks.onLike?.(userId, row);
  }
  return refresh(ctx, postId, userId);
}

export async function unlike(ctx: AppContext, userId: string, postId: string): Promise<Post> {
  const row = await loadPost(ctx, postId, userId);
  const result = await ctx.db
    .deleteFrom('likes')
    .where('user_id', '=', userId)
    .where('post_id', '=', postId)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) > 0) {
    await bump(ctx, postId, 'like_count', -1);
    await ctx.hooks.onUnlike?.(userId, row);
  }
  return refresh(ctx, postId, userId);
}

export async function repost(ctx: AppContext, userId: string, postId: string): Promise<Post> {
  const row = await loadPost(ctx, postId, userId);
  if (row.visibility === 'followers') throw badRequest("Followers-only posts can't be reposted.");
  const repostId = ctx.nextId();
  const result = await ctx.db
    .insertInto('reposts')
    .values({ id: repostId, user_id: userId, post_id: postId, created_at: Date.now() })
    .onConflict((oc) => oc.columns(['user_id', 'post_id']).doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) return refresh(ctx, postId, userId);

  await bump(ctx, postId, 'repost_count', 1);
  await notify(ctx, { userId: id(row.author_id), type: 'repost', actorId: userId, postId });

  const reposter = await getUser(ctx, userId);
  for (const followerId of await localFollowerIds(ctx, userId)) {
    const [seen] = await serializePosts(
      ctx,
      [{ ...row, repost_count: Number(row.repost_count) + 1 }],
      followerId,
    );
    ctx.bus.publish(userTopic(followerId), {
      t: 'FEED_ITEM_CREATE',
      d: { id: repostId, post: seen!, repostedBy: reposter },
    });
  }
  await ctx.hooks.onRepost?.(userId, repostId, row);
  const post = await refresh(ctx, postId, userId);
  ctx.bus.publish(userTopic(userId), {
    t: 'FEED_ITEM_CREATE',
    d: { id: repostId, post, repostedBy: reposter },
  });
  return post;
}

export async function unrepost(ctx: AppContext, userId: string, postId: string): Promise<Post> {
  const row = await loadPost(ctx, postId, userId);
  const existing = await ctx.db
    .selectFrom('reposts')
    .select('id')
    .where('user_id', '=', userId)
    .where('post_id', '=', postId)
    .executeTakeFirst();
  if (existing) {
    await ctx.db.deleteFrom('reposts').where('id', '=', existing.id).execute();
    await bump(ctx, postId, 'repost_count', -1);
    await ctx.hooks.onUnrepost?.(userId, id(existing.id), row);
  }
  return refresh(ctx, postId, userId);
}
