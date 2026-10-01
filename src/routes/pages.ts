// Public web pages for profiles and posts, so a link to `/@alice` or one of her posts opens in any browser. They're
// plain server-rendered HTML with no scripts. Fediverse software asking for ActivityPub at the same address is sent
// to the actor or Note instead.

import { instanceOrigin, Limits, type Post, type PublicLink, type User } from '@getjolt/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { id } from '../db/values.js';
import { richTextToHtml } from '../activitypub/html.js';
import { getLocalUserByHandle } from '../services/users.js';
import { getThread } from '../social/posts.js';
import { getProfile } from '../social/profiles.js';
import { profileTimeline } from '../social/timeline.js';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

const AVATAR_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#c026d3',
  '#db2777',
  '#e11d48',
  '#ea580c',
  '#d97706',
  '#059669',
  '#0d9488',
  '#0284c7',
  '#2563eb',
];

/** The same stable per-user colour the apps use. */
function avatarColor(seed: string): string {
  let hash = 0x811c9dc5;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length]!;
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0]!.toUpperCase())
    .slice(0, 2)
    .join('') || '?';

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

const wantsActivityPub = (req: FastifyRequest) =>
  /application\/(activity|ld)\+json/.test(req.headers.accept ?? '');

export function pageRoutes(app: FastifyInstance, ctx: AppContext) {
  const origin = instanceOrigin(ctx.config.domain, ctx.config.devInsecure);
  const profileHref = (user: User) => (user.local ? `${origin}/@${user.handle}` : null);
  const address = (user: User) => `@${user.handle}@${user.instance}`;

  function avatar(user: User, size: number) {
    const name = user.displayName || user.handle;
    return user.avatarUrl
      ? `<img class="avatar" src="${escape(user.avatarUrl)}" alt="" width="${size}" height="${size}" loading="lazy">`
      : `<span class="avatar" style="--c:${avatarColor(user.id)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px" aria-hidden="true">${escape(initials(name))}</span>`;
  }

  function postHtml(post: Post, { focus = false, repostedBy = null as User | null } = {}) {
    const author = post.author;
    const name = escape(author.displayName || author.handle);
    const authorHref = profileHref(author) ?? post.url ?? '#';
    const body = richTextToHtml(
      { text: post.text, facets: post.facets },
      {
        mention: (facet) => {
          if (!facet.value.includes('@')) return null;
          const [handle, instance] = facet.value.split('@');
          return instance === ctx.config.domain ? `${origin}/@${handle}` : null;
        },
        tag: () => null,
      },
    );
    const media = post.media.length
      ? `<div class="media media--${Math.min(post.media.length, 4)}">${post.media
          .map(
            (m) =>
              `<a href="${escape(m.url)}"><img src="${escape(m.url)}" alt="${escape(m.alt)}" loading="lazy"${m.width && m.height ? ` width="${m.width}" height="${m.height}"` : ''}></a>`,
          )
          .join('')}</div>`
      : '';
    const quote = post.quote
      ? `<a class="quote" href="${escape(post.quote.url ?? '#')}"><b>${escape(post.quote.author.displayName || post.quote.author.handle)}</b> <span>${escape(address(post.quote.author))}</span><span class="quote__text">${escape(post.quote.cw ? `Content warning: ${post.quote.cw}` : post.quote.text.slice(0, 280))}</span></a>`
      : '';
    const content = `${body}${media}${quote}`;
    const when = new Date(post.createdAt);
    const stats = `<p class="stats"><span>${post.counts.replies} ${post.counts.replies === 1 ? 'reply' : 'replies'}</span><span>${post.counts.reposts} ${post.counts.reposts === 1 ? 'repost' : 'reposts'}</span><span>${post.counts.likes} ${post.counts.likes === 1 ? 'like' : 'likes'}</span></p>`;

    return `<article class="post${focus ? ' post--focus' : ''}">
  ${repostedBy ? `<p class="reposted">⟳ ${escape(repostedBy.displayName || repostedBy.handle)} reposted</p>` : ''}
  <header class="post__head">
    <a href="${escape(authorHref)}" class="post__avatar">${avatar(author, focus ? 48 : 40)}</a>
    <div>
      <a href="${escape(authorHref)}" class="post__name">${name}</a>
      <span class="post__address">${escape(address(author))}</span>
    </div>
  </header>
  ${post.replyToAuthor ? `<p class="replying">Replying to ${escape(address(post.replyToAuthor))}</p>` : ''}
  <div class="post__body">${post.cw ? `<details><summary>${escape(post.cw)}</summary>${content}</details>` : content}</div>
  <footer class="post__foot">
    <a href="${escape(post.url ?? '#')}"><time datetime="${when.toISOString()}">${escape(dateFormat.format(when))}</time></a>
    ${stats}
  </footer>
</article>`;
  }

  function page({
    title,
    description,
    image,
    canonical,
    alternate,
    body,
  }: {
    title: string;
    description: string;
    image: string | null;
    canonical: string;
    alternate: string;
    body: string;
  }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${escape(canonical)}">
<link rel="alternate" type="application/activity+json" href="${escape(alternate)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escape(ctx.config.name)}">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${escape(canonical)}">
${image ? `<meta property="og:image" content="${escape(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><a href="${escape(origin)}" class="brand">${escape(ctx.config.name)}</a><span>${escape(ctx.config.domain)}</span></header>
<main id="main">
${body}
</main>
<footer class="bottom">Shared from ${escape(ctx.config.domain)}, a <a href="https://joltapp.org">Jolt</a> instance.</footer>
</body>
</html>`;
  }

  function notFoundPage(reply: FastifyReply) {
    return reply
      .status(404)
      .type('text/html; charset=utf-8')
      .header('content-security-policy', CSP)
      .send(
        page({
          title: 'Not found',
          description: '',
          image: null,
          canonical: origin,
          alternate: origin,
          body: `<section class="empty"><h1>Nothing here</h1><p>That page doesn't exist, or it isn't public.</p></section>`,
        }),
      );
  }

  const send = (reply: FastifyReply, html: string) =>
    reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', CSP)
      .header('cache-control', 'public, max-age=60')
      .header('vary', 'Accept')
      .send(html);

  app.get<{ Params: { handle: string }; Querystring: { before?: string } }>(
    '/@:handle',
    async (req, reply) => {
      const row = await getLocalUserByHandle(ctx, req.params.handle.toLowerCase());
      if (!row) return notFoundPage(reply);
      const userId = id(row.id);
      if (wantsActivityPub(req)) return reply.redirect(`${origin}/users/${userId}`, 302);

      const profile = await getProfile(ctx, userId, null);
      const before = /^\d{1,20}$/.test(req.query.before ?? '') ? req.query.before : undefined;
      const timeline = await profileTimeline(ctx, userId, null, {
        filter: 'posts',
        before,
        limit: Limits.postsPerPage,
      });
      const items = timeline.items.filter((i) => i.post.visibility === 'public');
      const user = profile.user;
      const name = user.displayName || user.handle;
      const links: PublicLink[] = profile.links;

      const body = `<section class="profile">
  <div class="banner" style="--c:${avatarColor(user.id)}"></div>
  <div class="profile__main">
    ${avatar(user, 96)}
    <h1>${escape(name)}</h1>
    <p class="post__address">${escape(address(user))}</p>
    ${user.bio ? `<p class="bio">${escape(user.bio).replace(/\n/g, '<br>')}</p>` : ''}
    ${
      links.length
        ? `<ul class="links">${links
            .map(
              (l) =>
                `<li><a rel="me nofollow noopener" href="${escape(l.url)}">${l.provider === 'bluesky' ? 'Bluesky' : 'Mastodon'} · ${escape(l.handle)}${l.verified ? ' <span class="verified" title="Verified">✓</span>' : ''}</a></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <p class="counts"><span><b>${profile.counts.posts}</b> posts</span><span><b>${profile.counts.followers}</b> followers</span><span><b>${profile.counts.following}</b> following</span></p>
    <div class="follow">
      <p>To follow ${escape(name)}, search for <code>${escape(address(user))}</code> in Jolt, Mastodon or any other fediverse app.</p>
      <a class="button" href="jolt://profile/${escape(encodeURIComponent(`${user.handle}@${user.instance}`))}">Open in Jolt</a>
    </div>
  </div>
</section>
<section class="feed" aria-label="Posts">
${items.length ? items.map((i) => postHtml(i.post, { repostedBy: i.repostedBy })).join('\n') : '<p class="empty">No public posts yet.</p>'}
${timeline.cursor ? `<a class="more" href="?before=${escape(timeline.cursor)}">Older posts</a>` : ''}
</section>`;

      return send(
        reply,
        page({
          title: `${name} (${address(user)})`,
          description: user.bio || `${name} on ${ctx.config.name}`,
          image: user.avatarUrl,
          canonical: `${origin}/@${user.handle}`,
          alternate: `${origin}/users/${userId}`,
          body,
        }),
      );
    },
  );

  app.get<{ Params: { handle: string; id: string } }>('/@:handle/posts/:id', async (req, reply) => {
    const row = await getLocalUserByHandle(ctx, req.params.handle.toLowerCase());
    if (!row || !/^\d{1,20}$/.test(req.params.id)) return notFoundPage(reply);
    const thread = await getThread(ctx, req.params.id, null).catch(() => null);
    if (!thread || thread.post.author.id !== id(row.id)) return notFoundPage(reply);
    if (wantsActivityPub(req)) return reply.redirect(`${origin}/posts/${thread.post.id}`, 302);

    const post = thread.post;
    const name = post.author.displayName || post.author.handle;
    const summary = post.cw ? `Content warning: ${post.cw}` : post.text || 'An image';
    const body = `<section class="thread">
${thread.ancestors.map((p) => postHtml(p)).join('\n')}
${postHtml(post, { focus: true })}
${thread.replies.length ? `<h2 class="replies">Replies</h2>${thread.replies.map((p) => postHtml(p)).join('\n')}` : ''}
<p class="open"><a class="button" href="jolt://post/${escape(encodeURIComponent(post.url ?? ''))}">Open in Jolt</a></p>
</section>`;

    return send(
      reply,
      page({
        title: `${name}: "${summary.slice(0, 60)}${summary.length > 60 ? '…' : ''}"`,
        description: summary.slice(0, 300),
        image: post.cw ? post.author.avatarUrl : (post.media[0]?.url ?? post.author.avatarUrl),
        canonical: post.url ?? `${origin}/@${post.author.handle}/posts/${post.id}`,
        alternate: `${origin}/posts/${post.id}`,
        body,
      }),
    );
  });
}

// No scripts at all; images can come from other servers that host media for remote posts.
const CSP =
  "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STYLES = `
:root{color-scheme:light dark;--paper:#f2efe6;--sheet:#f8f6f0;--ink:#141412;--soft:#3c3a34;--faint:#67635a;--rule:rgb(20 20 18/.14);--volt:#c8f04b;--on-volt:#141a04;--accent:#3d5700}
@media (prefers-color-scheme:dark){:root{--paper:#11110f;--sheet:#1a1a17;--ink:#efece3;--soft:#c9c5ba;--faint:#9c988d;--rule:rgb(239 236 227/.12);--accent:#d3f36d}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:inherit}main{max-width:40rem;margin:0 auto;padding:0 1rem 3rem}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--ink);color:var(--paper);padding:.5rem 1rem}
.top,.bottom{max-width:40rem;margin:0 auto;padding:1rem;display:flex;justify-content:space-between;gap:1rem;color:var(--faint);font-size:.85rem}
.brand{font:600 1.1rem/1 Georgia,'Iowan Old Style',serif;color:var(--ink);text-decoration:none}
.bottom{display:block;text-align:center;border-top:1px solid var(--rule)}
.profile{background:var(--sheet);border:1px solid var(--rule);border-radius:14px;overflow:hidden}
.banner{height:7rem;background:linear-gradient(135deg,color-mix(in srgb,var(--c) 75%,white),var(--c))}
.profile__main{padding:0 1.25rem 1.25rem}.profile__main>.avatar{margin-top:-48px;border:4px solid var(--sheet)}
h1{margin:.6rem 0 0;font:600 1.8rem/1.15 Georgia,'Iowan Old Style',serif;letter-spacing:-.02em}
.avatar{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;object-fit:cover;background:linear-gradient(140deg,color-mix(in srgb,var(--c) 78%,white),var(--c));color:#fff;font-weight:700;flex:none}
.bio{margin:.75rem 0 0;color:var(--soft)}.post__address{color:var(--faint);font-size:.9rem;margin:0}
.links{list-style:none;padding:0;margin:.75rem 0 0;display:flex;flex-wrap:wrap;gap:.5rem}.links a{display:inline-block;padding:.2rem .7rem;border:1px solid var(--rule);border-radius:99px;font-size:.85rem;text-decoration:none}.verified{color:#1f9d63}
.counts{display:flex;gap:1.25rem;margin:.9rem 0 0;color:var(--faint);font-size:.9rem}.counts b{color:var(--ink)}
.follow{margin-top:1rem;padding:.9rem 1rem;border-radius:10px;background:var(--paper);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;font-size:.9rem;color:var(--soft)}.follow p{margin:0}
code{font-size:.85em;padding:.1em .35em;border-radius:4px;background:var(--sheet);border:1px solid var(--rule)}
.button{display:inline-block;padding:.55rem 1rem;border-radius:9px;background:var(--ink);color:var(--paper);font-weight:600;text-decoration:none;white-space:nowrap}
.feed,.thread{margin-top:1.25rem;background:var(--sheet);border:1px solid var(--rule);border-radius:14px;overflow:hidden}
.post{padding:1rem 1.25rem;border-bottom:1px solid var(--rule)}.post:last-of-type{border-bottom:0}
.post__head{display:flex;gap:.7rem;align-items:center}.post__name{font-weight:650;text-decoration:none}.post__name:hover{text-decoration:underline}.post__avatar{display:flex}
.post__body{margin:.5rem 0 0}.post__body p{margin:0 0 .6rem;overflow-wrap:anywhere}.post__body a{color:var(--accent)}.hashtag{color:var(--accent)}
.post--focus .post__body{font-size:1.15rem}
.reposted,.replying{margin:0 0 .4rem;color:var(--faint);font-size:.85rem}
details{border:1px solid var(--rule);border-radius:9px;padding:.5rem .75rem}summary{cursor:pointer;font-weight:600}details[open] summary{margin-bottom:.5rem}
.media{display:grid;gap:4px;margin-top:.5rem;border-radius:10px;overflow:hidden}.media--2,.media--3,.media--4{grid-template-columns:1fr 1fr}.media img{display:block;width:100%;height:100%;max-height:32rem;object-fit:cover;background:var(--paper)}
.quote{display:block;margin-top:.5rem;padding:.7rem .85rem;border:1px solid var(--rule);border-radius:10px;text-decoration:none;font-size:.9rem}.quote span{color:var(--faint)}.quote__text{display:block;margin-top:.25rem;color:var(--ink)!important}
.post__foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem;margin-top:.5rem;color:var(--faint);font-size:.82rem}.post__foot a{text-decoration:none}
.stats{display:flex;gap:.9rem;margin:0}.replies{margin:0;padding:.8rem 1.25rem;font:600 .8rem/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);border-bottom:1px solid var(--rule)}
.more,.open{display:block;margin:0;padding:1rem;text-align:center}.more{border-top:1px solid var(--rule);font-weight:600}
.empty{padding:2.5rem 1rem;text-align:center;color:var(--faint)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
`;
