import { createPostBodySchema, Limits, lookupQuerySchema, pageQuerySchema } from '@getjolt/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, parse } from '../http/errors.js';
import { requireLocalAuth } from '../services/auth.js';
import { follow, unfollow } from '../social/follows.js';
import { like, repost, unlike, unrepost } from '../social/interactions.js';
import { mediaUrl, storeImage } from '../social/media.js';
import { listNotifications, markNotificationsRead } from '../social/notifications.js';
import { createPost, deletePost, getPost, getThread, lookupPostByUrl } from '../social/posts.js';
import { getProfile, lookupProfile } from '../social/profiles.js';
import { homeTimeline, profileTimeline } from '../social/timeline.js';

const posting = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const profileQuerySchema = pageQuerySchema.extend({
  filter: z.enum(['posts', 'replies', 'media']).optional(),
});

type IdParams = { Params: { id: string } };

/** Everything here is answered by the user's home instance; other servers are reached over ActivityPub. */
export function socialRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/timeline', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return homeTimeline(ctx, userId, parse(pageQuerySchema, req.query));
  });

  app.post('/posts', { config: posting }, async (req, reply) => {
    const { userId } = await requireLocalAuth(ctx, req);
    reply.status(201);
    return createPost(ctx, userId, parse(createPostBodySchema, req.body));
  });

  app.get('/posts/lookup', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    const { url } = parse(z.object({ url: z.string().trim().min(1).max(2048) }), req.query);
    return lookupPostByUrl(ctx, url, userId);
  });

  app.get<IdParams>('/posts/:id', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return getPost(ctx, req.params.id, userId);
  });

  app.get<IdParams>('/posts/:id/thread', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return getThread(ctx, req.params.id, userId);
  });

  app.delete<IdParams>('/posts/:id', async (req, reply) => {
    const { userId } = await requireLocalAuth(ctx, req);
    await deletePost(ctx, req.params.id, userId);
    reply.status(204);
  });

  app.put<IdParams>('/posts/:id/like', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return like(ctx, userId, req.params.id);
  });
  app.delete<IdParams>('/posts/:id/like', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return unlike(ctx, userId, req.params.id);
  });
  app.put<IdParams>('/posts/:id/repost', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return repost(ctx, userId, req.params.id);
  });
  app.delete<IdParams>('/posts/:id/repost', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return unrepost(ctx, userId, req.params.id);
  });

  /** Images for a post are uploaded first, then attached by id when the post is published. */
  app.post('/media', { config: posting, bodyLimit: Limits.mediaBytes }, async (req, reply) => {
    const { userId } = await requireLocalAuth(ctx, req);
    if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as the request body.');
    const image = await storeImage(ctx, req.body, Limits.mediaPixels);
    const uploadId = ctx.nextId();
    await ctx.db
      .insertInto('media_uploads')
      .values({ id: uploadId, user_id: userId, hash: image.hash, created_at: Date.now() })
      .execute();
    reply.status(201);
    return {
      id: uploadId,
      url: mediaUrl(ctx, image.hash),
      mediaType: image.type,
      width: image.width,
      height: image.height,
    };
  });

  app.get('/profiles/lookup', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return lookupProfile(ctx, parse(lookupQuerySchema, req.query).address, userId);
  });

  app.get<IdParams>('/profiles/:id', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return getProfile(ctx, req.params.id, userId);
  });

  app.get<IdParams>('/profiles/:id/posts', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return profileTimeline(ctx, req.params.id, userId, parse(profileQuerySchema, req.query));
  });

  app.put<IdParams>('/profiles/:id/follow', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return follow(ctx, userId, req.params.id);
  });
  app.delete<IdParams>('/profiles/:id/follow', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return unfollow(ctx, userId, req.params.id);
  });

  app.get('/notifications', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return listNotifications(ctx, userId, parse(pageQuerySchema, req.query));
  });
  app.post('/notifications/read', async (req, reply) => {
    const { userId } = await requireLocalAuth(ctx, req);
    await markNotificationsRead(ctx, userId);
    reply.status(204);
  });
}
