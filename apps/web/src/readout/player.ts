import { setupEffect } from '@xstate/effect';
import { createActorAtoms } from '@xstate/effect/atom';
import { Layer, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { SnapshotFrom } from 'xstate';

// Listen mode's player: one XState 6 machine, stopped, waiting (play was
// asked for before the audio was made) or playing. It holds the lit
// Question, its script and its audio, and where each Question's reading
// rests, and says what the page's one audio element should be doing: which
// audio, playing or not, and a seek to carry out once per id. The element is
// made to match by `readoutAudioAtom` (`readout.ts`), so nothing here touches
// it, and every transition is a pure function of the context and the event.
//
// Times come in on the events (`at`, the element's time when it was sent),
// so the machine never reads the clock or the element.

const Place = Schema.Struct({ script: Schema.String, t: Schema.Number });
export type Place = typeof Place.Type;

const Seek = Schema.Struct({ id: Schema.Int, t: Schema.Number });

const PlayerContext = Schema.Struct({
  // The lit Question, and the key of its speech script.
  key: Schema.UndefinedOr(Schema.String),
  script: Schema.UndefinedOr(Schema.String),
  // Its audio, once serve has made it.
  src: Schema.UndefinedOr(Schema.String),
  // Where each Question's reading rests while it is not playing, by its key:
  // left there by pausing, by moving to another Question mid-read, or by a
  // jump while stopped. The next play of that script starts there.
  cues: Schema.Record(Schema.String, Place),
  // Where play starts once the audio arrives, while waiting.
  from: Schema.Number,
  // The last seek asked of the element.
  seek: Seek,
});
export type PlayerContext = typeof PlayerContext.Type;

export const PLAYER_START: PlayerContext = {
  key: undefined,
  script: undefined,
  src: undefined,
  cues: {},
  from: 0,
  seek: { id: 0, t: 0 },
};

const At = { at: Schema.Number };

const setup = setupEffect({
  schemas: {
    context: PlayerContext,
    events: {
      // The lit Question changed, or its script or audio did.
      Lit: Schema.Struct({
        key: Schema.UndefinedOr(Schema.String),
        script: Schema.UndefinedOr(Schema.String),
        src: Schema.UndefinedOr(Schema.String),
        ...At,
      }),
      // Play from `from`, or from where this Question's reading rests.
      Play: Schema.Struct({ from: Schema.UndefinedOr(Schema.Number) }),
      Pause: Schema.Struct(At),
      // Play from `t` (a tap on a word, the bar, a jump while playing).
      Seek: Schema.Struct({ t: Schema.Number }),
      // Move the place to `t` without playing (a jump while stopped).
      Cue: Schema.Struct({ t: Schema.Number }),
      Ended: Schema.Struct({}),
      // Listen mode was turned off.
      Off: Schema.Struct(At),
    },
  },
});

type Ctx = PlayerContext;

const restOf = (c: Ctx): number | undefined => {
  const cue = c.key === undefined ? undefined : c.cues[c.key];
  return cue !== undefined && cue.script === c.script ? cue.t : undefined;
};

const seekTo = (c: Ctx, t: number): Ctx => ({
  ...c,
  seek: { id: c.seek.id + 1, t },
});

const cued = (c: Ctx, t: number): Ctx =>
  c.key === undefined || c.script === undefined
    ? c
    : { ...c, cues: { ...c.cues, [c.key]: { script: c.script, t } } };

const uncued = (c: Ctx): Ctx => {
  if (c.key === undefined || !(c.key in c.cues)) return c;
  const { [c.key]: _, ...cues } = c.cues;
  return { ...c, cues };
};

/** Start from `t`: playing when the audio is here, else waiting for it. */
const start = (c: Ctx, t: number) =>
  c.src === undefined
    ? { target: 'waiting' as const, context: { ...seekTo(c, t), from: t } }
    : { target: 'playing' as const, context: seekTo(c, t) };

/**
 * The lit Question, its script or its audio changed. Another Question, or
 * this one's script changed, stops: the place being read is kept for coming
 * back, and the new one shows where its own rests. The audio arriving while
 * waiting starts it.
 */
const lit = (
  c: Ctx,
  e: {
    readonly key: string | undefined;
    readonly script: string | undefined;
    readonly src: string | undefined;
    readonly at: number;
  },
  waiting: boolean,
) => {
  if (e.key !== c.key || e.script !== c.script) {
    const left = e.at > 0 ? cued(c, e.at) : c;
    const next: Ctx = {
      ...left,
      key: e.key,
      script: e.script,
      src: e.src,
      from: 0,
    };
    // An edit to this Question makes its old place meaningless.
    const kept = e.key === c.key ? uncued(next) : next;
    return {
      target: 'stopped' as const,
      context: seekTo(kept, restOf(kept) ?? 0),
    };
  }
  if (e.src === c.src) return undefined;
  const next = { ...c, src: e.src };
  if (waiting && e.src !== undefined)
    return { target: 'playing' as const, context: seekTo(next, c.from) };
  return { context: next };
};

export const playerMachine = setup.createMachine({
  id: 'readoutPlayer',
  context: PLAYER_START,
  initial: 'stopped',
  states: {
    stopped: {
      on: {
        Lit: ({ context, event }) => lit(context, event, false),
        Play: ({ context, event }) =>
          start(context, event.from ?? restOf(context) ?? 0),
        Seek: ({ context, event }) => start(context, event.t),
        Cue: ({ context, event }) => ({
          context: seekTo(cued(context, event.t), event.t),
        }),
        Off: ({ context, event }) =>
          event.at > 0 ? { context: cued(context, event.at) } : undefined,
      },
    },
    waiting: {
      on: {
        Lit: ({ context, event }) => lit(context, event, true),
        Pause: { target: 'stopped' },
        Seek: ({ context, event }) => ({
          context: { ...seekTo(context, event.t), from: event.t },
        }),
        Cue: ({ context, event }) => ({
          context: {
            ...seekTo(cued(context, event.t), event.t),
            from: event.t,
          },
        }),
        Off: { target: 'stopped' },
      },
    },
    playing: {
      on: {
        Lit: ({ context, event }) => lit(context, event, false),
        Pause: ({ context, event }) => ({
          target: 'stopped',
          context: cued(context, event.at),
        }),
        // A jump while playing plays on from there.
        Seek: ({ context, event }) => ({ context: seekTo(context, event.t) }),
        Cue: ({ context, event }) => ({ context: seekTo(context, event.t) }),
        // The end clears the place: the next play starts from the top.
        Ended: ({ context }) => ({
          target: 'stopped',
          context: seekTo(uncued(context), 0),
        }),
        Off: ({ context, event }) => ({
          target: 'stopped',
          context: cued(context, event.at),
        }),
      },
    },
  },
});

export type PlayerSnapshot = SnapshotFrom<typeof playerMachine>;
export type PlayerState = 'stopped' | 'waiting' | 'playing';

export const playerStateOf = (s: PlayerSnapshot): PlayerState =>
  s.matches('playing')
    ? 'playing'
    : s.matches('waiting')
      ? 'waiting'
      : 'stopped';

/**
 * The machine as Atoms. The actor lives while something reads them; the
 * page holds it with `useAtomMount` through `ReadoutController`. An event
 * sent before the actor is ready is dropped.
 */
export const playerAtoms = createActorAtoms(
  Atom.runtime(Layer.empty),
  playerMachine,
);
