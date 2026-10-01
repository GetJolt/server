import {
  instanceOrigin,
  linkActionBodySchema,
  startLinkBodySchema,
  updateLinkBodySchema,
} from '@getjolt/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiError, parse } from '../http/errors.js';
import { deleteLink, linkRow, listLinks, updateLink } from '../links/accounts.js';
import {
  blueskyClient,
  blueskyClientMetadata,
  finishBlueskyLink,
  revokeBluesky,
  startBlueskyLink,
} from '../links/bluesky.js';
import { finishMastodonLink, revokeMastodon, startMastodonLink } from '../links/mastodon.js';
import { findFriends } from '../links/friends.js';
import { linkAction, linkReply, linkTimeline } from '../links/timelines.js';
import { requireLocalAuth } from '../services/auth.js';

const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** Signed-in routes for managing linked accounts. */
export function linkRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/links', async (req) => listLinks(ctx, (await requireLocalAuth(ctx, req)).userId));

  app.post('/links/start', { config: strict }, async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    const body = parse(startLinkBodySchema, req.body);
    const url =
      body.provider === 'bluesky'
        ? await startBlueskyLink(ctx, userId, body.identifier)
        : await startMastodonLink(ctx, userId, body.identifier);
    return { url };
  });

  app.patch<{ Params: { id: string } }>('/links/:id', async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return updateLink(ctx, userId, req.params.id, parse(updateLinkBodySchema, req.body));
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>(
    '/links/:id/timeline',
    async (req) => {
      const { userId } = await requireLocalAuth(ctx, req);
      const row = await linkRow(ctx, userId, req.params.id);
      const before = typeof req.query.before === 'string' ? req.query.before.slice(0, 512) : undefined;
      return linkTimeline(ctx, row, before || undefined);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/links/:id/actions',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const { userId } = await requireLocalAuth(ctx, req);
      const row = await linkRow(ctx, userId, req.params.id);
      const body = parse(linkActionBodySchema, req.body);
      return body.action === 'reply'
        ? linkReply(ctx, row, body.postId, body.text ?? '')
        : linkAction(ctx, row, body.postId, body.action);
    },
  );

  app.get<{ Params: { id: string } }>('/links/:id/friends', { config: strict }, async (req) => {
    const { userId } = await requireLocalAuth(ctx, req);
    return findFriends(ctx, await linkRow(ctx, userId, req.params.id));
  });

  app.delete<{ Params: { id: string } }>('/links/:id', async (req, reply) => {
    const { userId } = await requireLocalAuth(ctx, req);
    const row = await linkRow(ctx, userId, req.params.id);
    await (row.provider === 'bluesky' ? revokeBluesky(ctx, row) : revokeMastodon(ctx, row));
    await deleteLink(ctx, userId, row);
    reply.status(204);
  });
}

/** Where Bluesky and Mastodon send people back to after they approve Jolt, plus Bluesky's client documents. */
export function oauthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/oauth/bluesky/client-metadata.json', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=600').send(blueskyClientMetadata(ctx)),
  );

  app.get('/oauth/bluesky/jwks.json', async (_req, reply) => {
    const client = await blueskyClient(ctx);
    return reply.header('cache-control', 'public, max-age=600').send(client.jwks);
  });

  for (const provider of ['bluesky', 'mastodon'] as const) {
    app.get(`/oauth/${provider}/callback`, async (req, reply) => {
      const params = new URLSearchParams(req.url.split('?')[1] ?? '');
      try {
        const { link } =
          provider === 'bluesky'
            ? await finishBlueskyLink(ctx, params)
            : await finishMastodonLink(ctx, params);
        return resultPage(reply, ctx, true, `${link.handle} is now linked to your Jolt account.`);
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Something went wrong while linking.';
        if (!(error instanceof ApiError)) ctx.log.warn({ err: error }, `Linking ${provider} failed`);
        return resultPage(reply, ctx, false, message);
      }
    });
  }
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** A small page shown in the browser at the end of linking, pointing back to the app. */
function resultPage(reply: FastifyReply, ctx: AppContext, ok: boolean, message: string) {
  const title = ok ? 'All linked' : "That didn't work";
  return reply
    .status(ok ? 200 : 400)
    .type('text/html; charset=utf-8')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    )
    .header('cache-control', 'no-store')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2efe6;color:#141412;font:16px/1.5 system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#11110f;color:#efece3}}main{max-width:26rem;padding:2rem;text-align:center}h1{font:600 1.8rem/1.2 Georgia,serif;margin:0 0 .5rem}p{margin:0 0 1.5rem;opacity:.8}a{display:inline-block;padding:.6rem 1.1rem;border-radius:9px;background:#c8f04b;color:#141a04;font-weight:600;text-decoration:none}</style></head>
<body><main><h1>${title}</h1><p>${escape(message)}</p><a href="jolt://settings/linked">Back to Jolt</a><p style="margin-top:1rem;font-size:.85rem">You can close this tab. ${escape(instanceOrigin(ctx.config.domain, ctx.config.devInsecure))}</p></main></body></html>`);
}
