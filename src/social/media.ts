// Uploaded images live in the database, once per distinct file and named by a hash of their bytes, so backing up
// an instance is still just backing up its database. Avatars and post images share the same store.

import { createHash } from 'node:crypto';
import { API_PREFIX, instanceOrigin } from '@getjolt/protocol';
import { sql } from 'kysely';
import type { AppContext } from '../context.js';
import { badRequest } from '../http/errors.js';
import { inspectImage, type ImageInfo } from '../services/images.js';

export interface StoredImage extends ImageInfo {
  hash: string;
}

export const mediaUrl = (ctx: AppContext, hash: string) =>
  `${instanceOrigin(ctx.config.domain, ctx.config.devInsecure)}${API_PREFIX}/media/${hash}`;

/** Pulls the hash back out of one of our media urls (or the older /avatars/ form). */
export function hashFromUrl(ctx: AppContext, url: string): string | null {
  const origin = instanceOrigin(ctx.config.domain, ctx.config.devInsecure) + API_PREFIX;
  const match = /^\/(?:media|avatars)\/([\w-]{43})$/.exec(
    url.startsWith(origin) ? url.slice(origin.length) : '',
  );
  return match ? match[1]! : null;
}

export async function storeImage(ctx: AppContext, data: Buffer, maxPixels: number): Promise<StoredImage> {
  const image = inspectImage(data);
  if (!image) throw badRequest('Images need to be PNG, JPEG, WebP or GIF.');
  if (image.width > maxPixels || image.height > maxPixels) {
    throw badRequest(`Images can be at most ${maxPixels} by ${maxPixels} pixels.`);
  }
  const hash = createHash('sha256').update(data).digest('base64url');
  await ctx.db
    .insertInto('media')
    .values({
      hash,
      content_type: image.type,
      data,
      width: image.width,
      height: image.height,
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.column('hash').doNothing())
    .execute();
  return { ...image, hash };
}

export async function getImage(ctx: AppContext, hash: string) {
  return ctx.db
    .selectFrom('media')
    .select(['content_type', 'data'])
    .where('hash', '=', hash)
    .executeTakeFirst();
}

/** Identical uploads share a row, so an image is only deleted once nothing refers to it any more. */
export async function pruneImage(ctx: AppContext, hash: string): Promise<void> {
  const used = await sql<{ n: number }>`
    select 1 as n from users where avatar_url like ${'%/' + hash}
    union all select 1 from post_media where media_hash = ${hash}
    union all select 1 from media_uploads where hash = ${hash}
    limit 1`.execute(ctx.db);
  if (used.rows.length === 0) await ctx.db.deleteFrom('media').where('hash', '=', hash).execute();
}

/** Drafted uploads that never made it into a post are dropped after a day. */
export async function pruneStaleUploads(ctx: AppContext): Promise<void> {
  const stale = await ctx.db
    .deleteFrom('media_uploads')
    .where('created_at', '<', Date.now() - 24 * 60 * 60 * 1000)
    .returning('hash')
    .execute();
  for (const hash of new Set(stale.map((row) => row.hash))) await pruneImage(ctx, hash);
}
