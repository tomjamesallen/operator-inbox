import {
  type InboxAgentQuestionDto,
  type InboxViewDto,
  machineKeyOf,
} from '@operator-inbox/core/api';
import { DateTime, Option, Schema } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { Atom } from 'effect/reactivity';
import { clockAtom, nowMillis } from './clock';
import {
  type DrawnBoard,
  drawnBoardAtom,
  relAge,
  type SessionTarget,
  sessionTargetOf,
} from './inbox';
import { chaseAfterMsAtom } from './inbox-reader';
import { tickEvery } from './poll';

// Chasing: a question the operator answered, deferred or asked, which has sat
// in With the agent past config.json's `chaseAfterMinutes` (five by default)
// probably needs the session nudged: chiefly a session that is stuck, or has
// dropped its Inbox. Its card highlights when it was answered and gives a
// Chase link to the session, and a toast for its Inbox stays up until the
// operator dismisses it.

// The card's time and the toasts are read off the clock, so they move on
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

/** A question's key in the dismissed list: `<inbox>/<number>`, as `answerKey`. */
const keyOf = (inboxId: string, number: number) => `${inboxId}/${number}`;

/** One Inbox's toast: its stale questions the operator has not dismissed. */
export interface ChaseToast {
  readonly id: string;
  readonly inboxId: string;
  readonly label: string;
  readonly numbers: ReadonlyArray<number>;
  // The keys a dismissal records, one per question.
  readonly keys: ReadonlyArray<string>;
  // "6m": how long the longest-waiting of them has been with the agent.
  readonly waited: string;
  readonly target: SessionTarget | undefined;
}

const chasedIn = (view: InboxViewDto) => !view.archived && view.muted !== true;

/**
 * The toasts to show: one per Inbox holding a stale question the operator has
 * not dismissed, in sidebar order. An archived or muted Inbox raises none.
 */
export const chaseToastsOf = (
  board: DrawnBoard | undefined,
  nowMs: number,
  afterMs: number,
  dismissed: ReadonlySet<string>,
): ReadonlyArray<ChaseToast> =>
  (board?.views ?? []).filter(chasedIn).flatMap((view) => {
    const stale = view.awaitingAgent
      .filter((q) => isStale(q, nowMs, afterMs))
      .filter((q) => !dismissed.has(keyOf(view.inboxId, q.number)))
      .sort((a, b) => a.number - b.number);
    if (stale.length === 0) return [];
    const oldest = Math.min(
      ...stale.map((q) => withAgentSince(q) ?? Number.POSITIVE_INFINITY),
    );
    return [
      {
        id: `chase:${machineKeyOf(view)}:${view.inboxId}`,
        inboxId: view.inboxId,
        label: view.label,
        numbers: stale.map((q) => q.number),
        keys: stale.map((q) => keyOf(view.inboxId, q.number)),
        waited: relAge(Math.max(0, nowMs - oldest) / 86_400_000),
        target: sessionTargetOf(board, view.inboxId),
      },
    ];
  });

/** A toast's line: what has waited, and for how long. */
export const chaseLine = (toast: ChaseToast): string => {
  const which =
    toast.numbers.length === 1
      ? `#${toast.numbers[0]}`
      : `${toast.numbers.length} questions (${toast.numbers.map((n) => `#${n}`).join(', ')})`;
  return `${which} in ${toast.label} ${toast.numbers.length === 1 ? 'has' : 'have'} sat with the agent for ${toast.waited}.`;
};

// --- the atoms -------------------------------------------------------------------

const chaseTickAtom = tickEvery(CHASE_TICK_MS);

/** Now, for chasing: the clock, read again on every tick. */
export const chaseNowAtom = Atom.make((get) => {
  get(chaseTickAtom);
  return nowMillis(get(clockAtom));
});

const browserStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => localStorage),
);

// The questions whose toast the operator dismissed, kept in this browser's
// localStorage as the sidebar's width is, so a reload or another tab does not
// raise them again. A question that leaves With the agent drops out of it on
// the next dismissal, so the list holds only questions still there.
export const chaseDismissedAtom = Atom.kvs({
  runtime: browserStorage,
  key: 'operator-inbox:chase-dismissed',
  schema: Schema.Array(Schema.String),
  defaultValue: (): ReadonlyArray<string> => [],
}).pipe(Atom.keepAlive);

/** The toasts the page shows now. */
export const chaseToastsAtom = Atom.make((get) =>
  chaseToastsOf(
    get(drawnBoardAtom),
    get(chaseNowAtom),
    get(chaseAfterMsAtom),
    new Set(get(chaseDismissedAtom)),
  ),
);

/** Dismiss a toast: its questions stay dismissed while they are with the agent. */
export const dismissChaseAtom = Atom.writable<void, ChaseToast>(
  () => undefined,
  (ctx, toast) => {
    const board = ctx.get(drawnBoardAtom);
    const still = new Set(
      (board?.views ?? []).flatMap((v) =>
        v.awaitingAgent.map((q) => keyOf(v.inboxId, q.number)),
      ),
    );
    const kept = ctx.get(chaseDismissedAtom).filter((k) => still.has(k));
    ctx.set(chaseDismissedAtom, [...new Set([...kept, ...toast.keys])]);
  },
);
