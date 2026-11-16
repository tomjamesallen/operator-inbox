import { describe, expect, it } from '@effect/vitest';
import {
  decideEmit,
  decideOwnerVerdict,
  decideOwnerWatch,
  emptyBurst,
  IDLE_WINDOW_MILLIS,
  MAX_WAIT_MILLIS,
  normaliseFingerprint,
  onArrival,
  planOwnerWatchdog,
} from '../src/watcher';

// The pure halves of a long-lived watcher: the debounce and the owner
// watchdog. Plain `it()`: `now` is an
// injected epoch-millis number, so the debounce is a fold over values and needs
// no clock at all. The `TestClock` work belongs at the edge that drives these.

const T0 = 1_770_000_000_000;

// Fold a sequence of arrival offsets through the state machine, ticking the
// decision at every millisecond of interest, and collect what was emitted. This
// is the shape the edge runs, so the tests exercise the real composition rather
// than each function alone.
const run = (arrivalOffsets: readonly number[], untilOffset: number) => {
  const emitted: { readonly at: number; readonly count: number }[] = [];
  let state = emptyBurst;
  const arrivals = new Set(arrivalOffsets);
  for (let t = 0; t <= untilOffset; t++) {
    if (arrivals.has(t)) state = onArrival(state, T0 + t);
    const { emit, next } = decideEmit(state, T0 + t);
    state = next;
    if (emit !== undefined) emitted.push({ at: t, count: emit });
  }
  return { emitted, state };
};

describe('decideEmit — the idle window', () => {
  it('emits nothing while nothing has arrived', () => {
    expect(decideEmit(emptyBurst, T0)).toEqual({
      emit: undefined,
      next: emptyBurst,
    });
  });

  // EVERY OFFSET BELOW IS DERIVED FROM THE CONSTANTS, not written as a literal.
  // These fixtures were scaled to the old 3s window and two of them broke when it
  // became 10s — one emitted past its own deadline, and one had a gap that landed
  // exactly ON the boundary, so whether it made one burst or two turned on the
  // `>=`. Deriving the offsets is what stops the next tune silently rotting them.
  const GAP_INSIDE = IDLE_WINDOW_MILLIS / 2;
  const GAP_OUTSIDE = IDLE_WINDOW_MILLIS * 2;

  it('coalesces arrivals inside the idle window into ONE burst', () => {
    // Three utterances, each a mid-thought pause inside the window of the last —
    // and each gap comfortably LARGER than the 3s window this replaced, which is
    // the regression that motivated the change.
    const offsets = [0, GAP_INSIDE, GAP_INSIDE * 2];
    const { emitted } = run(offsets, GAP_INSIDE * 2 + IDLE_WINDOW_MILLIS * 2);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.count).toBe(3);
    // ...and it fires one idle window after the LAST arrival, not the first.
    expect(emitted[0]?.at).toBe(GAP_INSIDE * 2 + IDLE_WINDOW_MILLIS);
  });

  it('starts a NEW burst for an arrival after the window has expired', () => {
    const { emitted } = run(
      [0, GAP_OUTSIDE],
      GAP_OUTSIDE + IDLE_WINDOW_MILLIS * 2,
    );
    expect(emitted).toHaveLength(2);
    expect(emitted.map((e) => e.count)).toEqual([1, 1]);
    expect(emitted[0]?.at).toBe(IDLE_WINDOW_MILLIS);
    expect(emitted[1]?.at).toBe(GAP_OUTSIDE + IDLE_WINDOW_MILLIS);
  });

  it('resets the burst once it has emitted', () => {
    const { state } = run([0], IDLE_WINDOW_MILLIS * 2);
    expect(state).toEqual(emptyBurst);
  });
});

// THE STATE SHAPE ITSELF, a tagged union. A flat record would allow
// `pending: 3` with no `firstArrival`, which is meaningless in the domain and
// would need a runtime guard in `decideEmit`. These pin the two invariants the
// type holds instead.
describe('Burst — a burst always knows when it started', () => {
  it('starts idle, carrying nothing', () => {
    expect(emptyBurst).toEqual({ kind: 'idle' });
  });

  it('the first arrival sets both timestamps to itself', () => {
    expect(onArrival(emptyBurst, T0)).toEqual({
      kind: 'collecting',
      pending: 1,
      firstArrival: T0,
      lastArrival: T0,
    });
  });

  // The cap measures from the FIRST arrival, so a later one must not move it —
  // otherwise a sustained run of arrivals would reset the starvation guard
  // forever.
  it('a later arrival moves only the last, never the first', () => {
    const two = onArrival(onArrival(emptyBurst, T0), T0 + 1_000);
    expect(two).toEqual({
      kind: 'collecting',
      pending: 2,
      firstArrival: T0,
      lastArrival: T0 + 1_000,
    });
  });
});

describe('decideEmit — the max-wait cap', () => {
  // NAMED FOR WHAT IT PREVENTS, not for the number: a pure trailing debounce
  // never fires while arrivals keep coming, so without the cap a long run of
  // arrivals would never wake the session at all.
  // BOTH fixtures must out-run the cap, so both are sized FROM it. Written as a
  // fixed 61 arrivals over 60s they silently stopped testing the cap the moment
  // it passed 60s: with no arrival left to sustain the burst the idle window
  // expired first, and the assertion below would have been measuring the window
  // while claiming to measure the cap.
  const SUSTAINED_UNTIL = MAX_WAIT_MILLIS + IDLE_WINDOW_MILLIS;
  const everyMillis = (step: number) =>
    Array.from(
      { length: Math.floor(SUSTAINED_UNTIL / step) + 1 },
      (_, i) => i * step,
    );

  it('prevents starvation under a sustained run of arrivals', () => {
    // An arrival every second, past the cap — the idle window NEVER expires.
    const offsets = everyMillis(1_000);
    // Run one idle window PAST the last arrival, so the trailing burst drains
    // too. Stopping at the last arrival would leave it mid-collection.
    const { emitted } = run(offsets, SUSTAINED_UNTIL + IDLE_WINDOW_MILLIS);

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]?.at).toBe(MAX_WAIT_MILLIS);
    // EVERY arrival is announced, exactly once — none starved, none double-counted.
    expect(emitted.reduce((n, e) => n + e.count, 0)).toBe(offsets.length);
  });

  it('caps from the FIRST arrival of the burst, not the last', () => {
    const { emitted } = run(everyMillis(500), MAX_WAIT_MILLIS);
    expect(emitted[0]?.at).toBe(MAX_WAIT_MILLIS);
  });
});

describe('decideOwnerWatch', () => {
  it('watches an explicit pid', () => {
    expect(decideOwnerWatch('90212')).toEqual({ kind: 'watch', pid: 90212 });
  });

  // The case that actually happens: the command writes `--owner-pid "$CLAUDE_PID"`
  // and the shell expands an unset var to an EMPTY STRING. That must degrade to
  // a warning, never to a startup failure — a manual terminal run has no owner.
  it.each([
    undefined,
    '',
    '   ',
  ])('degrades to unwatched (not a failure) for %p', (given) => {
    const verdict = decideOwnerWatch(given);
    expect(verdict.kind).toBe('unwatched');
    if (verdict.kind === 'unwatched') {
      expect(verdict.reason).toContain('--max-duration');
    }
  });

  // Distinct from the above: somebody typed something wrong, and quietly not
  // watching would report as working when it is not.
  it.each([
    'abc',
    '12x',
    '-4',
    '0',
    '1',
    '1.5',
  ])('rejects %p as invalid rather than silently not watching', (given) => {
    expect(decideOwnerWatch(given)).toEqual({ kind: 'invalid', given });
  });
});

describe('decideOwnerVerdict', () => {
  const FP = 'claude Thu  6 Aug 22:36:21 2026';
  const alive = (fingerprint: string) =>
    ({ kind: 'alive', fingerprint }) as const;

  it('is alive while the fingerprint is unchanged', () => {
    expect(decideOwnerVerdict(FP, alive(FP))).toBe('alive');
  });

  it('is gone when the process no longer exists', () => {
    expect(decideOwnerVerdict(FP, { kind: 'gone' })).toBe('gone');
  });

  // THE THIRD STATE, and the reason it exists. `ps` failing to RUN says nothing
  // about the owner, so it must not read as a death: collapsing it to `gone`
  // ended a healthy session on one transient failure while narrating a reason
  // that was false.
  it('is UNKNOWN — never gone — when the instrument itself failed', () => {
    expect(decideOwnerVerdict(FP, { kind: 'unreadable' })).toBe('unknown');
  });

  // THE PID-REUSE GUARD. Existence alone is not enough over a --max-duration
  // window: the pid can be recycled, and a watcher polling a recycled pid
  // reports as working while watching a stranger.
  it('is gone when the pid was reused by a different process', () => {
    expect(decideOwnerVerdict(FP, alive('node Thu  6 Aug 23:10:02 2026'))).toBe(
      'gone',
    );
  });

  it('is gone when the same command restarted at a different time', () => {
    expect(
      decideOwnerVerdict(FP, alive('claude Thu  6 Aug 23:10:02 2026')),
    ).toBe('gone');
  });

  it('tolerates whitespace wobble in what ps prints', () => {
    expect(
      decideOwnerVerdict(FP, alive('  claude Thu 6 Aug 22:36:21 2026  ')),
    ).toBe('alive');
    expect(normaliseFingerprint('  a   b  ')).toBe('a b');
  });
});

// THE STARTUP FOLD. The owner question is answered once, as one value: one
// narration, one `kind` to match, so the edge never re-derives the watchdog
// from a value that has lost the distinction.
describe('planOwnerWatchdog', () => {
  const FP = 'claude Thu  6 Aug 22:36:21 2026';

  it('watches a live owner, carrying the fingerprint the poll compares against', () => {
    expect(
      planOwnerWatchdog(
        { kind: 'watch', pid: 4_242 },
        {
          kind: 'alive',
          fingerprint: FP,
        },
      ),
    ).toEqual({
      kind: 'watch',
      pid: 4_242,
      fingerprint: FP,
      narration: 'watching owner pid 4242',
    });
  });

  // No flag given: the decision's own reason is the narration, unchanged. This
  // must be a warning rather than a failure — a manual terminal run
  // legitimately has no owner.
  it('passes the unwatched reason straight through as the narration', () => {
    const decision = decideOwnerWatch(undefined);
    // Narrow for the type: `invalid` is excluded from the fold BY TYPE, because
    // the edge has already failed on it before the watcher starts.
    if (decision.kind === 'invalid') throw new Error('unreachable');
    const plan = planOwnerWatchdog(decision, undefined);
    expect(plan.kind).toBe('none');
    expect(plan.narration).toContain('--max-duration');
  });

  // A pid that is already gone at startup is a RACE, not a reason to
  // leave the operator with no watcher at all. It starts, and says why nothing
  // is being watched.
  it.each([
    ['gone', { kind: 'gone' } as const],
    ['unreadable', { kind: 'unreadable' } as const],
    ['not read at all', undefined],
  ])('does not refuse to start when the owner reads back %s', (_label, reading) => {
    const plan = planOwnerWatchdog({ kind: 'watch', pid: 4_242 }, reading);
    expect(plan.kind).toBe('none');
    expect(plan.narration).toContain('owner pid 4242');
    expect(plan.narration).toContain('--max-duration');
  });

  // The collapse above is a STARTUP-ONLY collapse, and this is the line between
  // the two: mid-run the three states stay three, because mistaking "I cannot
  // tell" for "it died" ended healthy sessions. `decideOwnerVerdict` is what
  // runs on every poll, and it never conflates them.
  it('collapses gone and unreadable only at startup, never mid-run', () => {
    expect(decideOwnerVerdict(FP, { kind: 'gone' })).toBe('gone');
    expect(decideOwnerVerdict(FP, { kind: 'unreadable' })).toBe('unknown');
  });
});
