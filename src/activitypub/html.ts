// ActivityPub content is HTML. Incoming HTML is reduced to plain text plus facets, so nothing from another server
// is ever rendered as markup; outgoing posts are written as the small, escaped HTML subset Mastodon expects.

import { segmentRichText, type Facet, type RichText } from '@getjolt/protocol';
import { Parser } from 'htmlparser2';

const BLOCKS = new Set([
  'p',
  'div',
  'blockquote',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
]);
const SKIPPED = new Set(['script', 'style', 'template', 'iframe', 'object', 'svg', 'math', 'head', 'title']);

interface OpenLink {
  href: string;
  classes: string[];
  rel: string[];
  start: number;
}

/**
 * Turns post HTML into text and facets. `mentionAddress` maps a mentioned actor's URL to `user@server`, using the
 * Mention tags that came with the post; without it the address is guessed from the link.
 */
export function htmlToRichText(
  html: string,
  mentionAddress: (href: string) => string | undefined = () => undefined,
): RichText {
  let text = '';
  const facets: Facet[] = [];
  const links: OpenLink[] = [];
  let skipping = 0;

  const breakBlock = () => {
    const trimmed = text.replace(/[ \t]+$/, '');
    if (trimmed.length === 0) return;
    text = trimmed.endsWith('\n\n') ? trimmed : trimmed.endsWith('\n') ? `${trimmed}\n` : `${trimmed}\n\n`;
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (SKIPPED.has(name)) skipping++;
        if (skipping) return;
        if (name === 'br') text += '\n';
        else if (BLOCKS.has(name)) breakBlock();
        else if (name === 'a') {
          links.push({
            href: attribs.href ?? '',
            classes: (attribs.class ?? '').split(/\s+/),
            rel: (attribs.rel ?? '').split(/\s+/),
            start: text.length,
          });
        }
      },
      ontext(chunk) {
        if (!skipping) text += chunk.replace(/\s+/g, (ws) => (ws.includes('\n') ? ' ' : ws));
      },
      onclosetag(name) {
        if (SKIPPED.has(name)) {
          skipping = Math.max(0, skipping - 1);
          return;
        }
        if (skipping) return;
        if (BLOCKS.has(name)) breakBlock();
        if (name !== 'a') return;
        const link = links.pop();
        if (!link || !/^https?:\/\//i.test(link.href)) return;
        const label = text.slice(link.start);
        const facet = classifyLink(link, label, mentionAddress);
        if (facet && label.length > 0) facets.push({ start: link.start, end: text.length, ...facet });
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();

  // Trailing whitespace goes, and facets that ran into it are clipped to match.
  const trimmedEnd = text.replace(/\s+$/, '').length;
  const leading = text.length - text.replace(/^\s+/, '').length;
  return {
    text: text.slice(leading, trimmedEnd),
    facets: facets
      .map((f) => ({ ...f, start: f.start - leading, end: Math.min(f.end, trimmedEnd) - leading }))
      .filter((f) => f.start >= 0 && f.end > f.start),
  };
}

function classifyLink(
  link: OpenLink,
  label: string,
  mentionAddress: (href: string) => string | undefined,
): Omit<Facet, 'start' | 'end'> | null {
  const isTag = link.rel.includes('tag') || link.classes.includes('hashtag') || label.startsWith('#');
  if (isTag) return { kind: 'tag', value: label.replace(/^#/, '') };
  const isMention =
    link.classes.includes('mention') || link.classes.includes('u-url') || label.startsWith('@');
  if (isMention && label.startsWith('@')) {
    const known = mentionAddress(link.href);
    if (known) return { kind: 'mention', value: known.toLowerCase() };
    const user = label.slice(1).split('@')[0];
    try {
      return { kind: 'mention', value: `${user}@${new URL(link.href).host}`.toLowerCase() };
    } catch {
      return null;
    }
  }
  return { kind: 'link', value: link.href };
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

const textToHtml = (value: string) =>
  escape(value)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');

interface HtmlLinks {
  /** Where a mention should link to, usually the person's profile page. */
  mention(facet: Facet): string | null;
  /** Where a hashtag links to, or null to leave it as text. */
  tag(tag: string): string | null;
}

/** Writes text and facets as the HTML that Mastodon and friends render. */
export function richTextToHtml({ text, facets }: RichText, links: HtmlLinks): string {
  let html = '';
  for (const part of segmentRichText({ text, facets })) {
    const facet = part.facet;
    if (!facet) {
      html += textToHtml(part.text);
    } else if (facet.kind === 'link') {
      html += `<a href="${escape(facet.value)}" rel="nofollow noopener noreferrer" target="_blank">${escape(part.text)}</a>`;
    } else if (facet.kind === 'tag') {
      const href = links.tag(facet.value);
      html += href
        ? `<a href="${escape(href)}" class="mention hashtag" rel="tag">#<span>${escape(facet.value)}</span></a>`
        : `<span class="hashtag">${escape(part.text)}</span>`;
    } else {
      const href = links.mention(facet);
      const handle = facet.value.split('@')[0]!;
      html += href
        ? `<span class="h-card" translate="no"><a href="${escape(href)}" class="u-url mention">@<span>${escape(handle)}</span></a></span>`
        : escape(part.text);
    }
  }
  return `<p>${html}</p>`;
}
