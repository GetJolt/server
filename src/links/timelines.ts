// Reading a linked account's Bluesky or Mastodon world inside Jolt: its home timeline, threads with their replies,
// and other people's profiles, plus liking, reposting, replying and following as that account. Everything is
// converted to the same shapes Jolt uses for its own posts and profiles.
//
// Ids carry the link they were read through, so later requests go back to the right account:
//   posts  `bsky:<link>:<cid>:<uri>`  or  `masto:<link>:<status id>`
//   people `bsky:<link>:<did>`        or  `masto:<link>:<account id>`

import { RichText, type Agent, type AppBskyFeedDefs } from '@atproto/api';
import {
  utf8ToUtf16Offset,
  type Facet,
  type Post,
  type PostMedia,
  type Profile,
  type Relationship,
  type Thread,
  type TimelineItem,
  type TimelinePage,
  type User,
} from '@getjolt/protocol';
import { htmlToRichText } from '../activitypub/html.js';
import type { AppContext } from '../context.js';
import type { LinkedAccountRow } from '../db/schema.js';
import { id } from '../db/values.js';
import { badRequest } from '../http/errors.js';
import { openSecret } from './accounts.js';
import { blueskyAgent } from './bluesky.js';
import { mastodonFetch, type MastodonToken } from './mastodon.js';

export type LinkAction = 'like' | 'unlike' | 'repost' | 'unrepost';
export type ProfileFilter = 'posts' | 'replies' | 'media';

const PAGE = 30;

function externalUser(
  idValue: string,
  handle: string,
  instance: string,
  name: string | undefined,
  avatar: string | undefined,
  bio = '',
): User {
  return {
    id: idValue,
    handle,
    instance,
    displayName: name || handle,
    avatarUrl: avatar || null,
    bio,
    local: false,
  };
}

function basePost(partial: Partial<Post> & Pick<Post, 'id' | 'source' | 'author' | 'text' | 'facets'>): Post {
  return {
    media: [],
    cw: null,
    visibility: 'public',
    url: null,
    createdAt: Date.now(),
    editedAt: null,
    replyToId: null,
    rootId: null,
    replyToAuthor: null,
    quote: null,
    counts: { replies: 0, reposts: 0, likes: 0 },
    viewer: { liked: false, reposted: false },
    ...partial,
  };
}

const relationship = (
  userId: string,
  following: boolean,
  pending: boolean,
  followedBy: boolean,
): Relationship => ({
  userId,
  following: following ? 'following' : pending ? 'pending' : 'none',
  followedBy,
});

// --- Bluesky -------------------------------------------------------------------------------------------------

type BskyPostView = AppBskyFeedDefs.PostView;
type BskyAuthor = BskyPostView['author'];

const bskyUser = (linkId: string, author: BskyAuthor) =>
  externalUser(`bsky:${linkId}:${author.did}`, author.handle, 'bsky.app', author.displayName, author.avatar);

function bskyFacets(linkId: string, text: string, facets: unknown): Facet[] {
  const result: Facet[] = [];
  for (const facet of (facets as Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<Record<string, string>>;
  }>) ?? []) {
    const start = utf8ToUtf16Offset(text, facet.index.byteStart);
    const end = utf8ToUtf16Offset(text, facet.index.byteEnd);
    for (const feature of facet.features ?? []) {
      if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
        result.push({ start, end, kind: 'link', value: feature.uri });
      } else if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
        result.push({ start, end, kind: 'tag', value: feature.tag });
      } else if (feature.$type === 'app.bsky.richtext.facet#mention') {
        const userId = feature.did ? `bsky:${linkId}:${feature.did}` : undefined;
        result.push({ start, end, kind: 'mention', value: text.slice(start + 1, end), userId });
      }
    }
  }
  return result;
}

function bskyMedia(embed: unknown): PostMedia[] {
  const view = embed as {
    $type?: string;
    images?: Array<{ fullsize: string; alt: string; aspectRatio?: { width: number; height: number } }>;
    media?: unknown;
  };
  if (view?.$type === 'app.bsky.embed.recordWithMedia#view') return bskyMedia(view.media);
  if (view?.$type !== 'app.bsky.embed.images#view') return [];
  return (view.images ?? []).map((img) => ({
    url: img.fullsize,
    mediaType: 'image/jpeg',
    alt: img.alt ?? '',
    width: img.aspectRatio?.width ?? null,
    height: img.aspectRatio?.height ?? null,
  }));
}

function bskyPost(linkId: string, view: BskyPostView, replyParent?: BskyAuthor): Post {
  const record = view.record as { text?: string; facets?: unknown; createdAt?: string };
  const text = record.text ?? '';
  const rkey = view.uri.split('/').pop();
  const embed = view.embed as
    | {
        $type?: string;
        record?: {
          $type?: string;
          uri?: string;
          cid?: string;
          author?: BskyAuthor;
          value?: { text?: string };
        };
        media?: unknown;
      }
    | undefined;
  const quoted = embed?.$type === 'app.bsky.embed.record#view' ? embed.record : undefined;
  return basePost({
    id: `bsky:${linkId}:${view.cid}:${view.uri}`,
    source: 'bluesky',
    author: bskyUser(linkId, view.author),
    text,
    facets: bskyFacets(linkId, text, record.facets),
    media: bskyMedia(view.embed),
    url: `https://bsky.app/profile/${view.author.handle}/post/${rkey}`,
    createdAt: Date.parse(record.createdAt ?? view.indexedAt) || Date.now(),
    replyToAuthor: replyParent ? bskyUser(linkId, replyParent) : null,
    quote:
      quoted?.$type === 'app.bsky.embed.record#viewRecord' && quoted.author && quoted.uri && quoted.cid
        ? basePost({
            id: `bsky:${linkId}:${quoted.cid}:${quoted.uri}`,
            source: 'bluesky',
            author: bskyUser(linkId, quoted.author),
            text: quoted.value?.text ?? '',
            facets: [],
            url: `https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}`,
          })
        : null,
    counts: { replies: view.replyCount ?? 0, reposts: view.repostCount ?? 0, likes: view.likeCount ?? 0 },
    viewer: { liked: Boolean(view.viewer?.like), reposted: Boolean(view.viewer?.repost) },
  });
}

/** One entry of a Bluesky feed (home or someone's profile), with reposts credited to whoever reposted. */
function bskyItem(linkId: string, item: AppBskyFeedDefs.FeedViewPost): TimelineItem {
  const reason = item.reason as { $type?: string; by?: BskyAuthor } | undefined;
  const parent = (item.reply?.parent as { author?: BskyAuthor } | undefined)?.author;
  const post = bskyPost(linkId, item.post, parent);
  const repostedBy =
    reason?.$type === 'app.bsky.feed.defs#reasonRepost' && reason.by ? bskyUser(linkId, reason.by) : null;
  return { id: repostedBy ? `${post.id}:by:${repostedBy.id}` : post.id, post, repostedBy };
}

function parseBskyId(postId: string) {
  const match = /^bsky:(\d+):([^:]+):(at:\/\/.+)$/.exec(postId);
  if (!match) throw badRequest("That isn't a Bluesky post.");
  return { linkId: match[1]!, cid: match[2]!, uri: match[3]! };
}

async function bskyFresh(agent: Agent, uri: string): Promise<BskyPostView> {
  const { data } = await agent.getPosts({ uris: [uri] });
  const post = data.posts[0];
  if (!post) throw badRequest('That post is gone.');
  return post;
}

async function bskyThread(ctx: AppContext, link: LinkedAccountRow, postId: string): Promise<Thread> {
  const linkId = id(link.id);
  const { uri } = parseBskyId(postId);
  const agent = await blueskyAgent(ctx, link);
  const { data } = await agent.getPostThread({ uri, depth: 1, parentHeight: 20 });
  type Node = { $type?: string; post?: BskyPostView; parent?: Node; replies?: Node[] };
  const root = data.thread as Node;
  if (root.$type !== 'app.bsky.feed.defs#threadViewPost' || !root.post)
    throw badRequest('That post is gone.');

  const chain: BskyPostView[] = [];
  for (
    let node = root.parent;
    node?.$type === 'app.bsky.feed.defs#threadViewPost' && node.post;
    node = node.parent
  ) {
    chain.unshift(node.post);
  }
  const ancestors = chain.map((p, i) => bskyPost(linkId, p, chain[i - 1]?.author));
  const replies = (root.replies ?? [])
    .filter((r) => r.$type === 'app.bsky.feed.defs#threadViewPost' && r.post)
    .map((r) => bskyPost(linkId, r.post!, root.post!.author));
  return { ancestors, post: bskyPost(linkId, root.post, chain.at(-1)?.author), replies };
}

async function bskyProfile(ctx: AppContext, link: LinkedAccountRow, did: string): Promise<Profile> {
  const linkId = id(link.id);
  const agent = await blueskyAgent(ctx, link);
  const { data } = await agent.getProfile({ actor: did });
  const user = externalUser(
    `bsky:${linkId}:${data.did}`,
    data.handle,
    'bsky.app',
    data.displayName,
    data.avatar,
    data.description ?? '',
  );
  const self = data.did === link.external_id;
  return {
    user,
    counts: {
      followers: data.followersCount ?? 0,
      following: data.followsCount ?? 0,
      posts: data.postsCount ?? 0,
    },
    links: [],
    relationship: self
      ? null
      : relationship(user.id, Boolean(data.viewer?.following), false, Boolean(data.viewer?.followedBy)),
    url: `https://bsky.app/profile/${data.handle}`,
  };
}

async function bskyProfilePosts(
  ctx: AppContext,
  link: LinkedAccountRow,
  did: string,
  filter: ProfileFilter,
  cursor?: string,
): Promise<TimelinePage> {
  const agent = await blueskyAgent(ctx, link);
  const bskyFilter = { posts: 'posts_no_replies', replies: 'posts_with_replies', media: 'posts_with_media' }[
    filter
  ];
  const { data } = await agent.getAuthorFeed({ actor: did, limit: PAGE, cursor, filter: bskyFilter });
  const linkId = id(link.id);
  return { items: data.feed.map((item) => bskyItem(linkId, item)), cursor: data.cursor ?? null };
}

async function bskyFollow(ctx: AppContext, link: LinkedAccountRow, did: string, follow: boolean) {
  const agent = await blueskyAgent(ctx, link);
  if (follow) {
    await agent.follow(did);
  } else {
    const { data } = await agent.getProfile({ actor: did });
    if (data.viewer?.following) await agent.deleteFollow(data.viewer.following);
  }
  return (await bskyProfile(ctx, link, did)).relationship!;
}

// --- Mastodon ------------------------------------------------------------------------------------------------

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  url: string;
  note?: string;
  followers_count?: number;
  following_count?: number;
  statuses_count?: number;
}

interface MastodonStatus {
  id: string;
  url: string | null;
  uri: string;
  created_at: string;
  content: string;
  spoiler_text: string;
  visibility: string;
  account: MastodonAccount;
  reblog: MastodonStatus | null;
  in_reply_to_id?: string | null;
  in_reply_to_account_id: string | null;
  replies_count: number;
  reblogs_count: number;
  favourites_count: number;
  favourited?: boolean;
  reblogged?: boolean;
  mentions: Array<{ id: string; url: string; acct: string; username: string }>;
  media_attachments: Array<{
    type: string;
    url: string;
    description: string | null;
    meta?: { original?: { width?: number; height?: number } };
  }>;
}

interface MastodonRelationship {
  id: string;
  following: boolean;
  requested: boolean;
  followed_by: boolean;
}

function mastodonUser(linkId: string, domain: string, account: MastodonAccount): User {
  const [handle, host] = account.acct.includes('@') ? account.acct.split('@') : [account.acct, domain];
  return externalUser(
    `masto:${linkId}:${account.id}`,
    handle!,
    host!,
    account.display_name,
    account.avatar,
    account.note ? htmlToRichText(account.note).text : '',
  );
}

function mastodonPost(linkId: string, domain: string, status: MastodonStatus): Post {
  const mentions = status.mentions ?? [];
  const address = (m: (typeof mentions)[number]) => (m.acct.includes('@') ? m.acct : `${m.acct}@${domain}`);
  const byUrl = new Map(mentions.map((m) => [m.url, address(m)]));
  const { text, facets } = htmlToRichText(status.content, (href) => byUrl.get(href));
  // Mentions open the person's profile here, through the same linked account.
  for (const facet of facets) {
    const mention =
      facet.kind === 'mention' ? mentions.find((m) => address(m).toLowerCase() === facet.value) : null;
    if (mention) facet.userId = `masto:${linkId}:${mention.id}`;
  }
  const replyMention = mentions.find((m) => m.id === status.in_reply_to_account_id);
  return basePost({
    id: `masto:${linkId}:${status.id}`,
    source: 'mastodon',
    author: mastodonUser(linkId, domain, status.account),
    text,
    facets,
    cw: status.spoiler_text || null,
    visibility:
      status.visibility === 'unlisted' ? 'unlisted' : status.visibility === 'public' ? 'public' : 'followers',
    media: (status.media_attachments ?? [])
      .filter((m) => m.type === 'image' || m.type === 'gifv')
      .map((m) => ({
        url: m.url,
        mediaType: 'image/jpeg',
        alt: m.description ?? '',
        width: m.meta?.original?.width ?? null,
        height: m.meta?.original?.height ?? null,
      })),
    url: status.url ?? status.uri,
    createdAt: Date.parse(status.created_at) || Date.now(),
    replyToId: status.in_reply_to_id ? `masto:${linkId}:${status.in_reply_to_id}` : null,
    replyToAuthor: replyMention
      ? externalUser(
          `masto:${linkId}:${replyMention.id}`,
          replyMention.username,
          replyMention.acct.split('@')[1] ?? domain,
          replyMention.username,
          undefined,
        )
      : null,
    counts: { replies: status.replies_count, reposts: status.reblogs_count, likes: status.favourites_count },
    viewer: { liked: Boolean(status.favourited), reposted: Boolean(status.reblogged) },
  });
}

const mastodonItem = (linkId: string, domain: string, status: MastodonStatus): TimelineItem => ({
  id: `masto:${linkId}:${status.id}`,
  post: mastodonPost(linkId, domain, status.reblog ?? status),
  repostedBy: status.reblog ? mastodonUser(linkId, domain, status.account) : null,
});

async function mastodonJson<T>(
  ctx: AppContext,
  link: LinkedAccountRow,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { domain, token } = openSecret<MastodonToken>(ctx, link);
  const res = await mastodonFetch(ctx, domain, path, { ...init, token });
  if (!res.ok) throw badRequest(`${domain} said no (${res.status}).`);
  return (await res.json()) as T;
}

function parseMastodonId(postId: string) {
  const match = /^masto:(\d+):([\w-]+)$/.exec(postId);
  if (!match) throw badRequest("That isn't a Mastodon post.");
  return { linkId: match[1]!, statusId: match[2]! };
}

async function mastodonPage(
  ctx: AppContext,
  link: LinkedAccountRow,
  path: string,
  params: Record<string, string>,
  cursor?: string,
): Promise<TimelinePage> {
  const { domain } = openSecret<MastodonToken>(ctx, link);
  const query = new URLSearchParams({ limit: String(PAGE), ...params });
  if (cursor) query.set('max_id', cursor);
  const statuses = await mastodonJson<MastodonStatus[]>(ctx, link, `${path}?${query}`);
  const linkId = id(link.id);
  return {
    items: statuses.map((status) => mastodonItem(linkId, domain, status)),
    cursor: statuses.length === PAGE ? statuses.at(-1)!.id : null,
  };
}

async function mastodonThread(ctx: AppContext, link: LinkedAccountRow, postId: string): Promise<Thread> {
  const linkId = id(link.id);
  const { statusId } = parseMastodonId(postId);
  const { domain } = openSecret<MastodonToken>(ctx, link);
  const path = `/api/v1/statuses/${encodeURIComponent(statusId)}`;
  const [status, context] = await Promise.all([
    mastodonJson<MastodonStatus>(ctx, link, path),
    mastodonJson<{ ancestors: MastodonStatus[]; descendants: MastodonStatus[] }>(
      ctx,
      link,
      `${path}/context`,
    ),
  ]);
  // Direct replies only, like Jolt threads; opening one of them shows the conversation below it.
  return {
    ancestors: context.ancestors.map((s) => mastodonPost(linkId, domain, s)),
    post: mastodonPost(linkId, domain, status),
    replies: context.descendants
      .filter((s) => s.in_reply_to_id === statusId)
      .map((s) => mastodonPost(linkId, domain, s)),
  };
}

async function mastodonProfile(ctx: AppContext, link: LinkedAccountRow, accountId: string): Promise<Profile> {
  const linkId = id(link.id);
  const { domain, accountId: self } = openSecret<MastodonToken>(ctx, link);
  const account = await mastodonJson<MastodonAccount>(
    ctx,
    link,
    `/api/v1/accounts/${encodeURIComponent(accountId)}`,
  );
  const user = mastodonUser(linkId, domain, account);
  let rel: Relationship | null = null;
  if (account.id !== self) {
    const [r] = await mastodonJson<MastodonRelationship[]>(
      ctx,
      link,
      `/api/v1/accounts/relationships?id[]=${encodeURIComponent(account.id)}`,
    ).catch(() => []);
    rel = relationship(user.id, Boolean(r?.following), Boolean(r?.requested), Boolean(r?.followed_by));
  }
  return {
    user,
    counts: {
      followers: account.followers_count ?? 0,
      following: account.following_count ?? 0,
      posts: account.statuses_count ?? 0,
    },
    links: [],
    relationship: rel,
    url: account.url,
  };
}

function mastodonProfilePosts(
  ctx: AppContext,
  link: LinkedAccountRow,
  accountId: string,
  filter: ProfileFilter,
  cursor?: string,
) {
  const params: Record<string, string> =
    filter === 'posts' ? { exclude_replies: 'true' } : filter === 'media' ? { only_media: 'true' } : {};
  return mastodonPage(
    ctx,
    link,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses`,
    params,
    cursor,
  );
}

async function mastodonFollow(ctx: AppContext, link: LinkedAccountRow, accountId: string, follow: boolean) {
  const r = await mastodonJson<MastodonRelationship>(
    ctx,
    link,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/${follow ? 'follow' : 'unfollow'}`,
    { method: 'POST' },
  );
  return relationship(`masto:${id(link.id)}:${accountId}`, r.following, r.requested, r.followed_by);
}

// --- Shared --------------------------------------------------------------------------------------------------

/** Splits an external person's id and checks it belongs to this linked account. */
function actorOf(link: LinkedAccountRow, userId: string): string {
  const match = /^(bsky|masto):(\d+):(.+)$/.exec(userId);
  const provider = match?.[1] === 'bsky' ? 'bluesky' : 'mastodon';
  if (!match || match[2] !== id(link.id) || provider !== link.provider) {
    throw badRequest('That person was found through a different linked account.');
  }
  return match[3]!;
}

export function linkTimeline(
  ctx: AppContext,
  link: LinkedAccountRow,
  cursor?: string,
): Promise<TimelinePage> {
  return link.provider === 'bluesky'
    ? blueskyAgent(ctx, link).then(async (agent) => {
        const { data } = await agent.getTimeline({ limit: PAGE, cursor });
        return { items: data.feed.map((item) => bskyItem(id(link.id), item)), cursor: data.cursor ?? null };
      })
    : mastodonPage(ctx, link, '/api/v1/timelines/home', {}, cursor);
}

/** A post with the posts above it and its direct replies, read from the other network. */
export function linkThread(ctx: AppContext, link: LinkedAccountRow, postId: string): Promise<Thread> {
  return link.provider === 'bluesky' ? bskyThread(ctx, link, postId) : mastodonThread(ctx, link, postId);
}

export function linkProfile(ctx: AppContext, link: LinkedAccountRow, userId: string): Promise<Profile> {
  const actor = actorOf(link, userId);
  return link.provider === 'bluesky' ? bskyProfile(ctx, link, actor) : mastodonProfile(ctx, link, actor);
}

export function linkProfilePosts(
  ctx: AppContext,
  link: LinkedAccountRow,
  userId: string,
  filter: ProfileFilter,
  cursor?: string,
): Promise<TimelinePage> {
  const actor = actorOf(link, userId);
  return link.provider === 'bluesky'
    ? bskyProfilePosts(ctx, link, actor, filter, cursor)
    : mastodonProfilePosts(ctx, link, actor, filter, cursor);
}

/** Follows or unfollows someone on the other network, as the linked account. */
export function linkFollow(
  ctx: AppContext,
  link: LinkedAccountRow,
  userId: string,
  follow: boolean,
): Promise<Relationship> {
  const actor = actorOf(link, userId);
  return link.provider === 'bluesky'
    ? bskyFollow(ctx, link, actor, follow)
    : mastodonFollow(ctx, link, actor, follow);
}

/** Likes, reposts or undoes either on the other network, and returns the post as it now stands. */
export async function linkAction(
  ctx: AppContext,
  link: LinkedAccountRow,
  postId: string,
  action: LinkAction,
): Promise<Post> {
  const linkId = id(link.id);
  if (link.provider === 'bluesky') {
    const { uri, cid, linkId: owner } = parseBskyId(postId);
    if (owner !== linkId) throw badRequest('That post belongs to a different linked account.');
    const agent = await blueskyAgent(ctx, link);
    if (action === 'like') await agent.like(uri, cid);
    if (action === 'repost') await agent.repost(uri, cid);
    if (action === 'unlike' || action === 'unrepost') {
      const view = await bskyFresh(agent, uri);
      const record = action === 'unlike' ? view.viewer?.like : view.viewer?.repost;
      if (record) await (action === 'unlike' ? agent.deleteLike(record) : agent.deleteRepost(record));
    }
    return bskyPost(linkId, await bskyFresh(agent, uri));
  }

  const { statusId, linkId: owner } = parseMastodonId(postId);
  if (owner !== linkId) throw badRequest('That post belongs to a different linked account.');
  const verb = { like: 'favourite', unlike: 'unfavourite', repost: 'reblog', unrepost: 'unreblog' }[action];
  const { domain } = openSecret<MastodonToken>(ctx, link);
  const status = await mastodonJson<MastodonStatus>(
    ctx,
    link,
    `/api/v1/statuses/${encodeURIComponent(statusId)}/${verb}`,
    { method: 'POST' },
  );
  // Reblogging returns the wrapper status; the post itself is inside it.
  return mastodonPost(linkId, domain, action === 'repost' && status.reblog ? status.reblog : status);
}

/** Replies on the other network, as the linked account. */
export async function linkReply(
  ctx: AppContext,
  link: LinkedAccountRow,
  postId: string,
  text: string,
): Promise<Post> {
  const linkId = id(link.id);
  if (link.provider === 'bluesky') {
    const { uri, cid } = parseBskyId(postId);
    const agent = await blueskyAgent(ctx, link);
    const parent = await bskyFresh(agent, uri);
    const parentReply = (parent.record as { reply?: { root?: { uri: string; cid: string } } }).reply;
    const rich = new RichText({ text });
    await rich.detectFacets(agent);
    const created = await agent.post({
      text: rich.text,
      facets: rich.facets,
      reply: { root: parentReply?.root ?? { uri, cid }, parent: { uri, cid } },
    });
    return bskyPost(linkId, await bskyFresh(agent, created.uri), parent.author);
  }

  const { statusId } = parseMastodonId(postId);
  const { domain } = openSecret<MastodonToken>(ctx, link);
  const original = await mastodonJson<MastodonStatus>(
    ctx,
    link,
    `/api/v1/statuses/${encodeURIComponent(statusId)}`,
  );
  // Mastodon wants the person being replied to mentioned in the text.
  const mention = `@${original.account.acct}`;
  const status = await mastodonJson<MastodonStatus>(ctx, link, '/api/v1/statuses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: text.includes(mention) ? text : `${mention} ${text}`,
      in_reply_to_id: statusId,
      visibility: original.visibility === 'direct' ? 'direct' : 'unlisted',
    }),
  });
  return mastodonPost(linkId, domain, status);
}
