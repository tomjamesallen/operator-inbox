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
// - raw HTML in the source, block or inline, is escaped and shown as text,
//   with one exception: a bare `<small>` and its `</small>`, paired among
//   the same siblings, render as a `small` element (`pairSmallTags` below);
// - a link is an anchor only for an http(s) or mailto target, and opens in a
//   new tab with no referrer; any other target renders as its text;
// - an image is an `<img>` only for an http(s) source, lazy, with its alt
//   text; any other source renders as the alt text. The one exception is an
//   `attachment:<name>` source, a file the Question carries: it is an `<img>`
//   only when the caller resolves the name to a URL (`AttachmentImages`),
//   which the caller builds, never the body; otherwise it is the alt text.
//   Such an `<img>` carries the file's name, escaped, in
//   `data-attachment-image`, so the page can open the file in its lightbox;
//   outside a link's anchor it is also a focusable button (`role`,
//   `tabindex` and `aria-haspopup`, each a fixed value, and, when its alt
//   text is empty, an `aria-label` naming the file, escaped);
// - a task-list checkbox is disabled;
// - a ```svg fence whose body is an SVG document renders as a diagram, as an
//   `<img>` with a base64 `data:` URL. An SVG loaded as an image runs no script
//   and fetches nothing external in any browser, so it needs no sanitiser. Raw
//   inline `<svg>` stays escaped like all raw HTML;
// - every other fence stays code, keeping `class="language-x"`; a fence in a
//   language `code-highlight.ts` colours carries its coloured spans, and one
//   in any other language, or none, stays plain.
//
// A table is marked's own, inside a `<div data-table-scroll>`: a table's box
// cannot both stretch to the column and scroll its overflow, so the div is
// the box that scrolls sideways when the table is wider than the page.
//
// A ```mermaid fence is code in `renderQuestionMarkdown`'s HTML. The page
// draws it from `renderQuestionParts` instead, which splits the body at each
// mermaid fence: the markdown around it is HTML as above, and the fence is
// its source text, which the browser draws with Mermaid. The source never becomes HTML here.
// An `<Excalidraw id="…"/>` line on its own is split out the same way, as the
// id of a drawing the Question carries; the tag never becomes HTML either.
// So is an `<Html id="…"/>` line, with an optional `width`, as the id of one
// of the Question's HTML blocks, which the page runs in a sandboxed frame.

import {
  Marked,
  Renderer,
  type Token,
  type Tokens,
  type TokensList,
} from 'marked';
import {
  attachmentImageNames,
  attachmentSrcName,
  isAttachmentSrc,
} from './attachment-images';
import { highlightCode } from './code-highlight';
import type { HtmlBlockWidth } from './html-block';
import { escapeHtml } from './html-escape';

const LINK_HREF = /^(https?:\/\/|mailto:)/i;
const IMAGE_SRC = /^https?:\/\//i;

/**
 * Where an `attachment:<name>` image in a body is read from: the URL of the
 * file of that name the Question carries, or undefined when it carries none
 * that can be shown here.
 */
export type AttachmentImages = (name: string) => string | undefined;

// The resolver for the render under way. Rendering is synchronous, so it is
// set for one call and cleared after it (`withAttachmentImages`); marked's
// renderer is built once and has no per-call options.
let attachmentImages: AttachmentImages | undefined;

const withAttachmentImages = <A>(
  images: AttachmentImages | undefined,
  render: () => A,
): A => {
  attachmentImages = images;
  anchorDepth = 0;
  try {
    return render();
  } finally {
    attachmentImages = undefined;
    anchorDepth = 0;
  }
};

// How deep the render under way is inside a link's anchor; reset with the
// resolver. An attachment image in an anchor is the link's: a click on it
// follows the link, so it is not a control of its own.
let anchorDepth = 0;

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

// --- <small> ----------------------------------------------------------------
//
// The one raw tag let through. Only the bare tag counts, in any case: `<small>`
// with an attribute, or any other tag, stays escaped text. A tag renders only
// when it is paired with its partner among the same sibling tokens (the
// inline tokens of one paragraph, cell or emphasis; or the blocks of one
// body, list item or quote), so every `<small>` this renderer writes is
// closed inside the element that opened it, and a stray one cannot stretch
// small text over the rest of the page. An unpaired tag stays escaped text.
//
// As a block, it is a `<small>` line and a `</small>` line with blank lines
// round the markdown between them; or, with no blank line inside, one HTML
// block of the form `<small>\n…\n</small>`, whose inside is read as markdown.

const SMALL_OPEN = /^<small\s*>$/i;
const SMALL_CLOSE = /^<\/small\s*>$/i;
const SMALL_BLOCK = /^<small\s*>\n([\s\S]*)\n<\/small\s*>$/i;

// A paired tag, swapped in for its `html` token; drawn by the `small`
// extension renderer.
const smallTag = (raw: string, close: boolean): Tokens.Generic => ({
  type: 'small',
  raw,
  close,
});

const isHtml = (token: Token): token is Tokens.HTML | Tokens.Tag =>
  token.type === 'html';

// Pairs the `<small>` tags among `tokens`, and among every token list nested
// in them, in place: each paired tag's token becomes a `small` one.
const pairSmallTags = (tokens: Array<Token>): void => {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    const inner = isHtml(token)
      ? SMALL_BLOCK.exec(token.text.trim())?.[1]
      : undefined;
    if (inner !== undefined && (token as Tokens.HTML).block) {
      const body: Array<Token> = marked.lexer(inner);
      pairSmallTags(body);
      tokens.splice(
        i,
        1,
        smallTag('<small>', false),
        ...body,
        smallTag('</small>', true),
      );
      i += body.length + 1;
      continue;
    }
    if (token.type === 'list') {
      pairSmallTags((token as Tokens.List).items);
    } else if (token.type === 'table') {
      const table = token as Tokens.Table;
      for (const cell of table.header) pairSmallTags(cell.tokens);
      for (const row of table.rows)
        for (const cell of row) pairSmallTags(cell.tokens);
    } else if ('tokens' in token && Array.isArray(token.tokens)) {
      pairSmallTags(token.tokens);
    }
  }
  const open: Array<number> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (!isHtml(token)) continue;
    const text = token.text.trim();
    if (SMALL_OPEN.test(text)) open.push(i);
    else if (SMALL_CLOSE.test(text)) {
      const start = open.pop();
      if (start === undefined) continue;
      tokens[start] = smallTag((tokens[start] as Token).raw, false);
      tokens[i] = smallTag(token.raw, true);
    }
  }
};

const marked: Marked = new Marked({
  gfm: true,
  async: false,
  extensions: [
    {
      name: 'small',
      renderer: (token) => (token.close ? '</small>' : '<small>'),
    },
  ],
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      if (!LINK_HREF.test(href)) return this.parser.parseInline(tokens);
      anchorDepth++;
      let text: string;
      try {
        text = this.parser.parseInline(tokens);
      } finally {
        anchorDepth--;
      }
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} rel="noreferrer" target="_blank">${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      if (isAttachmentSrc(href)) {
        const name = attachmentSrcName(href);
        const src = attachmentImages?.(name);
        if (src === undefined) return escapeHtml(text);
        // The page opens it whole over the page on a click, or on Enter or
        // Space once focused, so outside a link it is a button.
        const control =
          anchorDepth > 0
            ? ''
            : ` role="button" tabindex="0" aria-haspopup="dialog"${text === '' ? ` aria-label="Show ${escapeHtml(name)}"` : ''}`;
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${t} loading="lazy" data-attachment-image="${escapeHtml(name)}"${control}>`;
      }
      if (!IMAGE_SRC.test(href)) return escapeHtml(text);
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
    table(token: Tokens.Table) {
      const table = Renderer.prototype.table.call(this, token);
      // The table's own newline goes after the div, so the body's text, which
      // a comment's place is counted in, is the same as without it.
      return `<div data-table-scroll>${table.trimEnd()}</div>\n`;
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
export const renderQuestionMarkdown = (
  markdown: string,
  images?: AttachmentImages,
): string =>
  withAttachmentImages(images, () => {
    const tokens = marked.lexer(markdown);
    pairSmallTags(tokens);
    return marked.parser(tokens);
  });

/** One part of a question's body: rendered markdown, or a Mermaid diagram. */
export type QuestionBodyPart =
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'mermaid'; readonly source: string }
  // An `<Excalidraw id="…"/>` line: the Question's drawing of that id, which
  // the page draws from the scene the Question carries beside its body.
  | { readonly kind: 'excalidraw'; readonly id: string }
  // An `<Html id="…" width="…"/>` line: the Question's HTML block of that id,
  // which the page runs in a sandboxed frame from the document the Question
  // names beside its body. `width` is left out for the default, `constrain`.
  | {
      readonly kind: 'html-block';
      readonly id: string;
      readonly width?: HtmlBlockWidth;
    };

// A drawing's tag: the whole of an HTML block, on a line of its own, exactly
// `<Excalidraw id="…"/>`. Anywhere else, inline or with any other attribute,
// it is raw HTML like any other and stays escaped text.
const EXCALIDRAW_TAG = /^<Excalidraw id="([a-z0-9][a-z0-9-]{0,39})"\s*\/>$/;

const excalidrawId = (token: Token): string | undefined =>
  token.type === 'html' && (token as Tokens.HTML).block
    ? EXCALIDRAW_TAG.exec((token as Tokens.HTML).text.trim())?.[1]
    : undefined;

// An HTML block's tag, by the same rule: the whole of an HTML block, on a line
// of its own, exactly `<Html id="…"/>` or `<Html id="…" width="…"/>`, the
// width one of `constrain`, `wide` and `full`. Anything else stays escaped
// text.
const HTML_TAG =
  /^<Html id="([a-z0-9][a-z0-9-]{0,39})"(?:\s+width="(constrain|wide|full)")?\s*\/>$/;

const htmlBlockOf = (
  token: Token,
):
  | { readonly id: string; readonly width?: HtmlBlockWidth | undefined }
  | undefined => {
  if (token.type !== 'html' || !(token as Tokens.HTML).block) return undefined;
  const m = HTML_TAG.exec((token as Tokens.HTML).text.trim());
  const id = m?.[1];
  if (id === undefined) return undefined;
  return { id, width: m?.[2] as HtmlBlockWidth | undefined };
};

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
  images?: AttachmentImages,
): ReadonlyArray<QuestionBodyPart> =>
  withAttachmentImages(images, () => questionParts(markdown));

const questionParts = (markdown: string): ReadonlyArray<QuestionBodyPart> => {
  const tokens = marked.lexer(markdown);
  const parts: Array<QuestionBodyPart> = [];
  let run: Array<Token> = [];
  const flush = () => {
    if (run.length === 0) return;
    // Reference links are defined once for the whole body, so every run
    // carries the body's definitions.
    // `<small>` pairs within the run, so a pair split by a fence stays text.
    pairSmallTags(run);
    const list = Object.assign(run, { links: tokens.links }) as TokensList;
    const html = marked.parser(list);
    if (html.trim().length > 0) parts.push({ kind: 'html', html });
    run = [];
  };
  for (const token of tokens) {
    const drawing = excalidrawId(token);
    const block = htmlBlockOf(token);
    if (isMermaid(token)) {
      flush();
      parts.push({ kind: 'mermaid', source: token.text });
    } else if (drawing !== undefined) {
      flush();
      parts.push({ kind: 'excalidraw', id: drawing });
    } else if (block !== undefined) {
      flush();
      parts.push(
        block.width === undefined || block.width === 'constrain'
          ? { kind: 'html-block', id: block.id }
          : { kind: 'html-block', id: block.id, width: block.width },
      );
    } else run.push(token);
  }
  flush();
  return parts;
};

/**
 * A question's body as the page gets it: the raw markdown, and both renderings
 * of it by this machine's own escaping renderers. Local's serve renders its
 * own questions with this, and every question a machine sends again with it,
 * so the page only ever shows HTML Local wrote. `images` resolves the body's
 * `attachment:<name>` images; left out, each renders as its alt text.
 * `bodyImages` names the files the body shows in place, each an image the
 * resolver gave a URL; it is left out when there are none.
 */
export const renderedQuestionBody = (
  body: string,
  images?: AttachmentImages,
): {
  readonly body: string;
  readonly bodyHtml: string;
  readonly bodyParts: ReadonlyArray<QuestionBodyPart>;
  readonly bodyImages?: ReadonlyArray<string>;
} => {
  const shown =
    images === undefined
      ? []
      : attachmentImageNames(body).filter((name) => images(name) !== undefined);
  return {
    body,
    bodyHtml: renderQuestionMarkdown(body, images),
    bodyParts: renderQuestionParts(body, images),
    ...(shown.length === 0 ? {} : { bodyImages: shown }),
  };
};
