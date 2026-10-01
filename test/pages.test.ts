import type { JoltSession } from '@getjolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

let a: TestInstance;
let b: TestInstance;
let alice: JoltSession;
let bob: JoltSession;

const html = async (url: string, accept = 'text/html') => {
  const res = await fetch(url, { headers: { accept }, redirect: 'manual' });
  return { res, body: await res.text() };
};

beforeAll(async () => {
  [a, b] = await Promise.all([startInstance({ name: 'Instance A' }), startInstance()]);
  [alice, bob] = await Promise.all([signUp(a, 'alice'), signUp(b, 'bob')]);
  await alice.updateProfile({ displayName: 'Alice Rivera', bio: 'Design lead <b>not bold</b>' });
});

afterAll(async () => {
  await Promise.all([alice?.signOut(), bob?.signOut()]);
  await Promise.all([a?.close(), b?.close()]);
});

describe('public pages', { timeout: 20_000 }, () => {
  it('renders a profile with its public posts and no scripts', async () => {
    await alice.social.createPost({ text: 'Visible to everyone <script>alert(1)</script> #jolt' });
    await alice.social.createPost({ text: 'Only for followers', visibility: 'followers' });

    const { res, body } = await html(`http://${a.domain}/@alice`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(body).toContain('Alice Rivera');
    expect(body).toContain('Design lead &lt;b&gt;not bold&lt;/b&gt;');
    expect(body).toContain('Visible to everyone &lt;script&gt;');
    expect(body).not.toContain('<script');
    expect(body).not.toContain('Only for followers');
    expect(body).toContain(`rel="alternate" type="application/activity+json"`);
  });

  it('serves single posts, but not followers-only ones', async () => {
    const post = await alice.social.createPost({ text: 'A post worth linking to' });
    const { res, body } = await html(post.url!);
    expect(res.status).toBe(200);
    expect(body).toContain('<meta property="og:description" content="A post worth linking to">');

    const secret = await alice.social.createPost({ text: 'Secret', visibility: 'followers' });
    expect((await html(`http://${a.domain}/@alice/posts/${secret.id}`)).res.status).toBe(404);
    expect((await html(`http://${a.domain}/@nobody`)).res.status).toBe(404);
  });

  it('sends fediverse software to the ActivityPub documents', async () => {
    const post = await alice.social.createPost({ text: 'Fetch me' });
    const profile = await html(`http://${a.domain}/@alice`, 'application/activity+json');
    expect(profile.res.status).toBe(302);
    expect(profile.res.headers.get('location')).toMatch(/\/users\/\d+$/);
    const note = await html(post.url!, 'application/activity+json');
    expect(note.res.headers.get('location')).toBe(`http://${a.domain}/posts/${post.id}`);
  });

  it('opens a post link from another instance', async () => {
    const post = await alice.social.createPost({ text: 'Paste this link elsewhere' });
    const found = await waitFor(
      () =>
        bob
          .rest(b.domain)
          .lookupPost(post.url!)
          .catch(() => null),
      8000,
    );
    expect(found).toMatchObject({ text: 'Paste this link elsewhere', source: 'activitypub' });
    expect(found.author).toMatchObject({ handle: 'alice', instance: a.domain });
  });
});
