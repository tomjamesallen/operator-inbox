import path from 'node:path';
import {
  answeredNumbers,
  decideEmit,
  decideOwnerVerdict,
  decideOwnerWatch,
  decideWatchGuard,
  emptyBurst,
  type InboxId,
  type InboxState,
  InboxWatcherRecord,
  inboxState,
  newAnswers,
  onArrival,
  planOwnerWatchdog,
  renderAnswerSignal,
} from '@operator-inbox/core';
import {
  Clock,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Ref,
  Schema,
} from 'effect';
import { InputError } from './errors';
import { resolveInboxDatabaseEdge } from './inbox-database';
import { InboxLog } from './inbox-store';
import { durationDeadline, ownerWatchdog } from './owner-watchdog';
import { readOwnerFingerprint } from './process-edge';

// `operator-inbox watch` and `operator-inbox guard`, the edge. The watcher
// polls the inbox log: one long-lived process, stdout only ever the signal line (which
// the harness's Monitor turns into a wake-up), stderr every narration, the
// owner-pid watchdog and the max-duration deadline (`owner-watchdog.ts`), and
// its burst coalescer from core.
//
// A watcher records itself in a folder beside the inbox's event log, one small
// file per process, removed when it exits. The guard reads that folder to tell
// whether this session's Inbox is being watched. A file a crash left behind is
// recognised by its fingerprint (`ps -o comm=,lstart=` of the watcher at
// start), so a recycled pid is never taken for a live watcher, and is removed.

// How often the watcher reads the inbox. The same 5s `inbox wait` polls at.
export const WATCH_POLL = Duration.seconds(5);
// How often the coalescer is asked whether its burst is ready.
const TICK = Duration.millis(250);

const RecordJson = Schema.fromJsonString(InboxWatcherRecord);

/** The folder the watchers record themselves in, beside the event log. */
const watcherFolder = Effect.map(resolveInboxDatabaseEdge, (resolved) =>
  path.join(path.dirname(resolved.path), 'inbox-watchers'),
);

const recordFile = (folder: string, inboxId: InboxId, pid: number) =>
  path.join(folder, `${inboxId}.${pid}.json`);

/**
 * Record this process as watching `inboxId` until the scope closes. When its
 * own fingerprint cannot be read, it says so and records nothing: the guard
 * then sees no watcher, which errs towards reminding rather than trusting.
 */
const registerWatcher = (inboxId: InboxId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* watcherFolder;
    const pid = yield* Effect.sync(() => process.pid);
    const self = yield* readOwnerFingerprint(pid);
    if (self.kind !== 'alive') {
      yield* Console.error(
        'inbox watch: cannot read its own process fingerprint, so the guard will not see this watcher',
      );
      return;
    }
    const file = recordFile(folder, inboxId, pid);
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(
      file,
      Schema.encodeSync(RecordJson)({
        inboxId,
        pid,
        fingerprint: self.fingerprint,
      }),
    );
    yield* Effect.addFinalizer(() => fs.remove(file).pipe(Effect.ignore));
  }).pipe(
    Effect.catchTag('PlatformError', (e) =>
      Console.error(
        `inbox watch: could not record itself for the guard (${e.message}); watching anyway`,
      ),
    ),
  );

/**
 * Is a watcher running for `inboxId`? A record whose process is gone is
 * removed. A record whose process cannot be read counts as alive: "I cannot
 * tell" is not evidence it died, the same rule the owner watchdog keeps.
 */
export const watcherAlive = (inboxId: InboxId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* watcherFolder;
    if (!(yield* fs.exists(folder))) return false;
    let alive = false;
    for (const name of yield* fs.readDirectory(folder)) {
      if (!name.startsWith(`${inboxId}.`) || !name.endsWith('.json')) continue;
      const file = path.join(folder, name);
      const record = yield* fs
        .readFileString(file)
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RecordJson)),
          Effect.option,
        );
      if (Option.isNone(record)) continue;
      const verdict = decideOwnerVerdict(
        record.value.fingerprint,
        yield* readOwnerFingerprint(record.value.pid),
      );
      if (verdict === 'gone') yield* fs.remove(file).pipe(Effect.ignore);
      else alive = true;
    }
    return alive;
  });

const readInbox = (inboxId: InboxId) =>
  Effect.flatMap(InboxLog, (log) =>
    Effect.map(log.read(inboxId), ({ events }) => inboxState(events)),
  );

/**
 * Watch one Inbox until the owner dies or the deadline passes, printing one
 * line per burst of new answers. Answers already there when it starts are not
 * signalled: the skill runs `answers` before arming the watcher.
 */
const runInboxWatchScoped = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly ownerPid: string | undefined;
  readonly maxDurationSeconds: number;
}) {
  const decision = decideOwnerWatch(opts.ownerPid);
  if (decision.kind === 'invalid')
    return yield* new InputError({
      message: `--owner-pid is not a pid: '${decision.given}' — pass "$CLAUDE_PID", or omit the flag to run with --max-duration as the only backstop`,
    });
  if (!Number.isInteger(opts.maxDurationSeconds) || opts.maxDurationSeconds < 1)
    return yield* new InputError({
      message: `inbox watch: --max-duration is whole seconds from 1, got ${opts.maxDurationSeconds}`,
    });
  const start: InboxState = yield* readInbox(opts.inboxId);
  if (!start.opened)
    return yield* new InputError({
      message: `inbox: inbox ${opts.inboxId} does not exist`,
    });
  const owner = planOwnerWatchdog(
    decision,
    decision.kind === 'watch'
      ? yield* readOwnerFingerprint(decision.pid)
      : undefined,
  );
  yield* Console.error(
    `inbox watch: watching "${start.label}" (${opts.inboxId}) for answers; ${owner.narration}`,
  );
  yield* registerWatcher(opts.inboxId);

  const seenRef = yield* Ref.make(answeredNumbers(start));
  const burstRef = yield* Ref.make(emptyBurst);
  const labelRef = yield* Ref.make(start.label);
  // The first failed read is narrated, and the recovery, not every poll.
  const failingRef = yield* Ref.make(false);

  const poller = Effect.forever(
    readInbox(opts.inboxId).pipe(
      Effect.flatMap((state) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(failingRef, false))
            yield* Console.error('inbox watch: the inbox is readable again');
          yield* Ref.set(labelRef, state.label);
          const { fresh, seen } = newAnswers(
            yield* Ref.get(seenRef),
            answeredNumbers(state),
          );
          yield* Ref.set(seenRef, seen);
          const now = yield* Clock.currentTimeMillis;
          for (let i = 0; i < fresh; i++)
            yield* Ref.update(burstRef, (b) => onArrival(b, now));
        }),
      ),
      Effect.catch((e) =>
        Effect.gen(function* () {
          if (!(yield* Ref.getAndSet(failingRef, true)))
            yield* Console.error(
              `inbox watch: cannot read the inbox (${e.message}); still trying every ${Duration.toSeconds(WATCH_POLL)}s`,
            );
        }),
      ),
      Effect.andThen(Effect.sleep(WATCH_POLL)),
    ),
  );

  const emitter: Effect.Effect<never> = Effect.forever(
    Effect.gen(function* () {
      const { emit, next } = decideEmit(
        yield* Ref.get(burstRef),
        yield* Clock.currentTimeMillis,
      );
      yield* Ref.set(burstRef, next);
      if (emit !== undefined)
        yield* Console.log(renderAnswerSignal(emit, yield* Ref.get(labelRef)));
    }).pipe(Effect.andThen(Effect.sleep(TICK))),
  );

  const watchdog = ownerWatchdog(
    owner,
    'inbox watch',
    'so the guard stops counting this watcher',
  );

  yield* Effect.raceAll([
    poller,
    emitter,
    watchdog,
    durationDeadline(opts.maxDurationSeconds, 'inbox watch'),
  ]);
});

/** The watcher, with its record removed when it exits, however it exits. */
export const runInboxWatch = (opts: {
  readonly inboxId: InboxId;
  readonly ownerPid: string | undefined;
  readonly maxDurationSeconds: number;
}) => Effect.scoped(runInboxWatchScoped(opts));

/**
 * The Stop hook's watcher check, on an Inbox the caller has already read: the
 * hook's block decision when `decideWatchGuard` says so, else ''. The caller
 * has already let a stop with `stop_hook_active` through, and found the
 * session's Inbox (`dispatchStopGuard`, in `inbox-mode-hooks.ts`).
 */
export const watcherGuard = Effect.fnUntraced(function* (
  inboxId: InboxId,
  state: InboxState,
) {
  const decision = decideWatchGuard({
    stopHookActive: false,
    inbox: {
      label: state.label,
      state,
      watcherAlive: yield* watcherAlive(inboxId),
    },
  });
  return decision.block
    ? JSON.stringify({ decision: 'block', reason: decision.reason })
    : '';
});
