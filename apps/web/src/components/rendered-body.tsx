import type { MouseEvent } from 'react';

// An absolute http(s) URL with a host and no whitespace or control character
// anywhere, matched against the WHOLE string, so a leading space or a scheme
// spelt with an embedded tab cannot slip past. Case-insensitive, as URL
// schemes are.
const HTTP_URL_RE = /^https?:\/\/[^\s\p{Cc}/?#]+[^\s\p{Cc}]*$/iu;

// `s` when it is an absolute http(s) URL, else `undefined`.
export const httpUrl = (s: string): string | undefined =>
  HTTP_URL_RE.test(s) ? s : undefined;

// ⚠ THE ONLY `dangerouslySetInnerHTML` IN `apps/web` is `RenderedBody`
// below. Keep it that way. It draws an inbox question's body.
//
// The escaping promise it rests on: a question's body comes from core's
// `renderQuestionMarkdown` (`packages/core/src/question-markdown.ts`), full
// GFM through `marked`, with its renderer overridden so that raw HTML, block
// or inline, is escaped to text, but for a bare `<small>` paired with its
// `</small>` among the same siblings, written as the bare tags; an anchor is made only for http(s) or mailto
// (with `target="_blank"`); an `<img>` only for an http(s) source, or for an
// ```svg fence as a base64 `data:image/svg+xml` URL, which a browser loads
// with no script and no external fetch; any other target renders as text.
// That holds for an Inbox on another machine too: Local's serve never
// forwards a machine's `bodyHtml` or html parts. Wherever a machine's view
// enters Local (the board's merge and every forwarded call), core's
// `machineView` discards them and renders each question again, on Local,
// from its raw `body` with the same renderer.
// Anything that changes that promise must change this comment.
//
// A link in the body would navigate the app's own tab (or its installed PWA
// window) away, so a click on an http(s) anchor opens it in a new tab
// instead, with no opener and no referrer. A `mailto:` anchor keeps its
// default. The check is `httpUrl` again, on the rendered `href`, rather than
// trust in the renderer's own scheme rule. A click with a modifier held
// (⌘, Ctrl, Shift, Alt) is the reader asking the browser for a background
// tab, a window or a download, so it is left to the browser.
export const openBodyLinkInNewTab = (e: MouseEvent<HTMLElement>): void => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest('a') : null;
  if (a === null || !e.currentTarget.contains(a)) return;
  const href = httpUrl(a.getAttribute('href') ?? '');
  if (href === undefined) return;
  e.preventDefault();
  window.open(href, '_blank', 'noopener,noreferrer');
};

// A server-rendered markdown body, the one way raw HTML enters the app. Its
// `data-question-body` hook is the stylesheet's escape hatch for the elements
// inside it (`index.css`).
export const RenderedBody = ({
  html,
  className,
}: {
  readonly html: string;
  readonly className: string;
}) => (
  // biome-ignore lint/a11y/useKeyWithClickEvents: the click is delegated from the body's anchors, which are focusable and fire it on Enter themselves.
  // biome-ignore lint/a11y/noStaticElementInteractions: as above; the div only catches its anchors' clicks.
  <div
    className={className}
    data-question-body=""
    onClick={openBodyLinkInNewTab}
    dangerouslySetInnerHTML={{ __html: html }}
  />
);
