// The markdown renderer for an inbox question's body: full CommonMark plus
// GitHub-flavoured markdown (tables, strikethrough, task lists, every heading
// level, images, fenced code with its language), through `marked`. Pure:
// string in, HTML string out, synchronous.
//
// A question is written by an agent for the operator, and may use anything
// GitHub renders, so the renderer is a general one rather than a small subset.
//
// The page injects this HTML (`RenderedBody` in apps/web), so safety is
// decided here, by overriding the renderer for every token that could carry
// markup or a URL:
// - raw HTML in the source, block or inline, is escaped and shown as text;
// - a link is an anchor only for an http(s) or mailto target, and opens in a
//   new tab with no referrer; any other target renders as its text;
// - an image is an `<img>` only for an http(s) source, lazy, with its alt
//   text; any other source renders as the alt text;
// - a task-list checkbox is disabled;
// - a ```svg fence whose body is an SVG document renders as a diagram, as an
//   `<img>` with a base64 `data:` URL. An SVG loaded as an image runs no script
//   and fetches nothing external in any browser, so it needs no sanitiser. Raw
//   inline `<svg>` stays escaped like all raw HTML;
// - every other fence stays code, keeping `class="language-x"`; a fence in a
//   language `code-highlight.ts` colours carries its coloured spans, and one
//   in any other language, or none, stays plain.
//
// A ```mermaid fence is code in `renderQuestionMarkdown`'s HTML. The page
// draws it from `renderQuestionParts` instead, which splits the body at each
// mermaid fence: the markdown around it is HTML as above, and the fence is
// its source text, which the browser draws with Mermaid. The source never becomes HTML here.
// An `<Excalidraw id="…"/>` line on its own is split out the same way, as the
// id of a drawing the Question carries; the tag never becomes HTML either.

import { Marked, type Token, type Tokens, type TokensList } from 'marked';
import { highlightCode } from './code-highlight';
import { escapeHtml } from './html-escape';

const LINK_HREF = /^(https?:\/\/|mailto:)/i;
const IMAGE_SRC = /^https?:\/\//i;

// An svg fence is drawn only when its body is an SVG document (an optional
// `<?xml …?>` prolog, then `<svg`), and only up to this size; past it, or
// otherwise, it is shown as code.
const SVG_START = /^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i;
const SVG_MAX_BYTES = 200 * 1024;

// Base64 of the UTF-8 bytes, with no node-only API.
const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const svgImage = (body: string): string | undefined => {
  const trimmed = body.trim();
  if (!SVG_START.test(trimmed)) return undefined;
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength > SVG_MAX_BYTES) return undefined;
  return `<img src="data:image/svg+xml;base64,${base64(bytes)}" alt="diagram" loading="lazy">`;
};

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      if (!LINK_HREF.test(href)) return text;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} rel="noreferrer" target="_blank">${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      if (!IMAGE_SRC.test(href)) return escapeHtml(text);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
    },
    code({ text, lang }: Tokens.Code) {
      if ((lang ?? '').trim().toLowerCase() === 'svg') {
        const img = svgImage(text);
        if (img !== undefined) return `<p>${img}</p>\n`;
      }
      const coloured = highlightCode(text, lang);
      if (coloured !== undefined) {
        // marked's own code renderer's shape, with the coloured body in it.
        const name = escapeHtml((lang ?? '').trim());
        return `<pre><code class="language-${name}">${coloured}\n</code></pre>\n`;
      }
      // `false` hands the fence back to marked's own code renderer.
      return false;
    },
  },
});

/** Render an inbox question's markdown body to safe HTML. */
export const renderQuestionMarkdown = (markdown: string): string =>
  marked.parse(markdown, { async: false });

/** One part of a question's body: rendered markdown, or a Mermaid diagram. */
export type QuestionBodyPart =
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'mermaid'; readonly source: string }
  // An `<Excalidraw id="…"/>` line: the Question's drawing of that id, which
  // the page draws from the scene the Question carries beside its body.
  | { readonly kind: 'excalidraw'; readonly id: string };

// A drawing's tag: the whole of an HTML block, on a line of its own, exactly
// `<Excalidraw id="…"/>`. Anywhere else, inline or with any other attribute,
// it is raw HTML like any other and stays escaped text.
const EXCALIDRAW_TAG = /^<Excalidraw id="([a-z0-9][a-z0-9-]{0,39})"\s*\/>$/;

const excalidrawId = (token: Token): string | undefined =>
  token.type === 'html' && (token as Tokens.HTML).block
    ? EXCALIDRAW_TAG.exec((token as Tokens.HTML).text.trim())?.[1]
    : undefined;

const isMermaid = (token: Token): token is Tokens.Code =>
  token.type === 'code' &&
  ((token as Tokens.Code).lang ?? '').trim().toLowerCase() === 'mermaid';

/**
 * A question's body as parts, in order: the markdown between ```mermaid
 * fences rendered to safe HTML exactly as `renderQuestionMarkdown` renders
 * it, and each mermaid fence as its source text. A body with no mermaid
 * fence is one HTML part; an empty body is none.
 */
export const renderQuestionParts = (
  markdown: string,
): ReadonlyArray<QuestionBodyPart> => {
  const tokens = marked.lexer(markdown);
  const parts: Array<QuestionBodyPart> = [];
  let run: Array<Token> = [];
  const flush = () => {
    if (run.length === 0) return;
    // Reference links are defined once for the whole body, so every run
    // carries the body's definitions.
    const list = Object.assign(run, { links: tokens.links }) as TokensList;
    const html = marked.parser(list);
    if (html.trim().length > 0) parts.push({ kind: 'html', html });
    run = [];
  };
  for (const token of tokens) {
    const drawing = excalidrawId(token);
    if (isMermaid(token)) {
      flush();
      parts.push({ kind: 'mermaid', source: token.text });
    } else if (drawing !== undefined) {
      flush();
      parts.push({ kind: 'excalidraw', id: drawing });
    } else run.push(token);
  }
  flush();
  return parts;
};

/**
 * A question's body as the page gets it: the raw markdown, and both renderings
 * of it by this machine's own escaping renderers. Local's serve renders its
 * own questions with this, and every question a machine sends again with it,
 * so the page only ever shows HTML Local wrote.
 */
export const renderedQuestionBody = (
  body: string,
): {
  readonly body: string;
  readonly bodyHtml: string;
  readonly bodyParts: ReadonlyArray<QuestionBodyPart>;
} => ({
  body,
  bodyHtml: renderQuestionMarkdown(body),
  bodyParts: renderQuestionParts(body),
});
