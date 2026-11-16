import {
  decideOwnerVerdict,
  OWNER_UNREADABLE_BEFORE_WARNING,
  type OwnerWatchdogPlan,
} from '@operator-inbox/core';
import { Console, Duration, Effect, Ref } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { readOwnerFingerprint } from './process-edge';

// The two backstops a long-lived watcher needs: the `--owner-pid` watchdog,
// which ends the watcher when the session that armed it dies, and the
// `--max-duration` deadline, which ends it regardless.

// How often the watchdog reads the owner's fingerprint.
export const OWNER_POLL = Duration.seconds(5);

/**
 * Ends when the owner is gone; never ends when there is no owner to watch.
 * `name` prefixes every narration line (`watch`); `goneWhy`
 * finishes the exit line, saying what stopping achieves.
 *
 * It re-checks the FINGERPRINT, not merely the pid's existence, on every poll:
 * over a long window a pid can be recycled, and a watcher polling a recycled
 * pid reports as working while watching a stranger. "The owner is still alive"
 * is an ordinary result, so the loop is a `repeat … until` over a success
 * value rather than a retry over a failure. `'unknown'` (`ps` could not run)
 * is never a reason to exit: it says the instrument failed, not that the owner
 * died. It is narrated once a run of them looks sustained.
 */
export const ownerWatchdog = (
  owner: OwnerWatchdogPlan,
  name: string,
  goneWhy: string,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  owner.kind === 'none'
    ? Effect.never
    : Effect.gen(function* () {
        const unreadable = yield* Ref.make(0);
        return yield* Effect.sleep(OWNER_POLL).pipe(
          Effect.andThen(readOwnerFingerprint(owner.pid)),
          Effect.map((observed) =>
            decideOwnerVerdict(owner.fingerprint, observed),
          ),
          Effect.tap((verdict) =>
            verdict === 'unknown'
              ? Effect.gen(function* () {
                  const n = yield* Ref.updateAndGet(unreadable, (x) => x + 1);
                  if (n === OWNER_UNREADABLE_BEFORE_WARNING) {
                    yield* Console.error(
                      `${name}: cannot read owner pid ${owner.pid} (${n} polls running); still watching, but the watchdog is blind`,
                    );
                  }
                })
              : Ref.set(unreadable, 0),
          ),
          Effect.repeat({ until: (verdict) => verdict === 'gone' }),
          Effect.andThen(
            Console.error(
              `${name}: owner pid ${owner.pid} is gone, exiting ${goneWhy}`,
            ),
          ),
        );
      });

/** The `--max-duration` backstop: ends after `seconds`, saying so. */
export const durationDeadline = (
  seconds: number,
  name: string,
): Effect.Effect<void> =>
  Effect.sleep(Duration.seconds(seconds)).pipe(
    Effect.andThen(
      Console.error(`${name}: --max-duration (${seconds}s) reached, exiting`),
    ),
  );
