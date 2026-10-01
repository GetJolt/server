// Remote ActivityPub accounts are stored as ordinary rows in `users`, so posts, follows and notifications treat
// them like anyone else. A remote Jolt user and their ActivityPub actor end up as the same row.

import { isActor, type Actor } from '@fedify/fedify/vocab';
import { instanceOrigin, normalizeInstance } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { flag, id, optNum } from '../db/values.js';
import { badRequest, forbidden } from '../http/errors.js';
import { fetchRemoteJson, isDomainAllowed } from '../services/federation.js';
import { broadcastUserUpdate, serializeUser } from '../services/users.js';
import { htmlToRichText } from './html.js';

/** How long a remote profile is trusted before it's fetched again. */
const ACTOR_TTL_MS = 24 * 60 * 60 * 1000;

const plain = (value: unknown) => (value == null ? '' : String(value));
const href = (value: unknown): string | null => {
  if (value instanceof URL) return value.href;
  if (value && typeof value === 'object' && 'href' in value && value.href instanceof URL)
    return value.href.href;
  return null;
};

export function assertAllowed(ctx: AppContext, url: URL | string): void {
  const host = normalizeInstance(new URL(url).host);
  if (!isDomainAllowed(ctx, host)) throw forbidden(`This instance doesn't federate with ${host}.`);
}

/** Creates or refreshes the local row for a remote actor. */
export async function upsertRemoteActor(ctx: AppContext, actor: Actor): Promise<UserRow> {
  if (!actor.id) throw badRequest('That account has no id.');
  const apId = actor.id.href;
  const instance = normalizeInstance(actor.id.host);
  const handle = plain(actor.preferredUsername).toLowerCase() || apId.split('/').pop()!.toLowerCase();
  const icon = await actor.getIcon().catch(() => null);
  const avatar = href(icon?.url);
  const scheme = ctx.config.devInsecure ? /^https?:\/\//i : /^https:\/\//i;

  const fields = {
    display_name: (plain(actor.name) || handle).slice(0, 64),
    bio: htmlToRichText(plain(actor.summary)).text.slice(0, 500),
    avatar_url: avatar && scheme.test(avatar) ? avatar : null,
    ap_id: apId,
    ap_inbox: actor.inboxId?.href ?? null,
    ap_shared_inbox: actor.endpoints?.sharedInbox?.href ?? null,
    ap_url: href(actor.url) ?? apId,
    ap_followers: actor.followersId?.href ?? null,
    profile_fetched_at: Date.now(),
  };

  let row =
    (await ctx.db.selectFrom('users').selectAll().where('ap_id', '=', apId).executeTakeFirst()) ??
    (await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('handle', '=', handle)
      .where('instance', '=', instance)
      .where('is_local', '=', 0)
      .executeTakeFirst());

  if (row && row.ap_id && row.ap_id !== apId) {
    // Same address, different actor: the account was recreated. Keep the old row's history under another name.
    await ctx.db
      .updateTable('users')
      .set({ handle: `${handle}#${id(row.id)}` })
      .where('id', '=', row.id)
      .execute();
    row = undefined;
  }

  if (row) {
    const changed =
      row.display_name !== fields.display_name ||
      row.bio !== fields.bio ||
      row.avatar_url !== fields.avatar_url;
    await ctx.db.updateTable('users').set(fields).where('id', '=', row.id).execute();
    const updated = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    if (changed) await broadcastUserUpdate(ctx, serializeUser(updated));
    return updated;
  }

  const userId = ctx.nextId();
  await ctx.db
    .insertInto('users')
    .values({
      id: userId,
      handle,
      instance,
      is_local: 0,
      remote_id: null,
      created_at: Date.now(),
      ...fields,
    })
    .execute();
  return ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
}

/** The local row for a remote actor URI, fetching the actor if we don't know them or haven't looked lately. */
export async function actorByUri(ctx: AppContext, uri: URL): Promise<UserRow | null> {
  const known = await ctx.db.selectFrom('users').selectAll().where('ap_id', '=', uri.href).executeTakeFirst();
  const fetchedAt = known ? optNum(known.profile_fetched_at) : null;
  if (known && fetchedAt !== null && Date.now() - fetchedAt < ACTOR_TTL_MS) return known;

  assertAllowed(ctx, uri);
  const object = await ctx
    .ap!.context()
    .lookupObject(uri)
    .catch(() => null);
  if (!object || !isActor(object)) return known ?? null;
  return upsertRemoteActor(ctx, object);
}

/**
 * Finds `user@server`, `@user@server` or a profile URL. Addresses go through WebFinger ourselves rather than
 * through Fedify so that development instances on plain http work too.
 */
export async function resolveAccount(ctx: AppContext, address: string): Promise<UserRow | null> {
  const raw = address.trim().replace(/^@/, '');
  if (/^https?:\/\//i.test(raw)) return actorByUri(ctx, new URL(raw));

  const at = raw.lastIndexOf('@');
  if (at <= 0) return null;
  const user = raw.slice(0, at);
  const domain = normalizeInstance(raw.slice(at + 1));
  const existing = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', user.toLowerCase())
    .where('instance', '=', domain)
    .where('ap_id', 'is not', null)
    .executeTakeFirst();
  if (existing && Date.now() - (optNum(existing.profile_fetched_at) ?? 0) < ACTOR_TTL_MS) return existing;

  if (!isDomainAllowed(ctx, domain)) throw forbidden(`This instance doesn't federate with ${domain}.`);
  const resource = encodeURIComponent(`acct:${user}@${domain}`);
  const jrd = (await fetchRemoteJson(ctx, domain, `/.well-known/webfinger?resource=${resource}`).catch(
    () => null,
  )) as { links?: Array<{ rel?: string; type?: string; href?: string }> } | null;
  const self = jrd?.links?.find(
    (l) => l.rel === 'self' && /application\/(activity|ld)\+json/.test(l.type ?? '') && l.href,
  );
  if (!self?.href) return existing ?? null;
  return actorByUri(ctx, new URL(self.href));
}

/** Makes sure a remote user row can be reached over ActivityPub, looking them up by address if needed. */
export async function ensureActor(ctx: AppContext, row: UserRow): Promise<UserRow | null> {
  if (flag(row.is_local)) return null;
  if (row.ap_id && row.ap_inbox) return row;
  return resolveAccount(ctx, `${row.handle}@${row.instance}`);
}

export const instanceUrl = (ctx: AppContext) => instanceOrigin(ctx.config.domain, ctx.config.devInsecure);
