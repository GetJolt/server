import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import {
  API_PREFIX,
  ErrorCode,
  federationChallengeMessage,
  generateKeyPair,
  IDENTITY_CERT_TTL_SECONDS,
  instanceInfoSchema,
  instanceOrigin,
  issueIdentityCert,
  isValidInstance,
  newCertSerial,
  parseAddress,
  PROTOCOL_VERSION,
  randomToken,
  userSchema,
  verifyBytes,
  verifyIdentityCert,
  WELL_KNOWN_PATH,
  type AuthResponse,
  type FederationAuthBody,
  type GuildIndexEntry,
  type IdentityCert,
  type InstanceInfo,
  type User,
} from '@getjolt/protocol';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { id, num, optNum } from '../db/values.js';
import { ApiError } from '../http/errors.js';
import { createSession, type Auth } from './auth.js';
import { broadcastUserUpdate, serializeUser } from './users.js';

const REMOTE_INSTANCE_TTL_MS = 60 * 60 * 1000;
const REMOTE_REFETCH_COOLDOWN_MS = 60 * 1000;
const PROFILE_TTL_MS = 5 * 60 * 1000;
const REVOCATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const denied = (message: string) => new ApiError(403, ErrorCode.FederationDenied, message);
const invalidCert = (message: string) => new ApiError(401, ErrorCode.InvalidCert, message);

export interface InstanceKey {
  kid: string;
  publicKey: string;
  secretKey: string;
}

export interface FederationState {
  activeKey: InstanceKey | null;
  challenges: Map<string, number>;
  lastRefetch: Map<string, number>;
}

export function createFederationState(): FederationState {
  return { activeKey: null, challenges: new Map(), lastRefetch: new Map() };
}

export async function ensureInstanceKey(ctx: AppContext): Promise<InstanceKey> {
  const state = ctx.federation;
  if (state.activeKey) return state.activeKey;
  const row = await ctx.db
    .selectFrom('instance_keys')
    .selectAll()
    .where('not_after', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (row) return (state.activeKey = { kid: row.kid, publicKey: row.public_key, secretKey: row.secret_key });

  const pair = await generateKeyPair();
  const kid = `k${Date.now().toString(36)}`;
  await ctx.db
    .insertInto('instance_keys')
    .values({
      kid,
      public_key: pair.publicKey,
      secret_key: pair.secretKey,
      created_at: Date.now(),
      not_after: null,
    })
    .execute();
  ctx.log.info({ kid }, 'Generated instance signing key');
  return (state.activeKey = { kid, ...pair });
}

export async function instanceInfo(ctx: AppContext): Promise<InstanceInfo> {
  await ensureInstanceKey(ctx);
  const keys = await ctx.db.selectFrom('instance_keys').select(['kid', 'public_key', 'not_after']).execute();
  return {
    software: 'jolt',
    protocolVersion: PROTOCOL_VERSION,
    domain: ctx.config.domain,
    name: ctx.config.name,
    description: ctx.config.description,
    registration: ctx.config.registration,
    federation: ctx.config.federation,
    keys: keys.map((k) => ({ kid: k.kid, publicKey: k.public_key, notAfter: optNum(k.not_after) })),
  };
}

export async function issueCert(ctx: AppContext, auth: Auth, devicePublicKey: string): Promise<IdentityCert> {
  const key = await ensureInstanceKey(ctx);
  const iat = Math.floor(Date.now() / 1000);
  const serial = newCertSerial();
  const cert = await issueIdentityCert(
    {
      sub: `${auth.user.handle}@${ctx.config.domain}`,
      uid: auth.userId,
      instance: ctx.config.domain,
      kid: key.kid,
      devicePublicKey,
      iat,
      exp: iat + IDENTITY_CERT_TTL_SECONDS,
      serial,
    },
    key.secretKey,
  );
  await ctx.db
    .insertInto('identity_certs')
    .values({
      serial,
      user_id: auth.userId,
      session_id: auth.session.id,
      device_public_key: devicePublicKey,
      issued_at: iat,
      expires_at: iat + IDENTITY_CERT_TTL_SECONDS,
      revoked: 0,
    })
    .execute();
  return cert;
}

export async function isCertRevoked(ctx: AppContext, serial: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom('identity_certs')
    .select('revoked')
    .where('serial', '=', serial)
    .executeTakeFirst();
  return !row || num(row.revoked) !== 0;
}

export function isDomainAllowed(ctx: AppContext, domain: string): boolean {
  const { federation, federationAllow, federationBlock } = ctx.config;
  if (federation === 'disabled' || domain === ctx.config.domain) return false;
  const matches = (list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (matches(federationBlock)) return false;
  return federation === 'open' || matches(federationAllow);
}

const privateRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['::ffff:0:0', 96],
] as const) {
  privateRanges.addSubnet(net, prefix, 'ipv6');
}

/**
 * Fetches JSON from another instance. Domains come from user-supplied certs, so outside of dev mode we
 * refuse anything that resolves to a private address to keep this from being used to probe our network.
 */
async function fetchRemoteJson(ctx: AppContext, domain: string, path: string): Promise<unknown> {
  if (!isValidInstance(domain)) throw denied('That instance address is invalid.');

  if (!ctx.config.devInsecure) {
    const host = domain.replace(/:\d+$/, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
    for (const { address, family } of addresses) {
      if (privateRanges.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
        throw denied('That instance resolves to a private address.');
      }
    }
  }

  const response = await fetch(`${instanceOrigin(domain, ctx.config.devInsecure)}${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
    headers: { accept: 'application/json', 'user-agent': `Jolt/${PROTOCOL_VERSION} (+${ctx.config.domain})` },
  });
  if (!response.ok) throw new Error(`${domain}${path} responded ${response.status}`);

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${domain}${path} response too large`);
  return JSON.parse(text);
}

export async function getRemoteInstance(ctx: AppContext, domain: string, opts: { needKid?: string } = {}) {
  const cached = await ctx.db
    .selectFrom('remote_instances')
    .selectAll()
    .where('domain', '=', domain)
    .executeTakeFirst();
  const cachedInfo = cached ? instanceInfoSchema.parse(JSON.parse(cached.info)) : null;
  const fresh = cached && Date.now() - num(cached.fetched_at) < REMOTE_INSTANCE_TTL_MS;
  const hasKid = !opts.needKid || cachedInfo?.keys.some((k) => k.kid === opts.needKid);
  if (cachedInfo && fresh && hasKid) return cachedInfo;

  // A cert with an unknown kid could mean the remote rotated keys, but don't let it force constant refetches.
  if (
    cachedInfo &&
    fresh &&
    Date.now() - (ctx.federation.lastRefetch.get(domain) ?? 0) < REMOTE_REFETCH_COOLDOWN_MS
  ) {
    return cachedInfo;
  }
  ctx.federation.lastRefetch.set(domain, Date.now());

  const info = instanceInfoSchema.parse(await fetchRemoteJson(ctx, domain, WELL_KNOWN_PATH));
  if (info.domain !== domain) throw denied(`${domain} claims to be ${info.domain}.`);

  await ctx.db
    .insertInto('remote_instances')
    .values({ domain, info: JSON.stringify(info), fetched_at: Date.now() })
    .onConflict((oc) =>
      oc.column('domain').doUpdateSet({ info: JSON.stringify(info), fetched_at: Date.now() }),
    )
    .execute();
  return info;
}

async function fetchRemoteProfile(ctx: AppContext, instance: string, handle: string): Promise<User | null> {
  try {
    const profile = userSchema.parse(
      await fetchRemoteJson(ctx, instance, `${API_PREFIX}/users/${encodeURIComponent(handle)}/profile`),
    );
    if (profile.handle !== handle || profile.instance !== instance) return null;
    return profile;
  } catch (error) {
    ctx.log.warn({ err: error, instance, handle }, 'Could not fetch remote profile');
    return null;
  }
}

async function upsertRemoteUser(
  ctx: AppContext,
  handle: string,
  instance: string,
  remoteId: string,
): Promise<UserRow> {
  let row = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', handle)
    .where('instance', '=', instance)
    .executeTakeFirst();

  // Same address, different account on the home instance (e.g. it was deleted and re-registered).
  // Park the old record so the newcomer doesn't inherit someone else's memberships.
  if (row && row.remote_id !== remoteId) {
    await ctx.db
      .updateTable('users')
      .set({ handle: `${handle}#${row.remote_id ?? 'old'}` })
      .where('id', '=', row.id)
      .execute();
    row = undefined;
  }

  if (!row) {
    const userId = ctx.nextId();
    await ctx.db
      .insertInto('users')
      .values({
        id: userId,
        handle,
        instance,
        display_name: handle,
        avatar_url: null,
        bio: '',
        is_local: 0,
        remote_id: remoteId,
        created_at: Date.now(),
        profile_fetched_at: null,
      })
      .execute();
    row = await ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
  }
  return row;
}

export async function refreshRemoteProfile(ctx: AppContext, row: UserRow, force = false): Promise<UserRow> {
  const fetchedAt = optNum(row.profile_fetched_at);
  if (!force && fetchedAt !== null && Date.now() - fetchedAt < PROFILE_TTL_MS) return row;

  const profile = await fetchRemoteProfile(ctx, row.instance, row.handle);
  if (!profile) return row;

  // Only images hosted by the user's own instance, so a profile can't make everyone load a tracking pixel.
  const home = `${instanceOrigin(row.instance, ctx.config.devInsecure)}/`;
  const avatarUrl = profile.avatarUrl?.startsWith(home) ? profile.avatarUrl : null;
  const changed =
    profile.displayName !== row.display_name || profile.bio !== row.bio || avatarUrl !== row.avatar_url;
  await ctx.db
    .updateTable('users')
    .set({
      display_name: profile.displayName,
      bio: profile.bio,
      avatar_url: avatarUrl,
      profile_fetched_at: Date.now(),
    })
    .where('id', '=', row.id)
    .execute();

  const updated = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();
  if (changed) await broadcastUserUpdate(ctx, serializeUser(updated));
  return updated;
}

export function createChallenge(ctx: AppContext): { nonce: string; expiresAt: number } {
  const { challenges } = ctx.federation;
  const now = Date.now();
  for (const [nonce, expiresAt] of challenges) if (expiresAt < now) challenges.delete(nonce);
  const nonce = randomToken(24);
  const expiresAt = now + CHALLENGE_TTL_MS;
  challenges.set(nonce, expiresAt);
  return { nonce, expiresAt };
}

function consumeChallenge(ctx: AppContext, nonce: string): boolean {
  const expiresAt = ctx.federation.challenges.get(nonce);
  ctx.federation.challenges.delete(nonce);
  return expiresAt !== undefined && expiresAt >= Date.now();
}

export async function federatedAuth(ctx: AppContext, body: FederationAuthBody): Promise<AuthResponse> {
  if (!consumeChallenge(ctx, body.nonce)) throw invalidCert('That sign-in challenge expired. Try again.');

  const { payload } = body.cert;
  const address = parseAddress(payload.sub);
  if (!address || address.instance !== payload.instance) throw invalidCert('That identity is malformed.');
  if (!isDomainAllowed(ctx, address.instance))
    throw denied(`This instance doesn't federate with ${address.instance}.`);

  const info = await getRemoteInstance(ctx, address.instance, { needKid: payload.kid }).catch(
    (error: unknown) => {
      if (error instanceof ApiError) throw error;
      ctx.log.warn({ err: error, instance: address.instance }, 'Could not reach home instance');
      throw denied(`Couldn't reach ${address.instance} to confirm who you are.`);
    },
  );

  const verdict = await verifyIdentityCert(body.cert, info.keys, address.instance);
  if (!verdict.ok) throw invalidCert(`Your identity certificate was rejected (${verdict.error}).`);

  const signed = await verifyBytes(
    body.signature,
    federationChallengeMessage(ctx.config.domain, body.nonce),
    payload.devicePublicKey,
  );
  if (!signed) throw invalidCert("Your device couldn't prove it holds the certified key.");

  const user = await refreshRemoteProfile(
    ctx,
    await upsertRemoteUser(ctx, address.handle, address.instance, payload.uid),
  );
  const token = await createSession(ctx, id(user.id), {
    kind: 'federated',
    deviceName: body.deviceName,
    certSerial: payload.serial,
    expiresAt: payload.exp * 1000,
  });
  return { token, user: serializeUser(user) };
}

/**
 * Asks a remote user's home instance whether their cert was revoked (they signed that device out).
 * Unreachable home instances are tolerated: certs only live a day, so availability wins here.
 */
export async function checkRemoteRevocation(ctx: AppContext, auth: Auth): Promise<boolean> {
  const { session, user } = auth;
  if (session.kind !== 'federated' || !session.certSerial) return true;
  if (session.revocationCheckedAt && Date.now() - session.revocationCheckedAt < REVOCATION_CHECK_INTERVAL_MS)
    return true;

  try {
    const result = z
      .object({ revoked: z.boolean() })
      .parse(
        await fetchRemoteJson(
          ctx,
          user.instance,
          `${API_PREFIX}/federation/certs/${encodeURIComponent(session.certSerial)}`,
        ),
      );
    if (result.revoked) {
      await ctx.db.deleteFrom('sessions').where('id', '=', session.id).execute();
      return false;
    }
  } catch (error) {
    ctx.log.warn({ err: error, instance: user.instance }, 'Revocation check failed; allowing session');
  }
  await ctx.db
    .updateTable('sessions')
    .set({ revocation_checked_at: Date.now() })
    .where('id', '=', session.id)
    .execute();
  return true;
}

export async function getGuildIndex(ctx: AppContext, userId: string): Promise<GuildIndexEntry[]> {
  const rows = await ctx.db
    .selectFrom('guild_index')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('position')
    .execute();
  return rows.map((r) => ({ instance: r.instance, guildId: r.guild_id, position: num(r.position) }));
}

export async function setGuildIndex(
  ctx: AppContext,
  userId: string,
  entries: GuildIndexEntry[],
): Promise<GuildIndexEntry[]> {
  const unique = new Map(entries.map((e) => [`${e.instance}/${e.guildId}`, e]));
  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom('guild_index').where('user_id', '=', userId).execute();
    if (unique.size > 0) {
      await trx
        .insertInto('guild_index')
        .values(
          [...unique.values()].map((e) => ({
            user_id: userId,
            instance: e.instance,
            guild_id: e.guildId,
            position: e.position,
          })),
        )
        .execute();
    }
  });
  return getGuildIndex(ctx, userId);
}
