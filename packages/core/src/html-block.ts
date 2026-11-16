import { Result, Schema } from 'effect';

// HTML blocks in a Question: HTML documents the agent puts beside a body,
// each named by an `<Html id="…"/>` line of its own, which the page runs in a
// sandboxed iframe (a chart, a WebGL scene, an interactive diagram).
//
// A document is never stored on an event. It is a row of the store's
// content-addressed blob table, keyed by the SHA-256 of its bytes, and the
// event carries only that hash and the byte count (`HtmlBlockRef`), so a
// fold, the board and every list never carry a document's text. The page
// fetches the documents of the Question it shows.
//
// The documents are not sanitised. What keeps a block from the page is the
// frame (`sandbox="allow-scripts"` and nothing else, so its origin is opaque)
// and the Content-Security-Policy the app writes first into the frame's
// document (`HTML_BLOCK_CSP`): no network at all, no forms, scripts only
// inline or from `blob:` URLs the frame makes itself. The fixed builds of
// three.js and d3 the app serves under `/vendor/` are read by the PAGE and
// handed into the frame as text, only those the document uses.
//
// BROWSER-SAFE and pure: `effect` only, no clock, no platform.

/** A block's id: the `id` of its tag in the body. */
export const HTML_BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The most bytes one document may take, as UTF-8 text. */
export const HTML_BLOCK_MAX_BYTES = 512 * 1024;

/** The most HTML blocks one Question may carry. */
export const HTML_BLOCKS_MAX = 8;

/** The tallest a block makes itself by reporting its height; past it, it scrolls inside. */
export const HTML_BLOCK_MAX_HEIGHT = 2400;

/** The height reserved for a block that declares none and has none remembered. */
export const HTML_BLOCK_DEFAULT_HEIGHT = 160;

/** The widest a block may declare itself, in CSS pixels. */
export const HTML_BLOCK_MAX_WIDTH = 4000;

/** How a block runs beside the text: the column, past it by `wideBlocks`, or the reader's full width. */
export const HTML_BLOCK_WIDTHS = ['constrain', 'wide', 'full'] as const;
export type HtmlBlockWidth = (typeof HTML_BLOCK_WIDTHS)[number];

// A block as an event carries it: the hash of its document, which is the key
// of its blob, and its size. Plain fields, so a log never fails to decode on
// a check made later; the decision checks them (`checkHtmlBlocks`).
export const HtmlBlockRef = Schema.Struct({
  sha: Schema.String,
  bytes: Schema.Int,
});
export type HtmlBlockRef = typeof HtmlBlockRef.Type;

/** A Question's HTML blocks, by id. */
export const HtmlBlocks = Schema.Record(Schema.String, HtmlBlockRef);
export type HtmlBlocks = typeof HtmlBlocks.Type;

/** The blob table's `kind` for an HTML block's document. */
export const HTML_BLOCK_BLOB_KIND = 'html';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const idProblem = (id: string): string | undefined =>
  HTML_BLOCK_ID.test(id)
    ? undefined
    : `an HTML block's id is lower-case letters, digits and hyphens, starting with a letter or digit, at most 40 characters; got "${id}"`;

/**
 * A set of blocks as an event may carry it: every id well formed, every hash
 * a SHA-256 in hex, every size within the cap, and no more than
 * `HTML_BLOCKS_MAX` of them. The set as kept, ids in order, or the first
 * reason it cannot be.
 */
export const checkHtmlBlocks = (
  blocks: HtmlBlocks,
): Result.Result<HtmlBlocks, string> => {
  const ids = Object.keys(blocks).sort();
  if (ids.length > HTML_BLOCKS_MAX)
    return Result.fail(
      `a question may carry at most ${HTML_BLOCKS_MAX} HTML blocks; this one would have ${ids.length}`,
    );
  const out: Record<string, HtmlBlockRef> = {};
  for (const id of ids) {
    const problem = idProblem(id);
    if (problem !== undefined) return Result.fail(problem);
    const ref = blocks[id];
    if (ref === undefined || !SHA256_HEX.test(ref.sha))
      return Result.fail(
        `HTML block "${id}" names no document: its hash is not a SHA-256`,
      );
    if (
      !Number.isInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > HTML_BLOCK_MAX_BYTES
    )
      return Result.fail(
        `HTML block "${id}" is ${ref.bytes} bytes; a block is 1 byte to ${HTML_BLOCK_MAX_BYTES / 1024} KiB`,
      );
    out[id] = { sha: ref.sha, bytes: ref.bytes };
  }
  return Result.succeed(out);
};

// --- the document's declared size ---------------------------------------------------

/**
 * What a document declares about itself, read from its text without running
 * it: `<meta name="oi-block" content="width=760; height=420; aspect=16/9">`
 * and its `<title>`. Every key is optional.
 */
export interface HtmlBlockMeta {
  // Its natural width, in CSS pixels: how far a `wide` block grows.
  readonly width?: number;
  // Its height before it reports one, in CSS pixels.
  readonly height?: number;
  // Its shape, width over height, for a document sized by its width.
  readonly aspect?: number;
  // Its `<title>`: the frame's accessible name.
  readonly title?: string;
}

const META_TAG = /<meta\b[^>]*>/gi;
const ATTRIBUTE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const TITLE = /<title\b[^>]*>([^<]*)<\/title>/i;
const PIXELS = /^\d{1,5}(?:\.\d+)?(?:px)?$/;
const RATIO = /^(\d+(?:\.\d+)?)\s*(?:[/:]\s*(\d+(?:\.\d+)?))?$/;

const attributesOf = (tag: string): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTRIBUTE)) {
    const name = m[1]?.toLowerCase();
    if (name !== undefined) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
};

const pixels = (
  key: string,
  value: string,
  most: number,
): Result.Result<number, string> => {
  const n = PIXELS.test(value) ? Number.parseFloat(value) : Number.NaN;
  return n > 0 && n <= most
    ? Result.succeed(Math.round(n))
    : Result.fail(
        `the oi-block meta's ${key} is a number of pixels from 1 to ${most}; got "${value}"`,
      );
};

/**
 * The document's declared size and title, or why its `oi-block` meta does
 * not parse: more than one such meta, a key it does not know, or a value
 * that is not a size. A document with no such meta declares nothing, which
 * is fine.
 */
export const htmlBlockMetaOf = (
  doc: string,
): Result.Result<HtmlBlockMeta, string> => {
  const metas = [...doc.matchAll(META_TAG)]
    .map((m) => attributesOf(m[0]))
    .filter((a) => a.name?.toLowerCase() === 'oi-block');
  const rawTitle = TITLE.exec(doc)?.[1]?.trim();
  const out: {
    width?: number;
    height?: number;
    aspect?: number;
    title?: string;
  } = {};
  if (rawTitle !== undefined && rawTitle.length > 0) out.title = rawTitle;
  if (metas.length > 1)
    return Result.fail(
      `the document has ${metas.length} oi-block metas; it may have one`,
    );
  const content = metas[0]?.content;
  if (content === undefined) return Result.succeed(out);
  for (const pair of content.split(/[;,]/)) {
    if (pair.trim().length === 0) continue;
    const eq = pair.indexOf('=');
    const key = (eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : pair.slice(eq + 1).trim();
    if (key === 'width' || key === 'height') {
      const n = pixels(
        key,
        value,
        key === 'width' ? HTML_BLOCK_MAX_WIDTH : HTML_BLOCK_MAX_HEIGHT,
      );
      if (Result.isFailure(n)) return Result.fail(n.failure);
      out[key] = n.success;
    } else if (key === 'aspect') {
      const m = RATIO.exec(value);
      const w = m?.[1] === undefined ? Number.NaN : Number(m[1]);
      const h = m?.[2] === undefined ? 1 : Number(m[2]);
      if (!(w > 0 && h > 0))
        return Result.fail(
          `the oi-block meta's aspect is width over height, as 16/9 or 1.5; got "${value}"`,
        );
      out.aspect = w / h;
    } else
      return Result.fail(
        `the oi-block meta has a key it does not know, "${key}"; it takes width, height and aspect`,
      );
  }
  return Result.succeed(out);
};

/**
 * A document as `ask` and `edit` may keep it, given as its UTF-8 size: the id
 * well formed, no larger than `HTML_BLOCK_MAX_BYTES`, and its `oi-block` meta
 * parsing. The meta it declares, or the first reason it cannot be kept.
 */
export const checkHtmlDocument = (
  id: string,
  doc: string,
  bytes: number,
): Result.Result<HtmlBlockMeta, string> => {
  const problem = idProblem(id);
  if (problem !== undefined) return Result.fail(problem);
  if (bytes > HTML_BLOCK_MAX_BYTES)
    return Result.fail(
      `HTML block "${id}" is ${Math.ceil(bytes / 1024)} KiB; a block may be at most ${HTML_BLOCK_MAX_BYTES / 1024} KiB`,
    );
  if (doc.trim().length === 0)
    return Result.fail(`HTML block "${id}" is empty`);
  return Result.mapError(
    htmlBlockMetaOf(doc),
    (why) => `HTML block "${id}": ${why}`,
  );
};

// --- the frame ----------------------------------------------------------------------

/** The frame's `sandbox`: scripts, and nothing else, so its origin is opaque. */
export const HTML_BLOCK_SANDBOX = 'allow-scripts';

/** The path under the app's origin that serves the vendored libraries. */
export const HTML_BLOCK_VENDOR_PATH = '/vendor/';

/**
 * The files the app serves under `/vendor/`: three.js as ES modules (its
 * module build, the core it imports, and OrbitControls, which imports
 * `three`), and d3 as a classic script that sets `window.d3`.
 */
export const HTML_BLOCK_VENDOR_FILES = [
  'three.module.js',
  'three.core.js',
  'three-addons/controls/OrbitControls.js',
  'd3.min.js',
] as const;
export type HtmlBlockVendorFile = (typeof HTML_BLOCK_VENDOR_FILES)[number];

/** The vendored files' text, by name: what a block's frame is handed. */
export type HtmlBlockLibraries = Readonly<
  Partial<Record<HtmlBlockVendorFile, string>>
>;

// The specifiers a document may import, each with the files it needs.
const SPECIFIERS: ReadonlyArray<
  readonly [RegExp, ReadonlyArray<HtmlBlockVendorFile>]
> = [
  [/['"]three['"]/, ['three.module.js', 'three.core.js']],
  [
    /['"]three\/addons\/controls\/OrbitControls\.js['"]/,
    [
      'three.module.js',
      'three.core.js',
      'three-addons/controls/OrbitControls.js',
    ],
  ],
  [/['"]d3['"]/, ['d3.min.js']],
];

/**
 * The vendored files a document needs, read from its text: the specifiers
 * `'three'`, `'three/addons/controls/OrbitControls.js'` and `'d3'`, quoted.
 * A document that names none is handed none, and stays small. Reading a
 * quoted name that is not an import costs only the bytes of a library it
 * does not use.
 */
export const htmlBlockLibrariesOf = (
  doc: string,
): ReadonlyArray<HtmlBlockVendorFile> => {
  const files = new Set<HtmlBlockVendorFile>();
  for (const [specifier, needs] of SPECIFIERS)
    if (specifier.test(doc)) for (const f of needs) files.add(f);
  return HTML_BLOCK_VENDOR_FILES.filter((f) => files.has(f));
};

/**
 * The Content-Security-Policy written first into every block's document. No
 * request leaves the frame: no source is an http(s) one, nothing to connect
 * to, no images or fonts but `data:` and `blob:`, no form to post, no
 * `<base>`. Scripts run inline (the whole document is inline, and the frame
 * has nothing of the page's to protect) or from the `blob:` URLs the frame
 * makes of the libraries it was handed. A policy the document writes itself
 * can only narrow this one: policies intersect.
 */
export const HTML_BLOCK_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** What a block's bootstrap posts to the page. */
export type HtmlBlockMessage =
  | { readonly oi: 'ready' }
  | { readonly oi: 'size'; readonly height: number }
  | { readonly oi: 'error'; readonly message: string }
  // A wheel the block did not take, for the page to scroll by: `mode` is the
  // event's `deltaMode` (0 pixels, 1 lines, 2 pages).
  | {
      readonly oi: 'wheel';
      readonly dx: number;
      readonly dy: number;
      readonly mode: number;
    }
  // The reader clicked into the block (`on`), or left it.
  | { readonly oi: 'engaged'; readonly on: boolean };

/**
 * Where a wheel over a block goes. `page`: it scrolls the page until the
 * reader clicks into the block, so a block that zooms on the wheel (a scene
 * with OrbitControls) is no trap; a block left, or Escape, hands it back.
 * `block`: always to the document, as in the full-screen view, where there is
 * no page to scroll.
 */
export type HtmlBlockWheel = 'page' | 'block';

/** The page's colours and faces, handed to a block as CSS variables. */
export type HtmlBlockTokens = Readonly<Record<string, string>>;

export type HtmlBlockScheme = 'light' | 'dark';

// The bootstrap the frame runs before the document. `window.oi` is all a
// document gets: `scheme` and `tokens`. It posts the body's height, at most
// once an animation frame or 100ms, whichever comes first (WebKit pauses
// animation frames in a frame scrolled out of view, so a block above the view
// would otherwise never report growing), and never for a change under 2px;
// `ready` on load; and each uncaught error or rejection, which the page shows
// once, outside the frame (but never the ResizeObserver loop notice).
//
// The page posts `{oi: 'column', left, width}` whenever the layout moves:
// where the text column sits in the frame, in px. The bootstrap sets them as
// `--oi-column-left` and `--oi-column-width` on the root, so a document can
// align a caption or an overlay with the prose. Until then, and full screen,
// they are 0px and 100%.
//
// With the wheel on the page (`HtmlBlockWheel`), a capture listener on the
// window, registered before any of the document's, takes each wheel while
// the block is not engaged: the document's own handlers never see it, and
// the page is told to scroll by it. A pointerdown engages the block; leaving
// it (the frame's own pointerleave, or the page's `disengage` when the mouse
// leaves the frame) and Escape disengage it. A ctrl+wheel, a trackpad's
// pinch, always goes to the document. Hover and drag need no engaging.
const bootstrap = (
  scheme: HtmlBlockScheme,
  tokens: HtmlBlockTokens,
  wheel: HtmlBlockWheel,
) => `
(function () {
  var post = function (m) { parent.postMessage(m, '*'); };
  window.oi = { scheme: ${jsonInScript(scheme)}, tokens: ${jsonInScript(tokens)} };
  var fail = function (m) { post({ oi: 'error', message: String(m) }); };
  // A ResizeObserver that could not deliver every notification in one frame
  // ("ResizeObserver loop completed with undelivered notifications.", or
  // "…limit exceeded") is the spec's loop-limit notice, which Chromium fires
  // as a window error: nothing failed, so it is not said.
  window.addEventListener('error', function (e) {
    var m = e.message || 'error';
    if (/^ResizeObserver loop/.test(m)) return;
    fail(m);
  });
  window.addEventListener('unhandledrejection', function (e) { fail(e.reason); });
  var last = -1, queued = false;
  var send = function () {
    queued = false;
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (Math.abs(h - last) < 2) return;
    last = h;
    post({ oi: 'size', height: h });
  };
  var measure = function () {
    if (queued) return;
    queued = true;
    var fired = false;
    var once = function () { if (fired) return; fired = true; send(); };
    requestAnimationFrame(once);
    setTimeout(once, 100);
  };
  document.addEventListener('DOMContentLoaded', function () {
    new ResizeObserver(measure).observe(document.body);
    measure();
  });
  window.addEventListener('load', function () { send(); post({ oi: 'ready' }); });
  // The text column's place in the frame, from the page, as it changes.
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.oi !== 'column') return;
    var root = document.documentElement.style;
    if (typeof m.left === 'number' && isFinite(m.left) && m.left >= 0)
      root.setProperty('--oi-column-left', m.left + 'px');
    if (typeof m.width === 'number' && isFinite(m.width) && m.width > 0)
      root.setProperty('--oi-column-width', m.width + 'px');
  });
  if (${jsonInScript(wheel)} !== 'page') return;
  var engaged = false;
  var engage = function (on) {
    if (engaged === on) return;
    engaged = on;
    post({ oi: 'engaged', on: on });
  };
  window.addEventListener('wheel', function (e) {
    if (engaged || e.ctrlKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ oi: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode });
  }, { capture: true, passive: false });
  window.addEventListener('pointerdown', function () { engage(true); }, true);
  document.documentElement.addEventListener('pointerleave', function () { engage(false); });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') engage(false); }, true);
  window.addEventListener('message', function (e) {
    if (e.source === parent && e.data && e.data.oi === 'disengage') engage(false);
  });
})();
`;

// The loader, a classic script that runs before any module does. It makes a
// `blob:` URL of each library it was handed (as JSON strings, so no text in
// them can close the tag), points three's module build at the core's URL in
// place of './three.core.js', and writes the import map that names them.
// OrbitControls imports 'three', which the map resolves to the same module.
// Chromium refuses an opaque-origin frame a fetch from the app's loopback
// address, so the libraries come in as text and nothing is fetched.
const loader = (libraries: HtmlBlockLibraries) => `
(function () {
  var src = ${jsonInScript(libraries)};
  var url = function (text) {
    return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  };
  var imports = {};
  if (typeof src['d3.min.js'] === 'string') imports.d3 = url(src['d3.min.js']);
  if (typeof src['three.module.js'] === 'string' && typeof src['three.core.js'] === 'string') {
    var core = url(src['three.core.js']);
    imports.three = url(src['three.module.js'].split("'./three.core.js'").join(JSON.stringify(core)));
  }
  var controls = src['three-addons/controls/OrbitControls.js'];
  if (typeof controls === 'string' && imports.three) imports['three/addons/controls/OrbitControls.js'] = url(controls);
  document.write('<script type="importmap">' + JSON.stringify({ imports: imports }) + '<\\/script>');
})();
`;

// JSON for inside a `<script>`: `<` escaped, so no value can close the tag.
const jsonInScript = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c');

const cssValue = (value: string): string => value.replace(/[;{}<>]/g, '');

const attribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A block's `srcdoc`: a head the app writes (the policy first, so it governs
 * everything after it; the loader, when the document uses a vendored
 * library, handed only the ones it uses; the page's colours as CSS variables; the bootstrap), then the document as it
 * was given, its own `<!doctype>`, `<html>` and `<head>` tags dropped, since
 * the parser would ignore them after this head anyway and the policy must
 * stay first.
 */
export const htmlBlockSrcdoc = (
  doc: string,
  options: {
    readonly scheme: HtmlBlockScheme;
    readonly tokens: HtmlBlockTokens;
    // The vendored libraries' text; only those the document uses are handed
    // on (`htmlBlockLibrariesOf`).
    readonly libraries?: HtmlBlockLibraries;
    // Where a wheel goes; `page` unless given.
    readonly wheel?: HtmlBlockWheel;
  },
): string => {
  const { scheme, tokens } = options;
  const libraries: Partial<Record<HtmlBlockVendorFile, string>> = {};
  for (const name of htmlBlockLibrariesOf(doc)) {
    const text = options.libraries?.[name];
    if (text !== undefined) libraries[name] = text;
  }
  const vars = Object.entries(tokens)
    .filter(([k]) => /^[a-z][a-z0-9-]*$/.test(k))
    .map(([k, v]) => `--${k}: ${cssValue(v)};`)
    .join(' ');
  const head = [
    '<!doctype html>',
    `<html data-scheme="${scheme}" style="color-scheme: ${scheme}">`,
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${attribute(HTML_BLOCK_CSP)}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    Object.keys(libraries).length === 0
      ? ''
      : `<script>${loader(libraries)}</script>`,
    `<style>:root{${vars} --oi-column-left: 0px; --oi-column-width: 100%;}html,body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font)}body{display:flow-root}</style>`,
    `<script>${bootstrap(scheme, tokens, options.wheel ?? 'page')}</script>`,
    '</head>',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  const body = doc
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<\/?head\b[^>]*>/gi, '');
  return `${head}\n${body}`;
};

/**
 * What the page says when a block's script fails. WebKit mutes an error in an
 * opaque-origin frame to "Script error.", so the page says what it knows.
 */
export const htmlBlockFailure = (message: string): string =>
  /^script error\.?$/i.test(message.trim()) || message.trim().length === 0
    ? 'A script in this block failed (the browser hides the message).'
    : `A script in this block failed: ${message}`;
