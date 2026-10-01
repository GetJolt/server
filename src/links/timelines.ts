// Reading a linked account's home timeline inside Jolt, and replying, liking and reposting from there. Posts are
// converted to the same text-and-facets shape as everything else, and their ids carry the link they came from
// (`bsky:<link>:<cid>:<uri>` or `masto:<link>:<status>`), so actions find their way back to the right account.

import { RichText, type Agent, type AppBskyFeedDefs } from '@atproto/api';
import {
  utf8ToUtf16Offset,
  type Facet,
  type Post,
  type PostMedia,
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

const PAGE = 30;

function externalUser(
  idValue: string,
  handle: string,
  instance: string,
  name: string | undefined,
  avatar: string | undefined,
): User {
  return {
    id: idValue,
    handle,
    instance,
    displayName: name || handle,
    avatarUrl: avatar ?? null,
    bio: '',
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

// --- Bluesky -------------------------------------------------------------------------------------------------

type BskyPostView = AppBskyFeedDefs.PostView;

const bskyUser = (author: BskyPostView['author']) =>
  externalUser(`bsky:${author.did}`, author.handle, 'bsky.app', author.displayName, author.avatar);

function bskyFacets(text: string, facets: unknown): Facet[] {
  const result: Facet[] = [];
  for (const facet of (facets as Array<{
    index: { byteStart: number; byteEnd: number };
    features: Array<Record<string, string>>;
  }>) ?? []) {
    const start = utf8ToUtf16Offset(text, facet.index.byteStart);
    const end = utf8ToUtf16Offset(text, facet.index.byteEnd);
    for (const feature of facet.features ?? []) {
      if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri)
        result.push({ start, end, kind: 'link', value: feature.uri });
      else if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag)
        result.push({ start, end, kind: 'tag', value: feature.tag });
      else if (feature.$type === 'app.bsky.richtext.facet#mention')
        result.push({ start, end, kind: 'mention', value: text.slice(start + 1, end) });
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

function bskyPost(linkId: string, view: BskyPostView, replyParent?: BskyPostView['author']): Post {
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
          author?: BskyPostView['author'];
          value?: { text?: string };
        };
        media?: unknown;
      }
    | undefined;
  const quoted = embed?.$type === 'app.bsky.embed.record#view' ? embed.record : undefined;
  return basePost({
    id: `bsky:${linkId}:${view.cid}:${view.uri}`,
    source: 'bluesky',
    author: bskyUser(view.author),
    text,
    facets: bskyFacets(text, record.facets),
    media: bskyMedia(view.embed),
    url: `https://bsky.app/profile/${view.author.handle}/post/${rkey}`,
    createdAt: Date.parse(record.createdAt ?? view.indexedAt) || Date.now(),
    replyToAuthor: replyParent ? bskyUser(replyParent) : null,
    quote:
      quoted?.$type === 'app.bsky.embed.record#viewRecord' && quoted.author && quoted.uri && quoted.cid
        ? basePost({
            id: `bsky:${linkId}:${quoted.cid}:${quoted.uri}`,
            source: 'bluesky',
            author: bskyUser(quoted.author),
            text: quoted.value?.text ?? '',
            facets: [],
            url: `https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}`,
          })
        : null,
    counts: { replies: view.replyCount ?? 0, reposts: view.repostCount ?? 0, likes: view.likeCount ?? 0 },
    viewer: { liked: Boolean(view.viewer?.like), reposted: Boolean(view.viewer?.repost) },
  });
}

async function bskyTimeline(ctx: AppContext, link: LinkedAccountRow, cursor?: string): Promise<TimelinePage> {
  const agent = await blueskyAgent(ctx, link);
  const { data } = await agent.getTimeline({ limit: PAGE, cursor });
  const linkId = id(link.id);
  return {
    items: data.feed.map((item) => {
      const reason = item.reason as { $type?: string; by?: BskyPostView['author'] } | undefined;
      const parent = (item.reply?.parent as { author?: BskyPostView['author'] } | undefined)?.author;
      const post = bskyPost(linkId, item.post, parent);
      return {
        id: `${post.id}${reason?.by ? `:by:${reason.by.did}` : ''}`,
        post,
        repostedBy:
          reason?.$type === 'app.bsky.feed.defs#reasonRepost' && reason.by ? bskyUser(reason.by) : null,
      };
    }),
    cursor: data.cursor ?? null,
  };
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

// --- Mastodon ------------------------------------------------------------------------------------------------

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  url: string;
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

function mastodonUser(domain: string, account: MastodonAccount): User {
  const [handle, host] = account.acct.includes('@') ? account.acct.split('@') : [account.acct, domain];
  return externalUser(`masto:${host}:${account.id}`, handle!, host!, account.display_name, account.avatar);
}

function mastodonPost(linkId: string, domain: string, status: MastodonStatus): Post {
  const mentions = new Map(
    (status.mentions ?? []).map((m) => [m.url, m.acct.includes('@') ? m.acct : `${m.acct}@${domain}`]),
  );
  const { text, facets } = htmlToRichText(status.content, (href) => mentions.get(href));
  const replyMention = (status.mentions ?? []).find((m) => m.id === status.in_reply_to_account_id);
  return basePost({
    id: `masto:${linkId}:${status.id}`,
    source: 'mastodon',
    author: mastodonUser(domain, status.account),
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
    replyToAuthor: replyMention
      ? externalUser(
          `masto:${domain}:${replyMention.id}`,
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

async function mastodonTimeline(
  ctx: AppContext,
  link: LinkedAccountRow,
  cursor?: string,
): Promise<TimelinePage> {
  const { domain } = openSecret<MastodonToken>(ctx, link);
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (cursor) query.set('max_id', cursor);
  const statuses = await mastodonJson<MastodonStatus[]>(ctx, link, `/api/v1/timelines/home?${query}`);
  const linkId = id(link.id);
  return {
    items: statuses.map((status) => ({
      id: `masto:${linkId}:${status.id}`,
      post: mastodonPost(linkId, domain, status.reblog ?? status),
      repostedBy: status.reblog ? mastodonUser(domain, status.account) : null,
    })),
    cursor: statuses.length === PAGE ? statuses.at(-1)!.id : null,
  };
}

function parseMastodonId(postId: string) {
  const match = /^masto:(\d+):([\w-]+)$/.exec(postId);
  if (!match) throw badRequest("That isn't a Mastodon post.");
  return { linkId: match[1]!, statusId: match[2]! };
}

// --- Shared --------------------------------------------------------------------------------------------------

export function linkTimeline(
  ctx: AppContext,
  link: LinkedAccountRow,
  cursor?: string,
): Promise<TimelinePage> {
  return link.provider === 'bluesky' ? bskyTimeline(ctx, link, cursor) : mastodonTimeline(ctx, link, cursor);
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
