import {
  HTML_BLOCK_VENDOR_FILES,
  HTML_BLOCK_VENDOR_PATH,
  type HtmlBlockMessage,
  type HtmlBlockScheme,
  type HtmlBlockTokens,
  type HtmlBlockVendorFile,
  InboxId,
  InboxOperatorQuestionDto,
  type QuestionHtmlBlocksDto,
} from '@operator-inbox/core/api';
import { Effect, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/http';
import { KeyValueStore } from 'effect/persistence';
import { Atom } from 'effect/reactivity';
import { InboxClient } from './api';

// The page's side of a Question's HTML blocks (core's `html-block.ts`): the
// documents, fetched for the Question shown and never with the board; the
// heights this browser remembers, so a block reserves its room before it
// runs; and each running frame's state.

// --- the documents ---------------------------------------------------------------

/** What names one Question's set of documents: its Inbox, number and hashes. */
export interface HtmlBlocksKey {
  readonly inboxId: InboxId;
  readonly number: InboxOperatorQuestionDto['number'];
  // The hashes of its blocks, in id order: an edit that changes one reads
  // the set again.
  readonly shas: ReadonlyArray<string>;
}

export const htmlBlocksKeyOf = (k: HtmlBlocksKey): string =>
  JSON.stringify([k.inboxId, k.number, k.shas]);

const KeyJson = Schema.fromJsonString(
  Schema.Tuple([
    InboxId,
    InboxOperatorQuestionDto.fields.number,
    Schema.Array(Schema.String),
  ]),
);
const decodeKey = Schema.decodeUnknownSync(KeyJson);

/**
 * One Question's documents, by id, read once per set of hashes and kept for
 * the page's life: a document never changes under its hash.
 */
export const htmlBlocksAtom = Atom.family((key: string) => {
  const [inboxId, number] = decodeKey(key);
  return InboxClient.runtime
    .atom(
      InboxClient.use(
        (client): Effect.Effect<QuestionHtmlBlocksDto, unknown> =>
          client.inbox.htmlBlocks({
            params: { inboxId, number },
            query: {},
          }),
      ),
    )
    .pipe(Atom.keepAlive);
});

// --- the vendored libraries ---------------------------------------------------------

// The page reads three.js and d3 from its own origin and hands their text
// into a block's frame, which makes `blob:` URLs of them: Chromium refuses an
// opaque-origin frame a fetch from the app's loopback address, and the
// frame's policy names no host at all (core's `HTML_BLOCK_CSP`).
const vendorRuntime = Atom.runtime(FetchHttpClient.layer);

/** One vendored file's text, read once for the page's life. */
export const vendorFileAtom = Atom.family((name: HtmlBlockVendorFile) =>
  vendorRuntime
    .atom(
      HttpClient.get(`${HTML_BLOCK_VENDOR_PATH}${name}`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
      ),
    )
    .pipe(Atom.keepAlive),
);

/** The files a document uses, as the key `vendorLibrariesAtom` takes. */
export const vendorKeyOf = (files: ReadonlyArray<HtmlBlockVendorFile>) =>
  files.join(',');

/** The text of the files a key names, each read once (`vendorFileAtom`). */
export const vendorLibrariesAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    Effect.gen(function* () {
      const out: Partial<Record<HtmlBlockVendorFile, string>> = {};
      const names = key.split(',');
      for (const name of HTML_BLOCK_VENDOR_FILES)
        if (names.includes(name))
          out[name] = yield* get.result(vendorFileAtom(name));
      return out;
    }),
  ).pipe(Atom.keepAlive),
);

// --- the heights a reload remembers -----------------------------------------------

/** How many blocks' heights this browser remembers, the most recent kept. */
export const HTML_BLOCK_HEIGHTS_KEPT = 200;

// Each block's last reported height, by its Question, id and hash, oldest
// first. Where localStorage cannot be read, nothing is remembered and a block
// reserves what its document declares.
export const htmlBlockHeightsAtom = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: 'operator-inbox:html-block-heights',
  schema: Schema.Record(Schema.String, Schema.Number),
  defaultValue: () => ({}),
}).pipe(Atom.keepAlive);

type Heights = Atom.Type<typeof htmlBlockHeightsAtom>;

/** `heights` with `key` the most recent at `height`, trimmed to the newest kept. */
export const rememberedHeights = (
  heights: Heights,
  key: string,
  height: number,
): Heights => {
  if (heights[key] === height) return heights;
  const entries = Object.entries(heights).filter(([k]) => k !== key);
  entries.push([key, height]);
  return Object.fromEntries(entries.slice(-HTML_BLOCK_HEIGHTS_KEPT));
};

// --- the scheme --------------------------------------------------------------------

const schemeNow = (): HtmlBlockScheme =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

/** The page's colour scheme, following `prefers-color-scheme` as it changes. */
export const colourSchemeAtom = Atom.make((get): HtmlBlockScheme => {
  if (typeof matchMedia === 'undefined') return 'light';
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const on = () => get.setSelf(schemeNow());
  mq.addEventListener('change', on);
  get.addFinalizer(() => mq.removeEventListener('change', on));
  return schemeNow();
}).pipe(Atom.keepAlive);

// The page's colours and faces as they are now, for a frame's CSS variables.
const COLOURS = [
  'fg',
  'bg',
  'blue',
  'orange',
  'purple',
  'green',
  'red',
  'yellow',
] as const;

export const pageTokens = (): HtmlBlockTokens => {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of COLOURS)
    out[name] = css.getPropertyValue(`--color-${name}`).trim();
  out.font = css.getPropertyValue('--font-zen').trim();
  out.mono = css.getPropertyValue('--font-app').trim();
  return out;
};

// --- a running frame ---------------------------------------------------------------

export interface HtmlFrameState {
  // How many times it has been run: ↻ runs it again, as a new frame.
  readonly run: number;
  // The frame's `load` event, or the bootstrap's `ready`, has come.
  readonly loaded: boolean;
  // The first uncaught error or rejection the bootstrap reported.
  readonly error?: string;
  // The height the document last reported.
  readonly height?: number;
  // The reader has clicked into it, so a wheel goes to the document.
  readonly engaged?: boolean;
}

const IDLE: HtmlFrameState = { run: 0, loaded: false };

/** One frame's state, by the place it runs in (inline, or full screen). */
export const htmlFrameAtom = Atom.family((_place: string) =>
  Atom.make<HtmlFrameState>(IDLE),
);

/** The state once `message` arrives from the frame. */
export const frameStateAfter = (
  state: HtmlFrameState,
  message: HtmlBlockMessage,
): HtmlFrameState => {
  switch (message.oi) {
    case 'ready':
      return state.loaded ? state : { ...state, loaded: true };
    case 'size':
      return typeof message.height === 'number' &&
        Number.isFinite(message.height) &&
        message.height >= 0 &&
        (state.height === undefined ||
          Math.abs(message.height - state.height) >= 2)
        ? { ...state, height: message.height }
        : state;
    case 'error':
      return state.error === undefined
        ? { ...state, error: String(message.message) }
        : state;
    case 'engaged':
      return (state.engaged ?? false) === (message.on === true)
        ? state
        : { ...state, engaged: message.on === true };
    case 'wheel':
      // Not state: the page scrolls by it (`wheelPixels`).
      return state;
  }
};

/**
 * A forwarded wheel's distance in pixels: `mode` is the event's `deltaMode`,
 * 0 pixels, 1 lines (`line` pixels each), 2 pages (`page` pixels each).
 * Anything that is not a finite number moves nothing.
 */
export const wheelPixels = (
  message: {
    readonly dx: unknown;
    readonly dy: unknown;
    readonly mode: unknown;
  },
  line: number,
  page: number,
): { readonly x: number; readonly y: number } => {
  const unit = message.mode === 1 ? line : message.mode === 2 ? page : 1;
  const px = (d: unknown) =>
    typeof d === 'number' && Number.isFinite(d) ? d * unit : 0;
  return { x: px(message.dx), y: px(message.dy) };
};

/** The state for a run again: a new frame, nothing loaded nor engaged, the height kept. */
export const frameRunAgain = (state: HtmlFrameState): HtmlFrameState => ({
  run: state.run + 1,
  loaded: false,
  ...(state.height === undefined ? {} : { height: state.height }),
});

/**
 * Where the text column sits in a block's frame, from their boxes on the
 * page: how far in from the frame's left edge it starts, and how wide it is,
 * in whole px. A block no wider than the column has it at 0.
 */
export const columnInset = (
  room: { readonly left: number; readonly width: number },
  frame: { readonly left: number },
): {
  readonly oi: 'column';
  readonly left: number;
  readonly width: number;
} => ({
  oi: 'column',
  left: Math.max(0, Math.round(room.left - frame.left)),
  width: Math.round(room.width),
});

/** Is `data` one of the bootstrap's messages? */
export const isFrameMessage = (data: unknown): data is HtmlBlockMessage =>
  typeof data === 'object' &&
  data !== null &&
  'oi' in data &&
  (data.oi === 'ready' ||
    data.oi === 'size' ||
    data.oi === 'error' ||
    data.oi === 'wheel' ||
    data.oi === 'engaged');
