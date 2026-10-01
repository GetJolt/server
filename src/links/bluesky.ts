// Linking a Bluesky account with AT Protocol OAuth. A public instance is a confidential client: it publishes its
// client metadata and signing key under /oauth/bluesky. Development instances on localhost use the loopback client
// the spec allows instead, which needs no published metadata.

import { Agent } from '@atproto/api';
import {
  atprotoLoopbackClientMetadata,
  buildAtprotoLoopbackClientId,
  HandleResolverError,
  isExpectedSessionError,
  JoseKey,
  NodeOAuthClient,
  OAuthResolverError,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthClientMetadataInput,
} from '@atproto/oauth-client-node';
import { instanceOrigin } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { LinkedAccountRow } from '../db/schema.js';
import { num } from '../db/values.js';
import { badRequest } from '../http/errors.js';
import { finishFlow, saveLink, startFlow } from './accounts.js';

const SCOPE = 'atproto transition:generic';
const STATE_TTL_MS = 60 * 60 * 1000;

/** Bluesky's own clients and anyone running an instance on localhost can't use a public client id. */
const isLocal = (ctx: AppContext) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(ctx.config.domain);

/** A sealed key-value store in the database, the shape the OAuth client wants for its state and sessions. */
function store<V>(ctx: AppContext, prefix: string, ttlMs: number | null) {
  const key = (k: string) => `${prefix}:${k}`;
  return {
    async get(k: string): Promise<V | undefined> {
      const row = await ctx.db
        .selectFrom('oauth_kv')
        .selectAll()
        .where('key', '=', key(k))
        .executeTakeFirst();
      if (!row || (row.expires_at !== null && num(row.expires_at) < Date.now())) return undefined;
      return JSON.parse(ctx.secrets.open(row.value)) as V;
    },
    async set(k: string, value: V): Promise<void> {
      const values = {
        value: ctx.secrets.seal(JSON.stringify(value)),
        expires_at: ttlMs === null ? null : Date.now() + ttlMs,
      };
      await ctx.db
        .insertInto('oauth_kv')
        .values({ key: key(k), ...values })
        .onConflict((oc) => oc.column('key').doUpdateSet(values))
        .execute();
    },
    async del(k: string): Promise<void> {
      await ctx.db.deleteFrom('oauth_kv').where('key', '=', key(k)).execute();
    },
  };
}

export function blueskyClientMetadata(ctx: AppContext): OAuthClientMetadataInput {
  const origin = instanceOrigin(ctx.config.domain, ctx.config.devInsecure);
  if (isLocal(ctx)) {
    const port = ctx.config.domain.split(':')[1] ?? '80';
    return atprotoLoopbackClientMetadata(
      buildAtprotoLoopbackClientId({
        scope: SCOPE,
        redirect_uris: [`http://127.0.0.1:${port}/oauth/bluesky/callback`],
      }),
    );
  }
  return {
    client_id: `${origin}/oauth/bluesky/client-metadata.json`,
    client_name: `Jolt on ${ctx.config.domain}`,
    client_uri: origin,
    redirect_uris: [`${origin}/oauth/bluesky/callback`],
    scope: SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true,
    jwks_uri: `${origin}/oauth/bluesky/jwks.json`,
  };
}

/** The ES256 key this instance signs its token requests with, made once and kept sealed in the database. */
async function signingKey(ctx: AppContext): Promise<JoseKey> {
  const keys = store<Record<string, unknown>>(ctx, 'bluesky-key', null);
  const saved = await keys.get('client');
  if (saved) return JoseKey.fromJWK(saved, 'jolt-1');
  const key = await JoseKey.generate(['ES256'], 'jolt-1');
  await keys.set('client', key.privateJwk as unknown as Record<string, unknown>);
  return key;
}

const clients = new WeakMap<AppContext, Promise<NodeOAuthClient>>();

export function blueskyClient(ctx: AppContext): Promise<NodeOAuthClient> {
  let client = clients.get(ctx);
  if (!client) {
    client = (async () =>
      new NodeOAuthClient({
        clientMetadata: blueskyClientMetadata(ctx),
        keyset: isLocal(ctx) ? undefined : [await signingKey(ctx)],
        stateStore: store<NodeSavedState>(ctx, 'bluesky-state', STATE_TTL_MS),
        sessionStore: store<NodeSavedSession>(ctx, 'bluesky-session', null),
        onSessionDeleted: (did, cause) => ctx.log.warn({ did, err: cause }, 'Bluesky session ended'),
      }))();
    client.catch(() => clients.delete(ctx));
    clients.set(ctx, client);
  }
  return client;
}

/** Returns the address to send someone to so they can approve Jolt on Bluesky. */
export async function startBlueskyLink(ctx: AppContext, userId: string, handle: string): Promise<string> {
  const clean = handle
    .trim()
    .replace(/^@/, '')
    .replace(/^https:\/\/bsky\.app\/profile\//, '')
    .replace(/\/$/, '');
  if (!clean) throw badRequest('Enter your Bluesky handle, like name.bsky.social.');
  const state = await startFlow(ctx, userId, 'bluesky', {});
  const client = await blueskyClient(ctx);
  const url = await client.authorize(clean, { state, scope: SCOPE }).catch((error: unknown) => {
    if (error instanceof OAuthResolverError || error instanceof HandleResolverError) {
      throw badRequest(`Couldn't find ${clean} on Bluesky.`);
    }
    // Usually Bluesky couldn't fetch our client metadata: a reverse proxy not passing /oauth/* to the server.
    ctx.log.warn({ err: error }, 'Bluesky refused to start a sign-in');
    throw badRequest(
      isLocal(ctx)
        ? "Bluesky didn't accept the sign-in request. Try again in a moment."
        : `Bluesky couldn't load this instance's sign-in details. If you run ${ctx.config.domain}, make sure /oauth/* reaches the Jolt server.`,
    );
  });
  return url.href;
}

/**
 * Finishes the sign-in. The OAuth client has already checked that the session's DID really is hosted where it
 * claims; the handle shown is only marked verified when Bluesky itself vouches that it points back at that DID.
 */
export async function finishBlueskyLink(ctx: AppContext, params: URLSearchParams) {
  const client = await blueskyClient(ctx);
  const { session, state } = await client.callback(params).catch(() => {
    throw badRequest("Bluesky didn't confirm the sign-in. Start again from Jolt.");
  });
  const { userId } = await finishFlow(ctx, 'bluesky', state ?? '');
  const agent = new Agent(session);
  const profile = await agent.getProfile({ actor: session.did });
  const handle = profile.data.handle;
  const verified = handle !== 'handle.invalid';
  const link = await saveLink(ctx, userId, {
    provider: 'bluesky',
    externalId: session.did,
    handle: verified ? `@${handle}` : session.did,
    url: `https://bsky.app/profile/${verified ? handle : session.did}`,
    secret: null,
    verified,
  });
  return { userId, link };
}

/** An authenticated client for a linked account, refreshing its tokens as needed. */
export async function blueskyAgent(ctx: AppContext, row: LinkedAccountRow): Promise<Agent> {
  const client = await blueskyClient(ctx);
  const session = await client.restore(row.external_id).catch((error: unknown) => {
    // Bluesky revoked or expired the session, or a refresh failed. Only signing in again fixes that.
    if (isExpectedSessionError(error)) {
      throw badRequest(
        `Jolt's sign-in to ${row.handle} on Bluesky has expired. Link the account again in Settings.`,
      );
    }
    throw error;
  });
  return new Agent(session);
}

export async function revokeBluesky(ctx: AppContext, row: LinkedAccountRow): Promise<void> {
  const others = await ctx.db
    .selectFrom('linked_accounts')
    .select('id')
    .where('provider', '=', 'bluesky')
    .where('external_id', '=', row.external_id)
    .where('id', '!=', row.id)
    .executeTakeFirst();
  // The session is shared by everyone here who linked this account, so it's only revoked for the last one.
  if (others) return;
  const client = await blueskyClient(ctx);
  await client.revoke(row.external_id).catch(() => undefined);
}
