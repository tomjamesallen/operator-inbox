import path from 'node:path';
import {
  decodeWidgetsFile,
  loadXdgConfigHome,
  stateDir,
  WIDGETS_FILE,
  type WidgetConfig,
  widgetsPath,
} from '@operator-inbox/core';
import {
  type WidgetDto,
  WidgetNotFound,
  WidgetRunDto,
} from '@operator-inbox/core/api';
import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  type Scope,
  Semaphore,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { readHome } from './home-dir';
import { runWidgetCommand, widgetEnvironment } from './serve-widget-run';

// Serve's widget runner: it runs each widget of `widgets.json` (core's
// `widgets.ts`) on a timer of its own and keeps where each one stands, in
// memory. Runs are never events: the last good run of each widget is also
// written to a small file under the state folder, a derived cache read back
// when the widget is first seen, so a chip is not blank after a restart.
//
// The file is read fresh on every call and the running widgets reconciled
// with it: a new widget starts and runs at once; one whose command, format,
// templates, interval or timeout changed is restarted and runs once its old
// run's process has gone; a removed one is stopped, its process ended and its
// cache deleted. The rest keep their runs, and a new label or `lines` is only
// shown. A file that is missing or cannot be read stops every widget but
// deletes no cache.
//
// Each widget has one fibre: a run, then a sleep of its interval from the
// run's end, then the next run, so no two of its runs overlap. A refresh
// while it sleeps runs it now and starts the interval again from that run's
// end; a refresh while it runs queues one more run for when it ends, and
// refreshes while one is queued are that one run. A scheduled run is skipped
// when no watching read (the open sidebar's) has come in the last 15s: the
// widget pauses until a watching read or `opened` wakes it.

/** How long after the last watching read scheduled runs go on. */
export const WIDGET_UNWATCHED_AFTER = Duration.seconds(15);
/** `opened` leaves alone a widget whose last run ended this recently. */
export const WIDGET_OPENED_FRESH = Duration.seconds(5);
/** The cache's folder under the state folder. */
export const WIDGETS_CACHE_DIR = 'widgets';

/** The Local machine's widgets as the API answers them. */
export interface LocalWidgets {
  readonly widgets: ReadonlyArray<WidgetDto>;
  readonly problems: ReadonlyArray<string>;
  readonly now: number;
}

export interface WidgetRunnerService {
  /** The widgets; `watching` when the open sidebar reads, which keeps scheduled runs going. */
  readonly read: (options: {
    readonly watching: boolean;
  }) => Effect.Effect<LocalWidgets>;
  /** The sidebar opened: watching, and every widget runs bar one running or just run. */
  readonly opened: Effect.Effect<LocalWidgets>;
  /** Run one widget now, or once more when it ends if it is running. */
  readonly run: (id: string) => Effect.Effect<LocalWidgets, WidgetNotFound>;
}

export class WidgetRunner extends Context.Service<
  WidgetRunner,
  WidgetRunnerService
>()('operator-inbox/WidgetRunner') {}

// --- the file -----------------------------------------------------------------

interface ReadFile {
  readonly path: ReadonlyArray<string>;
  readonly widgets: ReadonlyArray<WidgetConfig>;
  readonly problems: ReadonlyArray<string>;
  // The file was there and decoded, so it said which widgets there are. Only
  // then is a widget missing from it removed for good, its cache with it. A
  // file that is missing or cannot be read stops every widget but keeps their
  // caches, so a typo saved and fixed, an editor that saves by renaming the
  // old file away, or a link to a volume not mounted yet brings each back
  // with its last output.
  readonly said: boolean;
  // The file was there, decoded, and dropped none of its entries: only then
  // are its ids every widget there is, so a cache file of any other id is a
  // widget removed while serve was down (`sweepCache`).
  readonly whole: boolean;
}

const unread = (problem: string): ReadFile => ({
  path: [],
  widgets: [],
  problems: [problem],
  said: false,
  whole: false,
});

// How many entries the file's `widgets` holds, before any is dropped.
const entriesIn = (text: string): number => {
  try {
    const json: unknown = JSON.parse(text);
    const widgets =
      typeof json === 'object' && json !== null && 'widgets' in json
        ? json.widgets
        : undefined;
    return Array.isArray(widgets) ? widgets.length : -1;
  } catch {
    return -1;
  }
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** `widgets.json`, read now: no file is no widgets and no problems. Never fails. */
export const readWidgetsFile: Effect.Effect<
  ReadFile,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Effect.result(loadXdgConfigHome);
  if (Result.isFailure(home))
    return unread(`${WIDGETS_FILE} cannot be found: ${home.failure.message}`);
  const p = widgetsPath(home.success);
  const text = yield* Effect.result(
    Effect.flatMap(fs.exists(p), (exists) =>
      exists
        ? Effect.map(fs.readFileString(p), Option.some)
        : Effect.succeedNone,
    ),
  );
  if (Result.isFailure(text))
    return unread(
      `${WIDGETS_FILE} at ${p} could not be read: ${messageOf(text.failure)}`,
    );
  if (Option.isNone(text.success))
    return { path: [], widgets: [], problems: [], said: false, whole: false };
  const decoded = decodeWidgetsFile(text.success.value, p);
  return Result.isFailure(decoded)
    ? unread(decoded.failure)
    : {
        ...decoded.success,
        said: true,
        whole: entriesIn(text.success.value) === decoded.success.widgets.length,
      };
});

// Whether two configs of one widget run the same: anything else (its label,
// its `lines`) only changes how it is shown.
const runsAlike = (a: WidgetConfig, b: WidgetConfig): boolean =>
  a.command === b.command &&
  a.format === b.format &&
  a.intervalSeconds === b.intervalSeconds &&
  a.timeoutSeconds === b.timeoutSeconds &&
  a.text === b.text &&
  a.detail === b.detail &&
  JSON.stringify(a.tone) === JSON.stringify(b.tone);

// --- the cache ----------------------------------------------------------------

/** The cache's folder, `<state base>/operator-inbox/widgets`, or none without a home. */
export const widgetsCacheDir: Effect.Effect<Option.Option<string>> = Effect.gen(
  function* () {
    const xdgStateHome = yield* Config.String('XDG_STATE_HOME').pipe(
      Effect.orElseSucceed(() => ''),
    );
    const home = Option.getOrElse(yield* readHome, () => '');
    const dir = path.join(stateDir({ xdgStateHome, home }), WIDGETS_CACHE_DIR);
    return path.isAbsolute(dir) ? Option.some(dir) : Option.none();
  },
);

const decodeCached = Schema.decodeUnknownOption(
  Schema.fromJsonString(WidgetRunDto),
);

// The cache is a convenience: when it cannot be read or written, the widget
// runs as it would with none, and the log says why.
const cacheFile = (id: string) =>
  Effect.map(
    widgetsCacheDir,
    Option.map((dir) => path.join(dir, `${id}.json`)),
  );

const readCache = (
  id: string,
): Effect.Effect<WidgetRunDto | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const file = yield* cacheFile(id);
    if (Option.isNone(file)) return null;
    const fs = yield* FileSystem.FileSystem;
    const text = yield* Effect.option(fs.readFileString(file.value));
    const run = Option.flatMap(text, decodeCached);
    return Option.isSome(run) && run.value.ok ? run.value : null;
  });

// A temp file then a rename, so a reader never meets half a file.
const writeCache = (
  id: string,
  run: WidgetRunDto,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const file = yield* cacheFile(id);
    if (Option.isNone(file)) return;
    const fs = yield* FileSystem.FileSystem;
    const temp = path.join(path.dirname(file.value), `.${id}.json.tmp`);
    yield* fs.makeDirectory(path.dirname(file.value), { recursive: true });
    yield* fs.writeFileString(temp, JSON.stringify(run));
    yield* fs.rename(temp, file.value);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`widgets: could not cache ${id}'s run`, cause),
    ),
  );

const deleteCache = (
  id: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const file = yield* cacheFile(id);
    if (Option.isNone(file)) return;
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(file.value)) yield* fs.remove(file.value);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`widgets: could not delete ${id}'s cached run`, cause),
    ),
  );

// A cache file's widget id: `<id>.json`, or `.<id>.json.tmp` left by a write
// cut short. Any other name is not the cache's, and is left alone.
const CACHE_NAME =
  /^(?:([a-z0-9][a-z0-9_-]{0,63})\.json|\.([a-z0-9][a-z0-9_-]{0,63})\.json\.tmp)$/;
const cachedIdOf = (name: string): string | undefined => {
  const found = CACHE_NAME.exec(name);
  return found?.[1] ?? found?.[2];
};

// Delete every cache file of a widget the file no longer has: one removed
// while serve was down, which no reconcile saw go. Run once, on the first
// read of a whole file after serve starts (`ReadFile.whole`), never on a file
// that is missing, broken or unreadable, nor on one that dropped an entry,
// whose id the decode could not say.
const sweepCache = (
  keep: ReadonlySet<string>,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const dir = yield* widgetsCacheDir;
    if (Option.isNone(dir)) return;
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(dir.value))) return;
    for (const name of yield* fs.readDirectory(dir.value)) {
      const id = cachedIdOf(name);
      if (id !== undefined && !keep.has(id))
        yield* fs.remove(path.join(dir.value, name));
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning('widgets: could not sweep the old cached runs', cause),
    ),
  );

// --- a widget -----------------------------------------------------------------

interface WidgetState {
  readonly running: boolean;
  readonly runningSince: number | null;
  readonly refreshQueued: boolean;
  readonly lastRun: WidgetRunDto | null;
  readonly lastOk: WidgetRunDto | null;
  readonly nextRunAt: number | null;
  // A scheduled run came while nobody watched: it waits to be woken.
  readonly paused: boolean;
}

// One widget as the runner holds it. A restart makes a new one, so a fibre
// interrupted mid-write never touches the state its successor shows.
interface Slot {
  readonly config: WidgetConfig;
  readonly state: Ref.Ref<WidgetState>;
  // Wakes the fibre from its sleep or its pause; whoever offers has already
  // marked the widget running.
  readonly wake: Queue.Queue<void>;
  // Waits for the widget's last process to be gone: done at once unless a
  // run was ended (timed out, or interrupted by a restart) and its group is
  // still dying. Each run waits on it first, a restarted widget's first run
  // on its old slot's, so no two of one widget's processes overlap.
  readonly reap: Ref.Ref<Effect.Effect<void>>;
}

const startingState = (
  now: number,
  kept: Pick<WidgetState, 'lastRun' | 'lastOk'>,
): WidgetState => ({
  running: true,
  runningSince: now,
  refreshQueued: false,
  nextRunAt: null,
  paused: false,
  ...kept,
});

const toDto = (
  config: WidgetConfig,
  s: WidgetState,
  watched: boolean,
): WidgetDto => ({
  id: config.id,
  label: config.label,
  format: config.format,
  lines: config.lines,
  intervalSeconds: config.intervalSeconds,
  timeoutSeconds: config.timeoutSeconds,
  running: s.running,
  runningSince: s.runningSince,
  refreshQueued: s.refreshQueued,
  lastRun: s.lastRun,
  lastOk: s.lastOk,
  // Unwatched, the next scheduled run will be skipped: there is none to show.
  nextRunAt: watched ? s.nextRunAt : null,
});

// --- the runner ---------------------------------------------------------------

/**
 * The runner, in the caller's scope: closing it interrupts every widget's
 * fibre and ends every process still running. Nothing is read or run until
 * the first call.
 */
export const makeWidgetRunner: Effect.Effect<
  WidgetRunnerService,
  never,
  Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  const fibers = yield* FiberMap.make<string>();
  const slots = yield* Ref.make<ReadonlyArray<Slot>>([]);
  const problems = yield* Ref.make<ReadonlyArray<string>>([]);
  const searchPath = yield* Ref.make<ReadonlyArray<string>>([]);
  const lastWatched = yield* Ref.make<number | undefined>(undefined);
  const lock = yield* Semaphore.make(1);
  const swept = yield* Ref.make(false);

  const watchedAt = (now: number) =>
    Effect.map(
      Ref.get(lastWatched),
      (at) =>
        at !== undefined &&
        now - at < Duration.toMillis(WIDGET_UNWATCHED_AFTER),
    );

  // Run a widget now: wake it if it sleeps or is paused, or queue one more
  // run if it is running.
  const request = (slot: Slot, now: number) =>
    Effect.flatMap(
      Ref.modify(slot.state, (s): readonly [boolean, WidgetState] =>
        s.running
          ? [false, { ...s, refreshQueued: true }]
          : [
              true,
              {
                ...s,
                running: true,
                runningSince: now,
                nextRunAt: null,
                paused: false,
              },
            ],
      ),
      (woken) => (woken ? Queue.offer(slot.wake, undefined) : Effect.void),
    );

  // After a run: record it, then run again if a refresh came meanwhile, or
  // sleep until the interval is up. True when it runs again.
  const finish = (slot: Slot, run: WidgetRunDto) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.modify(slot.state, (s): readonly [boolean, WidgetState] => {
        const recorded = {
          ...s,
          lastRun: run,
          lastOk: run.ok ? run : s.lastOk,
        };
        return s.refreshQueued
          ? [
              true,
              {
                ...recorded,
                refreshQueued: false,
                running: true,
                runningSince: now,
              },
            ]
          : [
              false,
              {
                ...recorded,
                running: false,
                runningSince: null,
                nextRunAt: now + slot.config.intervalSeconds * 1000,
              },
            ];
      }),
    );

  // Sleep out the interval, or until woken. A scheduled run with nobody
  // watching is skipped, and the widget waits to be woken.
  //
  // It is marked paused before watching is read: a watching read sets the
  // time it watched and then wakes every paused widget, so one that lands
  // between the two either is seen here or sees the widget paused.
  const sleep = (slot: Slot) =>
    Effect.gen(function* () {
      const woken = yield* Effect.raceFirst(
        Effect.as(
          Effect.sleep(Duration.seconds(slot.config.intervalSeconds)),
          false,
        ),
        Effect.as(Queue.take(slot.wake), true),
      );
      if (woken) return;
      // Already running: a request came as the sleep ended, and woke it.
      const paused = yield* Ref.modify(
        slot.state,
        (s): readonly [boolean, WidgetState] =>
          s.running
            ? [false, s]
            : [true, { ...s, paused: true, nextRunAt: null }],
      );
      if (!paused) return;
      const now = yield* Clock.currentTimeMillis;
      if (!(yield* watchedAt(now))) return yield* Queue.take(slot.wake);
      // Watched: it runs, unless a watching read woke it meanwhile, which
      // marked it running already.
      yield* Ref.update(slot.state, (s) =>
        s.paused
          ? { ...s, paused: false, running: true, runningSince: now }
          : s,
      );
    });

  // The widget's fibre. It starts with the widget marked running.
  const loop = (slot: Slot): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.flatten(Ref.get(slot.reap));
        // A wake offered before this run started is this run.
        yield* Queue.clear(slot.wake);
        const environment = yield* widgetEnvironment(
          slot.config.id,
          yield* Ref.get(searchPath),
        );
        const outcome = yield* runWidgetCommand(
          slot.config,
          environment,
          scope,
          (reaped) => Ref.set(slot.reap, reaped),
        );
        if (outcome.run.ok) yield* writeCache(slot.config.id, outcome.run);
        if (yield* finish(slot, outcome.run)) continue;
        yield* sleep(slot);
      }
    }).pipe(Effect.provide(context));

  const start = (
    config: WidgetConfig,
    state: WidgetState,
    reap: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.gen(function* () {
      const slot: Slot = {
        config,
        state: yield* Ref.make(state),
        wake: yield* Queue.sliding<void>(1),
        reap: yield* Ref.make(reap),
      };
      yield* FiberMap.run(fibers, config.id, loop(slot));
      return slot;
    });

  // Bring the running widgets in line with the file. It says which widgets
  // it started, each already running its first run.
  const reconcile = Effect.gen(function* () {
    const file = yield* readWidgetsFile;
    // Before any widget starts, so its first run has the file's own path.
    yield* Ref.set(searchPath, file.path);
    const now = yield* Clock.currentTimeMillis;
    const before = yield* Ref.get(slots);
    const had = new Map(before.map((s) => [s.config.id, s]));
    const next: Array<Slot> = [];
    const started = new Set<string>();
    for (const config of file.widgets) {
      const old = had.get(config.id);
      had.delete(config.id);
      if (old !== undefined && runsAlike(old.config, config)) {
        next.push({ ...old, config });
        continue;
      }
      started.add(config.id);
      if (old !== undefined) {
        // Interrupted, its loop leaves in `reap` what waits for its process.
        yield* FiberMap.remove(fibers, config.id);
        const { lastRun, lastOk } = yield* Ref.get(old.state);
        next.push(
          yield* start(
            config,
            startingState(now, { lastRun, lastOk }),
            yield* Ref.get(old.reap),
          ),
        );
        continue;
      }
      const lastOk = yield* readCache(config.id);
      next.push(
        yield* start(config, startingState(now, { lastRun: null, lastOk })),
      );
    }
    for (const gone of had.keys()) {
      yield* FiberMap.remove(fibers, gone);
      if (file.said) yield* deleteCache(gone);
    }
    if (file.whole && !(yield* Ref.getAndSet(swept, true)))
      yield* sweepCache(new Set(file.widgets.map((w) => w.id)));
    yield* Ref.set(slots, next);
    yield* Ref.set(problems, file.problems);
    return { slots: next, started };
  }).pipe(Effect.provide(context));

  const snapshot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const watched = yield* watchedAt(now);
    const widgets = yield* Effect.forEach(yield* Ref.get(slots), (slot) =>
      Effect.map(Ref.get(slot.state), (s) => toDto(slot.config, s, watched)),
    );
    return { widgets, problems: yield* Ref.get(problems), now };
  });

  const locked = Semaphore.withPermits(lock, 1);

  const read = ({ watching }: { readonly watching: boolean }) =>
    locked(
      Effect.gen(function* () {
        const { slots: current } = yield* reconcile;
        if (watching) {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.set(lastWatched, now);
          // A watcher back: every widget that skipped a run runs.
          for (const slot of current)
            if ((yield* Ref.get(slot.state)).paused) yield* request(slot, now);
        }
        return yield* snapshot;
      }),
    );

  const opened = locked(
    Effect.gen(function* () {
      const { slots: current } = yield* reconcile;
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(lastWatched, now);
      for (const slot of current) {
        const s = yield* Ref.get(slot.state);
        const fresh =
          s.lastRun !== null &&
          now - s.lastRun.finishedAt < Duration.toMillis(WIDGET_OPENED_FRESH);
        if (!s.running && !fresh) yield* request(slot, now);
      }
      return yield* snapshot;
    }),
  );

  const run = (id: string) =>
    locked(
      Effect.gen(function* () {
        const { slots: current, started } = yield* reconcile;
        const slot = current.find((s) => s.config.id === id);
        if (slot === undefined)
          return yield* new WidgetNotFound({
            message: `No widget ${id} here.`,
          });
        // One the reconcile just started or restarted is running this run.
        if (!started.has(id))
          yield* request(slot, yield* Clock.currentTimeMillis);
        return yield* snapshot;
      }),
    );

  return { read, opened, run } satisfies WidgetRunnerService;
});

/**
 * Serve's `WidgetRunner`, scoped to serve: stopping serve stops every widget
 * and ends every process still running. Building it reads and runs nothing;
 * the first read from a page does, as `ReadoutLive` waits for one.
 */
export const WidgetRunnerLive: Layer.Layer<
  WidgetRunner,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(WidgetRunner, makeWidgetRunner);
