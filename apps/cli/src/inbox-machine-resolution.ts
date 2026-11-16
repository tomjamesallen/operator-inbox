import {
  type HerdrMachine,
  type InboxMachineEntry,
  type InboxMachinesReadOf,
  inboxMachineEntries,
  inboxMachinesOf,
  type LoadedConfig,
  loadConfig,
} from '@operator-inbox/core';
import { Duration, Effect, Fiber, Result, type Scope } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { loadMachines } from './machines-edge';

// The Inbox machines as serve and tunnel both read them: `config.json`'s
// `inboxMachines`, read apart from the rest of the file (so a bad entry costs
// the machines and nothing else), against `herdr machine list --json`, waited
// on for at most a bound. Written once here, so the two commands cannot read
// the same setting two ways. The resolution itself is core's pure
// `inboxMachineEntries`; this is only the edge around it.

// The longest any command waits on `herdr machine list --json`. Herdr reads
// its profiles locally, so a healthy one answers in well under this; one
// that hangs is given up on at the bound, and its process ended in the
// background (`run` in `machines-edge.ts` kills one that ignores
// SIGTERM), rather than left holding a command or a re-read open; a command
// stopped while it waits ends the process before it exits (`detached`).
export const HERDR_LIST_TIMEOUT = Duration.seconds(3);

// What reading the machines came to (core's `InboxMachinesReadOf`): `Listed`
// carries each configured machine resolved, in configured order; none
// configured is `entries: []`, and Herdr is then never run. When Herdr did
// not answer within the bound, `herdrTimedOut` is the sentence saying so,
// and every entry is unresolved with it. A config.json that does not load is
// `Unreadable`.
export type InboxMachinesRead = InboxMachinesReadOf<{
  readonly entries: ReadonlyArray<InboxMachineEntry>;
  readonly herdrTimedOut?: string;
}>;

// A read of a config.json that loaded: never `Unreadable`.
export type LoadedInboxMachinesRead = Exclude<
  InboxMachinesRead,
  { readonly _tag: 'Unreadable' }
>;

// The sentence saying why no Inbox machine is read at all, for serve's
// `machinesOff` (the page's banner) and tunnel's refusal; `undefined` when
// the machines were listed. It reads as `describeConfigFailure` writes a
// whole-file failure, so the banner says the same either way.
export const machinesOffOf = (read: InboxMachinesRead): string | undefined => {
  switch (read._tag) {
    case 'Unreadable':
      return read.problem;
    case 'Invalid':
      return `config.json at ${read.configPath}: ${read.problem}`;
    case 'Listed':
      return undefined;
  }
};

// What `herdr machine list --json` gave within a bound: its profiles, or the
// sentence saying why there are none. `timedOut` is that sentence when Herdr
// did not answer in time.
interface HerdrRead {
  readonly herdr: Result.Result<ReadonlyArray<HerdrMachine>, string>;
  readonly timedOut: string | undefined;
}

// Run `self` on a fiber of the caller's Scope and join it; when the joiner is
// interrupted (the bound below), interrupt that fiber on a fiber of its own,
// so the joiner returns at once rather than waiting for `self` to end.
// `Effect.timeout*` waits for the effect it interrupts, and ending a child
// process waits for it to die: without this, a Herdr that ignores SIGTERM
// would hold the bound open by the 500 ms grace before its SIGKILL (`run` in
// `machines-edge.ts`). The fiber is the Scope's, not detached, so closing the Scope (serve stopped,
// Ctrl-C of tunnel) interrupts it and waits for its process to be
// ended: Herdr runs in a process group of its own, so nothing else ends it.
const detached = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Effect.forkScoped(restore(self)), (fiber) =>
      restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() =>
          Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber))),
        ),
      ),
    ),
  );

// Herdr's profiles, waiting at most `within`, whatever the process does
// once given up on. Never fails.
const herdrWithin = (
  within: Duration.Input,
): Effect.Effect<
  HerdrRead,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => {
  const timedOut = `'herdr machine list --json' did not answer within ${Duration.format(Duration.fromInputUnsafe(within))}`;
  return detached(loadMachines).pipe(
    Effect.map(
      (machines): HerdrRead => ({
        herdr: Result.succeed(machines),
        timedOut: undefined,
      }),
    ),
    Effect.catch((e) =>
      Effect.succeed<HerdrRead>({
        herdr: Result.fail(e.message),
        timedOut: undefined,
      }),
    ),
    Effect.timeoutOrElse({
      duration: within,
      orElse: () =>
        Effect.succeed<HerdrRead>({ herdr: Result.fail(timedOut), timedOut }),
    }),
  );
};

// The machines a config.json that loaded lists, against Herdr's profiles,
// waiting at most `within` for Herdr, which is run only when a machine is
// configured. Never fails.
export const inboxMachinesIn = (
  loaded: Pick<LoadedConfig, 'config' | 'path'>,
  within: Duration.Input = HERDR_LIST_TIMEOUT,
): Effect.Effect<
  LoadedInboxMachinesRead,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => {
  const configPath = loaded.path;
  const configured = inboxMachinesOf(loaded.config);
  if (Result.isFailure(configured))
    return Effect.succeed({
      _tag: 'Invalid',
      configPath,
      problem: configured.failure,
    });
  if (configured.success.length === 0)
    return Effect.succeed({ _tag: 'Listed', configPath, entries: [] });
  const machines = configured.success;
  return herdrWithin(within).pipe(
    Effect.map(
      (read): LoadedInboxMachinesRead => ({
        _tag: 'Listed',
        configPath,
        entries: inboxMachineEntries(machines, read.herdr),
        ...(read.timedOut === undefined
          ? {}
          : { herdrTimedOut: read.timedOut }),
      }),
    ),
  );
};

// Read config.json, then its machines as `inboxMachinesIn` does. Never
// fails: a config.json that does not load is `Unreadable`, with its sentence.
// Serve and tunnel call this.
export const readInboxMachines = (
  within: Duration.Input = HERDR_LIST_TIMEOUT,
) =>
  loadConfig().pipe(
    Effect.matchEffect({
      onFailure: (e) =>
        Effect.succeed<InboxMachinesRead>({
          _tag: 'Unreadable',
          problem: e.message,
        }),
      onSuccess: (loaded) =>
        inboxMachinesIn(loaded, within).pipe(
          Effect.map((read): InboxMachinesRead => read),
        ),
    }),
  );

// The configured machine a selector names: an entry whose selector as
// configured (`herdrMachine`), section label or Herdr id it is, so the
// machine answers to whichever name the page, tunnel or the entry gave it.
// A section label, as written, names its entry outright: labels are unique
// (`inboxMachineLabels`), so every entry can be named by its label, even an
// entry whose selector is another's Herdr id. Otherwise names are compared
// regardless of case, and a selector that matches one entry exactly wins
// over others it matches only regardless of case. The failure is every entry
// it matches regardless of case: none, or two or more (ambiguous, each then
// named by its label).
export const findInboxMachineEntry = (
  entries: ReadonlyArray<InboxMachineEntry>,
  selector: string,
): Result.Result<InboxMachineEntry, ReadonlyArray<InboxMachineEntry>> => {
  const byLabel = entries.find((e) => e.label === selector);
  if (byLabel !== undefined) return Result.succeed(byLabel);
  const namesOf = (e: InboxMachineEntry): ReadonlyArray<string> =>
    Result.isSuccess(e.resolved)
      ? [e.herdrMachine, e.label, e.resolved.success.herdrId]
      : [e.herdrMachine, e.label];
  const wanted = selector.toLowerCase();
  const loose = entries.filter((e) =>
    namesOf(e).some((n) => n.toLowerCase() === wanted),
  );
  const [only] = loose;
  if (loose.length === 1 && only !== undefined) return Result.succeed(only);
  const exact = loose.filter((e) => namesOf(e).includes(selector));
  const [exactOnly] = exact;
  return exact.length === 1 && exactOnly !== undefined
    ? Result.succeed(exactOnly)
    : Result.fail(loose);
};
