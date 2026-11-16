import {
  checkDrawings,
  DRAWING_BLOB_KIND,
  type DrawingInputs,
  type DrawingRef,
  type Drawings,
  type InboxQuestion,
  InboxRefusal,
  isDrawingRef,
  type StoredDrawing,
} from '@operator-inbox/core';
import { Effect, Result } from 'effect';
import type { InputError } from './errors';
import { sha256Hex } from './inbox-blobs';
import { InboxLog } from './inbox-store';

// A Question's drawings on the store's side (core's `drawing.ts`). A scene is
// a row of the blob table, kind `drawing`, written BEFORE the event that
// names it, as an HTML block's document is (`inbox-blobs.ts`). A drawing
// logged before scenes moved to the blob table carries its scene's text on
// its event, and is read from there; nothing is rewritten.

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * A set of scenes checked as a decision would check them (`checkDrawings`),
 * BEFORE any is written: a scene the inbox would refuse never reaches the
 * blob table. The set as kept, or the refusal the decision would give.
 */
export const checkedScenes = (
  scenes: Drawings,
): Result.Result<Drawings, InboxRefusal> =>
  Result.mapError(
    checkDrawings(scenes),
    (message) => new InboxRefusal({ reason: 'bad-drawing', message }),
  );

/**
 * Keep each scene, as `checkedScenes` kept it, in the blob table, then give
 * back the scenes with their refs, as a decision takes them. An append that
 * then fails or is refused leaves blobs no event names, which costs only
 * their bytes; a blob is never updated or deleted.
 */
export const keepScenes = Effect.fnUntraced(function* (kept: Drawings) {
  const log = yield* InboxLog;
  const out: Record<string, DrawingInputs[string]> = {};
  for (const [id, scene] of Object.entries(kept)) {
    const doc = utf8.encode(scene);
    const ref = { sha: sha256Hex(doc), bytes: doc.byteLength };
    yield* log.putBlob({ ...ref, kind: DRAWING_BLOB_KIND, doc });
    out[id] = { scene, ref };
  }
  const inputs: DrawingInputs = out;
  return inputs;
});

// The refs a board makes of drawings logged as text, by their text: the
// same scenes are hashed again on every read of the board, so the most
// recent are remembered. A drawing logged as a blob needs none.
const REMEMBERED = 256;
const hashedText = new Map<string, DrawingRef>();

/** A stored drawing as its ref: its blob's, or one made from its text. */
export const drawingRefOf = (stored: StoredDrawing): DrawingRef => {
  if (isDrawingRef(stored)) return { sha: stored.sha, bytes: stored.bytes };
  const known = hashedText.get(stored);
  if (known !== undefined) return known;
  const doc = utf8.encode(stored);
  const ref = { sha: sha256Hex(doc), bytes: doc.byteLength };
  if (hashedText.size >= REMEMBERED) {
    const oldest = hashedText.keys().next().value;
    if (oldest !== undefined) hashedText.delete(oldest);
  }
  hashedText.set(stored, ref);
  return ref;
};

/** A drawing's scene and the hash that names it. */
export interface DrawingScene {
  readonly sha: string;
  readonly scene: string;
}

/** A Question's scenes: the agent's, and the ones sent with the answer. */
export interface QuestionScenes {
  readonly drawings: Readonly<Record<string, DrawingScene>>;
  readonly sent: Readonly<Record<string, DrawingScene>>;
}

/**
 * The scenes of a Question's drawings, the agent's and the operator's sent
 * ones, read from the blob table for those logged as blobs and from the fold
 * for those logged as text. A blob the table does not hold, or holds as
 * another kind, is left out.
 */
export const questionScenes = Effect.fnUntraced(function* (
  q: Pick<InboxQuestion, 'drawings' | 'sentDrawings'>,
): Effect.fn.Return<QuestionScenes, InputError, InboxLog> {
  const own = Object.entries(q.drawings ?? {}).map(
    ([id, d]) => [id, d.stored] as const,
  );
  const sent = Object.entries(q.sentDrawings ?? {});
  const shas = [...own, ...sent].flatMap(([, d]) =>
    isDrawingRef(d) ? [d.sha] : [],
  );
  const log = yield* InboxLog;
  const kept = shas.length === 0 ? new Map() : yield* log.readBlobs(shas);
  const resolve = (
    entries: ReadonlyArray<readonly [string, StoredDrawing]>,
  ): Record<string, DrawingScene> => {
    const out: Record<string, DrawingScene> = {};
    for (const [id, d] of entries) {
      if (!isDrawingRef(d)) {
        out[id] = { sha: drawingRefOf(d).sha, scene: d };
        continue;
      }
      const blob = kept.get(d.sha);
      if (blob !== undefined && blob.kind === DRAWING_BLOB_KIND)
        out[id] = { sha: d.sha, scene: fromUtf8.decode(blob.doc) };
    }
    return out;
  };
  return { drawings: resolve(own), sent: resolve(sent) };
});
