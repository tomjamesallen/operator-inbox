import {
  READOUT_MAX_SEGMENT_TEXT,
  READOUT_MAX_SEGMENTS,
  type ReadoutEntry,
  type ReadoutReady,
  type ReadoutScript,
  type ReadoutStatusDto,
} from '@operator-inbox/core/api';
import { Effect, Option, Schedule, Schema, Stream } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from '../api';
import { knownDrawingScene } from '../drawings';
import {
  activeQueueAtom,
  headOf,
  litKeyAtom,
  type ReaderItem,
  shownQueuesAtom,
} from '../inbox-reader';
import { followHandsOffAtom } from './follow';
import { jumpFrom } from './locate';
import {
  type PlayerSnapshot,
  type PlayerState,
  playerAtoms,
  playerStateOf,
} from './player';
import { type Script, scriptOf } from './script';

// Listen mode on the page (ADR-0005). While it is on, the page makes the
// speech script of the lit Question and of the next few in the view, and
// asks serve for their audio, the lit one first; serve makes it one script at
// a time and caches it. The player (`player.ts`) plays the lit Question's,
// through one audio element this module owns.

// --- the preferences ---------------------------------------------------------------

// Per device, in this browser's localStorage: listen mode, and the speed.
const deviceStore = Atom.runtime(
  KeyValueStore.layerStorage(() => localStorage),
);

export const listenOnAtom = Atom.kvs({
  runtime: deviceStore,
  key: 'operator-inbox:listen',
  schema: Schema.Boolean,
  defaultValue: () => false,
}).pipe(Atom.keepAlive);

// The element's playback rate, its pitch kept: no new audio, and the word
// times, in the audio's own seconds, still line up with its `currentTime`.
export const RATES = [1, 1.25, 1.5] as const;
export type Rate = (typeof RATES)[number];
const RateSchema = Schema.Literals(RATES);

export const readoutRateAtom = Atom.kvs({
  runtime: deviceStore,
  key: 'operator-inbox:readout-rate',
  schema: RateSchema,
  defaultValue: (): Rate => 1,
}).pipe(Atom.keepAlive);

/** The speed one step slower (-1) or faster (1), or undefined at either end. */
export const steppedRate = (rate: Rate, by: 1 | -1): Rate | undefined =>
  RATES[RATES.indexOf(rate) + by];

// --- the scripts ---------------------------------------------------------------------

// A memo, not state: a script is a pure function of its Question, and the
// board hands over new objects on each read, so it is made again only for the
// few Questions in the window. Scripts are also found by their key, for the
// request a status Atom sends.
const scriptsOf = new WeakMap<object, Script>();
const scriptsByKey = new Map<string, Script>();

// A Question's drawings as a script describes them: the scenes inline from
// a machine on an older build, and those this page has read by their hash
// (`knownDrawingScene`). Whether every drawing named by a hash was found, so
// a script made before its scenes arrived is made again once they have.
const scenesFor = (q: ReaderItem['question']) => {
  const out: Record<string, { readonly scene: string }> = {
    ...q.drawings,
  };
  let whole = true;
  for (const [id, ref] of Object.entries(q.drawingRefs ?? {})) {
    const scene = knownDrawingScene(ref.sha);
    if (scene === undefined) whole = false;
    else out[id] = { scene };
  }
  return { drawings: out, whole };
};

export const scriptFor = (item: ReaderItem): Script => {
  const q = item.question;
  const known = scriptsOf.get(q);
  if (known !== undefined) return known;
  const scenes = scenesFor(q);
  const script = scriptOf({
    title: headOf(item).title,
    bodyHtml: q.bodyHtml,
    bodyParts: q.bodyParts,
    drawings: scenes.drawings,
  });
  if (scenes.whole) scriptsOf.set(q, script);
  scriptsByKey.set(script.key, script);
  // Kept to the Questions seen lately.
  if (scriptsByKey.size > 64) {
    const oldest = scriptsByKey.keys().next().value;
    if (oldest !== undefined) scriptsByKey.delete(oldest);
  }
  return script;
};

/** A script as serve takes it, held to the contract's limits. */
export const requestOf = (s: Script): ReadoutScript => ({
  segments: s.segments.slice(0, READOUT_MAX_SEGMENTS).map((seg) => ({
    id: seg.id,
    text: seg.text.slice(0, READOUT_MAX_SEGMENT_TEXT),
    pauseAfter: seg.pauseAfter,
  })),
});

// --- what is wanted ------------------------------------------------------------------

const viewAtom = Atom.make((get) => ({
  items: get(shownQueuesAtom)[get(activeQueueAtom)],
  lit: get(litKeyAtom),
}));

/** The lit Question, and its script. */
export const litScriptAtom = Atom.make((get) => {
  const { items, lit } = get(viewAtom);
  const item = items.find((i) => i.key === lit);
  return item === undefined
    ? undefined
    : { key: item.key, item, script: scriptFor(item) };
});

// The audio made so far, by script key: kept across the requests, so moving
// to another Question never forgets what it has.
export const readoutReadyAtom = Atom.make<
  Readonly<Record<string, ReadoutReady>>
>({}).pipe(Atom.keepAlive);

/**
 * How many Questions after the lit one to have made: while the operator
 * listens to one Question there is about its length to make the next, so as
 * many as fit in the lit one's audio at the speed chosen, at the time a
 * script has taken to make lately, from one to three. One until a script has
 * been timed.
 */
export const lookaheadOf = (
  made: ReadonlyArray<{
    readonly duration: number;
    readonly generationMs: number;
  }>,
  current: number | undefined,
  rate: number,
): number => {
  const timed = made.filter((m) => m.generationMs > 0).slice(-4);
  if (timed.length === 0) return 1;
  const making = timed.reduce((s, m) => s + m.generationMs, 0) / timed.length;
  const listening =
    ((current ?? timed.reduce((s, m) => s + m.duration, 0) / timed.length) *
      1000) /
    rate;
  return Math.max(1, Math.min(3, Math.floor(listening / Math.max(making, 1))));
};

export const lookaheadAtom = Atom.make((get) => {
  const ready = get(readoutReadyAtom);
  const lit = get(litScriptAtom);
  return lookaheadOf(
    Object.values(ready),
    lit === undefined ? undefined : ready[lit.script.key]?.duration,
    get(readoutRateAtom),
  );
});

// The scripts to ask for, by key, the lit Question's first; none while listen
// mode is off. A string, so it changes only when the scripts do.
const wantedKeyAtom = Atom.make((get): string => {
  if (!get(listenOnAtom)) return '';
  const { items, lit } = get(viewAtom);
  const at = items.findIndex((i) => i.key === lit);
  if (at < 0) return '';
  return items
    .slice(at, at + 1 + get(lookaheadAtom))
    .map(scriptFor)
    .filter((s) => s.segments.length > 0)
    .map((s) => s.key)
    .join(',');
});

const settled = (status: ReadoutStatusDto) =>
  status.entries.every((e) => e._tag === 'Ready' || e._tag === 'Failed');

/** How often the page asks again while a wanted script is still being made. */
export const READOUT_POLL = '1 second';

// One request per set of wanted scripts: asked at once, then again each
// second until every one is made or has failed. A newer set replaces it, and
// serve drops what this one queued that the newer one does not want.
const statusFamily = Atom.family((wanted: string) =>
  InboxClient.runtime.atom((get) => {
    const scripts = wanted
      .split(',')
      .map((k) => scriptsByKey.get(k))
      .filter((s): s is Script => s !== undefined);
    const ask = InboxClient.use((client) =>
      client.readout.queue({ payload: { scripts: scripts.map(requestOf) } }),
    );
    return Stream.fromEffectSchedule(ask, Schedule.spaced(READOUT_POLL)).pipe(
      Stream.tap((status) =>
        Effect.sync(() => {
          const made = status.entries.flatMap((e, i) => {
            const s = scripts[i];
            return e._tag === 'Ready' && s !== undefined
              ? [[s.key, e] as const]
              : [];
          });
          if (made.length === 0) return;
          get.set(readoutReadyAtom, {
            ...get.once(readoutReadyAtom),
            ...Object.fromEntries(made),
          });
        }),
      ),
      Stream.takeUntil(settled),
    );
  }),
);

const statusAtom = Atom.make((get) => {
  const wanted = get(wantedKeyAtom);
  return wanted === ''
    ? undefined
    : { wanted: wanted.split(','), result: get(statusFamily(wanted)) };
});

// Turning listen mode off asks for nothing, so serve drops what it queued.
const releaseAtom = InboxClient.runtime.fn(() =>
  InboxClient.use((client) =>
    client.readout.queue({ payload: { scripts: [] } }),
  ),
);

/** Where a script's audio stands, as the page shows it. */
export type Readiness =
  | ReadoutEntry
  | { readonly _tag: 'Asking' }
  | { readonly _tag: 'Unreachable'; readonly message: string };

export const readinessAtom = Atom.family((scriptKey: string) =>
  Atom.make((get): Readiness | undefined => {
    const ready = get(readoutReadyAtom)[scriptKey];
    if (ready !== undefined) return ready;
    const status = get(statusAtom);
    const at = status?.wanted.indexOf(scriptKey) ?? -1;
    if (status === undefined || at < 0) return undefined;
    if (AsyncResult.isFailure(status.result))
      return {
        _tag: 'Unreachable',
        message: 'serve did not answer, so no audio can be made',
      };
    const value = Option.getOrUndefined(AsyncResult.value(status.result));
    return value?.entries[at] ?? { _tag: 'Asking' };
  }),
);

/** Why no audio can be made on this machine, when serve says so. */
export const readoutUnavailableAtom = Atom.make((get) => {
  const status = get(statusAtom);
  const value =
    status === undefined
      ? undefined
      : Option.getOrUndefined(AsyncResult.value(status.result));
  return value?.unavailable;
});

/** Whether any wanted script is being made, for the pulsing dot. */
export const readoutMakingAtom = Atom.make((get) => {
  const status = get(statusAtom);
  const value =
    status === undefined
      ? undefined
      : Option.getOrUndefined(AsyncResult.value(status.result));
  return value?.entries.some((e) => e._tag === 'Generating') ?? false;
});

// --- the player ----------------------------------------------------------------------

export const playerSnapshotAtom = Atom.make((get): PlayerSnapshot | undefined =>
  Option.getOrUndefined(AsyncResult.value(get(playerAtoms.snapshot))),
);

export const playerStateAtom = Atom.make((get): PlayerState => {
  const s = get(playerSnapshotAtom);
  return s === undefined ? 'stopped' : playerStateOf(s);
});

// Seconds into the lit Question's audio: the element's time, a frame at a
// time while it plays, and where a seek or a resting place puts it.
export const readoutTimeAtom = Atom.make(0).pipe(Atom.keepAlive);

/** The lit Question's made audio, while listen mode is on. */
export const litReadyAtom = Atom.make((get) => {
  const lit = get(litScriptAtom);
  if (lit === undefined || !get(listenOnAtom)) return undefined;
  const entry = get(readinessAtom(lit.script.key));
  return entry?._tag === 'Ready' ? { ...lit, ready: entry } : undefined;
});

// What the player is told of the lit Question, as a string so it is told
// only of a change.
const litNoticeAtom = Atom.make((get) => {
  const lit = get(litScriptAtom);
  const ready = get(litReadyAtom);
  return JSON.stringify([lit?.key, lit?.script.key, ready?.ready.audio]);
});

/**
 * The page's one audio element, made to match the player: its audio, its
 * place when the player seeks, playing or paused, and the speed. Its own
 * events go back to the player: the end, and a pause the page did not ask
 * for (a headset's button, the system's media keys). Mounted by
 * `ReadoutController`; the escape hatch, since the element is outside React
 * and outside the Atoms.
 */
export const readoutAudioAtom = Atom.readable((get) => {
  if (typeof Audio === 'undefined') return;
  const el = new Audio();
  el.preload = 'auto';
  let frame = 0;
  let seekId = -1;
  let playing = false;
  const send = (
    e:
      | { readonly type: 'Ended' }
      | { readonly type: 'Pause'; readonly at: number },
  ) => get.set(playerAtoms.send, e);
  const tick = () => {
    get.set(readoutTimeAtom, el.currentTime);
    if (!el.paused) frame = requestAnimationFrame(tick);
  };
  const onPlay = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  };
  const onEnded = () => send({ type: 'Ended' });
  const onPause = () => {
    get.set(readoutTimeAtom, el.currentTime);
    if (playing && !el.ended) send({ type: 'Pause', at: el.currentTime });
  };
  el.addEventListener('play', onPlay);
  el.addEventListener('ended', onEnded);
  el.addEventListener('pause', onPause);
  const applyRate = (rate: Rate) => {
    // A new source resets `playbackRate` to the default, so both are set.
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  };
  const apply = (snapshot: PlayerSnapshot | undefined) => {
    if (snapshot === undefined) return;
    const { src, seek } = snapshot.context;
    if (src === undefined) {
      if (el.hasAttribute('src')) {
        el.removeAttribute('src');
        el.load();
      }
    } else if (el.getAttribute('src') !== src) {
      el.src = src;
      applyRate(get.once(readoutRateAtom));
    }
    if (seek.id !== seekId) {
      seekId = seek.id;
      if (src !== undefined) el.currentTime = seek.t;
      get.set(readoutTimeAtom, seek.t);
    }
    playing = playerStateOf(snapshot) === 'playing';
    if (playing && el.paused)
      el.play().catch(() => {
        playing = false;
        send({ type: 'Pause', at: el.currentTime });
      });
    if (!playing && !el.paused) el.pause();
  };
  get.subscribe(playerSnapshotAtom, apply);
  get.subscribe(readoutRateAtom, applyRate);
  apply(get.once(playerSnapshotAtom));
  // The player hears of the lit Question as it changes.
  const notice = () => {
    const lit = get.once(litScriptAtom);
    const ready = get.once(litReadyAtom);
    get.set(playerAtoms.send, {
      type: 'Lit',
      key: lit?.key,
      script: lit?.script.key,
      src: ready?.ready.audio,
      at: playing ? el.currentTime : get.once(readoutTimeAtom),
    });
  };
  get.subscribe(litNoticeAtom, notice);
  notice();
  get.addFinalizer(() => {
    cancelAnimationFrame(frame);
    el.removeEventListener('play', onPlay);
    el.removeEventListener('ended', onEnded);
    el.removeEventListener('pause', onPause);
    el.pause();
    // Removing the source alone leaves the buffered media held until the
    // element is collected; `load()` resets it and lets it go at once.
    el.removeAttribute('src');
    el.load();
  });
});

// --- the commands --------------------------------------------------------------------

/** Listen mode on or off. Off pauses, and asks serve to make nothing more. */
export const toggleListenAtom = Atom.writable(
  () => undefined,
  (ctx): void => {
    const on = !ctx.get(listenOnAtom);
    ctx.set(listenOnAtom, on);
    if (on) return;
    ctx.set(playerAtoms.send, { type: 'Off', at: ctx.get(readoutTimeAtom) });
    ctx.set(releaseAtom, undefined);
  },
);

/** Play the lit Question from where it rests, or pause it. */
export const playPauseAtom = Atom.writable(
  () => undefined,
  (ctx): void => {
    const state = ctx.get(playerStateAtom);
    ctx.set(
      playerAtoms.send,
      state === 'stopped'
        ? { type: 'Play', from: undefined }
        : { type: 'Pause', at: ctx.get(readoutTimeAtom) },
    );
  },
);

/**
 * The play key: with listen mode off it turns it on, and the player waits
 * for the audio to be made, then plays; on, it plays or pauses.
 */
export const playKeyAtom = Atom.writable(
  () => undefined,
  (ctx): void => {
    if (ctx.get(listenOnAtom)) {
      ctx.set(playPauseAtom, undefined);
      return;
    }
    ctx.set(toggleListenAtom, undefined);
    ctx.set(playerAtoms.send, { type: 'Play', from: undefined });
  },
);

/** Play from `t` seconds (a tap on a word, the bar). */
export const seekAtom = Atom.writable(
  () => undefined,
  (ctx, t: number): void => ctx.set(playerAtoms.send, { type: 'Seek', t }),
);

/** Whether a paragraph jump has somewhere to go: listen mode on, the audio made. */
export const canJumpAtom = Atom.make(
  (get) => get(listenOnAtom) && get(litReadyAtom) !== undefined,
);

/**
 * The paragraph after (1) or before (-1). Playing, it plays on from there;
 * stopped, only the place moves, and play starts from it.
 */
export const jumpAtom = Atom.writable(
  () => undefined,
  (ctx, by: 1 | -1): void => {
    const lit = ctx.get(litReadyAtom);
    if (lit === undefined) return;
    const target = jumpFrom(lit.ready.segments, ctx.get(readoutTimeAtom), by);
    if (target === undefined) return;
    // A jump is the operator asking to see that paragraph: following takes
    // the scroll back from them.
    ctx.set(followHandsOffAtom, false);
    ctx.set(
      playerAtoms.send,
      ctx.get(playerStateAtom) === 'playing'
        ? { type: 'Seek', t: target.start }
        : { type: 'Cue', t: target.start },
    );
  },
);

/** The speed, from the control. */
export const setRateAtom = Atom.writable(
  () => undefined,
  (ctx, rate: Rate): void => ctx.set(readoutRateAtom, rate),
);
