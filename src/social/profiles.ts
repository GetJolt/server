import { normalizeInstance, type Profile } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import { id, num } from '../db/values.js';
import { badRequest, notFound } from '../http/errors.js';
import { getLocalUserByHandle, getUser } from '../services/users.js';
import { followCounts, relationship } from './follows.js';
import { profileUrl } from './posts.js';

export async function getProfile(ctx: AppContext, userId: string, viewerId: string | null): Promise<Profile> {
  const user = await getUser(ctx, userId);
  if (!user.local) await ctx.hooks.beforeRemoteProfile?.(userId);
  const [counts, posts, links] = await Promise.all([
    followCounts(ctx, userId),
    ctx.db
      .selectFrom('posts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('author_id', '=', userId)
      .executeTakeFirstOrThrow(),
    ctx.hooks.publicLinks?.(userId) ?? Promise.resolve([]),
  ]);
  return {
    user,
    counts: { ...counts, posts: num(posts.n) },
    links,
    relationship: viewerId && viewerId !== userId ? await relationship(ctx, viewerId, userId) : null,
    url: (await ctx.hooks.profileUrl?.(user)) ?? profileUrl(ctx, user),
  };
}

/** Finds someone by `handle`, `@handle@server` or a profile URL, asking their server if we haven't met them. */
export async function lookupProfile(
  ctx: AppContext,
  address: string,
  viewerId: string | null,
): Promise<Profile> {
  const raw = address.trim().replace(/^@/, '');
  const isUrl = /^https?:\/\//i.test(raw);
  const at = raw.lastIndexOf('@');
  const local = !isUrl && (at < 0 || normalizeInstance(raw.slice(at + 1)) === ctx.config.domain);

  if (local) {
    const row = await getLocalUserByHandle(ctx, (at < 0 ? raw : raw.slice(0, at)).toLowerCase());
    if (!row) throw notFound('That account');
    return getProfile(ctx, id(row.id), viewerId);
  }
  if (!isUrl && at <= 0) throw badRequest('Enter an address like @name@server.example.');
  const userId = await ctx.hooks.lookupActor?.(raw);
  if (!userId) throw notFound('That account');
  return getProfile(ctx, userId, viewerId);
}
