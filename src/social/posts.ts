// Creating, deleting and reading posts, and turning rows into what clients see. Visibility is enforced here, so
// routes, timelines and federation never hand out a post the viewer isn't allowed to see.

import {
  detectFacets,
  instanceOrigin,
  type createPostBodySchema,
  type Facet,
  type Post,
  type PostMedia,
  type Thread,
  type User,
} from '@getjolt/protocol';
import type { z } from 'zod';
import type { AppContext } from '../context.js';
import { sql, type Insertable } from 'kysely';
import type { PostRow, PostsTable } from '../db/schema.js';
import { id, num, optId, optNum } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { getLocalUserByHandle, getUsers } from '../services/users.js';
import { isFollowing, localFollowerIds } from './follows.js';
import { mediaUrl, pruneImage } from './media.js';
import { notify } from './notifications.js';

export type CreatePostInput = z.output<typeof createPostBodySchema>;

const parseFacets = (json: string): Facet[] => {
  try {
    return JSON.parse(json) as Facet[];
  } catch {
    return [];
  }
};

export function profileUrl(ctx: AppContext, user: Pick<User, 'handle' | 'local'>): string | null {
  return user.local ? `${instanceOrigin(ctx.config.domain, ctx.config.devInsecure)}/@${user.handle}` : null;
}

/** Whether `viewerId` (null for logged-out visitors) may see this post. */
export async function canSee(ctx: AppContext, row: PostRow, viewerId: string | null): Promise<boolean> {
  if (row.visibility !== 'followers') return true;
  if (!viewerId) return false;
  if (id(row.author_id) === viewerId) return true;
  if (parseFacets(row.facets).some((f) => f.userId === viewerId)) return true;
  return isFollowing(ctx, viewerId, id(row.author_id));
}

export async function visiblePostRow(
  ctx: AppContext,
  postId: string,
  viewerId: string | null,
): Promise<PostRow | undefined> {
  if (!/^\d{1,20}$/.test(postId)) return undefined;
  const row = await ctx.db.selectFrom('posts').selectAll().where('id', '=', postId).executeTakeFirst();
  return row && (await canSee(ctx, row, viewerId)) ? row : undefined;
}

/** Detects facets and ties mentions of local accounts to their user ids. */
async function resolveFacets(ctx: AppContext, text: string): Promise<Facet[]> {
  const facets = detectFacets(text);
  for (const facet of facets) {
    if (facet.kind !== 'mention') continue;
    const [handle, instance] = facet.value.split('@');
    if (instance && instance !== ctx.config.domain) continue;
    facet.value = `${handle}@${ctx.config.domain}`;
    const user = await getLocalUserByHandle(ctx, handle!);
    if (user) facet.userId = id(user.id);
  }
  return ctx.hooks.resolveMentions ? ctx.hooks.resolveMentions(facets) : facets;
}

export async function createPost(ctx: AppContext, authorId: string, body: CreatePostInput): Promise<Post> {
  const text = body.text.trim();
  const replyTo = body.replyToId ? await visiblePostRow(ctx, body.replyToId, authorId) : undefined;
  if (body.replyToId && !replyTo) throw notFound('The post you replied to');
  const quote = body.quoteId ? await visiblePostRow(ctx, body.quoteId, authorId) : undefined;
  if (body.quoteId && !quote) throw notFound('The quoted post');
  if (quote?.visibility === 'followers') throw badRequest("Followers-only posts can't be quoted.");

  const uploadIds = body.media.map((m) => m.id);
  const uploads = uploadIds.length
    ? await ctx.db
        .selectFrom('media_uploads')
        .innerJoin('media', 'media.hash', 'media_uploads.hash')
        .select(['media_uploads.id', 'media.hash', 'media.content_type', 'media.width', 'media.height'])
        .where('media_uploads.id', 'in', uploadIds)
        .where('media_uploads.user_id', '=', authorId)
        .execute()
    : [];
  if (uploads.length !== new Set(uploadIds).size)
    throw badRequest('One of those images has expired. Add it again.');

  const facets = await resolveFacets(ctx, text);
  const now = Date.now();
  const values: Insertable<PostsTable> = {
    id: ctx.nextId(),
    author_id: authorId,
    text,
    facets: JSON.stringify(facets),
    visibility: body.visibility,
    cw: body.cw || null,
    reply_to_id: replyTo ? id(replyTo.id) : null,
    root_id: replyTo ? (optId(replyTo.root_id) ?? id(replyTo.id)) : null,
    quote_id: quote ? id(quote.id) : null,
    reply_count: 0,
    repost_count: 0,
    like_count: 0,
    created_at: now,
    edited_at: null,
  };
  const row = values as PostRow;

  await ctx.db.transaction().execute(async (trx) => {
    await trx.insertInto('posts').values(values).execute();
    for (const [position, item] of body.media.entries()) {
      const upload = uploads.find((u) => id(u.id) === item.id)!;
      await trx
        .insertInto('post_media')
        .values({
          post_id: values.id,
          position,
          media_hash: upload.hash,
          remote_url: null,
          media_type: upload.content_type,
          alt: item.alt,
          width: num(upload.width),
          height: num(upload.height),
        })
        .execute();
    }
    if (uploadIds.length) await trx.deleteFrom('media_uploads').where('id', 'in', uploadIds).execute();
    if (replyTo) {
      await trx
        .updateTable('posts')
        .set({ reply_count: sql<number>`reply_count + 1` })
        .where('id', '=', replyTo.id)
        .execute();
    }
  });

  const notified = new Set<string>();
  const tell = async (userId: string, type: 'reply' | 'quote' | 'mention') => {
    if (notified.has(userId)) return;
    notified.add(userId);
    await notify(ctx, { userId, type, actorId: authorId, postId: id(row.id) });
  };
  if (replyTo) await tell(id(replyTo.author_id), 'reply');
  if (quote) await tell(id(quote.author_id), 'quote');
  for (const facet of facets) if (facet.userId) await tell(facet.userId, 'mention');

  const [post] = await serializePosts(ctx, [row], authorId);
  const created = { ...post!, nonce: body.nonce ?? null };
  await fanOut(ctx, row, created);
  await ctx.hooks.onPostCreated?.(row, { crosspost: body.crosspost });
  return created;
}

/**
 * Pushes a new post to its author and local followers. Replies only reach followers who also follow (or are)
 * the person being replied to, the same rule the home timeline uses.
 */
export async function fanOut(ctx: AppContext, row: PostRow, post: Post) {
  const authorId = id(row.author_id);
  const parentAuthor = row.reply_to_id
    ? (
        await ctx.db
          .selectFrom('posts')
          .select('author_id')
          .where('id', '=', row.reply_to_id)
          .executeTakeFirst()
      )?.author_id
    : undefined;
  const item = { id: post.id, post, repostedBy: null };
  for (const followerId of [authorId, ...(await localFollowerIds(ctx, authorId))]) {
    if (parentAuthor !== undefined && followerId !== authorId) {
      const parent = id(parentAuthor);
      if (followerId !== parent && !(await isFollowing(ctx, followerId, parent))) continue;
    }
    ctx.bus.publish(userTopic(followerId), { t: 'FEED_ITEM_CREATE', d: item });
  }
}

export async function deletePost(ctx: AppContext, postId: string, userId: string): Promise<void> {
  const row = await ctx.db.selectFrom('posts').selectAll().where('id', '=', postId).executeTakeFirst();
  if (!row) throw notFound('That post');
  if (id(row.author_id) !== userId) throw forbidden('You can only delete your own posts.');
  await removePost(ctx, row);
  await ctx.hooks.onPostDeleted?.(row);
}

/** Deletes a post row and tidies up after it. Also used when a remote server deletes one of its posts. */
export async function removePost(ctx: AppContext, row: PostRow): Promise<void> {
  const hashes = await ctx.db
    .selectFrom('post_media')
    .select('media_hash')
    .where('post_id', '=', row.id)
    .execute();
  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom('posts').where('id', '=', row.id).execute();
    if (row.reply_to_id) {
      await trx
        .updateTable('posts')
        .set({ reply_count: sql<number>`reply_count - 1` })
        .where('id', '=', row.reply_to_id)
        .where('reply_count', '>', 0)
        .execute();
    }
  });
  const authorId = id(row.author_id);
  for (const userId of [authorId, ...(await localFollowerIds(ctx, authorId))]) {
    ctx.bus.publish(userTopic(userId), { t: 'POST_DELETE', d: { id: id(row.id) } });
  }
  for (const { media_hash } of hashes) if (media_hash) await pruneImage(ctx, media_hash);
}

export async function getPost(ctx: AppContext, postId: string, viewerId: string | null): Promise<Post> {
  const row = await visiblePostRow(ctx, postId, viewerId);
  if (!row) throw notFound('That post');
  return (await serializePosts(ctx, [row], viewerId))[0]!;
}

/** Opens a post from its web or ActivityPub address, fetching it from its server if it's from elsewhere. */
export async function lookupPostByUrl(ctx: AppContext, url: string, viewerId: string | null): Promise<Post> {
  const origin = instanceOrigin(ctx.config.domain, ctx.config.devInsecure);
  if (url.startsWith(`${origin}/`)) {
    const local = /^\/(?:@[^/]+\/)?posts\/(\d{1,20})\/?$/.exec(new URL(url).pathname);
    if (local) return getPost(ctx, local[1]!, viewerId);
  }
  if (!/^https?:\/\//i.test(url)) throw badRequest('Paste a link to a post.');
  const postId = await ctx.hooks.lookupPost?.(url).catch(() => null);
  if (!postId) throw notFound('That post');
  return getPost(ctx, postId, viewerId);
}

export async function getThread(ctx: AppContext, postId: string, viewerId: string | null): Promise<Thread> {
  const row = await visiblePostRow(ctx, postId, viewerId);
  if (!row) throw notFound('That post');

  const ancestors: PostRow[] = [];
  let parentId = optId(row.reply_to_id);
  while (parentId && ancestors.length < 30) {
    const parent = await visiblePostRow(ctx, parentId, viewerId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = optId(parent.reply_to_id);
  }

  const replyRows = await ctx.db
    .selectFrom('posts')
    .selectAll()
    .where('reply_to_id', '=', row.id)
    .orderBy('id', 'asc')
    .limit(200)
    .execute();
  const replies: PostRow[] = [];
  for (const reply of replyRows) if (await canSee(ctx, reply, viewerId)) replies.push(reply);

  const posts = await serializePosts(ctx, [...ancestors, row, ...replies], viewerId);
  return {
    ancestors: posts.slice(0, ancestors.length),
    post: posts[ancestors.length]!,
    replies: posts.slice(ancestors.length + 1),
  };
}

/** Turns post rows into what `viewerId` sees, loading authors, media, quotes and their own likes in batches. */
export async function serializePosts(
  ctx: AppContext,
  rows: PostRow[],
  viewerId: string | null,
  { withQuotes = true } = {},
): Promise<Post[]> {
  if (rows.length === 0) return [];
  const postIds = rows.map((row) => id(row.id));

  const parentIds = rows.map((row) => optId(row.reply_to_id)).filter((v): v is string => v !== null);
  const parents = parentIds.length
    ? await ctx.db.selectFrom('posts').select(['id', 'author_id']).where('id', 'in', parentIds).execute()
    : [];
  const parentAuthor = new Map(parents.map((p) => [id(p.id), id(p.author_id)] as const));

  const users = await getUsers(ctx, [...rows.map((row) => id(row.author_id)), ...parentAuthor.values()]);

  const mediaRows = await ctx.db
    .selectFrom('post_media')
    .selectAll()
    .where('post_id', 'in', postIds)
    .orderBy('position')
    .execute();
  const media = new Map<string, PostMedia[]>();
  for (const m of mediaRows) {
    const list = media.get(id(m.post_id)) ?? [];
    list.push({
      url: m.media_hash ? mediaUrl(ctx, m.media_hash) : m.remote_url!,
      mediaType: m.media_type,
      alt: m.alt,
      width: optNum(m.width),
      height: optNum(m.height),
    });
    media.set(id(m.post_id), list);
  }

  const liked = new Set<string>();
  const reposted = new Set<string>();
  if (viewerId) {
    const [likes, reposts] = await Promise.all([
      ctx.db
        .selectFrom('likes')
        .select('post_id')
        .where('user_id', '=', viewerId)
        .where('post_id', 'in', postIds)
        .execute(),
      ctx.db
        .selectFrom('reposts')
        .select('post_id')
        .where('user_id', '=', viewerId)
        .where('post_id', 'in', postIds)
        .execute(),
    ]);
    for (const l of likes) liked.add(id(l.post_id));
    for (const r of reposts) reposted.add(id(r.post_id));
  }

  const quotes = new Map<string, Post>();
  if (withQuotes) {
    const quoteIds = rows.map((row) => optId(row.quote_id)).filter((v): v is string => v !== null);
    if (quoteIds.length) {
      const quoteRows = await ctx.db.selectFrom('posts').selectAll().where('id', 'in', quoteIds).execute();
      const visible: PostRow[] = [];
      for (const q of quoteRows) if (await canSee(ctx, q, viewerId)) visible.push(q);
      for (const post of await serializePosts(ctx, visible, viewerId, { withQuotes: false })) {
        quotes.set(post.id, post);
      }
    }
  }

  const result: Post[] = [];
  for (const row of rows) {
    const author = users.get(id(row.author_id));
    if (!author) continue;
    const postId = id(row.id);
    const replyToId = optId(row.reply_to_id);
    const replyToAuthorId = replyToId ? parentAuthor.get(replyToId) : undefined;
    result.push({
      id: postId,
      source: author.local ? 'jolt' : 'activitypub',
      author,
      text: row.text,
      facets: parseFacets(row.facets),
      media: media.get(postId) ?? [],
      cw: row.cw,
      visibility: row.visibility,
      url: ctx.hooks.postUrl ? ctx.hooks.postUrl(row, author) : postPageUrl(ctx, author, postId),
      createdAt: num(row.created_at),
      editedAt: optNum(row.edited_at),
      replyToId,
      rootId: optId(row.root_id),
      replyToAuthor: replyToAuthorId ? (users.get(replyToAuthorId) ?? null) : null,
      quote: row.quote_id ? (quotes.get(id(row.quote_id)) ?? null) : null,
      counts: { replies: num(row.reply_count), reposts: num(row.repost_count), likes: num(row.like_count) },
      viewer: { liked: liked.has(postId), reposted: reposted.has(postId) },
    });
  }
  return result;
}

export function postPageUrl(ctx: AppContext, author: User, postId: string): string | null {
  const profile = profileUrl(ctx, author);
  return profile ? `${profile}/posts/${postId}` : null;
}
