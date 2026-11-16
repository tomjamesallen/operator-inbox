import type { InboxBoardDto } from '@operator-inbox/core/api';
import { Effect, Schema } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { Atom } from 'effect/reactivity';
import { drawnBoardAtom } from './inbox';

// Mermaid diagrams in inbox question bodies. The library is loaded with a
// dynamic import the first time a board holds a diagram, so it is its own
// chunk and costs nothing on a page with none.
//
// A diagram is drawn to SVG text and shown as an `<img>` with a `data:` URL,
// as a ```svg fence is: an SVG loaded as an image runs no script and fetches
// nothing. Mermaid's own `strict` security level cleans its input too. Labels
// are drawn as SVG text, not HTML, because an image does not lay out HTML.
//
// A diagram is drawn inline, in a frame whose shape is the diagram's own, so
// the question it sits in should mount at its final height: a picture arriving
// later moves everything under it, and the reader with it. So each diagram is
// drawn as soon as the board holding it arrives (`mermaidPrefetchAtom`), not
// when its question is drawn, and its size is remembered by a hash of its
// source: in memory with the drawing, and in localStorage alone, so a reload
// reserves the frame before Mermaid has even loaded.

// Mermaid needs a fresh element id for each drawing.
let drawn = 0;

const prefersDark = (): boolean =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-color-scheme: dark)').matches;

// Fixed sizes rather than "100% of the container", so the image has a size
// of its own: the frame scales it down, the full-screen view scales it up.
const fixedSize = { useMaxWidth: false, htmlLabels: false };

// What the reader is told when the library itself does not load. The usual
// cause is a page opened before a rebuild asking for a file the build has
// since removed (the build keeps a few earlier builds' files; see
// `keepEarlierBuilds` in vite.config.ts). A reload fetches the current build.
export const mermaidLoadFailure = (e: unknown): string =>
  `Mermaid did not load (${String(e)}). The app may have been rebuilt since this page opened: reload the page.`;

const loadMermaid = Effect.tryPromise({
  try: () => import('mermaid'),
  catch: mermaidLoadFailure,
}).pipe(
  Effect.map(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // On a parse error Mermaid would otherwise draw its own error picture
      // into a scratch element on `document.body` and throw without removing
      // it, leaving that picture on the page. Suppressed, it removes the
      // scratch element and throws, and the diagram's frame shows the error
      // with its source.
      suppressErrorRendering: true,
      theme: prefersDark() ? 'dark' : 'default',
      htmlLabels: false,
      flowchart: fixedSize,
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false },
    });
    return mermaid;
  }),
);

/** SVG text as a `data:` URL an `<img>` can show. */
export const svgDataUrl = (svg: string): string => {
  let binary = '';
  for (const b of new TextEncoder().encode(svg))
    binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

/** A picture's own size, in any one unit: only its shape is read from it. */
export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size an SVG gives itself on its root element: its `width` and
 * `height` when both are plain lengths, else its `viewBox`'s. Undefined when
 * it gives neither.
 */
export const svgSizeOf = (svg: string): PictureSize | undefined => {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (tag === undefined) return undefined;
  // A space before the name, so `stroke-width` is not `width`.
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  const length = (value: string | undefined) =>
    value !== undefined && /^\s*\d+(\.\d+)?(px)?\s*$/.test(value)
      ? Number.parseFloat(value)
      : undefined;
  const width = length(attribute('width'));
  const height = length(attribute('height'));
  if (width !== undefined && height !== undefined && width > 0 && height > 0)
    return { width, height };
  const box = (attribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , w, h] = box;
  return box.length === 4 &&
    w !== undefined &&
    h !== undefined &&
    w > 0 &&
    h > 0
    ? { width: w, height: h }
    : undefined;
};

/**
 * A short, stable name for a diagram's source: its length and its 32-bit
 * FNV-1a hash, in base 36. It keys the caches; two sources sharing one would
 * share a remembered size only until the drawing itself arrives.
 */
export const mermaidHash = (source: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${source.length.toString(36)}-${(hash >>> 0).toString(36)}`;
};

// --- the sizes a reload remembers ------------------------------------------------

/** How many diagrams' sizes this browser remembers, the most recent kept. */
export const MERMAID_SIZES_KEPT = 200;

const browserStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => localStorage),
);

// Each diagram's size by its hash, as `[width, height]`, oldest first. Where
// localStorage cannot be read, nothing is remembered and a frame waits for
// its drawing.
export const mermaidSizesAtom = Atom.kvs({
  runtime: browserStorage,
  key: 'operator-inbox:mermaid-sizes',
  schema: Schema.Record(
    Schema.String,
    Schema.Tuple([Schema.Number, Schema.Number]),
  ),
  defaultValue: () => ({}),
}).pipe(Atom.keepAlive);

type Sizes = Atom.Type<typeof mermaidSizesAtom>;

/** `sizes` with `hash` the most recent, trimmed to the newest kept. */
export const rememberedSizes = (
  sizes: Sizes,
  hash: string,
  { width, height }: PictureSize,
): Sizes => {
  const was = sizes[hash];
  if (was?.[0] === width && was[1] === height) return sizes;
  const entries = Object.entries(sizes).filter(([key]) => key !== hash);
  entries.push([hash, [width, height]]);
  return Object.fromEntries(entries.slice(-MERMAID_SIZES_KEPT));
};

// --- the drawings ----------------------------------------------------------------

/** A drawn diagram: its image, and its own size when the SVG gives one. */
export interface MermaidDrawing {
  readonly url: string;
  readonly size: PictureSize | undefined;
}

// The drawings this page has made, by hash, with the source each was drawn
// from. Kept past the Atom that made it, so a question drawn again (another
// queue, another view) has its picture at once. Bounded as the sizes are.
const drawings = new Map<
  string,
  { readonly source: string; readonly drawing: MermaidDrawing }
>();

const keepDrawing = (
  hash: string,
  source: string,
  drawing: MermaidDrawing,
): void => {
  drawings.delete(hash);
  drawings.set(hash, { source, drawing });
  for (const oldest of drawings.keys()) {
    if (drawings.size <= MERMAID_SIZES_KEPT) break;
    drawings.delete(oldest);
  }
};

// Mermaid draws in scratch elements on `document.body`: the drawing `id`
// inside a `d<id>` div (or an `i<id>` iframe in its sandbox mode). It removes
// them itself when it succeeds and, with its error rendering suppressed, when
// it fails; this removes whatever any other path leaves, so a drawing never
// shows anywhere but in its own frame.
const removeScratch = (id: string): void => {
  for (const scratch of [`d${id}`, `i${id}`, id])
    document.getElementById(scratch)?.remove();
};

// One drawing per diagram source, or the reason Mermaid could not draw it.
// One this page has drawn before resolves at once.
export const mermaidImageAtom = Atom.family((source: string) =>
  Atom.make((get) => {
    const hash = mermaidHash(source);
    const known = drawings.get(hash);
    if (known?.source === source) return Effect.succeed(known.drawing);
    return Effect.gen(function* () {
      const mermaid = yield* loadMermaid;
      drawn += 1;
      const id = `operator-inbox-mermaid-${drawn}`;
      const { svg } = yield* Effect.tryPromise({
        try: () => mermaid.render(id, source),
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      }).pipe(Effect.ensuring(Effect.sync(() => removeScratch(id))));
      const drawing: MermaidDrawing = {
        url: svgDataUrl(svg),
        size: svgSizeOf(svg),
      };
      keepDrawing(hash, source, drawing);
      if (drawing.size !== undefined)
        get.set(
          mermaidSizesAtom,
          rememberedSizes(get.once(mermaidSizesAtom), hash, drawing.size),
        );
      return drawing;
    });
  }),
);

// The size to reserve for a diagram before its drawing arrives: the one this
// browser remembers for its source, if any.
export const mermaidReservedSizeAtom = Atom.family((source: string) => {
  const hash = mermaidHash(source);
  return Atom.make((get): PictureSize | undefined => {
    const size = get(mermaidSizesAtom)[hash];
    return size === undefined ? undefined : { width: size[0], height: size[1] };
  });
});

/** Every diagram source on a board, each once, in board order. */
export const mermaidSourcesOf = (
  board: InboxBoardDto,
): ReadonlyArray<string> => {
  const sources = new Set<string>();
  for (const view of board.views)
    for (const question of [
      ...view.awaitingOperator,
      ...view.awaitingAgent,
      ...view.processed,
    ])
      for (const part of question.bodyParts ?? [])
        if (part.kind === 'mermaid') sources.add(part.source);
  return [...sources];
};

// Draws every diagram on the board as soon as the board arrives, whichever
// queue or view it is in, so its question is drawn with its picture, or at
// least with its frame. Mounted by the question flow while it is shown.
export const mermaidPrefetchAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  if (board === undefined) return;
  for (const source of mermaidSourcesOf(board))
    get.mount(mermaidImageAtom(source));
});
