// What happens when another server sends us something: follows, likes, boosts, new posts, edits and deletions.
// Fedify has already checked the HTTP signature by the time a listener runs.

import {
  Accept,
  Announce,
  Article,
  Create,
  Delete,
  Follow,
  isActor,
  Like,
  Mention,
  Note,
  Reject,
  Undo,
  Update,
  type Object as APObject,
} from '@fedify/fedify/vocab';
import { normalizeInstance, type Facet, type PostVisibility } from '@getjolt/protocol';
import { sql, type Insertable } from 'kysely';
import type { AppContext } from '../context.js';
import type { PostRow, PostsTable, UserRow } from '../db/schema.js';
import { id, optId } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';
import { isDomainAllowed } from '../services/federation.js';
import { getUser } from '../services/users.js';
import { localFollowerIds, publishRelationship } from '../social/follows.js';
import { notify } from '../social/notifications.js';
import { fanOut, removePost, serializePosts } from '../social/posts.js';
import { actorByUri, upsertRemoteActor } from './actors.js';
import type { ActivityPub } from './federation.js';
import { htmlToRichText } from './html.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** Activities from blocked or non-allowlisted servers are dropped without a reply. */
function allowed(ctx: AppContext, actorId: URL | null): actorId is URL {
  return actorId !== null && isDomainAllowed(ctx, normalizeInstance(actorId.host));
}

async function senderRow(ctx: AppContext, activity: { actorId: URL | null }): Promise<UserRow | null> {
  if (!allowed(ctx, activity.actorId)) return null;
  return actorByUri(ctx, activity.actorId).catch(() => null);
}

/** Finds a post by its ActivityPub id, whether it's one of ours or one we stored from elsewhere. */
async function postByUri(ap: ActivityPub, ctx: AppContext, uri: URL | null): Promise<PostRow | undefined> {
  if (!uri) return undefined;
  const parsed = ap.context().parseUri(uri);
  if (parsed?.type === 'object' && parsed.class === Note) {
    const postId = parsed.values.id;
    if (postId && /^\d{1,20}$/.test(postId)) {
      return ctx.db.selectFrom('posts').selectAll().where('id', '=', postId).executeTakeFirst();
    }
  }
  return ctx.db.selectFrom('posts').selectAll().where('ap_id', '=', uri.href).executeTakeFirst();
}

const localUserId = (ap: ActivityPub, uri: URL | null): string | null => {
  const parsed = uri ? ap.context().parseUri(uri) : null;
  return parsed?.type === 'actor' && /^\d{1,20}$/.test(parsed.identifier) ? parsed.identifier : null;
};

/**
 * Our Follow activities are named `<actor>#follows/<followee id>`. Accepts and Rejects point back at that id, and
 * reading it directly is safer than dereferencing it: Fedify refetches cross-origin objects, and the fragment URL
 * would only fetch the actor document.
 */
function parseFollowId(ap: ActivityPub, uri: URL | null): { followerId: string; followeeId: string } | null {
  if (!uri) return null;
  const match = /^#follows\/(\d{1,20})$/.exec(uri.hash);
  const followerId = localUserId(ap, new URL(uri.href.slice(0, uri.href.length - uri.hash.length)));
  return match && followerId ? { followerId, followeeId: match[1]! } : null;
}

function visibilityOf(object: APObject): PostVisibility {
  if (object.toIds.some((u) => u.href === PUBLIC)) return 'public';
  if (object.ccIds.some((u) => u.href === PUBLIC)) return 'unlisted';
  return 'followers';
}

interface ParsedNote {
  text: string;
  facets: Facet[];
  cw: string | null;
  visibility: PostVisibility;
  media: Array<{ url: string; mediaType: string; alt: string; width: number | null; height: number | null }>;
}

/** Reads a Note's content into Jolt's text-and-facets form, tying mentions to users we know. */
async function parseNote(ap: ActivityPub, ctx: AppContext, note: Note | Article): Promise<ParsedNote> {
  const mentions = new Map<string, string>();
  for await (const tag of note.getTags({ suppressError: true })) {
    if (!(tag instanceof Mention)) continue;
    const href = tag.href;
    const name = String(tag.name ?? '').replace(/^@/, '');
    if (href) mentions.set(href.href, name.includes('@') ? name : `${name}@${href.host}`);
  }
  const html = String(note.content ?? '');
  const { text, facets } = htmlToRichText(html, (href) => mentions.get(href));

  for (const facet of facets) {
    if (facet.kind !== 'mention') continue;
    const href = [...mentions.entries()].find(([, address]) => address.toLowerCase() === facet.value)?.[0];
    if (!href) continue;
    const local = localUserId(ap, new URL(href));
    if (local) {
      facet.userId = local;
      continue;
    }
    const known = await ctx.db.selectFrom('users').select('id').where('ap_id', '=', href).executeTakeFirst();
    if (known) facet.userId = id(known.id);
  }

  const media: ParsedNote['media'] = [];
  for await (const attachment of note.getAttachments({ suppressError: true })) {
    const doc = attachment as unknown as {
      mediaType?: string | null;
      url?: URL | { href?: URL } | null;
      name?: unknown;
      width?: number | null;
      height?: number | null;
    };
    const url = doc.url instanceof URL ? doc.url : doc.url?.href;
    if (!url || !doc.mediaType?.startsWith('image/') || media.length >= 4) continue;
    media.push({
      url: url.href,
      mediaType: doc.mediaType,
      alt: String(doc.name ?? '').slice(0, 1500),
      width: doc.width ?? null,
      height: doc.height ?? null,
    });
  }

  return {
    text: text.slice(0, 5000),
    facets,
    cw: note.summary ? String(note.summary).slice(0, 200) : null,
    visibility: visibilityOf(note),
    media,
  };
}

/**
 * Stores a post from another server if anyone here has a reason to see it: they follow the author, it replies to
 * something we have, or it mentions them. Everything else is ignored rather than piling up.
 */
export async function storeRemoteNote(
  ap: ActivityPub,
  ctx: AppContext,
  note: Note | Article,
  author: UserRow,
  { force = false } = {},
): Promise<PostRow | undefined> {
  if (!note.id) return undefined;
  const existing = await postByUri(ap, ctx, note.id);
  if (existing) return existing;

  const parsed = await parseNote(ap, ctx, note);
  const parent = await postByUri(ap, ctx, note.replyTargetId);
  const quoted = await postByUri(ap, ctx, note.quoteUrl);
  const mentionedIds = parsed.facets.flatMap((f) => (f.userId ? [f.userId] : []));
  const mentionsLocal =
    mentionedIds.length > 0 &&
    (await ctx.db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', mentionedIds)
      .where('is_local', '=', 1)
      .executeTakeFirst()) !== undefined;
  const followed = (await localFollowerIds(ctx, id(author.id))).length > 0;
  if (!force && !followed && !parent && !mentionsLocal) return undefined;

  const published = note.published?.epochMilliseconds ?? Date.now();
  const values: Insertable<PostsTable> = {
    id: ctx.nextId(),
    author_id: id(author.id),
    text: parsed.text,
    facets: JSON.stringify(parsed.facets),
    visibility: parsed.visibility,
    cw: parsed.cw,
    reply_to_id: parent ? id(parent.id) : null,
    root_id: parent ? (optId(parent.root_id) ?? id(parent.id)) : null,
    quote_id: quoted ? id(quoted.id) : null,
    reply_count: 0,
    repost_count: 0,
    like_count: 0,
    created_at: Math.min(published, Date.now()),
    edited_at: null,
    ap_id: note.id.href,
    ap_url: note.url instanceof URL ? note.url.href : note.id.href,
  };
  const row = values as PostRow;

  try {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.insertInto('posts').values(values).execute();
      for (const [position, m] of parsed.media.entries()) {
        await trx
          .insertInto('post_media')
          .values({
            post_id: values.id,
            position,
            media_hash: null,
            remote_url: m.url,
            media_type: m.mediaType,
            alt: m.alt,
            width: m.width,
            height: m.height,
          })
          .execute();
      }
      if (parent) {
        await trx
          .updateTable('posts')
          .set({ reply_count: sql<number>`reply_count + 1` })
          .where('id', '=', parent.id)
          .execute();
      }
    });
  } catch {
    // Two deliveries of the same post raced; the other one stored it.
    return postByUri(ap, ctx, note.id);
  }

  const authorId = id(author.id);
  // notify() skips anyone who isn't a local account.
  if (parent)
    await notify(ctx, { userId: id(parent.author_id), type: 'reply', actorId: authorId, postId: id(row.id) });
  if (quoted)
    await notify(ctx, { userId: id(quoted.author_id), type: 'quote', actorId: authorId, postId: id(row.id) });
  for (const facet of parsed.facets) {
    if (facet.userId)
      await notify(ctx, { userId: facet.userId, type: 'mention', actorId: authorId, postId: id(row.id) });
  }

  const [post] = await serializePosts(ctx, [row], null);
  if (post) await fanOut(ctx, row, post);
  return row;
}

export function registerInbox(ap: ActivityPub, ctx: AppContext) {
  ap.federation
    .setInboxListeners('/users/{identifier}/inbox', '/inbox')
    .setSharedKeyDispatcher(() => ({ identifier: 'instance' }))
    .on(Follow, async (c, follow) => {
      const followeeId = localUserId(ap, follow.objectId);
      if (!follow.id || !followeeId) return;
      const actor = await follow.getActor();
      if (!actor || !isActor(actor) || !allowed(ctx, actor.id)) return;
      const follower = await upsertRemoteActor(ctx, actor);

      const inserted = await ctx.db
        .insertInto('follows')
        .values({
          follower_id: id(follower.id),
          followee_id: followeeId,
          state: 'following',
          created_at: Date.now(),
        })
        .onConflict((oc) => oc.columns(['follower_id', 'followee_id']).doUpdateSet({ state: 'following' }))
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) {
        await notify(ctx, { userId: followeeId, type: 'follow', actorId: id(follower.id) });
      }
      await c.sendActivity(
        { identifier: followeeId },
        actor,
        new Accept({
          id: new URL(`${c.getActorUri(followeeId).href}#accepts/${encodeURIComponent(follow.id.href)}`),
          actor: c.getActorUri(followeeId),
          object: follow,
        }),
      );
      await publishRelationship(ctx, followeeId, id(follower.id));
    })
    .on(Accept, async (_c, accept) => {
      const ours = parseFollowId(ap, accept.objectId);
      const followee = await senderRow(ctx, accept);
      if (!ours || !followee || id(followee.id) !== ours.followeeId) return;
      await ctx.db
        .updateTable('follows')
        .set({ state: 'following' })
        .where('follower_id', '=', ours.followerId)
        .where('followee_id', '=', ours.followeeId)
        .execute();
      await publishRelationship(ctx, ours.followerId, ours.followeeId);
    })
    .on(Reject, async (_c, reject) => {
      const ours = parseFollowId(ap, reject.objectId);
      const followee = await senderRow(ctx, reject);
      if (!ours || !followee || id(followee.id) !== ours.followeeId) return;
      await ctx.db
        .deleteFrom('follows')
        .where('follower_id', '=', ours.followerId)
        .where('followee_id', '=', ours.followeeId)
        .execute();
      await publishRelationship(ctx, ours.followerId, ours.followeeId);
    })
    .on(Undo, async (_c, undo) => {
      const sender = await senderRow(ctx, undo);
      const object = await undo.getObject().catch(() => null);
      if (!sender || !object) return;
      if (object instanceof Follow) {
        const followeeId = localUserId(ap, object.objectId);
        if (!followeeId) return;
        await ctx.db
          .deleteFrom('follows')
          .where('follower_id', '=', sender.id)
          .where('followee_id', '=', followeeId)
          .execute();
        await publishRelationship(ctx, followeeId, id(sender.id));
      } else if (object instanceof Like || object instanceof Announce) {
        const post = await postByUri(ap, ctx, object.objectId);
        if (!post) return;
        const table = object instanceof Like ? 'likes' : 'reposts';
        const removed = await ctx.db
          .deleteFrom(table)
          .where('user_id', '=', sender.id)
          .where('post_id', '=', post.id)
          .executeTakeFirst();
        if (Number(removed.numDeletedRows) > 0) {
          const column = object instanceof Like ? 'like_count' : 'repost_count';
          await ctx.db
            .updateTable('posts')
            .set({ [column]: sql<number>`${sql.ref(column)} - 1` })
            .where('id', '=', post.id)
            .where(column, '>', 0)
            .execute();
        }
      }
    })
    .on(Create, async (_c, create) => {
      const author = await senderRow(ctx, create);
      const object = await create.getObject().catch(() => null);
      if (!author || !(object instanceof Note || object instanceof Article)) return;
      // A server can only create posts for its own users.
      if (object.attributionId?.href !== author.ap_id) return;
      await storeRemoteNote(ap, ctx, object, author);
    })
    .on(Update, async (_c, update) => {
      const sender = await senderRow(ctx, update);
      const object = await update.getObject().catch(() => null);
      if (!sender || !object) return;
      if (isActor(object)) {
        if (object.id?.href === sender.ap_id) await upsertRemoteActor(ctx, object);
        return;
      }
      if (!(object instanceof Note || object instanceof Article)) return;
      const post = await postByUri(ap, ctx, object.id);
      if (!post || id(post.author_id) !== id(sender.id)) return;
      const parsed = await parseNote(ap, ctx, object);
      await ctx.db
        .updateTable('posts')
        .set({
          text: parsed.text,
          facets: JSON.stringify(parsed.facets),
          cw: parsed.cw,
          edited_at: Date.now(),
        })
        .where('id', '=', post.id)
        .execute();
      const updated = await ctx.db
        .selectFrom('posts')
        .selectAll()
        .where('id', '=', post.id)
        .executeTakeFirstOrThrow();
      for (const userId of await localFollowerIds(ctx, id(sender.id))) {
        const [serialized] = await serializePosts(ctx, [updated], userId);
        if (serialized) ctx.bus.publish(userTopic(userId), { t: 'POST_UPDATE', d: serialized });
      }
    })
    .on(Delete, async (_c, del) => {
      const sender = await senderRow(ctx, del);
      if (!sender) return;
      const post = await postByUri(ap, ctx, del.objectId);
      if (post && id(post.author_id) === id(sender.id)) await removePost(ctx, post);
    })
    .on(Like, async (_c, like) => {
      const sender = await senderRow(ctx, like);
      const post = await postByUri(ap, ctx, like.objectId);
      if (!sender || !post) return;
      const inserted = await ctx.db
        .insertInto('likes')
        .values({ user_id: id(sender.id), post_id: id(post.id), created_at: Date.now() })
        .onConflict((oc) => oc.columns(['user_id', 'post_id']).doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) return;
      await ctx.db
        .updateTable('posts')
        .set({ like_count: sql<number>`like_count + 1` })
        .where('id', '=', post.id)
        .execute();
      await notify(ctx, {
        userId: id(post.author_id),
        type: 'like',
        actorId: id(sender.id),
        postId: id(post.id),
      });
    })
    .on(Announce, async (_c, announce) => {
      const sender = await senderRow(ctx, announce);
      if (!sender || !announce.objectId) return;
      let post = await postByUri(ap, ctx, announce.objectId);
      if (!post) {
        // A boost of something we haven't seen: only worth fetching if someone here follows the booster.
        if ((await localFollowerIds(ctx, id(sender.id))).length === 0) return;
        const object = await announce.getObject().catch(() => null);
        if (!(object instanceof Note || object instanceof Article) || !object.attributionId) return;
        const author = await actorByUri(ctx, object.attributionId).catch(() => null);
        if (!author) return;
        post = await storeRemoteNote(ap, ctx, object, author, { force: true });
        if (!post) return;
      }
      if (post.visibility === 'followers') return;
      const repostId = ctx.nextId();
      const inserted = await ctx.db
        .insertInto('reposts')
        .values({ id: repostId, user_id: id(sender.id), post_id: id(post.id), created_at: Date.now() })
        .onConflict((oc) => oc.columns(['user_id', 'post_id']).doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0) return;
      await ctx.db
        .updateTable('posts')
        .set({ repost_count: sql<number>`repost_count + 1` })
        .where('id', '=', post.id)
        .execute();
      await notify(ctx, {
        userId: id(post.author_id),
        type: 'repost',
        actorId: id(sender.id),
        postId: id(post.id),
      });

      const reposter = await getUser(ctx, id(sender.id));
      for (const followerId of await localFollowerIds(ctx, id(sender.id))) {
        const [seen] = await serializePosts(ctx, [post], followerId);
        if (seen) {
          ctx.bus.publish(userTopic(followerId), {
            t: 'FEED_ITEM_CREATE',
            d: { id: repostId, post: seen, repostedBy: reposter },
          });
        }
      }
    })
    .onError((_c, error) => {
      ctx.log.warn({ err: error }, 'ActivityPub inbox error');
    });
}
