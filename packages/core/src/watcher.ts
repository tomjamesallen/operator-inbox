// The pure decisions behind a long-lived watcher (`operator-inbox watch`):
// when a burst of arrivals becomes one wake-up, and whether the process that
// owns the watcher is still alive. No IO, no clock: `now` and the owner's
// observed fingerprint arrive as arguments, which is what makes every rule
// below testable with `TestClock` and no process.

// ── Debounce ─────────────────────────────────────────────────────────────────

// Answers often arrive in a run: the operator works down a queue and answers
// several questions within seconds of each other. One wake-up per answer would
// hand the agent a run of fragments, each arriving with no sibling context, so
// a burst is coalesced into one line once it goes quiet.
//
// If a long burst ever risks tripping `Monitor`'s rate limit, tune the CAP UP
// rather than the idle window down: the window is what folds a run of answers
// into one wake-up.
//
// The cost of a wide window, stated because it is the whole trade: a lone
// answer waits the full window for its notification. That is the right way
// round: a single answer loses a few seconds, whereas a fragmented run loses
// its context.

/** Each arrival resets this; the burst emits once it expires. */
export const IDLE_WINDOW_MILLIS = 10_000;

/**
 * The starvation guard. A pure trailing debounce never fires under a continuous
 * stream, so the burst emits at this cap even mid-flow.
 *
 * The cap runs from the burst's FIRST arrival, so it is an absolute ceiling on
 * how long one burst may collect, and it binds harder the wider the idle window
 * gets. **Raise this with the window, or the window does not take effect for a
 * long burst.**
 */
export const MAX_WAIT_MILLIS = 120_000;

// `pending` is a COUNT, not a list of ids: the emitted line quotes only a
// count, and the edge reads the answers themselves when it emits.
//
// A TAGGED UNION, so the impossible state cannot be written down: "nothing is
// accumulating" and "a burst is accumulating, and therefore has both of its
// timestamps" are two shapes, so the guard is one `kind` check and the
// timestamps are plain `number`s wherever they are read.
export type Burst =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'collecting';
      readonly pending: number;
      readonly firstArrival: number;
      readonly lastArrival: number;
    };

export const emptyBurst: Burst = { kind: 'idle' };

/** One arrival landed at `now` (epoch millis). */
export const onArrival = (state: Burst, now: number): Burst =>
  state.kind === 'idle'
    ? { kind: 'collecting', pending: 1, firstArrival: now, lastArrival: now }
    : {
        kind: 'collecting',
        pending: state.pending + 1,
        // The FIRST arrival of the burst, which is what the starvation cap
        // measures from; only `lastArrival` moves.
        firstArrival: state.firstArrival,
        lastArrival: now,
      };

/**
 * Should the accumulated burst emit yet? `emit` is the COUNT to announce, or
 * `undefined` for "keep waiting". Driven at the edge on a short tick, so the
 * whole debounce is a fold over injected time.
 */
export const decideEmit = (
  state: Burst,
  now: number,
): { readonly emit: number | undefined; readonly next: Burst } => {
  if (state.kind === 'idle') return { emit: undefined, next: state };
  const idleExpired = now - state.lastArrival >= IDLE_WINDOW_MILLIS;
  const capReached = now - state.firstArrival >= MAX_WAIT_MILLIS;
  return idleExpired || capReached
    ? { emit: state.pending, next: emptyBurst }
    : { emit: undefined, next: state };
};

// ── Owner watchdog ───────────────────────────────────────────────────────────

// THE HAZARD: a backgrounded Bash-tool shell is a session leader (`ps` state
// `Ss`) detached from claude's process group, so it survives a signal sent to
// that group. On a crash or force-quit the harness cannot clean up, and an
// orphaned watcher goes on polling when nobody is listening.
//
// THE MECHANISM: a direct harness-provided owner signal. Claude Code sets
// `CLAUDE_PID`, which is the `claude` ancestor, two hops up past the
// session-leader shell. The watch command passes it as
// `--owner-pid "$CLAUDE_PID"`, so the SHELL expands it and the app reads no
// environment variable for it.
//
// `getppid()` is the WRONG process and is never used: it names the
// session-leader shell, which is precisely the thing guaranteed to outlive the
// event we are watching for.

/**
 * `--owner-pid ""` is a REAL case, not a malformed one: the command writes
 * `--owner-pid "$CLAUDE_PID"`, and if the harness ever stops setting that var
 * the shell expands it to an empty string. That must degrade to "no watchdog,
 * warn and carry on", never to a startup failure: a manual run from a terminal
 * legitimately has no owner. A non-numeric value is a different thing
 * entirely: somebody typed something wrong, and silently not watching would be
 * the wrong failure.
 */
export type OwnerWatch =
  | { readonly kind: 'watch'; readonly pid: number }
  | { readonly kind: 'unwatched'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly given: string };

export const decideOwnerWatch = (ownerPid: string | undefined): OwnerWatch => {
  const given = ownerPid?.trim();
  if (given === undefined || given.length === 0) {
    return {
      kind: 'unwatched',
      reason:
        'no --owner-pid, so nothing will notice if the session that armed this watcher dies; --max-duration is the only backstop',
    };
  }
  if (!/^\d+$/.test(given)) return { kind: 'invalid', given };
  const pid = Number(given);
  if (!Number.isSafeInteger(pid) || pid <= 1) return { kind: 'invalid', given };
  return { kind: 'watch', pid };
};

/**
 * The owner's identity, not merely its existence. What `ps -o comm=,lstart=` prints,
 * whitespace-normalised here so a formatting wobble in a third party's `ps`
 * cannot read as a different process.
 */
export const normaliseFingerprint = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ');

/**
 * Is the owner still the same live process it was at startup?
 *
 * The fingerprint comparison is the PID-REUSE GUARD. Existence alone is not
 * enough over a `--max-duration`-long window: pids wrap, and a watcher happily
 * polling a recycled pid reports as working when it is not. Comparing the whole
 * fingerprint rather than re-matching a name also keeps this correct for ANY
 * owner: `--owner-pid` watches whatever it is pointed at, including a test's
 * own shell, not only a process called claude.
 *
 * `observed` is a THREE-state reading, and the third state is why:
 * `'unreadable'` means the instrument failed, not that the owner died, so it
 * must never be mistaken for a verdict. Exiting on it would end a healthy
 * session while narrating something false.
 *
 * ONE type for the reading, defined HERE rather than beside the `ps` call that
 * produces it: core owns the shape both sides agree on, and the edge imports
 * it.
 */
export type OwnerReading =
  | { readonly kind: 'alive'; readonly fingerprint: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' };

export const decideOwnerVerdict = (
  atStart: string,
  observed: OwnerReading,
): 'alive' | 'gone' | 'unknown' => {
  if (observed.kind === 'unreadable') return 'unknown';
  if (observed.kind === 'gone') return 'gone';
  return normaliseFingerprint(observed.fingerprint) ===
    normaliseFingerprint(atStart)
    ? 'alive'
    : 'gone';
};

/**
 * THE startup fold: one decision, one reading, ONE value the edge acts on. The
 * edge narrates `plan.narration` unconditionally and matches `kind` exactly
 * once.
 *
 * `invalid` is excluded from the input BY TYPE, not by a runtime arm, because
 * it is settled strictly earlier: a typo must fail before the watcher starts,
 * so the edge has already returned an `InputError` by the time this runs.
 * Making it unrepresentable here stops a later edit "handling" it with a
 * narration and silently not watching.
 *
 * `reading` is `undefined` for exactly one reason: the decision said not to
 * watch, so no `ps` was ever spawned. On the watch arm it is a real reading,
 * and `gone` and `unreadable` deliberately COLLAPSE here: at startup the answer
 * to both is the same (there is nothing to watch, so start anyway rather than
 * leave the operator with no watcher at all). The distinction is load-bearing
 * MID-RUN, where `decideOwnerVerdict` keeps all three, and where mistaking "I
 * cannot tell" for "it died" would end healthy sessions.
 */
export type OwnerWatchdogPlan =
  | {
      readonly kind: 'watch';
      readonly pid: number;
      readonly fingerprint: string;
      readonly narration: string;
    }
  | { readonly kind: 'none'; readonly narration: string };

export const planOwnerWatchdog = (
  decision: Exclude<OwnerWatch, { readonly kind: 'invalid' }>,
  reading: OwnerReading | undefined,
): OwnerWatchdogPlan => {
  if (decision.kind === 'unwatched')
    return { kind: 'none', narration: decision.reason };
  if (reading === undefined || reading.kind !== 'alive')
    return {
      kind: 'none',
      narration: `owner pid ${decision.pid} could not be read at startup, so nothing will be watched; --max-duration is the only backstop`,
    };
  return {
    kind: 'watch',
    pid: decision.pid,
    fingerprint: reading.fingerprint,
    narration: `watching owner pid ${decision.pid}`,
  };
};

/**
 * How many consecutive UNREADABLE polls before the watchdog WARNS that it is
 * blind. It keeps watching either way: the count gates the narration, nothing
 * else, and it resets on the first readable poll.
 *
 * One failure to run `ps` is noise; a sustained inability to run it means the
 * watchdog has no instrument and should say so rather than pretending to
 * watch. It never exits the process on this arm, because "I cannot tell" is
 * not evidence the owner died.
 */
export const OWNER_UNREADABLE_BEFORE_WARNING = 3;
