// A finger on the minimap scrubs the list: pressed and dragged, the question
// under it is brought up as it goes, and lifted, the reader stays there. A
// plain tap is still a tap, which the row's click carries. Only a finger or a
// pen scrubs: a mouse has the rows' hover titles and their clicks.
//
// This is the gesture's arithmetic, kept apart from the DOM so it can be
// tested: the minimap measures its rows and feeds pointer events in, and sends
// the machine what comes out.

/** How far a finger moves before a press is a scrub rather than a tap. */
export const SCRUB_START_PX = 6;

export type ScrubGesture =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Pressed'; readonly pointer: number; readonly y: number }
  | { readonly _tag: 'Scrubbing'; readonly pointer: number };

export const SCRUB_IDLE: ScrubGesture = { _tag: 'Idle' };

export type ScrubInput =
  | {
      readonly type: 'down';
      readonly pointer: number;
      readonly y: number;
      // A finger or a pen, and the first one down.
      readonly scrubs: boolean;
    }
  | { readonly type: 'move'; readonly pointer: number; readonly y: number }
  | { readonly type: 'up'; readonly pointer: number; readonly y: number }
  | { readonly type: 'cancel'; readonly pointer: number };

export interface ScrubStep {
  readonly next: ScrubGesture;
  // The press became a scrub: the minimap takes the pointer.
  readonly began?: true;
  // Where the finger is, for the question under it to be brought up.
  readonly at?: number;
  // The scrub is over: the finger lifted, or the browser took it back.
  readonly ended?: true;
}

const ownedBy = (gesture: ScrubGesture, pointer: number): boolean =>
  gesture._tag !== 'Idle' && gesture.pointer === pointer;

/** One pointer event on the gesture, and what the minimap does about it. */
export const scrubStep = (
  gesture: ScrubGesture,
  input: ScrubInput,
): ScrubStep => {
  if (input.type === 'down') {
    // A second finger down mid-scrub leaves the first one scrubbing.
    if (gesture._tag === 'Scrubbing' || !input.scrubs) return { next: gesture };
    return {
      next: { _tag: 'Pressed', pointer: input.pointer, y: input.y },
    };
  }
  if (!ownedBy(gesture, input.pointer)) return { next: gesture };
  switch (input.type) {
    case 'move':
      if (gesture._tag === 'Scrubbing') return { next: gesture, at: input.y };
      if (
        gesture._tag === 'Pressed' &&
        Math.abs(input.y - gesture.y) >= SCRUB_START_PX
      )
        return {
          next: { _tag: 'Scrubbing', pointer: input.pointer },
          began: true,
          at: input.y,
        };
      return { next: gesture };
    case 'up':
      // A press that never moved is a tap, and the row's click has it.
      return gesture._tag === 'Scrubbing'
        ? { next: SCRUB_IDLE, at: input.y, ended: true }
        : { next: SCRUB_IDLE };
    case 'cancel':
      return gesture._tag === 'Scrubbing'
        ? { next: SCRUB_IDLE, ended: true }
        : { next: SCRUB_IDLE };
  }
};

/** A minimap row as it is drawn: its question and its edges on screen. */
export interface ScrubRow {
  readonly key: string;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The question under a finger at `y`, the rows in order from the top. Above
 * the first row it is the first, and below the last, the last, so a finger
 * run off either end of the minimap holds the end question.
 */
export const scrubKeyAt = (
  rows: ReadonlyArray<ScrubRow>,
  y: number,
): string | undefined =>
  (rows.find((row) => y < row.bottom) ?? rows.at(-1))?.key;
