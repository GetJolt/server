// Timelines are built when they're read: posts and reposts by the accounts someone follows, newest first. That
// keeps writes cheap and needs no backfill when you follow someone. A very large instance could swap this for
// precomputed timelines behind the same functions.

import { Limits, type TimelineItem, type TimelinePage } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { PostRow } from '../db/schema.js';
import { id } from '../db/values.js';
import { getUsers } from '../services/users.js';
import { isFollowing } from './follows.js';
import type { Page } from './page.js';
import { serializePosts } from './posts.js';

export type ProfileFilter = 'posts' | 'replies' | 'media';

export async function homeTimeline(ctx: AppContext, userId: string, query: Page): Promise<TimelinePage> {
  const limit = query.limit ?? Limits.postsPerPage;
  const followed = ctx.db
    .selectFrom('follows')
    .select('followee_id')
    .where('follower_id', '=', userId)
    .where('state', '=', 'following');

  // Posts by me or people I follow. Replies only show when they reply to someone I also follow (or me).
  let posts = ctx.db
    .selectFrom('posts as p')
    .leftJoin('posts as parent', 'parent.id', 'p.reply_to_id')
    .selectAll('p')
    .where((eb) => eb.or([eb('p.author_id', '=', userId), eb('p.author_id', 'in', followed)]))
    .where((eb) =>
      eb.or([
        eb('p.reply_to_id', 'is', null),
        eb('parent.author_id', '=', userId),
        eb('parent.author_id', 'in', followed),
      ]),
    );
  if (query.before) posts = posts.where('p.id', '<', query.before);

  let reposts = ctx.db
    .selectFrom('reposts')
    .select(['reposts.id', 'reposts.user_id', 'reposts.post_id'])
    .where((eb) => eb.or([eb('reposts.user_id', '=', userId), eb('reposts.user_id', 'in', followed)]));
  if (query.before) reposts = reposts.where('reposts.id', '<', query.before);

  const [postRows, repostRows] = await Promise.all([
    posts.orderBy('p.id', 'desc').limit(limit).execute(),
    reposts.orderBy('reposts.id', 'desc').limit(limit).execute(),
  ]);
  return assemble(ctx, userId, postRows, repostRows, limit);
}

export async function profileTimeline(
  ctx: AppContext,
  authorId: string,
  viewerId: string | null,
  query: Page & { filter?: ProfileFilter },
): Promise<TimelinePage> {
  const limit = query.limit ?? Limits.postsPerPage;
  const filter = query.filter ?? 'posts';
  const seesFollowersOnly =
    viewerId !== null && (viewerId === authorId || (await isFollowing(ctx, viewerId, authorId)));

  let posts = ctx.db.selectFrom('posts as p').selectAll('p').where('p.author_id', '=', authorId);
  if (!seesFollowersOnly) posts = posts.where('p.visibility', '!=', 'followers');
  if (filter === 'posts') posts = posts.where('p.reply_to_id', 'is', null);
  if (filter === 'media') {
    posts = posts.where((eb) =>
      eb.exists(eb.selectFrom('post_media').select('post_id').whereRef('post_media.post_id', '=', 'p.id')),
    );
  }
  if (query.before) posts = posts.where('p.id', '<', query.before);

  let repostRows: RepostRow[] = [];
  if (filter === 'posts') {
    let reposts = ctx.db
      .selectFrom('reposts')
      .select(['reposts.id', 'reposts.user_id', 'reposts.post_id'])
      .where('reposts.user_id', '=', authorId);
    if (query.before) reposts = reposts.where('reposts.id', '<', query.before);
    repostRows = await reposts.orderBy('reposts.id', 'desc').limit(limit).execute();
  }
  const postRows = await posts.orderBy('p.id', 'desc').limit(limit).execute();
  return assemble(ctx, viewerId, postRows, repostRows, limit);
}

interface RepostRow {
  id: string | bigint;
  user_id: string | bigint;
  post_id: string | bigint;
}

/** Merges posts and reposts newest first, drops repeats of the same post, and serializes the page. */
async function assemble(
  ctx: AppContext,
  viewerId: string | null,
  postRows: PostRow[],
  repostRows: RepostRow[],
  limit: number,
): Promise<TimelinePage> {
  const repostedIds = [...new Set(repostRows.map((r) => id(r.post_id)))].filter(
    (pid) => !postRows.some((p) => id(p.id) === pid),
  );
  const repostedRows = repostedIds.length
    ? await ctx.db
        .selectFrom('posts')
        .selectAll()
        .where('id', 'in', repostedIds)
        .where('visibility', '!=', 'followers')
        .execute()
    : [];
  const allRows = [...postRows, ...repostedRows];
  const posts = new Map((await serializePosts(ctx, allRows, viewerId)).map((p) => [p.id, p] as const));
  const reposters = await getUsers(
    ctx,
    repostRows.map((r) => id(r.user_id)),
  );

  const entries: Array<{ id: string; postId: string; by: string | null }> = [
    ...postRows.map((p) => ({ id: id(p.id), postId: id(p.id), by: null })),
    ...repostRows.map((r) => ({ id: id(r.id), postId: id(r.post_id), by: id(r.user_id) })),
  ].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));

  const seen = new Set<string>();
  const items: TimelineItem[] = [];
  let stoppedEarly = false;
  for (const entry of entries) {
    if (items.length === limit) {
      stoppedEarly = true;
      break;
    }
    const post = posts.get(entry.postId);
    if (!post || seen.has(entry.postId)) continue;
    seen.add(entry.postId);
    items.push({ id: entry.id, post, repostedBy: entry.by ? (reposters.get(entry.by) ?? null) : null });
  }
  // Both sources came back short and we used everything, so there's nothing older left to page into.
  const exhausted = postRows.length < limit && repostRows.length < limit && !stoppedEarly;
  return { items, cursor: exhausted || items.length === 0 ? null : items.at(-1)!.id };
}
