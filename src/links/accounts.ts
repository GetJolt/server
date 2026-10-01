// Linked Bluesky and Mastodon accounts: storing them, listing them, and the flow state that ties an OAuth sign-in
// on another site back to the Jolt user who started it.

import { randomBytes } from 'node:crypto';
import type { LinkedAccount, LinkProvider, PublicLink, UpdateLinkBody } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { LinkedAccountRow } from '../db/schema.js';
import { flag, id, num } from '../db/values.js';
import { userTopic } from '../events/EventBus.js';
import { badRequest, notFound } from '../http/errors.js';

/** How long someone has to finish signing in on the other site. */
const FLOW_TTL_MS = 10 * 60 * 1000;

export function serializeLink(row: LinkedAccountRow): LinkedAccount {
  return {
    id: id(row.id),
    provider: row.provider,
    handle: row.handle,
    url: row.url,
    verified: row.verified_at !== null,
    crosspostDefault: flag(row.crosspost_default),
    showTimeline: flag(row.show_timeline),
    createdAt: num(row.created_at),
  };
}

export async function listLinks(ctx: AppContext, userId: string): Promise<LinkedAccount[]> {
  const rows = await ctx.db
    .selectFrom('linked_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  return rows.map(serializeLink);
}

/** Verified links, for profiles, the public page and the ActivityPub actor. */
export async function publicLinks(ctx: AppContext, userId: string): Promise<PublicLink[]> {
  return (await listLinks(ctx, userId))
    .filter((l) => l.verified)
    .map(({ provider, handle, url, verified }) => ({ provider, handle, url, verified }));
}

export async function linkRow(ctx: AppContext, userId: string, linkId: string): Promise<LinkedAccountRow> {
  const row = /^\d{1,20}$/.test(linkId)
    ? await ctx.db
        .selectFrom('linked_accounts')
        .selectAll()
        .where('id', '=', linkId)
        .where('user_id', '=', userId)
        .executeTakeFirst()
    : undefined;
  if (!row) throw notFound('That linked account');
  return row;
}

async function publish(ctx: AppContext, userId: string) {
  ctx.bus.publish(userTopic(userId), { t: 'LINKED_ACCOUNTS_UPDATE', d: await listLinks(ctx, userId) });
  await ctx.hooks.onProfileUpdated?.(userId);
}

interface SaveLink {
  provider: LinkProvider;
  externalId: string;
  handle: string;
  url: string;
  secret: string | null;
  verified: boolean;
}

/** Adds a link, or refreshes it if this account was linked before. */
export async function saveLink(ctx: AppContext, userId: string, link: SaveLink): Promise<LinkedAccount> {
  const now = Date.now();
  const values = {
    handle: link.handle,
    url: link.url,
    secret: link.secret === null ? null : ctx.secrets.seal(link.secret),
    verified_at: link.verified ? now : null,
  };
  await ctx.db
    .insertInto('linked_accounts')
    .values({
      id: ctx.nextId(),
      user_id: userId,
      provider: link.provider,
      external_id: link.externalId,
      crosspost_default: 0,
      show_timeline: 1,
      created_at: now,
      ...values,
    })
    .onConflict((oc) => oc.columns(['user_id', 'provider', 'external_id']).doUpdateSet(values))
    .execute();
  await publish(ctx, userId);
  const row = await ctx.db
    .selectFrom('linked_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .where('provider', '=', link.provider)
    .where('external_id', '=', link.externalId)
    .executeTakeFirstOrThrow();
  return serializeLink(row);
}

export async function updateLink(
  ctx: AppContext,
  userId: string,
  linkId: string,
  body: UpdateLinkBody,
): Promise<LinkedAccount> {
  const row = await linkRow(ctx, userId, linkId);
  const changes: { crosspost_default?: number; show_timeline?: number } = {};
  if (body.crosspostDefault !== undefined) changes.crosspost_default = body.crosspostDefault ? 1 : 0;
  if (body.showTimeline !== undefined) changes.show_timeline = body.showTimeline ? 1 : 0;
  if (Object.keys(changes).length) {
    await ctx.db.updateTable('linked_accounts').set(changes).where('id', '=', row.id).execute();
  }
  await publish(ctx, userId);
  return serializeLink({ ...row, ...changes });
}

export async function deleteLink(ctx: AppContext, userId: string, row: LinkedAccountRow): Promise<void> {
  await ctx.db.deleteFrom('linked_accounts').where('id', '=', row.id).execute();
  await publish(ctx, userId);
}

/** The decrypted secret stored with a link. */
export function openSecret<T>(ctx: AppContext, row: LinkedAccountRow): T {
  if (!row.secret) throw badRequest('That account needs linking again.');
  return JSON.parse(ctx.secrets.open(row.secret)) as T;
}

export async function startFlow(
  ctx: AppContext,
  userId: string,
  provider: LinkProvider,
  data: Record<string, unknown>,
  state = randomBytes(24).toString('base64url'),
): Promise<string> {
  await ctx.db.deleteFrom('oauth_flows').where('expires_at', '<', Date.now()).execute();
  await ctx.db
    .insertInto('oauth_flows')
    .values({
      state,
      user_id: userId,
      provider,
      data: ctx.secrets.seal(JSON.stringify(data)),
      expires_at: Date.now() + FLOW_TTL_MS,
    })
    .execute();
  return state;
}

/** Takes a flow back out by its state. Each one works once, and only before it expires. */
export async function finishFlow<T>(
  ctx: AppContext,
  provider: LinkProvider,
  state: string,
): Promise<{ userId: string; data: T }> {
  const row = await ctx.db
    .selectFrom('oauth_flows')
    .selectAll()
    .where('state', '=', state)
    .executeTakeFirst();
  await ctx.db.deleteFrom('oauth_flows').where('state', '=', state).execute();
  if (!row || row.provider !== provider || num(row.expires_at) < Date.now()) {
    throw badRequest('That sign-in link has expired. Start again from Jolt.');
  }
  return { userId: id(row.user_id), data: JSON.parse(ctx.secrets.open(row.data)) as T };
}
