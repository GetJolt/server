import { describe, expect, it } from 'vitest';
import { htmlToRichText, richTextToHtml } from '../src/activitypub/html.js';

describe('htmlToRichText', () => {
  it('reads a typical Mastodon post', () => {
    const html =
      '<p>Hi <span class="h-card"><a href="https://social.example/@bob" class="u-url mention">@<span>bob</span></a></span>, ' +
      'see <a href="https://joltapp.org/docs" rel="nofollow noopener" target="_blank"><span class="invisible">https://</span>' +
      '<span class="">joltapp.org/docs</span></a></p><p>Second paragraph<br>new line ' +
      '<a href="https://social.example/tags/jolt" class="mention hashtag" rel="tag">#<span>jolt</span></a></p>';
    const { text, facets } = htmlToRichText(html, (href) =>
      href === 'https://social.example/@bob' ? 'bob@social.example' : undefined,
    );
    expect(text).toBe('Hi @bob, see https://joltapp.org/docs\n\nSecond paragraph\nnew line #jolt');
    expect(facets.map((f) => [f.kind, f.value, text.slice(f.start, f.end)])).toEqual([
      ['mention', 'bob@social.example', '@bob'],
      ['link', 'https://joltapp.org/docs', 'https://joltapp.org/docs'],
      ['tag', 'jolt', '#jolt'],
    ]);
  });

  it('drops scripts, styles and unsafe links instead of rendering them', () => {
    const { text, facets } = htmlToRichText(
      '<p>ok<script>alert(1)</script><style>p{}</style> <a href="javascript:alert(1)">click</a> <img src=x onerror=alert(1)>done</p>',
    );
    expect(text).toBe('ok click done');
    expect(facets).toEqual([]);
  });

  it('decodes entities and keeps text from nested links', () => {
    const { text, facets } = htmlToRichText(
      '<p>Tom &amp; Jerry <a href="https://x.example/"><b>bold</b> link</a></p>',
    );
    expect(text).toBe('Tom & Jerry bold link');
    expect(facets[0]).toMatchObject({ kind: 'link', start: 12, end: 21 });
  });
});

describe('richTextToHtml', () => {
  it('escapes text and links mentions and tags', () => {
    const text = 'Hey @bob <3 #jolt\nhttps://a.example/?q="x"';
    const html = richTextToHtml(
      {
        text,
        facets: [
          { start: 4, end: 8, kind: 'mention', value: 'bob@b.example' },
          { start: 12, end: 17, kind: 'tag', value: 'jolt' },
          { start: 18, end: 42, kind: 'link', value: 'https://a.example/?q="x"' },
        ],
      },
      { mention: () => 'https://b.example/@bob', tag: (t) => `https://a.example/tags/${t}` },
    );
    expect(html).toContain('&lt;3');
    expect(html).toContain('class="u-url mention">@<span>bob</span>');
    expect(html).toContain('rel="tag">#<span>jolt</span>');
    expect(html).toContain('href="https://a.example/?q=&quot;x&quot;"');
    expect(html).toContain('<br>');
    expect(html).not.toContain('<3');
  });
});
