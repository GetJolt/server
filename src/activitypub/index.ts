import type { Federation } from '@fedify/fedify';
import fedifyPlugin from '@fedify/fastify';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { id } from '../db/values.js';
import { ActivityPub } from './federation.js';
import { installOutbox } from './outbox.js';

/**
 * Turns on ActivityPub for this instance: actor documents, WebFinger, NodeInfo, the inbox, and delivery of what
 * local users do. Browsers that open an actor or post URL are sent to the matching web page instead.
 */
export async function setupActivityPub(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const ap = new ActivityPub(ctx);
  ctx.ap = ap;
  installOutbox(ap, ctx);

  await app.register(fedifyPlugin, {
    federation: ap.federation as Federation<unknown>,
    contextDataFactory: () => undefined,
    errorHandlers: {
      onNotAcceptable: async (request) => {
        const page = await pageFor(ctx, new URL(request.url).pathname);
        return page
          ? new Response(null, { status: 302, headers: { location: page } })
          : new Response('Not Acceptable', { status: 406, headers: { Vary: 'Accept' } });
      },
    },
  });

  ap.start();
  const sweep = setInterval(() => void ap.purgeCache().catch(() => {}), 60 * 60 * 1000);
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    await ap.stop();
  });
}

/** `/users/123` and `/posts/456` are ActivityPub ids; in a browser they should show the profile or post page. */
async function pageFor(ctx: AppContext, path: string): Promise<string | null> {
  const user = /^\/users\/(\d{1,20})\/?$/.exec(path);
  const post = /^\/posts\/(\d{1,20})\/?$/.exec(path);
  if (user) {
    const row = await ctx.db
      .selectFrom('users')
      .select('handle')
      .where('id', '=', user[1]!)
      .where('is_local', '=', 1)
      .executeTakeFirst();
    return row ? `/@${row.handle}` : null;
  }
  if (post) {
    const row = await ctx.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .select(['users.handle', 'posts.id'])
      .where('posts.id', '=', post[1]!)
      .where('users.is_local', '=', 1)
      .executeTakeFirst();
    return row ? `/@${row.handle}/posts/${id(row.id)}` : null;
  }
  return null;
}
