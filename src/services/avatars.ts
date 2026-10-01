import { Limits, type User } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import { badRequest } from '../http/errors.js';
import { hashFromUrl, mediaUrl, pruneImage, storeImage } from '../social/media.js';
import { broadcastUserUpdate, getUser, getUserRow } from './users.js';

export async function setAvatar(ctx: AppContext, userId: string, data: Buffer): Promise<User> {
  if (data.length > Limits.avatarBytes) throw badRequest('Avatars can be at most 1 MB.');
  const image = await storeImage(ctx, data, Limits.avatarPixels);
  return replaceAvatar(ctx, userId, mediaUrl(ctx, image.hash));
}

export async function removeAvatar(ctx: AppContext, userId: string): Promise<User> {
  return replaceAvatar(ctx, userId, null);
}

async function replaceAvatar(ctx: AppContext, userId: string, url: string | null): Promise<User> {
  const previous = (await getUserRow(ctx, userId))?.avatar_url;
  await ctx.db.updateTable('users').set({ avatar_url: url }).where('id', '=', userId).execute();
  const oldHash = previous && previous !== url ? hashFromUrl(ctx, previous) : null;
  if (oldHash) await pruneImage(ctx, oldHash);

  const user = await getUser(ctx, userId);
  await broadcastUserUpdate(ctx, user);
  await ctx.hooks.onProfileUpdated?.(userId);
  return user;
}
