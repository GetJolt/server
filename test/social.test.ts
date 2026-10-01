import { feedKey, type JoltApiError, type JoltSession } from '@getjolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let a: TestInstance;
let alice: JoltSession;
let bob: JoltSession;
let carol: JoltSession;

const idOf = (s: JoltSession) => s.state.me[a.domain]!.id;
const homePosts = (s: JoltSession) =>
  s.social.feed(feedKey.home).entries.map((e) => s.social.state.posts[e.postId]?.text);

beforeAll(async () => {
  a = await startInstance();
  [alice, bob, carol] = await Promise.all([signUp(a, 'alice'), signUp(a, 'bob'), signUp(a, 'carol')]);
});

afterAll(async () => {
  await Promise.all([alice?.signOut(), bob?.signOut(), carol?.signOut()]);
  await a?.close();
});

describe('posts and timelines', () => {
  it('shows your own posts straight away and followers get them live', async () => {
    await bob.social.setFollowing(idOf(alice), true);
    await Promise.all([alice.social.loadFeed(feedKey.home), bob.social.loadFeed(feedKey.home)]);

    const post = await alice.social.createPost({ text: 'Hello @bob, welcome to #jolt https://joltapp.org' });
    expect(homePosts(alice)[0]).toBe(post.text);
    expect(post.facets.map((f) => f.kind)).toEqual(['mention', 'tag', 'link']);
    expect(post.facets[0]!.userId).toBe(idOf(bob));

    // Bob follows Alice, so the post arrives in the background, waiting behind "Show new posts".
    await waitFor(() => bob.social.feed(feedKey.home).fresh.length === 1);
    bob.social.showFresh();
    expect(homePosts(bob)[0]).toBe(post.text);

    // Carol doesn't follow Alice and sees nothing.
    await carol.social.loadFeed(feedKey.home);
    expect(homePosts(carol)).toEqual([]);
  });

  it('counts likes and reposts, and notifies the author', async () => {
    await alice.social.loadNotifications();
    const post = await alice.social.createPost({ text: 'Like this one' });
    await bob.social.loadThread(post.id);

    await bob.social.toggleLike(post.id);
    await bob.social.toggleRepost(post.id);
    expect(bob.social.state.posts[post.id]!.counts).toMatchObject({ likes: 1, reposts: 1 });
    expect(bob.social.state.posts[post.id]!.viewer).toEqual({ liked: true, reposted: true });

    await waitFor(() => alice.social.state.notifications.unread >= 2);
    const types = alice.social.state.notifications.items.map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(['like', 'repost']));

    await bob.social.toggleLike(post.id);
    expect(bob.social.state.posts[post.id]!.counts.likes).toBe(0);
  });

  it('threads replies and hides followers-only posts from strangers', async () => {
    const root = await alice.social.createPost({ text: 'Root post' });
    const reply = await bob.social.createPost({ text: 'A reply', replyTo: root });
    await alice.social.loadThread(root.id);
    expect(alice.social.state.threads[root.id]!.replies).toEqual([reply.id]);
    expect(alice.social.state.posts[root.id]!.counts.replies).toBe(1);

    const secret = await alice.social.createPost({ text: 'Followers only', visibility: 'followers' });
    const denied = await carol
      .rest(a.domain)
      .post(secret.id)
      .catch((e: JoltApiError) => e);
    expect((denied as JoltApiError).status).toBe(404);
    expect((await bob.rest(a.domain).post(secret.id)).text).toBe('Followers only');
  });

  it('attaches uploaded images with alt text', async () => {
    const upload = await alice.social.uploadMedia(new Blob([PIXEL], { type: 'image/png' }));
    const post = await alice.social.createPost({ text: '', media: [{ ...upload, alt: 'A single pixel' }] });
    expect(post.media).toEqual([expect.objectContaining({ alt: 'A single pixel', width: 1, height: 1 })]);

    // Someone else can't attach Alice's upload.
    const stolen = await bob
      .rest(a.domain)
      .createPost({ text: 'mine', media: [{ id: upload.id }] })
      .catch((e: JoltApiError) => e);
    expect((stolen as JoltApiError).status).toBe(400);
  });

  it('pages through profiles and removes deleted posts everywhere', async () => {
    for (let i = 0; i < 4; i++) await carol.social.createPost({ text: `Carol ${i}` });
    const page1 = await alice.rest(a.domain).profilePosts(idOf(carol), { limit: 3 });
    const page2 = await alice.rest(a.domain).profilePosts(idOf(carol), { limit: 3, before: page1.cursor! });
    expect([...page1.items, ...page2.items].map((i) => i.post.text)).toEqual([
      'Carol 3',
      'Carol 2',
      'Carol 1',
      'Carol 0',
    ]);
    expect(page2.cursor).toBeNull();

    const profile = await alice.social.lookup('carol');
    expect(profile.counts.posts).toBe(4);

    const doomed = page1.items[0]!.post;
    await carol.social.loadFeed(feedKey.home);
    await carol.social.deletePost(doomed.id);
    expect(homePosts(carol)).not.toContain('Carol 3');
    const gone = await alice
      .rest(a.domain)
      .post(doomed.id)
      .catch((e: JoltApiError) => e);
    expect((gone as JoltApiError).status).toBe(404);
  });
});
