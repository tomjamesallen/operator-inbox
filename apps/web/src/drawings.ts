import {
  type InboxBoardDto,
  InboxId,
  InboxOperatorQuestionDto,
} from '@operator-inbox/core/api';
import { Effect, Option, Schema } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { AsyncResult, Atom } from 'effect/reactivity';
import { inboxBoardAtom } from './inbox';
import { answerKey } from './inbox-queues';

// Excalidraw drawings in inbox question bodies: a body line
// `<Excalidraw id="…"/>` names one of the Question's drawings (its
// `drawings`, each a scene as JSON text and the revision that last set it).
//
// Everything that imports Excalidraw is one module,
// `components/drawing-canvas.tsx`, loaded by a dynamic import the first time
// a drawing is drawn, so a page with none pays nothing, its stylesheet
// included. Inline, a drawing is a static picture (an SVG exported from the
// scene, shown as an `<img>`, so the page scrolls over it as over an image);
// it is edited only in the full-screen editor.
//
// The operator's edits are drafts, kept in this browser's localStorage per
// Question and drawing, each stamped with the revision of the drawing it was
// made against. The answer, or the deferral, carries the drawings with a
// draft, and they are dropped once the server takes it. A draft whose
// drawing the agent has changed since is a conflict, which the operator
// settles (keep theirs or mine) before anything can be sent.

// --- the editor's module ------------------------------------------------------------

/**
 * Where the build serves Excalidraw's fonts from: `fonts/<Family>/<file>` under
 * it. The same path as `EXCALIDRAW_ASSETS` in `vite.config.ts`, which copies
 * the fonts there; repeated, as a Vite config cannot import the app.
 */
export const EXCALIDRAW_ASSET_PATH = '/excalidraw/';

declare global {
  interface Window {
    // Read by Excalidraw when it builds a font's URL. Without it the fonts
    // come from a CDN; with it, from this app.
    EXCALIDRAW_ASSET_PATH?: string | ReadonlyArray<string>;
  }
}

// What the reader is told when the module itself does not load: as a
// Mermaid diagram's, most often a page opened before a rebuild.
export const drawingLoadFailure = (e: unknown): string =>
  `The drawing editor did not load (${String(e)}). The app may have been rebuilt since this page opened: reload the page.`;

const loadCanvas = Effect.tryPromise({
  try: () => {
    // Before the module runs, so its fonts are this build's own.
    window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
    return import('./components/drawing-canvas');
  },
  catch: drawingLoadFailure,
});

/** The editor's module, loaded when something first reads it. */
export const drawingCanvasAtom = Atom.make(loadCanvas).pipe(Atom.keepAlive);

// --- the pictures ---------------------------------------------------------------------

const prefersDark = (): boolean =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-color-scheme: dark)').matches;

/** SVG text as a `data:` URL an `<img>` can show. */
const svgDataUrl = (svg: string): string => {
  let binary = '';
  for (const b of new TextEncoder().encode(svg))
    binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

// One picture per scene, or the reason it could not be drawn. The SVG
// carries its fonts inline, so the `<img>` draws the hand-drawn face and
// fetches nothing.
export const drawingPictureAtom = Atom.family((scene: string) =>
  Atom.make(
    Effect.gen(function* () {
      const canvas = yield* loadCanvas;
      const svg = yield* Effect.tryPromise({
        try: () => canvas.drawingSvg(scene, prefersDark()),
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      });
      return svgDataUrl(svg);
    }),
  ),
);

// --- the drafts -----------------------------------------------------------------------

/** The operator's edit of one drawing of one Question. */
export const DrawingDraft = Schema.Struct({
  inboxId: InboxId,
  number: InboxOperatorQuestionDto.fields.number,
  id: Schema.String,
  // The whole edited scene, as JSON text.
  scene: Schema.String,
  // The drawing's revision when the edit began, or when the operator last
  // chose to keep theirs over the agent's change.
  revision: Schema.Int,
});
export type DrawingDraft = typeof DrawingDraft.Type;

/** A drawing's place on the page: its question's key (`answerKey`) and its id. */
export const drawingKey = (questionKey: string, id: string): string =>
  `${questionKey}#${id}`;

const keyOf = (d: DrawingDraft): string =>
  drawingKey(answerKey(d.inboxId, d.number), d.id);

/**
 * The drafts whose question still waits on the operator, as far as `board`
 * can say: as the response drafts are (`draftsStillWaiting` in `inbox.ts`), a
 * draft is dropped only when its Inbox is on the board and the question is
 * not among those waiting there. A draft of a drawing the question no longer
 * carries is dropped too. The same array when nothing is dropped.
 */
export const drawingDraftsStillWaiting = (
  drafts: ReadonlyArray<DrawingDraft>,
  board: Pick<InboxBoardDto, 'views'>,
): ReadonlyArray<DrawingDraft> => {
  const views = new Map(board.views.map((v) => [v.inboxId, v]));
  const kept = drafts.filter((d) => {
    const view = views.get(d.inboxId);
    if (view === undefined) return true;
    const question = view.awaitingOperator.find((q) => q.number === d.number);
    return question?.drawings?.[d.id] !== undefined;
  });
  return kept.length === drafts.length ? drafts : kept;
};

// In localStorage rather than the tab's storage, where the response drafts
// are: a drawing is more work to redo than a line of text.
const browserStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => localStorage),
);

const storedDrawingDraftsAtom = Atom.kvs({
  runtime: browserStorage,
  key: 'operator-inbox:drawing-drafts',
  schema: Schema.Array(DrawingDraft),
  defaultValue: (): ReadonlyArray<DrawingDraft> => [],
}).pipe(Atom.keepAlive);

/** Every drawing draft still worth keeping. */
export const drawingDraftsAtom: Atom.Atom<ReadonlyArray<DrawingDraft>> =
  Atom.make((get) => {
    const drafts = get(storedDrawingDraftsAtom);
    const board = Option.getOrUndefined(AsyncResult.value(get(inboxBoardAtom)));
    return board === undefined
      ? drafts
      : drawingDraftsStillWaiting(drafts, board);
  }).pipe(Atom.keepAlive);

/**
 * One drawing's draft (keyed by `drawingKey`), undefined when the operator
 * has not changed it. Writing undefined drops it. A write keeps only the
 * drafts still worth keeping, so a dropped one leaves the storage then.
 */
export const drawingDraftAtom = Atom.family((key: string) =>
  Atom.writable(
    (get) => get(drawingDraftsAtom).find((d) => keyOf(d) === key),
    (ctx, next: DrawingDraft | undefined) => {
      const rest = ctx.get(drawingDraftsAtom).filter((d) => keyOf(d) !== key);
      ctx.set(
        storedDrawingDraftsAtom,
        next === undefined ? rest : [...rest, next],
      );
    },
  ),
);

/** The drafts of one question's drawings (by its `answerKey`). */
export const questionDrawingDraftsAtom = Atom.family((questionKey: string) =>
  Atom.make((get) =>
    get(drawingDraftsAtom).filter(
      (d) => answerKey(d.inboxId, d.number) === questionKey,
    ),
  ),
);

type DrawingsOf = Pick<InboxOperatorQuestionDto, 'drawings'>;

/**
 * The drawings whose draft was made against an older revision than the
 * question's drawing now has: the agent changed it since. Nothing goes until
 * each is settled.
 */
export const drawingConflicts = (
  drafts: ReadonlyArray<DrawingDraft>,
  question: DrawingsOf,
): ReadonlyArray<string> =>
  drafts
    .filter((d) => {
      const now = question.drawings?.[d.id];
      return now !== undefined && now.revision > d.revision;
    })
    .map((d) => d.id);

/**
 * What an answer carries: the drafts of the drawings the question still has,
 * by id, each its whole scene. Undefined when there are none, so the key is
 * left out of the payload.
 */
export const drawingsToSend = (
  drafts: ReadonlyArray<DrawingDraft>,
  question: DrawingsOf,
): Readonly<Record<string, string>> | undefined => {
  const sent = drafts.filter((d) => question.drawings?.[d.id] !== undefined);
  return sent.length === 0
    ? undefined
    : Object.fromEntries(sent.map((d) => [d.id, d.scene]));
};

// --- the full-screen view -------------------------------------------------------------

/**
 * Whether a drawing's full-screen view is open (keyed by `drawingKey`), and
 * the scene it opened on: the picture inline keeps showing that one until it
 * closes, so nothing behind the editor redraws or moves as the operator works.
 */
export const drawingOpenAtom = Atom.family((_key: string) =>
  Atom.make<string | undefined>(undefined),
);
