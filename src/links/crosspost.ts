// Copies a Jolt post to the author's linked Bluesky and Mastodon accounts, and deletes the copies when the original
// goes. Each network gets what it can show: Mastodon keeps content warnings, Bluesky gets a link back instead, and
// anything too long is trimmed with a link to the full post.

import { RichText } from '@atproto/api';
import { segmentRichText, type Facet } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { LinkedAccountRow, PostRow } from '../db/schema.js';
import { id, num } from '../db/values.js';
import type { Job, Jobs } from '../jobs.js';
import { getImage } from '../social/media.js';
import { postPageUrl } from '../social/posts.js';
import { getUser } from '../services/users.js';
import { openSecret } from './accounts.js';
import { blueskyAgent } from './bluesky.js';
import { mastodonFetch, type MastodonToken } from './mastodon.js';

const LIMITS = { bluesky: 300, mastodon: 500 };
/** Bluesky refuses image blobs over this size. */
const BLUESKY_IMAGE_BYTES = 976_560;

interface Media {
  data: Buffer;
  mediaType: string;
  alt: string;
  width: number | null;
  height: number | null;
}

const graphemes = (text: string) =>
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

/** Shortens `text` so that it plus a trailing link fits in `limit`, counting the way each network counts. */
function withLink(text: string, link: string, limit: number, count: (s: string) => number): string {
  const suffix = `\n\n${link}`;
  if (count(text + suffix) <= limit) return text + suffix;
  const chars = [...text];
  while (chars.length && count(`${chars.join('')}…${suffix}`) > limit) chars.pop();
  return `${chars.join('').trimEnd()}…${suffix}`;
}

/** Writes mentions as full fediverse addresses so the other network doesn't resolve them to its own users. */
function portableText(text: string, facets: Facet[]): string {
  return segmentRichText({ text, facets })
    .map((part) => (part.facet?.kind === 'mention' ? `@${part.facet.value}` : part.text))
    .join('');
}

export function installCrossposting(ctx: AppContext, jobs: Jobs) {
  const previousCreated = ctx.hooks.onPostCreated;
  const previousDeleted = ctx.hooks.onPostDeleted;

  ctx.hooks.onPostCreated = async (row, options) => {
    await previousCreated?.(row, options);
    if (row.visibility === 'followers' || options.crosspost.length === 0) return;
    for (const linkId of new Set(options.crosspost)) {
      await jobs.enqueue({ type: 'crosspost', postId: id(row.id), linkId });
    }
  };

  ctx.hooks.onPostDeleted = async (row) => {
    await previousDeleted?.(row);
    const copies = await ctx.db
      .selectFrom('crossposts')
      .innerJoin('linked_accounts', 'linked_accounts.id', 'crossposts.link_id')
      .select(['crossposts.link_id', 'crossposts.external_ref', 'linked_accounts.provider'])
      .where('crossposts.post_id', '=', row.id)
      .execute();
    for (const copy of copies) {
      await jobs.enqueue({
        type: 'crosspost-delete',
        linkId: id(copy.link_id),
        ref: copy.external_ref,
        provider: copy.provider,
      });
    }
    await ctx.db.deleteFrom('crossposts').where('post_id', '=', row.id).execute();
  };

  jobs.handle((job) => runJob(ctx, job));
}

async function runJob(ctx: AppContext, job: Job): Promise<void> {
  const link = await ctx.db
    .selectFrom('linked_accounts')
    .selectAll()
    .where('id', '=', job.linkId)
    .executeTakeFirst();
  if (!link) return;

  if (job.type === 'crosspost-delete') {
    if (job.provider === 'bluesky') {
      const agent = await blueskyAgent(ctx, link);
      await agent.deletePost((JSON.parse(job.ref) as { uri: string }).uri);
    } else {
      const { domain, token } = openSecret<MastodonToken>(ctx, link);
      const res = await mastodonFetch(ctx, domain, `/api/v1/statuses/${encodeURIComponent(job.ref)}`, {
        method: 'DELETE',
        token,
      });
      if (!res.ok && res.status !== 404) throw new Error(`Mastodon delete failed (${res.status})`);
    }
    return;
  }

  const post = await ctx.db.selectFrom('posts').selectAll().where('id', '=', job.postId).executeTakeFirst();
  // Deleted before we got to it, someone else's post, or already done (a retry after a crash).
  if (!post || id(post.author_id) !== id(link.user_id)) return;
  const done = await ctx.db
    .selectFrom('crossposts')
    .select('post_id')
    .where('post_id', '=', post.id)
    .where('link_id', '=', link.id)
    .executeTakeFirst();
  if (done) return;

  // A reply only goes out if it continues a thread that was cross-posted to the same account.
  let parentRef: string | null = null;
  if (post.reply_to_id) {
    const parent = await ctx.db
      .selectFrom('crossposts')
      .select('external_ref')
      .where('post_id', '=', post.reply_to_id)
      .where('link_id', '=', link.id)
      .executeTakeFirst();
    if (!parent) return;
    parentRef = parent.external_ref;
  }

  const media: Media[] = [];
  const mediaRows = await ctx.db
    .selectFrom('post_media')
    .selectAll()
    .where('post_id', '=', post.id)
    .orderBy('position')
    .execute();
  for (const m of mediaRows) {
    const image = m.media_hash ? await getImage(ctx, m.media_hash) : undefined;
    if (image) {
      media.push({
        data: Buffer.from(image.data),
        mediaType: image.content_type,
        alt: m.alt,
        width: m.width === null ? null : num(m.width),
        height: m.height === null ? null : num(m.height),
      });
    }
  }

  const author = await getUser(ctx, id(post.author_id));
  const pageUrl = postPageUrl(ctx, author, id(post.id))!;
  const text = portableText(post.text, JSON.parse(post.facets) as Facet[]);

  const copy =
    link.provider === 'bluesky'
      ? await toBluesky(ctx, link, post, text, media, pageUrl, parentRef)
      : await toMastodon(ctx, link, post, text, media, pageUrl, parentRef);

  await ctx.db
    .insertInto('crossposts')
    .values({
      post_id: id(post.id),
      link_id: id(link.id),
      external_ref: copy.ref,
      external_url: copy.url,
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.columns(['post_id', 'link_id']).doNothing())
    .execute();
}

async function toBluesky(
  ctx: AppContext,
  link: LinkedAccountRow,
  post: PostRow,
  text: string,
  media: Media[],
  pageUrl: string,
  parentRef: string | null,
) {
  const agent = await blueskyAgent(ctx, link);
  // Bluesky has no content warnings, so the warning goes out on its own with a link to the real post.
  const hidden = Boolean(post.cw);
  const fits = media.filter((m) => m.data.length <= BLUESKY_IMAGE_BYTES).slice(0, 4);
  const needsLink = hidden || fits.length < media.length || graphemes(text) > LIMITS.bluesky;
  const body = hidden
    ? withLink(`⚠ ${post.cw}`, pageUrl, LIMITS.bluesky, graphemes)
    : needsLink
      ? withLink(text, pageUrl, LIMITS.bluesky, graphemes)
      : text;

  const rich = new RichText({ text: body });
  await rich.detectFacets(agent);
  // Jolt addresses aren't Bluesky handles; only links and tags are kept as facets.
  const facets = rich.facets?.filter(
    (f) => !f.features.some((x) => x.$type === 'app.bsky.richtext.facet#mention'),
  );

  let embed: Record<string, unknown> | undefined;
  if (!hidden && fits.length) {
    const images = [];
    for (const m of fits) {
      const uploaded = await agent.uploadBlob(new Uint8Array(m.data), { encoding: m.mediaType });
      images.push({
        image: uploaded.data.blob,
        alt: m.alt,
        ...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {}),
      });
    }
    embed = { $type: 'app.bsky.embed.images', images };
  }

  let reply: Record<string, unknown> | undefined;
  if (parentRef) {
    const parent = JSON.parse(parentRef) as { uri: string; cid: string; root?: { uri: string; cid: string } };
    reply = {
      root: parent.root ?? { uri: parent.uri, cid: parent.cid },
      parent: { uri: parent.uri, cid: parent.cid },
    };
  }

  const created = await agent.post({
    text: rich.text,
    facets,
    embed: embed as never,
    reply: reply as never,
    createdAt: new Date(num(post.created_at)).toISOString(),
  });
  const rkey = created.uri.split('/').pop()!;
  const root = reply ? (reply.root as { uri: string; cid: string }) : { uri: created.uri, cid: created.cid };
  return {
    ref: JSON.stringify({ uri: created.uri, cid: created.cid, root }),
    url: `https://bsky.app/profile/${link.external_id}/post/${rkey}`,
  };
}

async function toMastodon(
  ctx: AppContext,
  link: LinkedAccountRow,
  post: PostRow,
  text: string,
  media: Media[],
  pageUrl: string,
  parentRef: string | null,
) {
  const { domain, token } = openSecret<MastodonToken>(ctx, link);
  const mediaIds: string[] = [];
  for (const m of media.slice(0, 4)) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(m.data)], { type: m.mediaType }), 'image');
    if (m.alt) form.append('description', m.alt);
    const res = await mastodonFetch(ctx, domain, '/api/v2/media', { method: 'POST', body: form, token });
    if (!res.ok) throw new Error(`Mastodon media upload failed (${res.status})`);
    mediaIds.push(((await res.json()) as { id: string }).id);
  }

  const status =
    [...text].length > LIMITS.mastodon
      ? withLink(text, pageUrl, LIMITS.mastodon, (s) => [...s].length)
      : text;
  const res = await mastodonFetch(ctx, domain, '/api/v1/statuses', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json', 'idempotency-key': `jolt-${id(post.id)}` },
    body: JSON.stringify({
      status,
      media_ids: mediaIds,
      sensitive: Boolean(post.cw),
      spoiler_text: post.cw ?? '',
      visibility: post.visibility === 'unlisted' ? 'unlisted' : 'public',
      in_reply_to_id: parentRef ?? undefined,
    }),
  });
  if (!res.ok) throw new Error(`Mastodon post failed (${res.status})`);
  const created = (await res.json()) as { id: string; url: string };
  return { ref: created.id, url: created.url };
}
