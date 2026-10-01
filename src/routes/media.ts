import { AVATAR_CONTENT_TYPES } from '@getjolt/protocol';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../http/errors.js';
import { getImage } from '../social/media.js';

/** Raw image uploads (avatars and post media) and serving stored images back out. */
export function imageRoutes(app: FastifyInstance, ctx: AppContext) {
  // Images are sent as the raw request body rather than JSON or multipart; each route sets its own size limit.
  app.addContentTypeParser([...AVATAR_CONTENT_TYPES], { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  // /avatars/ is the older address for the same images, kept so existing profile pictures keep loading.
  for (const path of ['/media/:hash', '/avatars/:hash']) {
    app.get<{ Params: { hash: string } }>(path, async (req, reply) => {
      const image = /^[\w-]{43}$/.test(req.params.hash) ? await getImage(ctx, req.params.hash) : undefined;
      if (!image) throw notFound('That image');
      // Loaded by clients on other origins, and never rendered as anything but an image.
      return reply
        .header('content-type', image.content_type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(Buffer.from(image.data));
    });
  }
}
