// "Find friends": who someone follows on a linked account, and how to follow each of them from Jolt. People on
// Jolt come first, then fediverse accounts that can be followed directly, then Bluesky accounts through Bridgy Fed.

import type { FriendSuggestion } from '@getjolt/protocol';
import type { AppContext } from '../context.js';
import type { LinkedAccountRow } from '../db/schema.js';
import { id } from '../db/values.js';
import { getLocalUserByHandle, getUsers } from '../services/users.js';
import { openSecret } from './accounts.js';
import { blueskyAgent } from './bluesky.js';
import { mastodonFetch, type MastodonToken } from './mastodon.js';

/** Enough to cover most people without hammering anyone's API. */
const MAX_FOLLOWS = 400;

interface Candidate {
  name: string;
  handle: string;
  avatarUrl: string | null;
  address: string | null;
  via: FriendSuggestion['via'];
  /** A Jolt user known to be this person. */
  userId?: string;
}

async function jolters(
  ctx: AppContext,
  provider: 'bluesky' | 'mastodon',
  ids: string[],
  column: 'external_id' | 'url',
) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await ctx.db
    .selectFrom('linked_accounts')
    .select(['user_id', 'external_id', 'url'])
    .where('provider', '=', provider)
    .where(column, 'in', ids)
    .where('verified_at', 'is not', null)
    .execute();
  return new Map(rows.map((r) => [r[column], id(r.user_id)] as const));
}

async function blueskyFollows(ctx: AppContext, link: LinkedAccountRow): Promise<Candidate[]> {
  const agent = await blueskyAgent(ctx, link);
  const follows: Array<{ did: string; handle: string; displayName?: string; avatar?: string }> = [];
  let cursor: string | undefined;
  do {
    const { data } = await agent.getFollows({ actor: link.external_id, limit: 100, cursor });
    follows.push(...data.follows);
    cursor = data.cursor;
  } while (cursor && follows.length < MAX_FOLLOWS);

  const onJolt = await jolters(
    ctx,
    'bluesky',
    follows.map((f) => f.did),
    'external_id',
  );
  return follows.map((f) => ({
    name: f.displayName || f.handle,
    handle: `@${f.handle}`,
    avatarUrl: f.avatar ?? null,
    // Bridgy Fed only bridges people who opted in; following fails cleanly for everyone else.
    address: `${f.handle}@bsky.brid.gy`,
    via: onJolt.has(f.did) ? 'jolt' : 'bridge',
    userId: onJolt.get(f.did),
  }));
}

interface MastodonAccount {
  acct: string;
  username: string;
  display_name: string;
  avatar: string;
  url: string;
}

async function mastodonFollows(ctx: AppContext, link: LinkedAccountRow): Promise<Candidate[]> {
  const { domain, token, accountId } = openSecret<MastodonToken>(ctx, link);
  const accounts: MastodonAccount[] = [];
  let path: string | null = `/api/v1/accounts/${encodeURIComponent(accountId)}/following?limit=80`;
  while (path && accounts.length < MAX_FOLLOWS) {
    const res = await mastodonFetch(ctx, domain, path, { token });
    if (!res.ok) break;
    accounts.push(...((await res.json()) as MastodonAccount[]));
    // Mastodon pages with a Link header; follow its "next" while it stays on the same server.
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    path =
      next && new URL(next).host === new URL(`http://${domain}`).host
        ? new URL(next).pathname + new URL(next).search
        : null;
  }

  const onJolt = await jolters(
    ctx,
    'mastodon',
    accounts.map((a) => a.url),
    'url',
  );
  return accounts.map((a) => {
    const address = a.acct.includes('@') ? a.acct : `${a.acct}@${domain}`;
    return {
      name: a.display_name || a.username,
      handle: `@${address}`,
      avatarUrl: a.avatar || null,
      address,
      via: onJolt.has(a.url) ? 'jolt' : 'activitypub',
      userId: onJolt.get(a.url),
    };
  });
}

export async function findFriends(ctx: AppContext, link: LinkedAccountRow): Promise<FriendSuggestion[]> {
  const candidates =
    link.provider === 'bluesky' ? await blueskyFollows(ctx, link) : await mastodonFollows(ctx, link);

  // Accounts on this very instance are recognised by address, too.
  for (const c of candidates) {
    const [handle, instance] = (c.address ?? '').split('@');
    if (!c.userId && handle && instance === ctx.config.domain) {
      const local = await getLocalUserByHandle(ctx, handle.toLowerCase());
      if (local) {
        c.userId = id(local.id);
        c.via = 'jolt';
      }
    }
  }

  const users = await getUsers(
    ctx,
    candidates.flatMap((c) => (c.userId ? [c.userId] : [])),
  );
  const rank = { jolt: 0, activitypub: 1, bridge: 2 };
  return candidates
    .filter((c) => c.userId !== id(link.user_id))
    .map(({ userId, ...c }) => ({ ...c, user: userId ? (users.get(userId) ?? null) : null }))
    .sort((a, b) => rank[a.via] - rank[b.via]);
}
