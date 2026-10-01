import type { FollowState, Relationship } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import { flag, id, num } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';
import { badRequest, notFound } from '../http/errors.js';
import { getUserRow } from '../services/users.js';
import { notify } from './notifications.js';

export async function followState(
  ctx: AppContext,
  followerId: string,
  followeeId: string,
): Promise<FollowState> {
  const row = await ctx.db
    .selectFrom('follows')
    .select('state')
    .where('follower_id', '=', followerId)
    .where('followee_id', '=', followeeId)
    .executeTakeFirst();
  return row?.state ?? 'none';
}

export async function isFollowing(ctx: AppContext, followerId: string, followeeId: string): Promise<boolean> {
  return (await followState(ctx, followerId, followeeId)) === 'following';
}

export async function relationship(
  ctx: AppContext,
  viewerId: string,
  targetId: string,
): Promise<Relationship> {
  const [following, followedBy] = await Promise.all([
    followState(ctx, viewerId, targetId),
    followState(ctx, targetId, viewerId),
  ]);
  return { userId: targetId, following, followedBy: followedBy === 'following' };
}

/** Local accounts that follow this user, for pushing new posts to their open sessions. */
export async function localFollowerIds(ctx: AppContext, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom('follows')
    .innerJoin('users', 'users.id', 'follows.follower_id')
    .select('follows.follower_id')
    .where('follows.followee_id', '=', userId)
    .where('follows.state', '=', 'following')
    .where('users.is_local', '=', 1)
    .execute();
  return rows.map((row) => id(row.follower_id));
}

export async function followCounts(ctx: AppContext, userId: string) {
  const count = (column: 'follower_id' | 'followee_id') =>
    ctx.db
      .selectFrom('follows')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where(column, '=', userId)
      .where('state', '=', 'following')
      .executeTakeFirstOrThrow();
  const [followers, following] = await Promise.all([count('followee_id'), count('follower_id')]);
  return { followers: num(followers.n), following: num(following.n) };
}

/** Tells both people's sessions how they now stand with each other. */
export async function publishRelationship(ctx: AppContext, a: string, b: string): Promise<Relationship> {
  const [ab, ba] = await Promise.all([relationship(ctx, a, b), relationship(ctx, b, a)]);
  ctx.bus.publish(userTopic(a), { t: 'RELATIONSHIP_UPDATE', d: ab });
  ctx.bus.publish(userTopic(b), { t: 'RELATIONSHIP_UPDATE', d: ba });
  return ab;
}

/**
 * Follows someone. Local accounts are followed straight away. Remote accounts start as pending until their
 * server accepts, which the ActivityPub layer handles through `onRemoteFollow`.
 */
export async function follow(ctx: AppContext, followerId: string, followeeId: string): Promise<Relationship> {
  if (followerId === followeeId) throw badRequest("You can't follow yourself.");
  const target = await getUserRow(ctx, followeeId);
  if (!target) throw notFound('That user');
  const local = flag(target.is_local);

  const inserted = await ctx.db
    .insertInto('follows')
    .values({
      follower_id: followerId,
      followee_id: followeeId,
      state: local ? 'following' : 'pending',
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.columns(['follower_id', 'followee_id']).doNothing())
    .executeTakeFirst();

  if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) {
    if (local) await notify(ctx, { userId: followeeId, type: 'follow', actorId: followerId });
    else await ctx.hooks.onRemoteFollow?.(followerId, followeeId);
  }
  return publishRelationship(ctx, followerId, followeeId);
}

export async function unfollow(
  ctx: AppContext,
  followerId: string,
  followeeId: string,
): Promise<Relationship> {
  const removed = await ctx.db
    .deleteFrom('follows')
    .where('follower_id', '=', followerId)
    .where('followee_id', '=', followeeId)
    .executeTakeFirst();
  const target = await getUserRow(ctx, followeeId);
  if (Number(removed.numDeletedRows) > 0 && target && !flag(target.is_local)) {
    await ctx.hooks.onRemoteUnfollow?.(followerId, followeeId);
  }
  return publishRelationship(ctx, followerId, followeeId);
}
