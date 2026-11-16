import {
  InboxAgentQuestionDto,
  InboxId,
  InboxMachineKey,
  InboxOperatorQuestionDto,
  InboxProcessedQuestionDto,
  type InboxViewDto,
  machineKeyOf,
} from '@operator-inbox/core/api';
import { DateTime, Option, Schema } from 'effect';

// The zen inbox page's three queues, as pure data: what each holds and in what
// order, and which questions are new to this page. The reader's flow over them
// is `inbox-reader-machine.ts`; nothing here keeps state or reads a clock.

export const QUEUE_NAMES = ['inbox', 'agent', 'processed'] as const;
export const QueueName = Schema.Literals(QUEUE_NAMES);
export type QueueName = typeof QueueName.Type;

export const QUEUE_TITLES: Readonly<Record<QueueName, string>> = {
  inbox: 'Your inbox',
  agent: 'With the agent',
  processed: 'Processed',
};

/** A question's key on the page: the same in every queue it passes through. */
export const answerKey = (inboxId: InboxId, number: number): string =>
  `${inboxId}/${number}`;

const queueItem = <Q extends Schema.Top>(question: Q) =>
  Schema.Struct({
    key: Schema.String,
    inboxId: InboxId,
    inboxLabel: Schema.String,
    machine: InboxMachineKey,
    question,
  });

export const InboxItem = queueItem(InboxOperatorQuestionDto);
export type InboxItem = typeof InboxItem.Type;
export const AgentItem = queueItem(InboxAgentQuestionDto);
export type AgentItem = typeof AgentItem.Type;
export const ProcessedItem = queueItem(InboxProcessedQuestionDto);
export type ProcessedItem = typeof ProcessedItem.Type;

export const Queues = Schema.Struct({
  inbox: Schema.Array(InboxItem),
  agent: Schema.Array(AgentItem),
  processed: Schema.Array(ProcessedItem),
});
export type Queues = typeof Queues.Type;

export const NO_QUEUES: Queues = { inbox: [], agent: [], processed: [] };

// --- time order -----------------------------------------------------------------

// The stated rule for questions from several machines. A question's place in
// time is its machine's stamp, taken at face value: two machines' clocks may
// differ and nothing here corrects for it, so skew moves a question by no more
// than the skew. A question with no stamp, or one that does not parse, reads as
// the oldest, since the stamp is what old log entries lack. A seq is a place in
// ONE machine's log, so it breaks a tie only between questions on that machine.
// A tie across machines goes by machine key, which keeps the order the same on
// every read whatever order the views came in.

const timeOf = (at: string | undefined): number =>
  at === undefined
    ? 0
    : Option.match(DateTime.make(at), {
        onNone: () => 0,
        onSome: DateTime.toEpochMillis,
      });

interface Placed<Q> {
  readonly machine: InboxMachineKey;
  readonly question: Q;
}

const timeOrder =
  <Q>(at: (q: Q) => string | undefined, seq: (q: Q) => number) =>
  (a: Placed<Q>, b: Placed<Q>): number => {
    const apart = timeOf(at(a.question)) - timeOf(at(b.question));
    if (apart !== 0) return apart;
    if (a.machine === b.machine) return seq(a.question) - seq(b.question);
    return a.machine < b.machine ? -1 : 1;
  };

/** Earliest asked first. Flip the arguments for most recent first. */
export const askedOrder = timeOrder<InboxOperatorQuestionDto>(
  (q) => q.askedAt,
  (q) => q.askedSeq,
);

/** Earliest answered first. Flip the arguments for most recent first. */
export const answeredOrder = timeOrder<InboxAgentQuestionDto>(
  (q) => q.answeredAt,
  (q) => q.answeredSeq,
);

/** Earliest processed first. Flip the arguments for most recent first. */
export const processedOrder = timeOrder<InboxProcessedQuestionDto>(
  (q) => q.processedAt,
  (q) => q.processedSeq,
);

// --- the queues -----------------------------------------------------------------

const itemsOf = <
  Q extends { readonly number: InboxOperatorQuestionDto['number'] },
>(
  views: ReadonlyArray<InboxViewDto>,
  pick: (v: InboxViewDto) => ReadonlyArray<Q>,
) =>
  views.flatMap((v) =>
    pick(v).map((question) => ({
      key: answerKey(v.inboxId, question.number),
      inboxId: v.inboxId,
      inboxLabel: v.label,
      machine: machineKeyOf(v),
      question,
    })),
  );

/**
 * The three queues for the views shown, interleaved by time with no grouping
 * by Inbox or machine. Your inbox is oldest first, and the other two most
 * recent first. A highlight lifts nothing: time
 * order overrides it, and the dot and the keys are what find it.
 */
export const queuesOf = (views: ReadonlyArray<InboxViewDto>): Queues => ({
  inbox: itemsOf(views, (v) => v.awaitingOperator).sort(askedOrder),
  agent: itemsOf(views, (v) => v.awaitingAgent).sort((a, b) =>
    answeredOrder(b, a),
  ),
  processed: itemsOf(views, (v) => v.processed).sort((a, b) =>
    processedOrder(b, a),
  ),
});

// --- follow-ups ----------------------------------------------------------------

// A follow-up on a question with the agent or processed is a linked ask, for
// now. The ask write carries only text, so the link is
// the text's last line: the agent reads it as it is, and the page reads it back
// to draw the follow-up under its question. Last, because core titles an asked
// question by its first line.
const FOLLOW_UP_LINE = /\n\nFollow-up to #(\d+): \S+$/;

/** The text of a follow-up to question `number`, ending in its link. */
export const followUpText = (
  text: string,
  number: number,
  path: string,
): string => `${text.trimEnd()}\n\nFollow-up to #${number}: ${path}`;

/** What an operator's ask says, and which question it follows up, if any. */
export const askedTextOf = (
  response: string,
): { readonly text: string; readonly followsUp?: number } => {
  const line = FOLLOW_UP_LINE.exec(response);
  return line === null
    ? { text: response }
    : {
        text: response.slice(0, line.index),
        followsUp: Number(line[1]),
      };
};

// --- what is new ----------------------------------------------------------------

/** How long a question new to the page keeps its dot. */
export const FRESH_MS = 60_000;

/** How long a dot takes to go once its question has stopped waiting. */
export const SPENT_FADE_MS = 300;

export interface FreshMark {
  readonly key: string;
  readonly inboxId: InboxId;
  // When the read that found it landed, from the caller's clock.
  readonly at: number;
  // Its question no longer waits, so the dot is on its way out.
  readonly spent?: true;
}

export interface SeenFold {
  // Every question this page has ever held waiting. It only grows: a machine
  // that drops out and comes back brings nothing new with it. Unlike
  // the old column's `SEEN_LIMIT` it has no cap, since a cap would forget.
  readonly known: ReadonlySet<string>;
  // The machines this page has read at least once.
  readonly machines: ReadonlySet<InboxMachineKey>;
  readonly fresh: ReadonlyArray<FreshMark>;
}

/** The marks still lit at `nowMs`. */
export const freshAt = (
  seen: Pick<SeenFold, 'fresh'>,
  nowMs: number,
): ReadonlyArray<FreshMark> =>
  seen.fresh.filter((f) => nowMs - f.at < FRESH_MS);

/**
 * When each mark's question stopped waiting, keyed by the mark. One that waits
 * again, as an answer the server refused does, is taken back out.
 */
export const spentAfter = (
  previous: ReadonlyMap<string, number>,
  fresh: ReadonlyArray<FreshMark>,
  waiting: ReadonlySet<string>,
  nowMs: number,
): ReadonlyMap<string, number> =>
  new Map(
    fresh
      .filter((f) => !waiting.has(f.key))
      .map((f) => [f.key, previous.get(f.key) ?? nowMs]),
  );

/**
 * The fold over each board read, across every view on the board rather than
 * the ones shown, so a question new to another Inbox lights too. `read` is the
 * machines that answered this read. The first board only seeds, and so does a
 * machine's first answer: what it holds was there before this page could see
 * it, so a machine down at load does not light on arrival.
 */
export const seenAfter = (
  previous: SeenFold | undefined,
  views: ReadonlyArray<InboxViewDto>,
  read: ReadonlyArray<InboxMachineKey>,
  nowMs: number,
): SeenFold => {
  const waiting = views.flatMap((v) =>
    v.awaitingOperator.map((q) => ({
      key: answerKey(v.inboxId, q.number),
      inboxId: v.inboxId,
      machine: machineKeyOf(v),
    })),
  );
  const news = waiting.filter(
    (w) =>
      previous?.machines.has(w.machine) === true && !previous.known.has(w.key),
  );
  return {
    known: new Set([...(previous?.known ?? []), ...waiting.map((w) => w.key)]),
    machines: new Set([...(previous?.machines ?? []), ...read]),
    fresh: [
      ...(previous === undefined ? [] : freshAt(previous, nowMs)),
      ...news.map(({ key, inboxId }) => ({ key, inboxId, at: nowMs })),
    ],
  };
};
