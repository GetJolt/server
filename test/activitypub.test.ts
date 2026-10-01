import { feedKey, type JoltSession } from '@getjolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

let a: TestInstance;
let b: TestInstance;
let alice: JoltSession;
let bob: JoltSession;

const AP = { accept: 'application/activity+json' };

interface Links {
  links: Array<{ rel: string; href: string }>;
}
interface ActorDoc {
  type: string;
  preferredUsername: string;
  inbox: string;
  publicKey: { publicKeyPem: string };
}
interface NodeInfoDoc {
  software: { name: string };
  protocols: string[];
}
const getJson = async <T>(url: string, init?: RequestInit) => (await fetch(url, init)).json() as Promise<T>;
const meOn = (s: JoltSession, t: TestInstance) => s.state.me[t.domain]!;

beforeAll(async () => {
  [a, b] = await Promise.all([startInstance({ name: 'A' }), startInstance({ name: 'B' })]);
  [alice, bob] = await Promise.all([signUp(a, 'alice'), signUp(b, 'bob')]);
});

afterAll(async () => {
  await Promise.all([alice?.signOut(), bob?.signOut()]);
  await Promise.all([a?.close(), b?.close()]);
});

// Each round trip goes through both instances' delivery queues, so these need more than the default 5s.
describe('ActivityPub', { timeout: 20_000 }, () => {
  it('publishes WebFinger, NodeInfo and actor documents', async () => {
    const jrd = await getJson<Links>(
      `http://${a.domain}/.well-known/webfinger?resource=acct:alice@${a.domain}`,
    );
    const self = jrd.links.find((l) => l.rel === 'self')!;
    expect(self.href).toBe(`http://${a.domain}/users/${meOn(alice, a).id}`);

    const actor = await getJson<ActorDoc>(self.href, { headers: AP });
    expect(actor).toMatchObject({ type: 'Person', preferredUsername: 'alice', inbox: expect.any(String) });
    expect(actor.publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY');

    // A browser opening the same address lands on the profile page instead.
    const page = await fetch(self.href, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/@alice');

    const links = await getJson<Links>(`http://${a.domain}/.well-known/nodeinfo`);
    const nodeinfo = await getJson<NodeInfoDoc>(links.links[0]!.href);
    expect(nodeinfo.software.name).toBe('jolt');
    expect(nodeinfo.protocols).toEqual(['activitypub']);
  });

  it('follows someone on another instance and receives their posts', async () => {
    const profile = await bob.social.lookup(`alice@${a.domain}`);
    expect(profile.user).toMatchObject({ handle: 'alice', instance: a.domain, local: false });

    await bob.social.setFollowing(profile.user.id, true);
    await waitFor(() => bob.social.relationship(profile.user.id)?.following === 'following', 8000);

    await bob.social.loadFeed(feedKey.home);
    const post = await alice.social.createPost({ text: `Hello fediverse, from ${a.domain} #jolt` });
    await waitFor(() => bob.social.feed(feedKey.home).fresh.length > 0, 8000);
    bob.social.showFresh();
    const remote = bob.social.state.posts[bob.social.feed(feedKey.home).entries[0]!.postId]!;
    expect(remote.text).toBe(post.text);
    expect(remote.source).toBe('activitypub');
    expect(remote.facets.find((f) => f.kind === 'tag')?.value).toBe('jolt');

    // Alice sees Bob as a follower, with a notification about it.
    await alice.social.loadNotifications();
    await waitFor(() => alice.social.state.notifications.items.some((n) => n.type === 'follow'));
  });

  it('carries likes and replies back to the author', async () => {
    const post = await alice.social.createPost({ text: 'Like and reply to this' });
    await bob.social.loadFeed(feedKey.home);
    const copy = await waitFor(async () => {
      await bob.social.loadFeed(feedKey.home);
      const entry = bob.social
        .feed(feedKey.home)
        .entries.find((e) => bob.social.state.posts[e.postId]?.text === post.text);
      return entry ? bob.social.state.posts[entry.postId] : undefined;
    }, 8000);

    await bob.social.toggleLike(copy!.id);
    await bob.social.createPost({ text: 'A reply from B', replyTo: copy! });

    await waitFor(async () => {
      const fresh = await alice.rest(a.domain).post(post.id);
      return fresh.counts.likes === 1 && fresh.counts.replies === 1;
    }, 8000);
    const thread = await alice.rest(a.domain).thread(post.id);
    expect(thread.replies[0]).toMatchObject({ text: 'A reply from B', source: 'activitypub' });
    expect(thread.replies[0]!.author).toMatchObject({ handle: 'bob', instance: b.domain });
  });

  it('removes deleted posts and passes on profile changes', async () => {
    const post = await alice.social.createPost({ text: 'Short-lived' });
    const find = async () => {
      const page = await bob.rest(b.domain).timeline();
      return page.items.find((i) => i.post.text === 'Short-lived');
    };
    const copy = await waitFor(find, 8000);
    await alice.social.deletePost(post.id);
    await waitFor(async () => !(await find()), 8000);
    const gone = await bob
      .rest(b.domain)
      .post(copy.post.id)
      .catch((e: { status: number }) => e);
    expect((gone as { status: number }).status).toBe(404);

    await alice.updateProfile({ displayName: 'Alice from A' });
    await waitFor(async () => {
      const profile = await bob.social.lookup(`alice@${a.domain}`);
      return profile.user.displayName === 'Alice from A';
    }, 8000);
  });

  it('refuses activity from blocked servers', async () => {
    const c = await startInstance({ federationBlock: [b.domain] });
    try {
      const carol = await signUp(c, 'carol');
      const result = await bob.social.lookup(`carol@${c.domain}`).catch((e: { status: number }) => e);
      // B can see C, but C refuses B's follow because B is blocked there.
      if ('user' in result) {
        await bob.social.setFollowing(result.user.id, true);
        await new Promise((r) => setTimeout(r, 1500));
        expect(bob.social.relationship(result.user.id)?.following).toBe('pending');
      }
      await carol.signOut();
    } finally {
      await c.close();
    }
  });
});
