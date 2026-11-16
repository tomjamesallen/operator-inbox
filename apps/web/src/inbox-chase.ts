import type {
  InboxAgentQuestionDto,
  InboxViewDto,
} from '@operator-inbox/core/api';
import { DateTime, Option } from 'effect';
import { Atom } from 'effect/reactivity';
import { clockAtom, nowMillis } from './clock';
import { type DrawnBoard, drawnBoardAtom } from './inbox';
import { chaseAfterMsAtom } from './inbox-reader';
import { tickEvery } from './poll';

// Chasing: a question the operator answered, deferred or asked, which has sat
// in With the agent past config.json's `chaseAfterMinutes` (ten by default)
// probably needs the session nudged: chiefly a session that is stuck, or has
// dropped its Inbox. Its card highlights when it was answered and gives a
// Chase link to the session, and a warning button in the bottom right counts
// the Inboxes that hold one and opens the inbox picker, which lists them
// first.

// The card's time and the button are read off the clock, so they move on
// without a new board: twice a minute is enough for minutes.
export const CHASE_TICK_MS = 30_000;

const millisOf = (at: string | undefined): number | undefined =>
  at === undefined
    ? undefined
    : Option.getOrUndefined(
        Option.map(DateTime.make(at), DateTime.toEpochMillis),
      );

/**
 * When a question with the agent began waiting on it: when it was answered,
 * or, for one the operator asked, when it was asked. Undefined for a stamp that
 * is missing or does not parse, which never reads as stale.
 */
export const withAgentSince = (q: InboxAgentQuestionDto): number | undefined =>
  millisOf(q.answeredAt ?? q.askedAt);

/** Whether a question with the agent has waited on it `afterMs` or more. */
export const isStale = (
  q: InboxAgentQuestionDto,
  nowMs: number,
  afterMs: number,
): boolean => {
  const since = withAgentSince(q);
  return since !== undefined && nowMs - since >= afterMs;
};

/** One Inbox holding questions stale with the agent. */
export interface Chase {
  readonly inboxId: string;
  readonly label: string;
  readonly numbers: ReadonlyArray<number>;
}

const chasedIn = (view: InboxViewDto) => !view.archived && view.muted !== true;

/**
 * The Inboxes that probably need chasing: each holding a stale question, in
 * sidebar order. An archived or muted Inbox needs none.
 */
export const chasesOf = (
  board: DrawnBoard | undefined,
  nowMs: number,
  afterMs: number,
): ReadonlyArray<Chase> =>
  (board?.views ?? []).filter(chasedIn).flatMap((view) => {
    const stale = view.awaitingAgent
      .filter((q) => isStale(q, nowMs, afterMs))
      .map((q) => q.number)
      .sort((a, b) => a - b);
    return stale.length === 0
      ? []
      : [{ inboxId: view.inboxId, label: view.label, numbers: stale }];
  });

// --- the atoms -------------------------------------------------------------------

const chaseTickAtom = tickEvery(CHASE_TICK_MS);

/** Now, for chasing: the clock, read again on every tick. */
export const chaseNowAtom = Atom.make((get) => {
  get(chaseTickAtom);
  return nowMillis(get(clockAtom));
});

/** The Inboxes the chase button counts now. */
export const chasesAtom = Atom.make((get) =>
  chasesOf(get(drawnBoardAtom), get(chaseNowAtom), get(chaseAfterMsAtom)),
);
