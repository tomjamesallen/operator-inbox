import {
  decideAssignCode,
  derivedCodeSuffixes,
  type InboxCode,
  type InboxId,
  inboxCodeOf,
  inboxCodePrefix,
} from '@operator-inbox/core';
import { Console, Effect, Result } from 'effect';
import { decideCodedAndAppend, InboxLog } from './inbox-store';

// Codes for the Inboxes opened before codes existed. A new Inbox gets its code
// in the same append as its `InboxOpened`; one opened earlier has none, so
// `serve` runs this once each time it starts, against the log it serves.
// It writes the same `InboxCodeAssigned` an open does, and never touches an
// older event.
//
// Safe to run again and again: an Inbox with a code is passed over, so a run
// with nothing to do reads the log and writes nothing, and two processes
// running it at once cannot give one Inbox two codes or two Inboxes one code
// (`decideCodedAndAppend` conditions each append on the Inbox and its
// candidate codes, and the fold keeps an Inbox's first code).
//
// Deterministic: the two letters are the Inbox's name now (it is getting its
// code now, and that is the name the operator sees), and the three letters
// are tried in an order derived from its id (core's `derivedCodeSuffixes`),
// with the Inboxes taken in the order they were opened. So the same log
// always gets the same codes: a run on a copy shows exactly what the real
// log will get.

// How many derived suffixes an Inbox tries before it is left for the next run.
export const BACKFILL_ATTEMPTS = 32;

export interface CodeBackfill {
  readonly assigned: ReadonlyArray<{
    readonly inboxId: InboxId;
    readonly code: InboxCode;
  }>;
  // Inboxes whose every candidate was taken, or whose append lost twice.
  readonly skipped: ReadonlyArray<InboxId>;
}

/** Give every opened Inbox that has no code its code, oldest first. */
export const assignMissingCodes = Effect.gen(function* () {
  const log = yield* InboxLog;
  const uncoded = (yield* log.listAll()).filter(
    (i) => i.state.opened && i.state.code === undefined,
  );
  const assigned: Array<CodeBackfill['assigned'][number]> = [];
  const skipped: Array<InboxId> = [];
  for (const { inboxId, state } of uncoded) {
    const prefix = inboxCodePrefix(state.label);
    const candidates = [
      ...new Set(
        derivedCodeSuffixes(inboxId, BACKFILL_ATTEMPTS).map((s) =>
          inboxCodeOf(prefix, s),
        ),
      ),
    ];
    const decided = yield* decideCodedAndAppend(
      inboxId,
      candidates,
      (current, free) =>
        Result.map(decideAssignCode(current, { inboxId, code: free }), (e) => ({
          events: [e],
          result: e.code,
        })),
    ).pipe(
      Effect.catchTag('AppendConditionFailed', () =>
        Effect.succeed(Result.fail(undefined)),
      ),
    );
    if (Result.isSuccess(decided))
      assigned.push({ inboxId, code: decided.success });
    // Another process gave it one first: nothing to do.
    else if (decided.failure?.reason !== 'unchanged') skipped.push(inboxId);
  }
  return { assigned, skipped } satisfies CodeBackfill;
});

/**
 * `serve`'s start-up run: what it assigned on stdout, anything it could not
 * on stderr. It never stops serve: a store that cannot be opened now is
 * said once, and the next start tries again.
 */
export const assignMissingCodesAtStart = assignMissingCodes.pipe(
  Effect.flatMap(({ assigned, skipped }) =>
    Effect.andThen(
      assigned.length === 0
        ? Effect.void
        : Console.log(
            `operator-inbox serve: gave ${assigned.length} inbox${assigned.length === 1 ? '' : 'es'} opened before codes their code`,
          ),
      skipped.length === 0
        ? Effect.void
        : Console.error(
            `operator-inbox serve: could not give ${skipped.join(', ')} a code; the next start tries again`,
          ),
    ),
  ),
  Effect.catch((e) =>
    Console.error(
      `operator-inbox serve: could not give older inboxes their codes (${e.message}); the next start tries again`,
    ),
  ),
);
