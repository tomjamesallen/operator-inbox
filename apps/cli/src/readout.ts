import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig, readoutVoiceOf, stateDir } from '@operator-inbox/core';
import {
  READOUT_HASH,
  type ReadoutEntry,
  type ReadoutScript,
  type ReadoutSegment,
  type ReadoutStatusDto,
  ReadoutTimedSegment,
  readoutAudioPath,
} from '@operator-inbox/core/api';
import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { readHome } from './home-dir';
import { makeKokoroVoice } from './readout-kokoro';
import {
  ReadoutVoice,
  ReadoutVoiceError,
  type SpokenScript,
} from './readout-voice';

// Listen mode's server side: the queue of scripts a page wants read aloud,
// and the cache of what has been made (ADR-0005). The page POSTs the scripts
// it wants, the current Question first; each request replaces the last. One
// worker makes the first wanted script that is not made yet, one at a time,
// through the `ReadoutVoice` port, and sleeps until the next request wakes
// it. Serve makes nothing a page has not asked for.
//
// The audio and its timings are a derived cache, not state: no events, only
// files under `$XDG_STATE_HOME/operator-inbox/readout/`, named by a hash of
// the voice and the script, so the same script in the same voice is made
// once. `<hash>.mp3` is the audio and `<hash>.json` its timings; each is
// written under a temporary name and renamed, the JSON last, so a script
// counts as made only once both are whole. The folder is swept when the
// service starts and after each script it makes.
//
// The decisions (what to make next, where each script stands, what the sweep
// removes) are pure functions, tested without IO; the service around them
// holds the state and does the IO.

export const READOUT_DIR_NAME = 'readout';
/** How long a failed script, or a voice found unavailable, is left before it is tried again. */
export const READOUT_COOL_OFF = Duration.seconds(30);
/** The cache keeps a script this long after it was last made or read from disk. */
export const READOUT_MAX_AGE = Duration.days(30);
/** Beyond this many bytes, the cache drops its oldest scripts first. */
export const READOUT_MAX_BYTES = 256 * 1024 * 1024;
// A temporary file this old was left by a serve that stopped mid-write.
const PART_MAX_AGE = Duration.hours(1);

// --- the hash ----------------------------------------------------------------

/** The first 24 hex digits of the SHA-256 of the voice and the script. Pure. */
export const readoutHash = (
  voiceId: string,
  segments: ReadonlyArray<ReadoutSegment>,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        voiceId,
        segments.map((s) => [s.id, s.text, s.pauseAfter]),
      ]),
    )
    .digest('hex')
    .slice(0, 24);

// --- the state, and the pure decisions over it --------------------------------

/** A made script, as its timings file holds it and as the answer needs it. */
export interface Made extends SpokenScript {
  // How long it took, in this serve; 0 when it was made before.
  readonly generationMs: number;
}

interface Stamped {
  readonly message: string;
  // When, in epoch milliseconds (`Clock`).
  readonly at: number;
}

export interface ReadoutState {
  /** The wanted scripts' hashes, in the order wanted. */
  readonly wanted: ReadonlyArray<string>;
  /** The wanted scripts themselves, by hash. */
  readonly scripts: ReadonlyMap<string, ReadonlyArray<ReadoutSegment>>;
  /** The one being made. */
  readonly making: string | undefined;
  readonly made: ReadonlyMap<string, Made>;
  readonly failed: ReadonlyMap<string, Stamped>;
  /** The voice found unavailable, and when; undefined when it was not. */
  readonly unavailable: Stamped | undefined;
}

export const emptyReadoutState: ReadoutState = {
  wanted: [],
  scripts: new Map(),
  making: undefined,
  made: new Map(),
  failed: new Map(),
  unavailable: undefined,
};

const coolingOff = (
  stamp: Stamped | undefined,
  now: number,
  coolOffMs: number,
): stamp is Stamped => stamp !== undefined && now - stamp.at < coolOffMs;

// Still to be made: wanted, not made, not being made, and not failed lately.
const isPending = (
  state: ReadoutState,
  hash: string,
  now: number,
  coolOffMs: number,
): boolean =>
  !state.made.has(hash) &&
  state.making !== hash &&
  !coolingOff(state.failed.get(hash), now, coolOffMs);

/** The script to make next, if any: the first one still to be made. Pure. */
export const nextToMake = (
  state: ReadoutState,
  now: number,
  coolOffMs: number,
): string | undefined =>
  coolingOff(state.unavailable, now, coolOffMs)
    ? undefined
    : state.wanted.find((hash) => isPending(state, hash, now, coolOffMs));

/** Where each wanted script stands, in the order wanted. Pure. */
export const entriesOf = (
  state: ReadoutState,
  now: number,
  coolOffMs: number,
): ReadonlyArray<ReadoutEntry> => {
  if (coolingOff(state.unavailable, now, coolOffMs)) {
    const { message } = state.unavailable;
    return state.wanted.map((hash) => ({ _tag: 'Failed', hash, message }));
  }
  // The one being made is ahead of every queued script.
  let ahead = state.making === undefined ? 0 : 1;
  return state.wanted.map((hash): ReadoutEntry => {
    const made = state.made.get(hash);
    if (made !== undefined) {
      return {
        _tag: 'Ready',
        hash,
        audio: readoutAudioPath(hash),
        duration: made.duration,
        generationMs: made.generationMs,
        segments: made.segments,
      };
    }
    if (state.making === hash) return { _tag: 'Generating', hash };
    const failure = state.failed.get(hash);
    if (coolingOff(failure, now, coolOffMs)) {
      return { _tag: 'Failed', hash, message: failure.message };
    }
    const position = ahead;
    ahead += 1;
    return { _tag: 'Queued', hash, position };
  });
};

/**
 * A new request: it replaces what is wanted. A queued script no longer
 * wanted is simply not wanted; the one being made stays `making`, so it is
 * finished; made ones stay made. Pure.
 */
export const wantScripts = (
  state: ReadoutState,
  scripts: ReadonlyArray<{
    readonly hash: string;
    readonly segments: ReadonlyArray<ReadoutSegment>;
  }>,
): ReadoutState => ({
  ...state,
  wanted: scripts.map((s) => s.hash),
  scripts: new Map(scripts.map((s) => [s.hash, s.segments])),
});

// --- the sweep ----------------------------------------------------------------

export interface CacheFile {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

// `<hash>.mp3`, `<hash>.json`, or a temporary `<hash>.<ext>.<n>.part`.
const CACHE_NAME = /^([0-9a-f]{24})\.(mp3|json)(\.\d+\.part)?$/;

/**
 * The files the sweep removes: a temporary file over an hour old; each script
 * (its audio and its timings together) not touched in `maxAgeMs`; then, while
 * the rest is over `maxBytes`, the oldest scripts first. A script in `keep`
 * (wanted now) is never removed, and a file this cache did not name is never
 * touched. Pure.
 */
export const chooseSweep = (
  files: ReadonlyArray<CacheFile>,
  now: number,
  limits: {
    readonly maxAgeMs: number;
    readonly maxBytes: number;
    readonly keep: ReadonlySet<string>;
  },
): ReadonlyArray<string> => {
  const remove: Array<string> = [];
  const scripts = new Map<
    string,
    { names: Array<string>; size: number; newest: number }
  >();
  for (const file of files) {
    const m = CACHE_NAME.exec(file.name);
    if (m === null) continue;
    const hash = m[1] ?? '';
    if (m[3] !== undefined) {
      if (now - file.mtimeMs > Duration.toMillis(PART_MAX_AGE)) {
        remove.push(file.name);
      }
      continue;
    }
    const script = scripts.get(hash) ?? { names: [], size: 0, newest: 0 };
    script.names.push(file.name);
    script.size += file.size;
    script.newest = Math.max(script.newest, file.mtimeMs);
    scripts.set(hash, script);
  }
  const kept: Array<{ names: Array<string>; size: number; newest: number }> =
    [];
  let total = 0;
  for (const [hash, script] of scripts) {
    if (!limits.keep.has(hash) && now - script.newest > limits.maxAgeMs) {
      remove.push(...script.names);
      continue;
    }
    total += script.size;
    if (!limits.keep.has(hash)) kept.push(script);
  }
  kept.sort((a, b) => a.newest - b.newest);
  for (const script of kept) {
    if (total <= limits.maxBytes) break;
    remove.push(...script.names);
    total -= script.size;
  }
  return remove;
};

// --- the service --------------------------------------------------------------

export interface ReadoutService {
  /** Want these scripts made, in this order, and say where each stands. */
  readonly want: (
    scripts: ReadonlyArray<ReadoutScript>,
  ) => Effect.Effect<ReadoutStatusDto>;
}

export class Readout extends Context.Service<Readout, ReadoutService>()(
  'operator-inbox/Readout',
) {}

/** The cache folder: `<state base>/operator-inbox/readout`. Fails with a sentence when it cannot be found. */
export const readoutCacheDir: Effect.Effect<string, string> = Effect.gen(
  function* () {
    const xdgStateHome = yield* Config.String('XDG_STATE_HOME').pipe(
      Effect.orElseSucceed(() => ''),
    );
    const home = Option.getOrElse(yield* readHome, () => '');
    const dir = path.join(stateDir({ xdgStateHome, home }), READOUT_DIR_NAME);
    if (!path.isAbsolute(dir)) {
      return yield* Effect.fail(
        'HOME is not set, so the readout cache cannot be found; set XDG_STATE_HOME',
      );
    }
    return dir;
  },
);

const Stored = Schema.Struct({
  duration: Schema.Number,
  segments: Schema.Array(ReadoutTimedSegment),
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Stored));

export interface ReadoutOptions {
  readonly dir: string;
  readonly coolOff?: Duration.Duration;
  readonly maxAge?: Duration.Duration;
  readonly maxBytes?: number;
}

/**
 * The service over the cache at `dir`, speaking through `ReadoutVoice`. Its
 * worker runs in the scope this is made in; the first thing it does is sweep.
 */
export const makeReadout = (options: ReadoutOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const voice = yield* ReadoutVoice;
    const { dir } = options;
    const coolOffMs = Duration.toMillis(options.coolOff ?? READOUT_COOL_OFF);
    const maxAgeMs = Duration.toMillis(options.maxAge ?? READOUT_MAX_AGE);
    const maxBytes = options.maxBytes ?? READOUT_MAX_BYTES;
    const state = yield* Ref.make(emptyReadoutState);
    const wake = yield* Queue.unbounded<void>();
    const lock = yield* Semaphore.make(1);
    const parts = yield* Ref.make(0);
    const locked = Semaphore.withPermits(lock, 1);
    const update = (f: (s: ReadoutState) => ReadoutState) =>
      locked(Ref.update(state, f));

    const fileOf = (hash: string, ext: 'mp3' | 'json') =>
      path.join(dir, `${hash}.${ext}`);

    // A script made by an earlier serve: both files there, the timings
    // whole. It is touched, so the sweep counts it as recently used.
    const fromDisk = (hash: string) =>
      Effect.gen(function* () {
        const mp3 = fileOf(hash, 'mp3');
        const json = fileOf(hash, 'json');
        if (!(yield* fs.exists(mp3)) || !(yield* fs.exists(json))) {
          return Option.none<Made>();
        }
        const stored = decodeStored(yield* fs.readFileString(json));
        if (Option.isNone(stored)) return Option.none<Made>();
        const now = yield* Clock.currentTimeMillis;
        yield* fs.utimes(mp3, now, now).pipe(Effect.ignore);
        yield* fs.utimes(json, now, now).pipe(Effect.ignore);
        return Option.some<Made>({ ...stored.value, generationMs: 0 });
      }).pipe(Effect.orElseSucceed(() => Option.none<Made>()));

    const sweep = Effect.gen(function* () {
      yield* fs.makeDirectory(dir, { recursive: true });
      const names = yield* fs.readDirectory(dir);
      const files: Array<CacheFile> = [];
      for (const name of names) {
        const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== 'File') continue;
        files.push({
          name,
          size: Number(info.value.size),
          mtimeMs: Option.match(info.value.mtime, {
            onNone: () => 0,
            onSome: (d) => d.getTime(),
          }),
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const current = yield* Ref.get(state);
      const keep = new Set([
        ...current.wanted,
        ...(current.making === undefined ? [] : [current.making]),
      ]);
      const removed = chooseSweep(files, now, { maxAgeMs, maxBytes, keep });
      for (const name of removed) {
        yield* fs.remove(path.join(dir, name)).pipe(Effect.ignore);
      }
      const gone = new Set(removed.map((name) => name.slice(0, 24)));
      yield* update((s) => ({
        ...s,
        made: new Map([...s.made].filter(([hash]) => !gone.has(hash))),
      }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('readout: could not sweep the cache', cause),
      ),
    );

    // Make one script: speak it into a temporary file, write its timings
    // beside it, then rename both, the timings last.
    const make = (hash: string, segments: ReadonlyArray<ReadoutSegment>) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError(asFailed));
        const n = yield* Ref.updateAndGet(parts, (x) => x + 1);
        const mp3Part = `${fileOf(hash, 'mp3')}.${n}.part`;
        const jsonPart = `${fileOf(hash, 'json')}.${n}.part`;
        return yield* Effect.gen(function* () {
          const spoken = yield* voice.speak(segments, mp3Part);
          const stored = {
            duration: spoken.duration,
            segments: spoken.segments,
          };
          yield* fs
            .writeFileString(jsonPart, encodeStored(stored))
            .pipe(Effect.mapError(asFailed));
          yield* fs
            .rename(mp3Part, fileOf(hash, 'mp3'))
            .pipe(Effect.mapError(asFailed));
          yield* fs
            .rename(jsonPart, fileOf(hash, 'json'))
            .pipe(Effect.mapError(asFailed));
          return stored;
        }).pipe(
          Effect.onError(() =>
            Effect.all([fs.remove(mp3Part), fs.remove(jsonPart)]).pipe(
              Effect.ignore,
            ),
          ),
        );
      });

    // Make the next script, if there is one; true when one was tried.
    const step = Effect.gen(function* () {
      const picked = yield* locked(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const s = yield* Ref.get(state);
          const hash = nextToMake(s, now, coolOffMs);
          const segments = hash === undefined ? undefined : s.scripts.get(hash);
          if (hash === undefined || segments === undefined) return undefined;
          yield* Ref.set(state, { ...s, making: hash });
          return { hash, segments };
        }),
      );
      if (picked === undefined) return false;
      const started = yield* Clock.currentTimeMillis;
      const result = yield* Effect.result(make(picked.hash, picked.segments));
      const now = yield* Clock.currentTimeMillis;
      yield* update((s) => {
        const made = new Map(s.made);
        const failed = new Map(s.failed);
        let unavailable = s.unavailable;
        if (result._tag === 'Success') {
          made.set(picked.hash, {
            ...result.success,
            generationMs: now - started,
          });
          failed.delete(picked.hash);
        } else if (result.failure.reason === 'unavailable') {
          unavailable = { message: result.failure.message, at: now };
        } else {
          failed.set(picked.hash, { message: result.failure.message, at: now });
        }
        return { ...s, making: undefined, made, failed, unavailable };
      });
      if (result._tag === 'Failure') {
        yield* Effect.logWarning(
          `readout: could not make ${picked.hash}: ${result.failure.message}`,
        );
      }
      yield* sweep;
      return true;
    });

    // The worker: sweep once, then on each wake make scripts until none is
    // left to make.
    const worker = Effect.gen(function* () {
      yield* sweep;
      while (true) {
        yield* Queue.take(wake);
        yield* Queue.clear(wake);
        while (yield* step) {}
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError('readout: the worker stopped', cause),
      ),
    );
    yield* Effect.forkScoped(worker);

    // Is the voice there? Asked when it has never been, and again once a
    // cool-off has passed since it was found missing, so installing it while
    // serve runs needs no restart.
    const checked = yield* Ref.make(false);
    const checkVoice = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const s = yield* Ref.get(state);
      if (coolingOff(s.unavailable, now, coolOffMs)) return;
      if ((yield* Ref.get(checked)) && s.unavailable === undefined) return;
      const found = yield* Effect.result(voice.available);
      yield* Ref.set(checked, true);
      yield* update((st) => ({
        ...st,
        unavailable:
          found._tag === 'Success'
            ? undefined
            : { message: found.failure.message, at: now },
      }));
    });

    const want = (scripts: ReadonlyArray<ReadoutScript>) =>
      Effect.gen(function* () {
        const hashed = scripts.map((script) => ({
          hash: readoutHash(voice.id, script.segments),
          segments: script.segments,
        }));
        const known = (yield* Ref.get(state)).made;
        for (const { hash } of hashed) {
          if (known.has(hash)) continue;
          const found = yield* fromDisk(hash);
          if (Option.isSome(found)) {
            yield* update((s) => ({
              ...s,
              made: new Map(s.made).set(hash, found.value),
            }));
          }
        }
        yield* update((s) => wantScripts(s, hashed));
        yield* checkVoice;
        const now = yield* Clock.currentTimeMillis;
        const s = yield* Ref.get(state);
        if (nextToMake(s, now, coolOffMs) !== undefined) {
          yield* Queue.offer(wake, undefined);
        }
        return statusOf(voice.voice, s, now, coolOffMs);
      });

    return { want } satisfies ReadoutService;
  });

const asFailed = (e: { readonly message: string }): ReadoutVoiceError =>
  new ReadoutVoiceError({ reason: 'failed', message: e.message });

/** The answer to a request, from the state. Pure. */
export const statusOf = (
  voice: string,
  state: ReadoutState,
  now: number,
  coolOffMs: number,
): ReadoutStatusDto => ({
  voice,
  ...(coolingOff(state.unavailable, now, coolOffMs)
    ? { unavailable: state.unavailable.message }
    : {}),
  entries: entriesOf(state, now, coolOffMs),
});

// --- serve's layer ------------------------------------------------------------

/**
 * Serve's `Readout`, built on the first request and never at start-up: the
 * cache folder, config.json's voice, the Kokoro voice and the worker, all in
 * the layer's scope, which is serve's. The voice's child is not started
 * until a script is to be made. A folder that cannot be found is answered as
 * the voice being unavailable, and tried again on the next request.
 */
export const ReadoutLive: Layer.Layer<
  Readout,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Readout,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<
      FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >();
    const built = yield* Ref.make(Option.none<ReadoutService>());
    const lock = yield* Semaphore.make(1);
    const acquire = Semaphore.withPermits(
      lock,
      1,
    )(
      Effect.gen(function* () {
        const have = yield* Ref.get(built);
        if (Option.isSome(have)) return have.value;
        const dir = yield* readoutCacheDir;
        const voiceName = yield* loadConfig().pipe(
          Effect.map(({ config }) => readoutVoiceOf(config)),
          Effect.orElseSucceed(() => readoutVoiceOf({})),
        );
        const voice = yield* makeKokoroVoice(voiceName);
        const service = yield* makeReadout({ dir }).pipe(
          Effect.provideService(ReadoutVoice, voice),
        );
        yield* Ref.set(built, Option.some(service));
        return service;
      }).pipe(
        Effect.provide(context),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    return {
      want: (scripts) =>
        acquire.pipe(
          Effect.flatMap((service) => service.want(scripts)),
          Effect.catch((message) =>
            Effect.succeed<ReadoutStatusDto>({
              voice: readoutVoiceOf({}),
              unavailable: message,
              entries: scripts.map((script) => ({
                _tag: 'Failed',
                hash: readoutHash('', script.segments),
                message,
              })),
            }),
          ),
        ),
    } satisfies ReadoutService;
  }),
);

/** Is `name` a made script's audio file name (`<hash>.mp3`)? Its hash, if so. Pure. */
export const audioHashOf = (name: string): string | undefined => {
  if (!name.endsWith('.mp3')) return undefined;
  const hash = name.slice(0, -'.mp3'.length);
  return READOUT_HASH.test(hash) ? hash : undefined;
};
