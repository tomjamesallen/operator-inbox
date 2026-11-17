import type {
  InboxMachineKey,
  WidgetDto,
  WidgetRunDto,
  WidgetRunPayload,
  WidgetsDto,
  WidgetsMachineDto,
} from '@operator-inbox/core/api';
import { Clock, Duration, Effect, Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import { clockAtom } from './clock';
import { failureText, ReadTimedOut } from './failure';
import { BOARD_READ_BOUND, inboxPollSignalAtom } from './inbox';

// The sidebar's widgets: every machine's, read from serve on the board's poll
// while the sidebar is out (the only read that counts as watching, so serve
// pauses their runs once it shuts), each machine's last widgets kept for
// when it misses a read, and the two asks: run them all (the sidebar opening,
// and Ctrl+R while it is out) and run one now. Serve runs the commands; the
// page only reads.
//
// Every time here is on the clock of the machine that ran the widget, so an
// age is reckoned against that machine's `now`, never the page's clock.

// --- what a widget is drawn as ---------------------------------------------------

export type WidgetPhase =
  | 'waiting' // never run yet, its first run going
  | 'fresh'
  | 'running' // a later run going, the last output still drawn
  | 'stale' // the last good output is older than it should be
  | 'error' // the last run failed; the last good output, if any, under it
  | 'failed'; // failed, and never once succeeded

export interface DrawnWidget {
  readonly phase: WidgetPhase;
  // Whose output is drawn: the last good run.
  readonly shown: WidgetRunDto | null;
  // One line saying why the last run failed.
  readonly failure: string | undefined;
  // The age of the output drawn.
  readonly ageMs: number | undefined;
  // A run is going (never on a greyed machine, whose runs the page cannot see).
  readonly running: boolean;
}

/** What failed, in one line: the chip's first row of output on a failure. */
export const widgetFailureOf = (
  widget: Pick<WidgetDto, 'timeoutSeconds'>,
  run: WidgetRunDto,
): string => {
  if (run.templateError !== undefined) return `template: ${run.templateError}`;
  if (run.spawnError !== null) return `could not start: ${run.spawnError}`;
  if (run.timedOut) return `timed out after ${widget.timeoutSeconds}s`;
  if (run.exitCode === 127) return 'command not found';
  const tail = run.stderrTail.trim();
  const code =
    run.exitCode === null
      ? `ended by ${run.signal ?? 'a signal'}`
      : `exit ${run.exitCode}`;
  return tail === '' ? code : `${code}: ${tail}`;
};

/** After this long the last good output is stale: a scheduled run was missed. */
export const staleAfterMs = (
  widget: Pick<WidgetDto, 'intervalSeconds' | 'timeoutSeconds'>,
): number => (2 * widget.intervalSeconds + widget.timeoutSeconds) * 1000;

/**
 * How a widget is drawn at `now`, its machine's clock. A greyed widget (its
 * machine missed the read) is drawn as it last was, stale, and not running.
 */
export const drawnWidgetOf = (
  widget: WidgetDto,
  now: number,
  greyed = false,
): DrawnWidget => {
  const last = widget.lastRun;
  const good = widget.lastOk;
  const running = widget.running && !greyed;
  const ageMs = good === null ? undefined : Math.max(0, now - good.finishedAt);
  const base = { shown: good, ageMs, running, failure: undefined };
  // A last good run with no latest one is the cache serve read back at its
  // start, drawn as any good run is.
  if (last === null && good === null) return { ...base, phase: 'waiting' };
  if (last !== null && !last.ok)
    return {
      ...base,
      phase: good === null ? 'failed' : 'error',
      failure: widgetFailureOf(widget, last),
    };
  if (
    greyed ||
    (ageMs !== undefined && ageMs > staleAfterMs(widget) && !running)
  )
    return { ...base, phase: 'stale' };
  return { ...base, phase: running ? 'running' : 'fresh' };
};

/** An age in the chip's words: `4s`, `5m`, `2h 3m`. */
export const ago = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

// --- a machine that misses a read -------------------------------------------------

// One machine's widgets as the sidebar draws them. A machine that answered
// a read and then comes back `unreachable` or `incompatible`, with no
// widgets, keeps the widgets it had, greyed: drawn stale, with refresh
// disabled, until it answers again. Its `now` runs on from the one it last
// gave by as far as Local's has run since, so its ages keep growing on its
// own clock. Where the section shows them is the sidebar's to say: a
// machine's fold shows them as it shows its Inboxes.
export interface DrawnWidgetsMachine {
  readonly key: InboxMachineKey;
  readonly label: string;
  readonly status: WidgetsMachineDto['status'];
  readonly greyed: boolean;
  readonly widgets: ReadonlyArray<WidgetDto>;
  readonly problems: ReadonlyArray<string>;
  readonly now: number;
}

interface HeldMachine {
  readonly widgets: ReadonlyArray<WidgetDto>;
  readonly problems: ReadonlyArray<string>;
  readonly now: number;
  // Local's `now` in the same read, undefined when it held none.
  readonly localNow: number | undefined;
}

// What the page keeps between reads: the read it last drew from, what it
// drew, and each machine's widgets from the last read it answered.
export interface DrawnWidgetsState {
  readonly source: WidgetsDto;
  readonly machines: ReadonlyArray<DrawnWidgetsMachine>;
  readonly held: ReadonlyMap<InboxMachineKey, HeldMachine>;
}

const isUnread = (m: WidgetsMachineDto): boolean =>
  m.status === 'unreachable' || m.status === 'incompatible';

/** The next widgets to draw: `read` itself, with a machine that missed it drawn from what it held. */
export const drawnWidgetsOf = (
  previous: DrawnWidgetsState | undefined,
  read: WidgetsDto,
): DrawnWidgetsState => {
  const localNow = read.machines.find((m) => m.status === 'local')?.now;
  const held = new Map<InboxMachineKey, HeldMachine>();
  const machines = read.machines.map((m): DrawnWidgetsMachine => {
    const drawn = {
      key: m.key,
      label: m.label,
      status: m.status,
      greyed: false,
      widgets: m.widgets,
      problems: m.problems,
      now: m.now,
    };
    const last = previous?.held.get(m.key);
    if (!isUnread(m) || m.widgets.length > 0 || last === undefined) {
      held.set(m.key, {
        widgets: m.widgets,
        problems: m.problems,
        now: m.now,
        localNow,
      });
      return drawn;
    }
    held.set(m.key, last);
    const ran =
      localNow === undefined || last.localNow === undefined
        ? 0
        : Math.max(0, localNow - last.localNow);
    return {
      ...drawn,
      greyed: last.widgets.length > 0,
      widgets: last.widgets,
      problems: last.problems,
      now: last.now + ran,
    };
  });
  return { source: read, machines, held };
};

// --- the reads -------------------------------------------------------------------

// The read, as the open sidebar's (`watching`), given up after the board's
// own bound, since serve fans it out to the machines as it does the board's.
const widgetsReadAtom = InboxClient.runtime.atom((get) =>
  InboxClient.use((client) =>
    client.widgets.read({ query: { watching: 'true' } }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: BOARD_READ_BOUND,
      orElse: () =>
        Effect.fail(
          new ReadTimedOut({
            message: `operator-inbox serve did not answer the widgets within ${Duration.format(BOARD_READ_BOUND)}, so the page gave the read up and reads again.`,
          }),
        ),
    }),
    Effect.provideService(Clock.Clock, get(clockAtom)),
  ),
);

// Each ask for a read goes through this Atom: refreshed, it builds a new
// object, so the feed's listener hears every ask.
const widgetsAskAtom: Atom.Atom<object> = Atom.readable(() => ({}));

// What was last drawn, kept while the sidebar is shut, so it opens on what it
// showed rather than on nothing. Undefined until a read has landed.
const widgetsStateAtom = Atom.make<DrawnWidgetsState | undefined>(
  undefined,
).pipe(Atom.keepAlive);

/** Every machine's widgets as the sidebar draws them. */
export const drawnWidgetsAtom: Atom.Atom<
  ReadonlyArray<DrawnWidgetsMachine> | undefined
> = Atom.make((get) => get(widgetsStateAtom)?.machines);

/** One machine's widgets as drawn, by its board key. */
export const machineWidgetsAtom = Atom.family((key: InboxMachineKey) =>
  Atom.make((get) => get(drawnWidgetsAtom)?.find((m) => m.key === key)),
);

/**
 * Run every widget now, bar one running or run in the last few seconds: what
 * the sidebar opening asks, and Ctrl+R while it is out. Run to its end even
 * when the sidebar shuts on it, then read again.
 */
export const widgetsOpenedAtom = InboxClient.runtime.fn(
  (_: undefined, get: Atom.FnContext) => {
    const { registry } = get;
    return InboxClient.use((client) =>
      client.widgets.opened({ query: {} }),
    ).pipe(
      Effect.tap(() => Effect.sync(() => registry.refresh(widgetsAskAtom))),
      Effect.uninterruptible,
    );
  },
);

/** The key of a widget's run Atom: its machine, and its id. */
export const widgetKey = (machine: InboxMachineKey, id: string): string =>
  `${machine} ${id}`;

/**
 * Run one widget now, one Atom per widget, so its refresh spins from the
 * press rather than from the next read. A run of Local's widget is sent
 * without `machine`; another machine's goes to it through Local. It reads
 * again however the ask ends: refused, the chip still catches up at once
 * with what serve has.
 */
export const widgetRunAtom = Atom.family((_key: string) =>
  InboxClient.runtime.fn((payload: WidgetRunPayload, get: Atom.FnContext) => {
    const { registry } = get;
    return InboxClient.use((client) =>
      client.widgets.run({ query: {}, payload }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => registry.refresh(widgetsAskAtom))),
      Effect.uninterruptible,
    );
  }),
);

/** Why a widget's last refresh failed, by its run Atom's key; none once one is taken. */
export const widgetAskFailureAtom = Atom.family((key: string) =>
  Atom.make((get): string | undefined => {
    const asked = get(widgetRunAtom(key));
    return AsyncResult.isFailure(asked)
      ? failureText(asked.cause).message
      : undefined;
  }),
);

/**
 * The sidebar's widgets feed, mounted by the sidebar and so built each time
 * it opens and dropped when it shuts. Built, it runs every widget (once per
 * opening, never per render), and reads on every poll tick and every ask.
 *
 * As the board's read does, a read in flight is never cut off: an ask made
 * while one is in flight waits for it to land, and then one more read
 * follows. A tab shown again reads at once, since a hidden tab's timers
 * are throttled.
 */
export const widgetsFeedAtom: Atom.Atom<void> = Atom.readable((get) => {
  let again = false;
  const ask = () => {
    if (get.once(widgetsReadAtom).waiting) again = true;
    else get.refresh(widgetsReadAtom);
  };
  const hold = (result: Atom.Type<typeof widgetsReadAtom>) => {
    const read = Option.getOrUndefined(AsyncResult.value(result));
    const state = get.once(widgetsStateAtom);
    if (read !== undefined && read !== state?.source)
      get.set(widgetsStateAtom, drawnWidgetsOf(state, read));
  };
  get.once(inboxPollSignalAtom);
  get.once(widgetsAskAtom);
  get.subscribe(inboxPollSignalAtom, ask);
  get.subscribe(widgetsAskAtom, ask);
  get.subscribe(widgetsReadAtom, (result) => {
    hold(result);
    if (!again || result.waiting) return;
    again = false;
    get.refresh(widgetsReadAtom);
  });
  hold(get.once(widgetsReadAtom));
  if (typeof document !== 'undefined') {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') ask();
    };
    document.addEventListener('visibilitychange', onVisibility);
    get.addFinalizer(() =>
      document.removeEventListener('visibilitychange', onVisibility),
    );
  }
  get.set(widgetsOpenedAtom, undefined);
});
