// Avatars for local accounts are stored in the database, keyed by a hash of their contents, so backing up
// an instance is still just backing up its database.

import { createHash } from 'node:crypto';
import { API_PREFIX, instanceOrigin, Limits, type User } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import { badRequest } from '../http/errors.js';
import { inspectImage } from './images.js';
import { broadcastUserUpdate, getUser, getUserRow } from './users.js';

const avatarBase = (ctx: AppContext) =>
  `${instanceOrigin(ctx.config.domain, ctx.config.devInsecure)}${API_PREFIX}/avatars/`;

export async function setAvatar(ctx: AppContext, userId: string, data: Buffer): Promise<User> {
  const image = inspectImage(data);
  if (!image) throw badRequest('Avatars need to be a PNG, JPEG, WebP or GIF image.');
  const max = Limits.avatarPixels;
  if (image.width > max || image.height > max) {
    throw badRequest(`Avatars can be at most ${max} by ${max} pixels.`);
  }

  const hash = createHash('sha256').update(data).digest('base64url');
  await ctx.db
    .insertInto('avatars')
    .values({ hash, content_type: image.type, data, created_at: Date.now() })
    .onConflict((oc) => oc.column('hash').doNothing())
    .execute();
  return replaceAvatar(ctx, userId, avatarBase(ctx) + hash);
}

export async function removeAvatar(ctx: AppContext, userId: string): Promise<User> {
  return replaceAvatar(ctx, userId, null);
}

export async function getAvatar(ctx: AppContext, hash: string) {
  return ctx.db
    .selectFrom('avatars')
    .select(['content_type', 'data'])
    .where('hash', '=', hash)
    .executeTakeFirst();
}

async function replaceAvatar(ctx: AppContext, userId: string, url: string | null): Promise<User> {
  const previous = (await getUserRow(ctx, userId))?.avatar_url;
  await ctx.db.updateTable('users').set({ avatar_url: url }).where('id', '=', userId).execute();
  if (previous && previous !== url) await pruneAvatar(ctx, previous);

  const user = await getUser(ctx, userId);
  await broadcastUserUpdate(ctx, user);
  return user;
}

/** Identical uploads share a row, so one is only deleted once nobody is using it. */
async function pruneAvatar(ctx: AppContext, url: string) {
  const base = avatarBase(ctx);
  if (!url.startsWith(base)) return;
  const inUse = await ctx.db
    .selectFrom('users')
    .select('id')
    .where('avatar_url', '=', url)
    .executeTakeFirst();
  if (!inUse) await ctx.db.deleteFrom('avatars').where('hash', '=', url.slice(base.length)).execute();
}
