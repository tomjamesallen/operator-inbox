import type { InboxEvent } from '@operator-inbox/core';
import {
  decideAssignCode,
  decideShortenCode,
  derivedCodes,
  type InboxCode,
  type InboxId,
  type InboxRefusal,
  type InboxState,
  lettersOfNamedCode,
} from '@operator-inbox/core';
import { Console, Effect, Result } from 'effect';
import { decideCodedAndAppend, InboxLog } from './inbox-store';

// Codes for the Inboxes the open path did not give one in the current form.
// `serve` runs this once each time it starts, against the log it serves, in
// two passes, oldest Inbox first in each:
//
// 1. An Inbox whose code is in the older named form (`ab-xyz`) is moved to
//    its three letters (`xyz`) by `InboxCodeChanged`. When an older Inbox has
//    taken those letters already (two named codes with the same three), the
//    later one takes the first free code derived from its id instead. Its
//    `InboxCodeAssigned` is never rewritten: the change is a new event, and
//    the older code still finds the Inbox for a transcript that quotes it.
// 2. An Inbox opened before codes, with none, gets one by the same
//    `InboxCodeAssigned` an open writes, derived from its id.
//
// The moves go first, so an Inbox keeps its own three letters wherever it
// can rather than losing them to one that had no code.
//
// Safe to run again and again: an Inbox already in the current form is passed
// over, so a run with nothing to do reads the log and writes nothing, and two
// processes running it at once cannot give one Inbox two codes or two Inboxes
// one code (`decideCodedAndAppend` conditions each append on the Inbox and its
// candidate codes, and the fold moves a code only from the one it holds).
//
// Deterministic: the candidates are the Inbox's own letters, then codes
// derived from its id (core's `derivedCodes`), with the Inboxes taken in the
// order they were opened. So the same log always gets the same codes: a run
// on a copy shows exactly what the real log will get.

// How many derived codes an Inbox tries before it is left for the next run.
export const BACKFILL_ATTEMPTS = 32;

export interface CodeBackfill {
  // Inboxes given their first code.
  readonly assigned: ReadonlyArray<{
    readonly inboxId: InboxId;
    readonly code: InboxCode;
  }>;
  // Inboxes moved from a named code to the current form.
  readonly changed: ReadonlyArray<{
    readonly inboxId: InboxId;
    readonly from: InboxCode;
    readonly code: InboxCode;
  }>;
  // Inboxes whose every candidate was taken, or whose append lost twice.
  readonly skipped: ReadonlyArray<InboxId>;
}

const settle = (
  inboxId: InboxId,
  candidates: ReadonlyArray<InboxCode>,
  decide: (
    state: InboxState,
    free: InboxCode | undefined,
  ) => Result.Result<InboxEvent & { readonly code: InboxCode }, InboxRefusal>,
) =>
  decideCodedAndAppend(inboxId, [...new Set(candidates)], (current, free) =>
    Result.map(decide(current, free), (e) => ({
      events: [e],
      result: e.code,
    })),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.succeed(Result.fail(undefined)),
    ),
  );

/**
 * Move every named code to the current form, then give every opened Inbox
 * that has no code its code, oldest first in each pass.
 */
export const assignMissingCodes = Effect.gen(function* () {
  const log = yield* InboxLog;
  const all = (yield* log.listAll()).filter((i) => i.state.opened);
  const assigned: Array<CodeBackfill['assigned'][number]> = [];
  const changed: Array<CodeBackfill['changed'][number]> = [];
  const skipped: Array<InboxId> = [];
  for (const { inboxId, state } of all) {
    const from = state.code;
    const letters = from === undefined ? undefined : lettersOfNamedCode(from);
    if (from === undefined || letters === undefined) continue;
    const decided = yield* settle(
      inboxId,
      [letters, ...derivedCodes(inboxId, BACKFILL_ATTEMPTS)],
      (current, free) => decideShortenCode(current, { inboxId, code: free }),
    );
    if (Result.isSuccess(decided))
      changed.push({ inboxId, from, code: decided.success });
    // Another process moved it first: nothing to do.
    else if (decided.failure?.reason !== 'unchanged') skipped.push(inboxId);
  }
  for (const { inboxId, state } of all) {
    if (state.code !== undefined) continue;
    const decided = yield* settle(
      inboxId,
      derivedCodes(inboxId, BACKFILL_ATTEMPTS),
      (current, free) => decideAssignCode(current, { inboxId, code: free }),
    );
    if (Result.isSuccess(decided))
      assigned.push({ inboxId, code: decided.success });
    // Another process gave it one first: nothing to do.
    else if (decided.failure?.reason !== 'unchanged') skipped.push(inboxId);
  }
  return { assigned, changed, skipped } satisfies CodeBackfill;
});

const inboxes = (n: number) => `${n} inbox${n === 1 ? '' : 'es'}`;

/**
 * `serve`'s start-up run: what it assigned or moved on stdout, anything it
 * could not on stderr. It never stops serve: a store that cannot be opened
 * now is said once, and the next start tries again.
 */
export const assignMissingCodesAtStart = assignMissingCodes.pipe(
  Effect.flatMap(({ assigned, changed, skipped }) =>
    Effect.all([
      changed.length === 0
        ? Effect.void
        : Console.log(
            `operator-inbox serve: moved ${inboxes(changed.length)} to three-letter codes (${changed.map((c) => `${c.from} → ${c.code}`).join(', ')})`,
          ),
      assigned.length === 0
        ? Effect.void
        : Console.log(
            `operator-inbox serve: gave ${inboxes(assigned.length)} opened before codes their code`,
          ),
      skipped.length === 0
        ? Effect.void
        : Console.error(
            `operator-inbox serve: could not give ${skipped.join(', ')} a code; the next start tries again`,
          ),
    ]),
  ),
  Effect.asVoid,
  Effect.catch((e) =>
    Console.error(
      `operator-inbox serve: could not settle the inboxes' codes (${e.message}); the next start tries again`,
    ),
  ),
);
