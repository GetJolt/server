import { createHash } from 'node:crypto';
import type { JoltSession } from '@getjolt/sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { freePort, signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

/** Just enough of Mastodon's OAuth and account API to link against, checking what a real server would check. */
async function fakeMastodon(joltDomain: string) {
  const port = await freePort();
  const domain = `localhost:${port}`;
  const seen = {
    revoked: [] as string[],
    challenge: '',
    redirect: '',
    media: [] as string[],
    statuses: [] as Array<Record<string, unknown>>,
    deleted: [] as string[],
  };
  const app: FastifyInstance = Fastify();
  app.post('/api/v1/apps', async (req) => {
    seen.redirect = (req.body as { redirect_uris: string }).redirect_uris;
    return { client_id: 'cid', client_secret: 'csecret' };
  });
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== 'cid' || q.code_challenge_method !== 'S256') return reply.status(400).send();
    seen.challenge = q.code_challenge!;
    // The user approves straight away.
    return reply.redirect(`${q.redirect_uri}?code=the-code&state=${encodeURIComponent(q.state!)}`, 302);
  });
  app.post('/oauth/token', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const verifies =
      createHash('sha256')
        .update(b.code_verifier ?? '')
        .digest('base64url') === seen.challenge;
    if (b.client_secret !== 'csecret' || b.code !== 'the-code' || !verifies) return reply.status(400).send();
    return { access_token: 'tok', token_type: 'Bearer' };
  });
  app.get('/api/v1/accounts/verify_credentials', async (req, reply) =>
    req.headers.authorization === 'Bearer tok'
      ? { id: '42', username: 'lou', acct: 'lou', url: `http://${domain}/@lou` }
      : reply.status(401).send(),
  );
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  app.post('/api/v2/media', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer tok') return reply.status(401).send();
    seen.media.push((req.body as Buffer).toString('latin1'));
    return { id: `m${seen.media.length}` };
  });
  app.post('/api/v1/statuses', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer tok') return reply.status(401).send();
    seen.statuses.push({ ...(req.body as Record<string, unknown>), key: req.headers['idempotency-key'] });
    const id = String(seen.statuses.length);
    return {
      ...status(id),
      url: `http://${domain}/@lou/${id}`,
      account: { ...sam, id: '42', username: 'lou', acct: 'lou' },
    };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/statuses/:id', async (req) => {
    seen.deleted.push(req.params.id);
    return {};
  });
  const sam = {
    id: '7',
    username: 'sam',
    acct: 'sam@elsewhere.example',
    display_name: 'Sam',
    avatar: '',
    url: 'https://elsewhere.example/@sam',
  };
  const status = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    url: `http://${domain}/@sam/${id}`,
    uri: `http://${domain}/statuses/${id}`,
    created_at: '2026-10-01T10:00:00.000Z',
    content:
      '<p>Hello from <a href="https://elsewhere.example/tags/jolt" class="mention hashtag" rel="tag">#<span>jolt</span></a></p>',
    spoiler_text: '',
    visibility: 'public',
    account: sam,
    reblog: null,
    in_reply_to_account_id: null,
    replies_count: 0,
    reblogs_count: 1,
    favourites_count: 2,
    favourited: false,
    reblogged: false,
    mentions: [],
    media_attachments: [
      {
        type: 'image',
        url: 'https://elsewhere.example/a.png',
        description: 'A cat',
        meta: { original: { width: 4, height: 3 } },
      },
    ],
    ...extra,
  });
  app.get('/api/v1/timelines/home', async () => [
    status('100'),
    {
      ...status('101'),
      account: { ...sam, id: '8', username: 'kim', acct: 'kim', display_name: 'Kim' },
      reblog: status('99'),
    },
  ]);
  app.get<{ Params: { id: string } }>('/api/v1/statuses/:id', async (req) => status(req.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/statuses/:id/favourite', async (req) =>
    status(req.params.id, { favourited: true, favourites_count: 3 }),
  );
  app.get('/api/v1/accounts/42/following', async () => [
    {
      acct: `bob@${joltDomain}`,
      username: 'bob',
      display_name: 'Bob',
      avatar: '',
      url: `http://${joltDomain}/@bob`,
    },
    sam,
  ]);
  app.post('/oauth/revoke', async (req) => {
    seen.revoked.push((req.body as { token: string }).token);
    return {};
  });
  await app.listen({ host: '127.0.0.1', port });
  return { domain, seen, close: () => app.close() };
}

let a: TestInstance;
let alice: JoltSession;
let bob: JoltSession;
let mastodon: Awaited<ReturnType<typeof fakeMastodon>>;

beforeAll(async () => {
  a = await startInstance();
  mastodon = await fakeMastodon(a.domain);
  [alice, bob] = await Promise.all([signUp(a, 'alice'), signUp(a, 'bob')]);
});

afterAll(async () => {
  await Promise.all([alice?.signOut(), bob?.signOut()]);
  await Promise.all([a?.close(), mastodon?.close()]);
});

describe('linked accounts', { timeout: 20_000 }, () => {
  it('links a Mastodon account and shows it as verified everywhere', async () => {
    const url = await alice.social.linkAccount('mastodon', `@lou@${mastodon.domain}`);
    expect(mastodon.seen.redirect).toBe(`http://${a.domain}/oauth/mastodon/callback`);

    // The browser goes to Mastodon, the user approves, and Mastodon sends them back to the instance.
    const approve = await fetch(url, { redirect: 'manual' });
    const callback = approve.headers.get('location')!;
    const done = await fetch(callback);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain(`@lou@${mastodon.domain} is now linked`);

    const link = await waitFor(() => alice.social.state.linkedAccounts[0]);
    expect(link).toMatchObject({ provider: 'mastodon', handle: `@lou@${mastodon.domain}`, verified: true });

    // Using the same sign-in link twice doesn't work.
    expect((await fetch(callback)).status).toBe(400);

    const page = await (await fetch(`http://${a.domain}/@alice`)).text();
    expect(page).toContain(`rel="me nofollow noopener" href="http://${mastodon.domain}/@lou"`);
    const actorUrl = `http://${a.domain}/users/${alice.state.me[a.domain]!.id}`;
    const actor = (await (
      await fetch(actorUrl, { headers: { accept: 'application/activity+json' } })
    ).json()) as {
      attachment: { name: string; value: string } | Array<{ name: string; value: string }>;
    };
    // Compacted JSON-LD writes a single attachment as an object rather than a list of one.
    expect([actor.attachment].flat()).toEqual([expect.objectContaining({ name: 'Mastodon' })]);
  });

  it('cross-posts to Mastodon and follows up deletes', async () => {
    const link = alice.social.state.linkedAccounts[0]!;
    const PIXEL = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const image = await alice.social.uploadMedia(new Blob([PIXEL], { type: 'image/png' }));
    const first = await alice.social.createPost({
      text: 'Hello Mastodon @alice',
      cw: 'Testing',
      media: [{ ...image, alt: 'One pixel' }],
      crosspost: [link.id],
    });
    await waitFor(() => mastodon.seen.statuses.length === 1, 8000);
    expect(mastodon.seen.statuses[0]).toMatchObject({
      status: `Hello Mastodon @alice@${a.domain}`,
      spoiler_text: 'Testing',
      sensitive: true,
      media_ids: ['m1'],
      key: `jolt-${first.id}`,
    });
    expect(mastodon.seen.media[0]).toContain('One pixel');

    // A reply to your own cross-posted post continues the thread there. Mentions grow into full addresses on the
    // way out, which pushes this one past Mastodon's limit, so it's trimmed with a link to the original.
    const long = await alice.social.createPost({
      text: 'hi @alice '.repeat(48).trim(),
      replyTo: first,
      crosspost: [link.id],
    });
    await waitFor(() => mastodon.seen.statuses.length === 2, 8000);
    const reply = mastodon.seen.statuses[1]!;
    expect(reply.in_reply_to_id).toBe('1');
    expect([...String(reply.status)].length).toBeLessThanOrEqual(500);
    expect(String(reply.status).endsWith(`…\n\n${long.url}`)).toBe(true);

    // Followers-only posts never leave Jolt.
    await alice.social.createPost({
      text: 'Just for followers',
      visibility: 'followers',
      crosspost: [link.id],
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(mastodon.seen.statuses).toHaveLength(2);

    await alice.social.deletePost(first.id);
    await waitFor(() => mastodon.seen.deleted.includes('1'), 8000);
  });

  it("reads the linked account's timeline and acts on it as that account", async () => {
    const link = alice.social.state.linkedAccounts[0]!;
    const key = `link:${link.id}`;
    await alice.social.loadFeed(key);
    const entries = alice.social.feed(key).entries;
    expect(entries).toHaveLength(2);
    const post = alice.social.state.posts[entries[0]!.postId]!;
    expect(post).toMatchObject({
      source: 'mastodon',
      text: 'Hello from #jolt',
      media: [expect.objectContaining({ alt: 'A cat' })],
    });
    expect(post.author).toMatchObject({ handle: 'sam', instance: 'elsewhere.example' });
    expect(entries[1]!.repostedBy?.displayName).toBe('Kim');

    await alice.social.toggleLike(post.id);
    expect(alice.social.state.posts[post.id]!.viewer.liked).toBe(true);
    expect(alice.social.state.posts[post.id]!.counts.likes).toBe(3);

    const before = mastodon.seen.statuses.length;
    const reply = await alice.social.createPost({ text: 'Nice one', replyTo: post });
    expect(reply.source).toBe('mastodon');
    expect(mastodon.seen.statuses[before]).toMatchObject({
      status: '@sam@elsewhere.example Nice one',
      in_reply_to_id: '100',
    });
  });

  it('finds people you follow there, with Jolt users first', async () => {
    const link = alice.social.state.linkedAccounts[0]!;
    const friends = await alice.social.findFriends(link.id);
    expect(friends.map((f) => [f.via, f.address])).toEqual([
      ['jolt', `bob@${a.domain}`],
      ['activitypub', 'sam@elsewhere.example'],
    ]);
    expect(friends[0]!.user).toMatchObject({ handle: 'bob', local: true });
  });

  it('changes settings and revokes the token when unlinked', async () => {
    const link = alice.social.state.linkedAccounts[0]!;
    await alice.social.updateLink(link.id, { crosspostDefault: true });
    expect(alice.social.state.linkedAccounts[0]!.crosspostDefault).toBe(true);

    await alice.social.unlink(link.id);
    expect(mastodon.seen.revoked).toEqual(['tok']);
    expect(await alice.social.loadLinks()).toEqual([]);
  });

  it('publishes Bluesky client metadata on a public instance', async () => {
    const config = loadConfig({}, { domain: 'jolt.example', database: ':memory:', logLevel: 'silent' });
    const server = await buildServer(config, { logger: false });
    try {
      const metadata = (await server.app.inject('/oauth/bluesky/client-metadata.json')).json();
      expect(metadata).toMatchObject({
        client_id: 'https://jolt.example/oauth/bluesky/client-metadata.json',
        redirect_uris: ['https://jolt.example/oauth/bluesky/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        dpop_bound_access_tokens: true,
      });
      const jwks = (await server.app.inject('/oauth/bluesky/jwks.json')).json() as {
        keys: Array<Record<string, string>>;
      };
      expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'jolt-1' });
      expect(jwks.keys[0]).not.toHaveProperty('d');
    } finally {
      await server.app.close();
    }
  });
});
