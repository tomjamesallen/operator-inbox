import {
  type InboxClaims,
  type InboxMachineEntry,
  NO_INBOX_CLAIMS,
} from '@operator-inbox/core';
import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Ref,
  Result,
  type Scope,
  SubscriptionRef,
} from 'effect';
import {
  detachedWrite,
  type KeepWrite,
  type MachineCallOptions,
} from './inbox-machine-client';
import {
  type InboxMachinesRead,
  machinesOffOf,
} from './inbox-machine-resolution';

// The Inbox machines `operator-inbox serve` merges, as the inbox handlers see
// them: each configured machine resolved against `herdr machine list --json`
// when it is needed, and what each machine claims (`RecordedOwners`). A
// Reference whose default is no machines, so a serve built without them
// (every test that does not ask for them) answers exactly as Local alone.

// The machines serve reads at a given moment: core's entries, each resolved
// or unresolved with the sentence saying why (`InboxMachineEntry`), and,
// when `config.json` (or its `inboxMachines`) could not be read, the
// sentence for the page's banner (`machinesOff`).
export interface ServedMachines {
  readonly entries: ReadonlyArray<InboxMachineEntry>;
  readonly machinesOff?: string;
}

export const NO_SERVED_MACHINES: ServedMachines = { entries: [] };

export interface ServedInboxMachinesShape {
  // The machines as they are now: `config.json`'s `inboxMachines` against
  // Herdr's profiles, re-read at most once a SERVED_MACHINES_TTL in `serve`.
  readonly machines: Effect.Effect<ServedMachines>;
  // What each machine claims, as the board and index reads record it: the
  // owner lookup's second rung. A SubscriptionRef, so a test can wait on a
  // machine's claims being recorded rather than sleep for it.
  readonly lastOwners: SubscriptionRef.SubscriptionRef<RecordedOwners>;
  // Overrides the client's timeouts and byte limit; tests lower them.
  readonly callOptions?: MachineCallOptions;
  // How a forwarded write is run (`KeepWrite`): in serve, on a fiber serve's
  // scope awaits before it closes.
  readonly keepWrite: KeepWrite;
}

// What each machine claims (core's `InboxClaims`), recorded by each board
// or index read as each machine's read completes (core's
// `recordMachineClaims`), and the number the next read takes as it starts.
// Reads overlap (two tabs, the header's index beside the board), so each is
// numbered as it starts: an older read finishing last never undoes what a
// newer one found of a machine, such as a clash, and a machine a read did not
// reach keeps the claims it had, so a clash is kept while any of its
// claimants is unreached.
export interface RecordedOwners {
  readonly claims: InboxClaims;
  readonly next: number;
}

const NO_OWNERS: RecordedOwners = { claims: NO_INBOX_CLAIMS, next: 0 };

export const ServedInboxMachines = Context.Reference<ServedInboxMachinesShape>(
  'operator-inbox/ServedInboxMachines',
  {
    defaultValue: () => ({
      machines: Effect.succeed(NO_SERVED_MACHINES),
      // A SubscriptionRef has no unsafe constructor; making one runs no
      // effect but a PubSub's allocation.
      lastOwners: Effect.runSync(SubscriptionRef.make(NO_OWNERS)),
      keepWrite: detachedWrite,
    }),
  },
);

// The machines as the inbox handlers read them on each request (`serve`
// gives `reloadingServedMachines`' reader), with a fresh owner record, and
// the forwarded writes in flight. Each write runs on a fiber
// kept in a set this layer's scope owns, so neither the page going away
// nor serve's HTTP shutdown, which interrupts the handlers still running
// once its grace is up, cuts a write already sent. The layer sits under the
// server, so it is released after it: when serve stops, the server closes
// first, and then this scope waits for every write still in flight to land
// or fail on its own terms, each within its write timeout, before serve
// exits. A write is never interrupted by the set closing, since nothing can
// add one once the server is closed.
export const servedInboxMachinesLayer = (
  machines: Effect.Effect<ServedMachines>,
  callOptions?: MachineCallOptions,
) =>
  Layer.effect(
    ServedInboxMachines,
    Effect.gen(function* () {
      const lastOwners = yield* SubscriptionRef.make(NO_OWNERS);
      const writes = yield* FiberSet.make();
      // Added after the set, so it runs before the set's own finalizer,
      // which interrupts whatever is left: by then nothing is.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const inFlight = yield* FiberSet.size(writes);
          if (inFlight > 0)
            yield* Effect.logInfo(
              `waiting for ${inFlight === 1 ? 'a forwarded write' : `${inFlight} forwarded writes`} to an Inbox machine to finish before serve stops`,
            );
          yield* FiberSet.awaitEmpty(writes);
        }),
      );
      const keepWrite: KeepWrite = (write) =>
        Effect.flatMap(FiberSet.run(writes, write), Fiber.join);
      return {
        machines,
        lastOwners,
        keepWrite,
        ...(callOptions === undefined ? {} : { callOptions }),
      } satisfies ServedInboxMachinesShape;
    }),
  );

// What start-up serves from its read: the machines listed, or none, with the
// banner's sentence, when `config.json` or its `inboxMachines` could not be
// read (serve starts with machines off: nothing about the machines is fatal
// to Local's own inbox). A Herdr that
// did not answer leaves every entry unresolved with that sentence.
export const servedAtStartup = (read: InboxMachinesRead): ServedMachines => {
  const machinesOff = machinesOffOf(read);
  return read._tag === 'Listed'
    ? { entries: read.entries }
    : { entries: [], ...(machinesOff === undefined ? {} : { machinesOff }) };
};

// The problem a read of the machines finds, for serve's log: config.json or
// its `inboxMachines` unreadable, or Herdr not answering in time.
export const machinesReadProblem = (
  read: InboxMachinesRead,
): string | undefined =>
  machinesOffOf(read) ??
  (read._tag === 'Listed' ? read.herdrTimedOut : undefined);

// What a re-read serves, given what serve had (`last`), and the problem to
// log, if any (`machinesReadProblem`). A re-read that finds `config.json` (or its `inboxMachines`)
// cannot be read keeps the machines it had, since emptying every machine's
// section on a save with a typo in it would say nothing useful, and sets the
// banner's sentence so the page says why the list is stale. One that finds Herdr did not answer
// in time keeps what it had outright, the config being fine and Herdr slow,
// unless what it had was kept under the banner: config.json reads again, so
// the banner no longer holds, and the machines it lists are served, each
// unresolved with Herdr's sentence until Herdr answers. A read that lists
// the machines replaces them, and clears the banner.
export const servedAfterReRead = (
  last: ServedMachines,
  read: InboxMachinesRead,
): { readonly served: ServedMachines; readonly problem?: string } => {
  const machinesOff = machinesOffOf(read);
  if (machinesOff !== undefined)
    return {
      served: {
        entries: last.entries,
        machinesOff:
          last.entries.length === 0
            ? machinesOff
            : `${machinesOff}; serve keeps the ${last.entries.length === 1 ? 'Inbox machine' : `${last.entries.length} Inbox machines`} it read before`,
      },
      problem: machinesOff,
    };
  if (read._tag === 'Listed' && read.herdrTimedOut !== undefined)
    return {
      served: last.machinesOff === undefined ? last : servedAtStartup(read),
      problem: read.herdrTimedOut,
    };
  return { served: servedAtStartup(read) };
};

// How long serve keeps what it read of the machines before reading
// `config.json` and Herdr again: the page polls every few seconds, and each
// read of Herdr spawns `herdr`, so a changed profile or `inboxMachines` entry
// shows within this, without a restart, and no faster.
export const SERVED_MACHINES_TTL = Duration.seconds(30);

// What a re-read says in serve's log: a problem once, when it starts or
// changes, and once more when a re-read finds it gone, never the same
// sentence on every re-read while it lasts.
const reReadLog = (
  logged: string | undefined,
  problem: string | undefined,
): Effect.Effect<void> =>
  problem === logged
    ? Effect.void
    : problem !== undefined
      ? Effect.logWarning(
          `could not re-read the Inbox machines (${problem}); said once, and again only when this changes`,
        )
      : Effect.logInfo(
          `re-read the Inbox machines: the earlier problem (${logged}) no longer holds`,
        );

// The machines as `serve` reads them on each request: `first`, what start-up
// read, until SERVED_MACHINES_TTL has passed on the Clock; then the request
// that finds it passed starts ONE re-read in the background and, like every
// request while that runs, answers at once with the list it has. A request
// never waits on a re-read, and never ends one: the re-read runs on its own
// fiber, so a request the page aborts (each poll aborts the one before) does
// not interrupt it. That fiber is owned by the Scope this is built in (serve's), so
// stopping serve interrupts a re-read and ends the Herdr it is waiting on
// (`readInboxMachines`'s own fiber is that Scope's too). Marking the re-read
// begun and forking it are one uninterruptible step, so an abort can never
// land between them and leave the mark set with no re-read to clear it.
// `load` bounds its own wait on Herdr (`readInboxMachines`). What a re-read
// keeps, and the problem it finds, is `servedAfterReRead`'s; when it says
// so in serve's log is `reReadLog`'s, starting from the problem start-up
// found and logged itself (`firstProblem`), so a problem that lasts from
// start-up is not logged again on the first re-read. Either way the next
// re-read is a TTL after this one began. Alongside the reader, `settled`
// waits for the re-read running now, if any, to finish: the re-reads run in
// a set of fibers serve's Scope owns, which it interrupts as it closes, as a
// fiber forked in that Scope would be. A test waits on it, rather than
// yielding until a re-read is done.
export interface ReloadingServedMachines {
  // The machines as a request reads them, starting a re-read when due.
  readonly current: Effect.Effect<ServedMachines>;
  // Done once no re-read is running.
  readonly settled: Effect.Effect<void>;
}

export const reloadingServedMachines = <R>(
  first: ServedMachines,
  load: Effect.Effect<InboxMachinesRead, never, R>,
  ttl: Duration.Input = SERVED_MACHINES_TTL,
  firstProblem?: string,
): Effect.Effect<ReloadingServedMachines, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const reReads = yield* FiberSet.make();
    const ttlMillis = Duration.toMillis(Duration.fromInputUnsafe(ttl));
    const state = yield* Ref.make<{
      readonly served: ServedMachines;
      readonly readAt: number;
      readonly reading: boolean;
      // The problem the log last said, until a re-read finds it gone.
      readonly logged: string | undefined;
    }>({
      served: first,
      readAt: yield* Clock.currentTimeMillis,
      reading: false,
      logged: firstProblem,
    });
    const reRead = (startedAt: number) =>
      Effect.gen(function* () {
        const read = yield* Effect.provideContext(load, context);
        const { served: last, logged } = yield* Ref.get(state);
        const { served, problem } = servedAfterReRead(last, read);
        yield* reReadLog(logged, problem);
        yield* Ref.set(state, {
          served,
          readAt: startedAt,
          reading: false,
          logged: problem,
        });
      }).pipe(
        Effect.onExit(() =>
          Ref.update(state, (last) => ({ ...last, reading: false })),
        ),
      );
    // The forked re-read is interruptible (`FiberSet.run`'s default), so its
    // own bound on Herdr still holds.
    const startReRead = (now: number) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const start = yield* Ref.modify(state, (last) =>
            last.reading || now - last.readAt < ttlMillis
              ? [false, last]
              : [true, { ...last, reading: true }],
          );
          // Not started within this step, as a fork in the Scope is not:
          // the request answers with the list it has before any of the
          // re-read runs.
          if (start)
            yield* FiberSet.run(reReads, reRead(now), {
              startImmediately: false,
            });
        }),
      );
    return {
      current: Effect.gen(function* () {
        yield* startReRead(yield* Clock.currentTimeMillis);
        return (yield* Ref.get(state)).served;
      }),
      settled: FiberSet.awaitEmpty(reReads),
    };
  });

// The one start-up refusal: serve listening on a port a machine's tunnel is
// configured to take. Port 0 lets the OS choose, so it never clashes.
export const servePortClash = (
  port: number,
  entries: ReadonlyArray<InboxMachineEntry>,
): string | undefined => {
  if (port === 0) return undefined;
  const taken = entries.find((m) => m.port === port);
  return taken === undefined
    ? undefined
    : `--port ${port} is the tunnel port of the Inbox machine "${taken.label}" in inboxMachines: choose another port for serve, or give that machine's tunnel another`;
};

// A machine on serve's own port, found by a re-read after start-up, where
// `servePortClash` can no longer refuse to start: unresolved, so it is never
// called (it would be Local reading itself) and the board says why. Port 0
// lets the OS choose, so it never clashes.
export const markServePortClash =
  (port: number) =>
  (served: ServedMachines): ServedMachines =>
    port === 0
      ? served
      : {
          ...served,
          entries: served.entries.map((m) =>
            m.port === port && Result.isSuccess(m.resolved)
              ? {
                  ...m,
                  resolved: Result.fail({
                    _tag: 'Unusable',
                    herdrMachine: m.herdrMachine,
                    port: m.port,
                    reason: `its tunnel port ${port} in inboxMachines is serve's own --port: give its tunnel another port, or restart serve on another`,
                  }),
                }
              : m,
          ),
        };
