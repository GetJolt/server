// The ActivityPub side of an instance, built on Fedify: actor documents, collections, the inbox and delivery. It
// shares the database and the social code with the rest of the server, so a post made in the app and one that
// arrives from Mastodon are the same kind of row.

import { createFederation, type Context, type Federation } from '@fedify/fedify';
import {
  Application,
  Create,
  Document,
  Endpoints,
  Hashtag,
  Image,
  Mention,
  Note,
  Person,
  PropertyValue,
  PUBLIC_COLLECTION,
  type Recipient,
} from '@fedify/fedify/vocab';
import { createRequire } from 'node:module';
import type { Facet } from '@getjolt/protocol';
import { Temporal as Polyfill } from '@js-temporal/polyfill';
import type { AppContext } from '../context.js';
import type { PostRow, UserRow } from '../db/schema.js';
import { flag, id, num } from '../db/values.js';
import { getLocalUserByHandle } from '../services/users.js';
import { mediaUrl } from '../social/media.js';
import { instanceUrl } from './actors.js';
import { richTextToHtml } from './html.js';
import { registerInbox } from './inbox.js';
import { actorKeyPairs } from './keys.js';
import { KyselyKvStore, KyselyMessageQueue } from './store.js';

// Read at runtime so src/ and dist/ both find it.
const { version: SOFTWARE_VERSION } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};
const INSTANCE_ACTOR = 'instance';
const PAGE_SIZE = 20;

// Fedify runs on the Temporal polyfill but types itself against the built-in Temporal, so the two are bridged here.
const instant = (ms: number | bigint | string) =>
  Polyfill.Instant.fromEpochMilliseconds(num(ms)) as unknown as Temporal.Instant;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

export class ActivityPub {
  readonly federation: Federation<void>;
  private readonly kv: KyselyKvStore;
  private readonly stopping = new AbortController();
  private queueTask: Promise<void> | null = null;

  constructor(private readonly ctx: AppContext) {
    this.kv = new KyselyKvStore(ctx.db);
    this.federation = createFederation<void>({
      kv: this.kv,
      queue: new KyselyMessageQueue(ctx.db, ctx.config.devInsecure ? 200 : 1000),
      manuallyStartQueue: true,
      origin: instanceUrl(ctx),
      // Development instances talk to each other over localhost; everywhere else private addresses are refused.
      allowPrivateAddress: ctx.config.devInsecure,
      userAgent: { software: `Jolt/${SOFTWARE_VERSION}`, url: new URL(instanceUrl(ctx)) },
    });
    this.registerDispatchers();
    registerInbox(this, ctx);
  }

  context(): Context<void> {
    return this.federation.createContext(new URL(instanceUrl(this.ctx)), undefined);
  }

  start(): void {
    this.queueTask ??= this.federation
      .startQueue(undefined, { signal: this.stopping.signal })
      .catch((error) => {
        this.ctx.log.error(error, 'ActivityPub queue stopped');
      });
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.queueTask;
  }

  async purgeCache(): Promise<void> {
    await this.kv.purgeExpired();
  }

  actorUri(userId: string): URL {
    return this.context().getActorUri(userId);
  }

  noteUri(postId: string): URL {
    return this.context().getObjectUri(Note, { id: postId });
  }

  /** The ActivityPub id of any post we know, local or remote. */
  postUri(row: PostRow): URL | null {
    if (row.ap_id) return new URL(row.ap_id);
    return this.noteUri(id(row.id));
  }

  recipientOf(row: UserRow): Recipient | null {
    if (!row.ap_id || !row.ap_inbox) return null;
    return {
      id: new URL(row.ap_id),
      inboxId: new URL(row.ap_inbox),
      endpoints: row.ap_shared_inbox ? { sharedInbox: new URL(row.ap_shared_inbox) } : null,
    };
  }

  private async localUser(identifier: string): Promise<UserRow | undefined> {
    if (!/^\d{1,20}$/.test(identifier)) return undefined;
    const row = await this.ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', identifier)
      .executeTakeFirst();
    return row && flag(row.is_local) ? row : undefined;
  }

  /** The actor document for a local account. Also sent as `Update` when someone edits their profile. */
  async person(c: Context<void>, user: UserRow): Promise<Person> {
    const identifier = id(user.id);
    const keys = await c.getActorKeyPairs(identifier);
    const links = (await this.ctx.hooks.publicLinks?.(identifier)) ?? [];
    return new Person({
      id: c.getActorUri(identifier),
      preferredUsername: user.handle,
      name: user.display_name,
      summary: user.bio ? `<p>${escapeHtml(user.bio).replace(/\n/g, '<br>')}</p>` : null,
      url: new URL(`${instanceUrl(this.ctx)}/@${user.handle}`),
      icon: user.avatar_url ? new Image({ url: new URL(user.avatar_url) }) : null,
      inbox: c.getInboxUri(identifier),
      outbox: c.getOutboxUri(identifier),
      followers: c.getFollowersUri(identifier),
      following: c.getFollowingUri(identifier),
      endpoints: new Endpoints({ sharedInbox: c.getInboxUri() }),
      publicKey: keys[0]?.cryptographicKey,
      assertionMethods: keys.map((k) => k.multikey),
      discoverable: true,
      indexable: true,
      manuallyApprovesFollowers: false,
      published: instant(user.created_at),
      attachments: links.map(
        (link) =>
          new PropertyValue({
            name: link.provider === 'bluesky' ? 'Bluesky' : 'Mastodon',
            value: `<a href="${escapeHtml(link.url)}" rel="me nofollow noopener" target="_blank">${escapeHtml(link.handle)}</a>`,
          }),
      ),
    });
  }

  /** Who a post is addressed to, as Mastodon expects it for each visibility. */
  addressing(row: PostRow, followers: URL, mentioned: URL[]) {
    switch (row.visibility) {
      case 'public':
        return { tos: [PUBLIC_COLLECTION], ccs: [followers, ...mentioned] };
      case 'unlisted':
        return { tos: [followers], ccs: [PUBLIC_COLLECTION, ...mentioned] };
      default:
        return { tos: [followers], ccs: mentioned };
    }
  }

  /** The users a post mentions, for addressing and Mention tags. */
  async mentionedUsers(row: PostRow): Promise<UserRow[]> {
    const facets = JSON.parse(row.facets) as Facet[];
    const ids = [...new Set(facets.filter((f) => f.kind === 'mention' && f.userId).map((f) => f.userId!))];
    return ids.length ? this.ctx.db.selectFrom('users').selectAll().where('id', 'in', ids).execute() : [];
  }

  actorIdOf(user: UserRow): URL | null {
    if (flag(user.is_local)) return this.actorUri(id(user.id));
    return user.ap_id ? new URL(user.ap_id) : null;
  }

  async note(c: Context<void>, row: PostRow, author: UserRow): Promise<Note> {
    const postId = id(row.id);
    const mentioned = await this.mentionedUsers(row);
    const facets = JSON.parse(row.facets) as Facet[];
    const profileHref = (user: UserRow) =>
      flag(user.is_local) ? `${instanceUrl(this.ctx)}/@${user.handle}` : (user.ap_url ?? user.ap_id);

    const content = richTextToHtml(
      { text: row.text, facets },
      {
        mention: (facet) => {
          const user = mentioned.find((u) => id(u.id) === facet.userId);
          return user ? profileHref(user) : null;
        },
        tag: (tag) => `${instanceUrl(this.ctx)}/tags/${encodeURIComponent(tag)}`,
      },
    );

    const media = await this.ctx.db
      .selectFrom('post_media')
      .selectAll()
      .where('post_id', '=', row.id)
      .orderBy('position')
      .execute();
    const parent = row.reply_to_id
      ? await this.ctx.db.selectFrom('posts').selectAll().where('id', '=', row.reply_to_id).executeTakeFirst()
      : undefined;
    const quoted = row.quote_id
      ? await this.ctx.db.selectFrom('posts').selectAll().where('id', '=', row.quote_id).executeTakeFirst()
      : undefined;

    const mentionedIds = mentioned.map((u) => this.actorIdOf(u)).filter((u): u is URL => u !== null);
    const page = `${instanceUrl(this.ctx)}/@${author.handle}/posts/${postId}`;
    return new Note({
      id: this.noteUri(postId),
      attribution: c.getActorUri(id(author.id)),
      ...this.addressing(row, c.getFollowersUri(id(author.id)), mentionedIds),
      content,
      summary: row.cw,
      sensitive: Boolean(row.cw),
      published: instant(row.created_at),
      updated: row.edited_at ? instant(row.edited_at) : null,
      url: new URL(page),
      replyTarget: parent ? this.postUri(parent) : null,
      quoteUrl: quoted ? this.postUri(quoted) : null,
      tags: [
        ...mentioned.flatMap((u) => {
          const href = this.actorIdOf(u);
          return href ? [new Mention({ href, name: `@${u.handle}@${u.instance}` })] : [];
        }),
        ...facets
          .filter((f) => f.kind === 'tag')
          .map(
            (f) =>
              new Hashtag({
                href: new URL(`${instanceUrl(this.ctx)}/tags/${encodeURIComponent(f.value)}`),
                name: `#${f.value}`,
              }),
          ),
      ],
      attachments: media.map(
        (m) =>
          new Document({
            mediaType: m.media_type,
            url: new URL(m.media_hash ? mediaUrl(this.ctx, m.media_hash) : m.remote_url!),
            name: m.alt || null,
            width: m.width === null ? null : num(m.width),
            height: m.height === null ? null : num(m.height),
          }),
      ),
    });
  }

  private registerDispatchers() {
    const { ctx, federation } = this;

    federation
      .setActorDispatcher('/users/{identifier}', async (c, identifier) => {
        if (identifier === INSTANCE_ACTOR) {
          const keys = await c.getActorKeyPairs(identifier);
          return new Application({
            id: c.getActorUri(identifier),
            preferredUsername: ctx.config.domain,
            name: ctx.config.name,
            inbox: c.getInboxUri(identifier),
            outbox: c.getOutboxUri(identifier),
            endpoints: new Endpoints({ sharedInbox: c.getInboxUri() }),
            publicKey: keys[0]?.cryptographicKey,
            assertionMethods: keys.map((k) => k.multikey),
            manuallyApprovesFollowers: true,
          });
        }
        const user = await this.localUser(identifier);
        return user ? this.person(c, user) : null;
      })
      .setKeyPairsDispatcher((_c, identifier) =>
        actorKeyPairs(ctx.db, identifier === INSTANCE_ACTOR ? INSTANCE_ACTOR : `user:${identifier}`),
      )
      .mapHandle(async (_c, username) => {
        if (username === ctx.config.domain) return INSTANCE_ACTOR;
        const user = await getLocalUserByHandle(ctx, username.toLowerCase());
        return user ? id(user.id) : null;
      });

    federation
      .setFollowersDispatcher('/users/{identifier}/followers', async (_c, identifier) => {
        if (!(await this.localUser(identifier))) return null;
        const rows = await ctx.db
          .selectFrom('follows')
          .innerJoin('users', 'users.id', 'follows.follower_id')
          .selectAll('users')
          .where('follows.followee_id', '=', identifier)
          .where('follows.state', '=', 'following')
          .where('users.is_local', '=', 0)
          .execute();
        return { items: rows.map((r) => this.recipientOf(r)).filter((r): r is Recipient => r !== null) };
      })
      .setCounter(async (_c, identifier) => this.countFollows('followee_id', identifier));

    federation
      .setFollowingDispatcher('/users/{identifier}/following', async (_c, identifier) => {
        if (!(await this.localUser(identifier))) return null;
        const rows = await ctx.db
          .selectFrom('follows')
          .innerJoin('users', 'users.id', 'follows.followee_id')
          .selectAll('users')
          .where('follows.follower_id', '=', identifier)
          .where('follows.state', '=', 'following')
          .execute();
        return { items: rows.map((r) => this.actorIdOf(r)).filter((u): u is URL => u !== null) };
      })
      .setCounter(async (_c, identifier) => this.countFollows('follower_id', identifier));

    federation
      .setOutboxDispatcher('/users/{identifier}/outbox', async (c, identifier, cursor) => {
        const user = await this.localUser(identifier);
        if (!user) return null;
        let query = ctx.db
          .selectFrom('posts')
          .selectAll()
          .where('author_id', '=', identifier)
          .where('visibility', '!=', 'followers');
        if (cursor) query = query.where('id', '<', cursor);
        const rows = await query.orderBy('id', 'desc').limit(PAGE_SIZE).execute();
        const items = await Promise.all(
          rows.map(async (row) => {
            const note = await this.note(c, row, user);
            return new Create({
              id: new URL(`${note.id!.href}#create`),
              actor: note.attributionId,
              tos: note.toIds,
              ccs: note.ccIds,
              published: note.published,
              object: note,
            });
          }),
        );
        return { items, nextCursor: rows.length === PAGE_SIZE ? id(rows.at(-1)!.id) : null };
      })
      .setFirstCursor(() => '')
      .setCounter(async (_c, identifier) => {
        const row = await ctx.db
          .selectFrom('posts')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('author_id', '=', identifier)
          .where('visibility', '!=', 'followers')
          .executeTakeFirstOrThrow();
        return num(row.n);
      });

    federation.setObjectDispatcher(Note, '/posts/{id}', async (c, values) => {
      if (!/^\d{1,20}$/.test(values.id)) return null;
      const row = await ctx.db.selectFrom('posts').selectAll().where('id', '=', values.id).executeTakeFirst();
      // Followers-only posts are delivered to followers directly and never served to anonymous fetches.
      if (!row || row.ap_id || row.visibility === 'followers') return null;
      const author = await this.localUser(id(row.author_id));
      return author ? this.note(c, row, author) : null;
    });

    federation.setNodeInfoDispatcher('/nodeinfo/2.1', async () => {
      const users = await ctx.db
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('is_local', '=', 1)
        .executeTakeFirstOrThrow();
      const posts = await ctx.db
        .selectFrom('posts')
        .innerJoin('users', 'users.id', 'posts.author_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('users.is_local', '=', 1)
        .executeTakeFirstOrThrow();
      return {
        software: {
          name: 'jolt',
          version: SOFTWARE_VERSION,
          homepage: new URL('https://joltapp.org'),
          repository: new URL('https://github.com/GetJolt/server'),
        },
        protocols: ['activitypub'],
        openRegistrations: ctx.config.registration === 'open',
        usage: { users: { total: num(users.n) }, localPosts: num(posts.n), localComments: 0 },
      };
    });
  }

  private async countFollows(column: 'follower_id' | 'followee_id', userId: string) {
    const row = await this.ctx.db
      .selectFrom('follows')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where(column, '=', userId)
      .where('state', '=', 'following')
      .executeTakeFirstOrThrow();
    return num(row.n);
  }
}

export { INSTANCE_ACTOR };
