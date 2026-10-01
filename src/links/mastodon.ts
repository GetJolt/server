// Linking a Mastodon account. Every Mastodon server is its own OAuth provider, so the instance registers itself as
// an app on each one the first time someone links an account there, then uses the authorization code flow with PKCE.

import { createHash, randomBytes } from 'node:crypto';
import { instanceOrigin, normalizeInstance } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { LinkedAccountRow } from '../db/schema.js';
import { badRequest } from '../http/errors.js';
import { assertPublicDomain, isDomainAllowed } from '../services/federation.js';
import { finishFlow, openSecret, saveLink, startFlow } from './accounts.js';

const SCOPES = 'read write';

interface App {
  clientId: string;
  clientSecret: string;
}

export interface MastodonToken {
  domain: string;
  token: string;
  accountId: string;
}

export const mastodonCallback = (ctx: AppContext) =>
  `${instanceOrigin(ctx.config.domain, ctx.config.devInsecure)}/oauth/mastodon/callback`;

const origin = (ctx: AppContext, domain: string) => instanceOrigin(domain, ctx.config.devInsecure);

/** Calls a Mastodon server, refusing private addresses outside development. */
export async function mastodonFetch(
  ctx: AppContext,
  domain: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  await assertPublicDomain(ctx, domain);
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  return fetch(`${origin(ctx, domain)}${path}`, {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw badRequest(`${what} failed (${response.status}).`);
  return (await response.json()) as T;
}

/** The app this instance registered on a Mastodon server, registering it the first time. */
async function appFor(ctx: AppContext, domain: string): Promise<App> {
  const key = `mastodon-app:${domain}`;
  const cached = await ctx.db
    .selectFrom('oauth_kv')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  if (cached) return JSON.parse(ctx.secrets.open(cached.value)) as App;

  const created = await json<{ client_id: string; client_secret: string }>(
    await mastodonFetch(ctx, domain, '/api/v1/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: `Jolt (${ctx.config.domain})`,
        redirect_uris: mastodonCallback(ctx),
        scopes: SCOPES,
        website: instanceOrigin(ctx.config.domain, ctx.config.devInsecure),
      }),
    }),
    `Registering with ${domain}`,
  );
  const app = { clientId: created.client_id, clientSecret: created.client_secret };
  await ctx.db
    .insertInto('oauth_kv')
    .values({ key, value: ctx.secrets.seal(JSON.stringify(app)), expires_at: null })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();
  return app;
}

/** Returns the address to send someone to so they can approve Jolt on their Mastodon server. */
export async function startMastodonLink(ctx: AppContext, userId: string, server: string): Promise<string> {
  const domain = normalizeInstance(
    server
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^@?[^@]*@/, ''),
  );
  if (!domain || !isDomainAllowed(ctx, domain))
    throw badRequest(`This instance can't link accounts on ${domain || 'that server'}.`);
  const app = await appFor(ctx, domain);
  const verifier = randomBytes(32).toString('base64url');
  const state = await startFlow(ctx, userId, 'mastodon', { domain, verifier });

  const url = new URL(`${origin(ctx, domain)}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: mastodonCallback(ctx),
    scope: SCOPES,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}

interface Account {
  id: string;
  username: string;
  acct: string;
  url: string;
}

/** Finishes the sign-in: trades the code for a token, checks whose account it is, and saves the link. */
export async function finishMastodonLink(ctx: AppContext, params: URLSearchParams) {
  const { userId, data } = await finishFlow<{ domain: string; verifier: string }>(
    ctx,
    'mastodon',
    params.get('state') ?? '',
  );
  const code = params.get('code');
  if (!code) throw badRequest(params.get('error_description') ?? 'Linking was cancelled.');
  const app = await appFor(ctx, data.domain);

  const token = await json<{ access_token: string }>(
    await mastodonFetch(ctx, data.domain, '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: mastodonCallback(ctx),
        code_verifier: data.verifier,
        scope: SCOPES,
      }),
    }),
    'Signing in',
  );
  // Holding a working token for this account is the proof that it's theirs.
  const account = await json<Account>(
    await mastodonFetch(ctx, data.domain, '/api/v1/accounts/verify_credentials', {
      token: token.access_token,
    }),
    'Checking the account',
  );
  const secret: MastodonToken = { domain: data.domain, token: token.access_token, accountId: account.id };
  const link = await saveLink(ctx, userId, {
    provider: 'mastodon',
    externalId: `${data.domain}/${account.id}`,
    handle: `@${account.username}@${data.domain}`,
    url: account.url,
    secret: JSON.stringify(secret),
    verified: true,
  });
  return { userId, link };
}

export async function revokeMastodon(ctx: AppContext, row: LinkedAccountRow): Promise<void> {
  const { domain, token } = openSecret<MastodonToken>(ctx, row);
  const app = await appFor(ctx, domain);
  await mastodonFetch(ctx, domain, '/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, token }),
  }).catch(() => undefined);
}
