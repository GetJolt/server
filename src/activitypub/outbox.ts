// Sends what local users do out to other servers. The social core calls these hooks after it has done its own
// work, and delivery goes through Fedify's queue, so a slow or broken server never holds up a request here.

import {
  Announce,
  Article,
  Create,
  Delete,
  Follow,
  Like,
  Note,
  PUBLIC_COLLECTION,
  Tombstone,
  Undo,
  Update,
  type Recipient,
} from '@fedify/fedify/vocab';
import type { Facet } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { PostRow, UserRow } from '../db/schema.js';
import { flag, id } from '../db/values.js';
import { postPageUrl } from '../social/posts.js';
import { actorByUri, assertAllowed, ensureActor, instanceUrl, resolveAccount } from './actors.js';
import type { ActivityPub } from './federation.js';
import { storeRemoteNote } from './inbox.js';

const BACKFILL_EVERY_MS = 60 * 60 * 1000;

export function installOutbox(ap: ActivityPub, ctx: AppContext) {
  const userRow = (userId: string | bigint) =>
    ctx.db.selectFrom('users').selectAll().where('id', '=', String(userId)).executeTakeFirst();

  /** Delivery problems are logged, never thrown at the person who posted. */
  const quietly = (what: string, task: () => Promise<void>) =>
    task().catch((error) => ctx.log.warn({ err: error }, `ActivityPub: couldn't send ${what}`));

  /** Remote people a post should reach directly, on top of the author's followers. */
  async function directRecipients(row: PostRow): Promise<Recipient[]> {
    const ids = new Set<string>();
    for (const user of await ap.mentionedUsers(row)) ids.add(id(user.id));
    for (const related of [row.reply_to_id, row.quote_id]) {
      if (!related) continue;
      const post = await ctx.db
        .selectFrom('posts')
        .select('author_id')
        .where('id', '=', related)
        .executeTakeFirst();
      if (post) ids.add(id(post.author_id));
    }
    const recipients: Recipient[] = [];
    for (const userId of ids) {
      const user = await userRow(userId);
      const reachable = user ? await ensureActor(ctx, user).catch(() => null) : null;
      const recipient = reachable ? ap.recipientOf(reachable) : null;
      if (recipient) recipients.push(recipient);
    }
    return recipients;
  }

  async function sendToAudience(authorId: string, row: PostRow, activity: Create | Delete) {
    const c = ap.context();
    await c.sendActivity({ identifier: authorId }, 'followers', activity, { preferSharedInbox: true });
    const direct = await directRecipients(row);
    if (direct.length)
      await c.sendActivity({ identifier: authorId }, direct, activity, { preferSharedInbox: true });
  }

  async function remoteAuthor(post: PostRow): Promise<UserRow | null> {
    const author = await userRow(post.author_id);
    return author && !flag(author.is_local) ? ensureActor(ctx, author) : null;
  }

  const lastBackfill = new Map<string, number>();

  Object.assign(ctx.hooks, {
    postUrl: (row: PostRow, author) =>
      author.local ? postPageUrl(ctx, author, id(row.id)) : (row.ap_url ?? row.ap_id),

    profileUrl: async (user) => {
      if (user.local) return null;
      const row = await userRow(user.id);
      return row?.ap_url ?? row?.ap_id ?? null;
    },

    lookupPost: async (url: string) => {
      const target = new URL(url);
      assertAllowed(ctx, target);
      const object = await ap
        .context()
        .lookupObject(target)
        .catch(() => null);
      if (!(object instanceof Note || object instanceof Article) || !object.attributionId) return null;
      const author = await actorByUri(ctx, object.attributionId);
      if (!author) return null;
      const row = await storeRemoteNote(ap, ctx, object, author, { force: true });
      return row ? id(row.id) : null;
    },

    lookupActor: async (address: string) => {
      const row = await resolveAccount(ctx, address);
      return row ? id(row.id) : null;
    },

    resolveMentions: async (facets: Facet[]) => {
      for (const facet of facets) {
        if (facet.kind !== 'mention' || facet.userId) continue;
        const [, instance] = facet.value.split('@');
        if (!instance || instance === ctx.config.domain) continue;
        const row = await resolveAccount(ctx, facet.value).catch(() => null);
        if (row) facet.userId = id(row.id);
      }
      return facets;
    },

    beforeRemoteProfile: async (userId: string) => {
      const last = lastBackfill.get(userId) ?? 0;
      if (Date.now() - last < BACKFILL_EVERY_MS) return;
      lastBackfill.set(userId, Date.now());
      await backfill(userId).catch((error) => ctx.log.debug({ err: error }, 'ActivityPub: backfill failed'));
    },

    onPostCreated: (row: PostRow) =>
      quietly('a post', async () => {
        const author = await userRow(row.author_id);
        if (!author || !flag(author.is_local)) return;
        const c = ap.context();
        const note = await ap.note(c, row, author);
        const create = new Create({
          id: new URL(`${note.id!.href}#create`),
          actor: note.attributionId,
          tos: note.toIds,
          ccs: note.ccIds,
          published: note.published,
          object: note,
        });
        await sendToAudience(id(author.id), row, create);
      }),

    onPostDeleted: (row: PostRow) =>
      quietly('a deletion', async () => {
        const author = await userRow(row.author_id);
        if (!author || !flag(author.is_local)) return;
        const noteId = ap.noteUri(id(row.id));
        const del = new Delete({
          id: new URL(`${noteId.href}#delete`),
          actor: ap.actorUri(id(author.id)),
          tos: [PUBLIC_COLLECTION],
          object: new Tombstone({ id: noteId }),
        });
        await sendToAudience(id(author.id), row, del);
      }),

    onLike: (userId: string, post: PostRow) =>
      quietly('a like', async () => {
        const author = await remoteAuthor(post);
        const recipient = author ? ap.recipientOf(author) : null;
        if (!recipient) return;
        await ap.context().sendActivity({ identifier: userId }, recipient, likeOf(userId, post));
      }),

    onUnlike: (userId: string, post: PostRow) =>
      quietly('an unlike', async () => {
        const author = await remoteAuthor(post);
        const recipient = author ? ap.recipientOf(author) : null;
        if (!recipient) return;
        const like = likeOf(userId, post);
        await ap
          .context()
          .sendActivity(
            { identifier: userId },
            recipient,
            new Undo({ id: new URL(`${like.id!.href}/undo`), actor: ap.actorUri(userId), object: like }),
          );
      }),

    onRepost: (userId: string, repostId: string, post: PostRow) =>
      quietly('a repost', async () => {
        await sendAnnounce(userId, repostId, post, false);
      }),

    onUnrepost: (userId: string, repostId: string, post: PostRow) =>
      quietly('an undone repost', async () => {
        await sendAnnounce(userId, repostId, post, true);
      }),

    onRemoteFollow: (followerId: string, followeeId: string) =>
      quietly('a follow', async () => {
        const target = await userRow(followeeId);
        const actor = target ? await ensureActor(ctx, target) : null;
        const recipient = actor ? ap.recipientOf(actor) : null;
        if (!recipient) return;
        await ap
          .context()
          .sendActivity({ identifier: followerId }, recipient, followOf(followerId, followeeId, actor!));
      }),

    onRemoteUnfollow: (followerId: string, followeeId: string) =>
      quietly('an unfollow', async () => {
        const target = await userRow(followeeId);
        const recipient = target ? ap.recipientOf(target) : null;
        if (!recipient || !target) return;
        const follow = followOf(followerId, followeeId, target);
        await ap.context().sendActivity(
          { identifier: followerId },
          recipient,
          new Undo({
            id: new URL(`${follow.id!.href}/undo`),
            actor: ap.actorUri(followerId),
            object: follow,
          }),
        );
      }),

    onProfileUpdated: (userId: string) =>
      quietly('a profile update', async () => {
        const user = await userRow(userId);
        if (!user || !flag(user.is_local)) return;
        const c = ap.context();
        const person = await ap.person(c, user);
        const update = new Update({
          id: new URL(`${person.id!.href}#updates/${Date.now()}`),
          actor: person.id,
          tos: [PUBLIC_COLLECTION],
          ccs: [c.getFollowersUri(userId)],
          object: person,
        });
        await c.sendActivity({ identifier: userId }, 'followers', update, { preferSharedInbox: true });
      }),
  } satisfies AppContext['hooks']);

  function likeOf(userId: string, post: PostRow) {
    return new Like({
      id: new URL(`${ap.actorUri(userId).href}#likes/${id(post.id)}`),
      actor: ap.actorUri(userId),
      object: ap.postUri(post),
    });
  }

  function followOf(followerId: string, followeeId: string, target: UserRow) {
    return new Follow({
      id: new URL(`${ap.actorUri(followerId).href}#follows/${followeeId}`),
      actor: ap.actorUri(followerId),
      object: new URL(target.ap_id!),
    });
  }

  async function sendAnnounce(userId: string, repostId: string, post: PostRow, undo: boolean) {
    const c = ap.context();
    const author = await userRow(post.author_id);
    const authorRecipient = author && !flag(author.is_local) ? ap.recipientOf(author) : null;
    const announce = new Announce({
      id: new URL(`${instanceUrl(ctx)}/reposts/${repostId}`),
      actor: ap.actorUri(userId),
      object: ap.postUri(post),
      tos: [PUBLIC_COLLECTION],
      ccs: [
        c.getFollowersUri(userId),
        ...(author ? [ap.actorIdOf(author)].filter((u): u is URL => !!u) : []),
      ],
    });
    const activity = undo
      ? new Undo({ id: new URL(`${announce.id!.href}/undo`), actor: ap.actorUri(userId), object: announce })
      : announce;
    await c.sendActivity({ identifier: userId }, 'followers', activity, { preferSharedInbox: true });
    if (authorRecipient) await c.sendActivity({ identifier: userId }, authorRecipient, activity);
  }

  /** Pulls a remote account's recent public posts, so their profile isn't empty the first time you visit. */
  async function backfill(userId: string) {
    const user = await userRow(userId);
    const actorRow = user ? await ensureActor(ctx, user) : null;
    if (!actorRow?.ap_id) return;
    await actorByUri(ctx, new URL(actorRow.ap_id));
    const c = ap.context();
    const actor = await c.lookupObject(actorRow.ap_id).catch(() => null);
    const outbox =
      actor && 'getOutbox' in actor
        ? await (actor as { getOutbox(): Promise<unknown> }).getOutbox().catch(() => null)
        : null;
    if (!outbox) return;
    let seen = 0;
    for await (const item of c.traverseCollection(outbox as never, { suppressError: true })) {
      if (++seen > 20) break;
      if (!(item instanceof Create)) continue;
      const object = await item.getObject().catch(() => null);
      if (object && 'content' in object && object.attributionId?.href === actorRow.ap_id) {
        await storeRemoteNote(ap, ctx, object as never, actorRow, { force: true });
      }
    }
  }
}
