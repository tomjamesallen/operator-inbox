import {
  InboxId,
  InboxMachineKey,
  MacroInvoked,
  QuestionComment,
} from '@operator-inbox/core/api';
import { setupEffect } from '@xstate/effect';
import { createActorAtoms } from '@xstate/effect/atom';
import { Layer, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { SnapshotFrom, StateValue } from 'xstate';
import {
  AgentItem,
  answeredOrder,
  askedOrder,
  InboxItem,
  NO_QUEUES,
  ProcessedItem,
  processedOrder,
  QUEUE_NAMES,
  QueueName,
  Queues,
} from './inbox-queues';

// The zen inbox page's flow: one XState 6 machine, five parallel regions.
// It holds what the reader is doing and nothing that is data: the
// queues arrive by `ItemsChanged`, the drafts live in Atoms, and every write is
// an Atom through `sendWrite`, which tells the machine its outcome by event. A
// write is never invoked here, because leaving a state interrupts what it
// invoked.
//
// Focus is a question key per queue, never a place in a list. Everything that
// changes what a queue shows runs through `settled`, which walks the old list
// from the focused key to find where the reader lands, so an answer coming
// back, a question arriving or a machine folding moves nothing it should not.

/** How long a jump may hold the scroll lock if `scrollend` never comes. */
export const JUMP_LOCK_MS = 1_200;
/** How long the scroll an instant placement causes is ignored. */
export const PLACE_LOCK_MS = 100;

// --- the context ----------------------------------------------------------------

// An answer on its way: the reader flows on at once, so it shows in
// With the agent until the board does. `landed` keeps it there after the write
// is confirmed and before a read has moved the question across.
const SendingAnswer = Schema.Struct({
  item: InboxItem,
  response: Schema.String,
  deferred: Schema.Boolean,
  // The macros it carries, shown with it as it goes.
  macros: Schema.Array(MacroInvoked),
  // And the comments, in body order.
  comments: Schema.Array(QuestionComment),
  landed: Schema.Boolean,
});
export type SendingAnswer = typeof SendingAnswer.Type;

// What became of an answer that did not land, while its question is here to say
// so. `mayHaveLanded` from the write's failure is 'uncertain', never 'unsent'.
const AnswerTroubleTag = Schema.Literals(['refused', 'unsent', 'uncertain']);
const AnswerTrouble = Schema.Struct({
  key: Schema.String,
  inboxId: InboxId,
  number: Schema.Int,
  machine: InboxMachineKey,
  tag: AnswerTroubleTag,
  text: Schema.String,
});
export type AnswerTrouble = typeof AnswerTrouble.Type;

// A request to bring a question up, which the page's scroller carries out once
// per `id`. `smooth` is false for a placement: a queue draws its own list, so it
// finds its place again without a slide.
const ScrollJump = Schema.Struct({
  id: Schema.Int,
  key: Schema.String,
  smooth: Schema.Boolean,
});
export type ScrollJump = typeof ScrollJump.Type;

// The lit question whose machine folded under the reader, in the
// queue it was lit in. It stays until the reader moves, or it comes back.
const HeldQuestion = Schema.Union([
  Schema.Struct({ queue: Schema.Literal('inbox'), item: InboxItem }),
  Schema.Struct({ queue: Schema.Literal('agent'), item: AgentItem }),
  Schema.Struct({ queue: Schema.Literal('processed'), item: ProcessedItem }),
]);
export type HeldQuestion = typeof HeldQuestion.Type;

const OptionalKey = Schema.UndefinedOr(Schema.String);
const OptionalInbox = Schema.UndefinedOr(InboxId);

const ReaderContext = Schema.Struct({
  // What the view is: a change of selection is not a question folding.
  view: Schema.UndefinedOr(Schema.String),
  queues: Queues,
  focus: Schema.Struct({
    inbox: OptionalKey,
    agent: OptionalKey,
    processed: OptionalKey,
  }),
  held: Schema.UndefinedOr(HeldQuestion),
  // A link's question the board does not show yet: it lands once, when it does.
  awaited: OptionalKey,
  sends: Schema.Array(SendingAnswer),
  troubles: Schema.Array(AnswerTrouble),
  folded: Schema.Array(InboxMachineKey),
  jump: Schema.UndefinedOr(ScrollJump),
  jumps: Schema.Int,
  askTo: OptionalInbox,
  // Matched by Inbox id, since two machines' Inboxes can share a name.
  askCursor: OptionalInbox,
  railFits: Schema.Boolean,
  railWanted: Schema.Boolean,
  renaming: OptionalInbox,
});
export type ReaderContext = typeof ReaderContext.Type;

const INITIAL: ReaderContext = {
  view: undefined,
  queues: NO_QUEUES,
  focus: { inbox: undefined, agent: undefined, processed: undefined },
  held: undefined,
  awaited: undefined,
  sends: [],
  troubles: [],
  folded: [],
  jump: undefined,
  jumps: 0,
  askTo: undefined,
  askCursor: undefined,
  railFits: false,
  railWanted: false,
  renaming: undefined,
};

// --- what the queues show -------------------------------------------------------

/** An answer on its way, as With the agent shows it. */
export type SendingRow = InboxItem & { readonly sending: SendingAnswer };

export interface ReaderQueues {
  readonly inbox: ReadonlyArray<InboxItem>;
  readonly agent: ReadonlyArray<AgentItem | SendingRow>;
  readonly processed: ReadonlyArray<ProcessedItem>;
}

/**
 * The queues as the reader sees them: an answer on its way has left Your inbox
 * for With the agent, and a held question keeps its place in time.
 */
export const readerQueuesOf = (
  context: Pick<ReaderContext, 'queues' | 'sends' | 'held'>,
): ReaderQueues => {
  const { queues, sends, held } = context;
  const sending = new Set(sends.map((s) => s.item.key));
  const agentKeys = new Set(queues.agent.map((i) => i.key));
  const waiting = queues.inbox.filter((i) => !sending.has(i.key));
  return {
    inbox:
      held?.queue === 'inbox'
        ? [...waiting, held.item].sort(askedOrder)
        : waiting,
    agent: [
      ...sends
        .filter((s) => !agentKeys.has(s.item.key))
        .map((s) => ({ ...s.item, sending: s }))
        .reverse(),
      ...(held?.queue === 'agent'
        ? [...queues.agent, held.item].sort((a, b) => answeredOrder(b, a))
        : queues.agent),
    ],
    processed:
      held?.queue === 'processed'
        ? [...queues.processed, held.item].sort((a, b) => processedOrder(b, a))
        : queues.processed,
  };
};

const keysOf = (items: ReadonlyArray<{ readonly key: string }>) =>
  items.map((i) => i.key);

/**
 * Where the focus lands when a queue's list changes. The key survives if its
 * question does. If not, the next question after it in the old list that is
 * still here takes over, and failing that the nearest before it, so a sent
 * answer flows on to what took its place. With no focus, the first question.
 */
const landingOf = (
  was: ReadonlyArray<string>,
  focus: string | undefined,
  now: ReadonlyArray<string>,
): string | undefined => {
  if (focus !== undefined && now.includes(focus)) return focus;
  const at = focus === undefined ? -1 : was.indexOf(focus);
  if (at < 0) return now[0];
  const after = was.slice(at + 1).find((k) => now.includes(k));
  return (
    after ??
    was
      .slice(0, at)
      .filter((k) => now.includes(k))
      .at(-1) ??
    now[0]
  );
};

const settled = (
  before: ReaderContext,
  after: ReaderContext,
): ReaderContext => {
  const was = readerQueuesOf(before);
  const now = readerQueuesOf(after);
  const land = (q: QueueName) =>
    landingOf(keysOf(was[q]), after.focus[q], keysOf(now[q]));
  return {
    ...after,
    focus: {
      inbox: land('inbox'),
      agent: land('agent'),
      processed: land('processed'),
    },
  };
};

const jumpTo = (
  context: ReaderContext,
  key: string | undefined,
  smooth: boolean,
): ReaderContext =>
  key === undefined
    ? context
    : {
        ...context,
        jumps: context.jumps + 1,
        jump: { id: context.jumps + 1, key, smooth },
      };

const queueHolding = (
  context: ReaderContext,
  key: string,
  active: QueueName,
): QueueName | undefined => {
  const queues = readerQueuesOf(context);
  return [active, ...QUEUE_NAMES].find((q) =>
    queues[q].some((i) => i.key === key),
  );
};

// The reader went to `key` in `queue`: whatever was held or awaited lets go.
const focusedOn = (
  context: ReaderContext,
  queue: QueueName,
  key: string,
): ReaderContext => {
  const released: ReaderContext = {
    ...context,
    awaited: undefined,
    held: context.held?.item.key === key ? context.held : undefined,
    focus: { ...context.focus, [queue]: key },
  };
  return settled(context, released);
};

// The reader left the queue, or chose a queue: nothing is held past that.
const letGo = (context: ReaderContext): ReaderContext =>
  settled(context, { ...context, held: undefined, awaited: undefined });

/** What `ItemsChanged` carries: the page derives it from the drawn board. */
const ItemsChanged = Schema.Struct({
  view: Schema.String,
  queues: Queues,
  // Machines gone from the board past their one greyed read.
  folded: Schema.Array(InboxMachineKey),
  // Every question waiting on the whole board, whatever the view shows.
  waiting: Schema.Array(Schema.String),
});

/**
 * The context after a read. The lit question is held only when it left because
 * its machine folded, in the same view: answered elsewhere or withdrawn, it is
 * gone and the focus moves on. A landed answer leaves `sends` once the board no
 * longer waits on it, and a trouble once the whole board has stopped waiting on
 * its question for any reason but a folded machine, since the read has then said
 * what became of it. A view that does not show the question says nothing.
 */
const afterRead = (
  context: ReaderContext,
  read: typeof ItemsChanged.Type,
  active: QueueName,
): ReaderContext => {
  const waiting = new Set(keysOf(read.queues.inbox));
  const onBoard = new Set(read.waiting);
  const folded = new Set(read.folded);
  const sameView = context.view === read.view;
  const lit = readerQueuesOf(context)[active].find(
    (i) => i.key === context.focus[active],
  );
  const litHere = (): HeldQuestion | undefined => {
    if (lit === undefined || 'sending' in lit) return undefined;
    if (context.sends.some((s) => s.item.key === lit.key)) return undefined;
    return { queue: active, item: lit } as HeldQuestion;
  };
  const candidate = context.held ?? litHere();
  const held =
    sameView &&
    candidate !== undefined &&
    !keysOf(read.queues[candidate.queue]).includes(candidate.item.key) &&
    folded.has(candidate.item.machine)
      ? candidate
      : undefined;
  // Across views the old list says nothing about where to land, so a focus the
  // new view does not hold starts it at its first question.
  const keeps = (q: QueueName) => {
    const key = context.focus[q];
    return sameView || keysOf(read.queues[q]).includes(key ?? '')
      ? key
      : undefined;
  };
  return settled(context, {
    ...context,
    view: read.view,
    queues: read.queues,
    focus: {
      inbox: keeps('inbox'),
      agent: keeps('agent'),
      processed: keeps('processed'),
    },
    folded: read.folded,
    held,
    sends: context.sends.filter((s) => !s.landed || waiting.has(s.item.key)),
    troubles: context.troubles.filter(
      (t) => onBoard.has(t.key) || folded.has(t.machine),
    ),
  });
};

// --- the machine ----------------------------------------------------------------

const Key = { key: Schema.String };
const Step = { by: Schema.Literals([1, -1]) };
const Nothing = Schema.Struct({});

const setup = setupEffect({
  schemas: {
    context: ReaderContext,
    events: {
      ItemsChanged,
      // A key, a click, the minimap, a search match or a link: bring it up.
      MovedTo: Schema.Struct(Key),
      // The reading line reached it: the focus follows and nothing jumps.
      ScrolledTo: Schema.Struct(Key),
      // A finger dragging down the minimap is over it: it is placed at once,
      // with no slide, and the reading line does not take the focus back.
      ScrubbedTo: Schema.Struct(Key),
      // The finger lifted: the reader stays on the question it was over.
      ScrubEnded: Nothing,
      Moved: Schema.Struct(Step),
      MovedToHighlight: Schema.Struct(Step),
      MovedToEnd: Schema.Struct({ end: Schema.Literals(['first', 'last']) }),
      QueueChosen: Schema.Struct({ queue: QueueName }),
      QueueStepped: Schema.Struct(Step),
      AnswerSent: Schema.Struct({
        ...Key,
        response: Schema.String,
        deferred: Schema.Boolean,
        macros: Schema.Array(MacroInvoked),
        comments: Schema.Array(QuestionComment),
      }),
      AnswerLanded: Schema.Struct(Key),
      AnswerFailed: Schema.Struct({
        ...Key,
        tag: AnswerTroubleTag,
        text: Schema.String,
      }),
      AskToggled: Schema.Struct({ inboxId: OptionalInbox }),
      AskClosed: Nothing,
      AskCursorSet: Schema.Struct({ inboxId: InboxId }),
      AskInboxPicked: Schema.Struct({ inboxId: InboxId }),
      AskInboxCleared: Nothing,
      AskLanded: Schema.Struct({ ...Key, inboxId: InboxId }),
      RailToggled: Nothing,
      RailHovered: Nothing,
      RailLeft: Nothing,
      RailFocused: Nothing,
      RailDismissed: Nothing,
      RailFitChanged: Schema.Struct({ fits: Schema.Boolean }),
      RenameOpened: Schema.Struct({ inboxId: InboxId }),
      RenameClosed: Nothing,
      RenameLanded: Schema.Struct({ inboxId: InboxId }),
      ScrollTaken: Nothing,
      JumpEnded: Schema.Struct({ id: Schema.Int }),
    },
    internalEvents: {
      // The reader moved, so the composer stops asking.
      ReaderMoved: Nothing,
      JumpStarted: Nothing,
      PlaceStarted: Nothing,
    },
  },
  delays: {
    jumpLock: JUMP_LOCK_MS,
    placeLock: PLACE_LOCK_MS,
  },
});

type RaisedEvent = 'ReaderMoved' | 'JumpStarted' | 'PlaceStarted';

interface Raises {
  readonly raise: (event: { readonly type: RaisedEvent }) => void;
}

interface Regions {
  readonly value: StateValue;
}

const QUEUE_TARGETS = {
  inbox: '.inbox',
  agent: '.agent',
  processed: '.processed',
} as const;

export const activeQueueOf = (snapshot: Regions): QueueName =>
  (snapshot.value as { readonly queue: QueueName }).queue;

const scrollLocked = (snapshot: Regions): boolean => {
  const { scroll, composer } = snapshot.value as {
    readonly scroll: string;
    readonly composer: unknown;
  };
  return (
    scroll === 'jumping' ||
    scroll === 'placing' ||
    scroll === 'scrubbing' ||
    composer !== 'replying'
  );
};

// The reader goes to `key`: within the queue it slides, across queues it is
// placed. Focusing what is already focused brings nothing up.
const arrive = (
  context: ReaderContext,
  active: QueueName,
  queue: QueueName,
  key: string,
  enq: Raises,
) => {
  const moved = focusedOn(context, queue, key);
  if (queue === active && context.focus[queue] === key)
    return { context: moved };
  const smooth = queue === active;
  enq.raise({ type: smooth ? 'JumpStarted' : 'PlaceStarted' });
  const jumped = jumpTo(moved, key, smooth);
  return queue === active
    ? { context: jumped }
    : { target: QUEUE_TARGETS[queue], context: jumped };
};

// The list changed under the reader. When that moved the focus in the queue on
// screen, bring the new question up: with a slide on the same view, and in place
// when nothing was focused, the view is another one, or the reader's own answer
// took the question away: the next one is simply there, with no slide to wait out.
const refocused = (
  before: ReaderContext,
  after: ReaderContext,
  active: QueueName,
  enq: Raises,
  slide = true,
) => {
  const was = before.focus[active];
  const now = after.focus[active];
  if (was === now) return { context: after };
  const smooth = slide && was !== undefined && before.view === after.view;
  enq.raise({ type: smooth ? 'JumpStarted' : 'PlaceStarted' });
  return { context: jumpTo(after, now, smooth) };
};

const stepped = (
  context: ReaderContext,
  active: QueueName,
  pick: (keys: ReadonlyArray<string>, at: number) => string | undefined,
  enq: Raises,
) => {
  enq.raise({ type: 'ReaderMoved' });
  const keys = keysOf(readerQueuesOf(context)[active]);
  const focus = context.focus[active];
  const key = pick(keys, focus === undefined ? -1 : keys.indexOf(focus));
  return key === undefined
    ? undefined
    : arrive(context, active, active, key, enq);
};

const NOT_ASKING = { askTo: undefined, askCursor: undefined };

const toggledRail = (context: ReaderContext) =>
  context.railFits
    ? {
        target: 'docked' as const,
        context: { ...context, railWanted: true },
      }
    : { target: 'drawer' as const };

export const readerMachine = setup.createMachine({
  id: 'inboxReader',
  type: 'parallel',
  context: INITIAL,
  states: {
    queue: {
      initial: 'inbox',
      states: { inbox: {}, agent: {}, processed: {} },
      on: {
        ItemsChanged: ({ context, event, self }, enq) => {
          const active = activeQueueOf(self.getSnapshot());
          const read = afterRead(context, event, active);
          const queue =
            read.awaited === undefined
              ? undefined
              : queueHolding(read, read.awaited, active);
          if (read.awaited === undefined || queue === undefined)
            return refocused(context, read, active, enq);
          enq.raise({ type: 'ReaderMoved' });
          return arrive(read, active, queue, read.awaited, enq);
        },
        MovedTo: ({ context, event, self }, enq) => {
          enq.raise({ type: 'ReaderMoved' });
          const active = activeQueueOf(self.getSnapshot());
          const queue = queueHolding(context, event.key, active);
          return queue === undefined
            ? { context: { ...context, awaited: event.key } }
            : arrive(context, active, queue, event.key, enq);
        },
        ScrolledTo: ({ context, event, self }) => {
          const snapshot = self.getSnapshot();
          if (scrollLocked(snapshot)) return;
          const active = activeQueueOf(snapshot);
          const shown = readerQueuesOf(context)[active];
          if (
            context.focus[active] === event.key ||
            !shown.some((i) => i.key === event.key)
          )
            return;
          return { context: focusedOn(context, active, event.key) };
        },
        // Within the queue on screen only: the minimap shows nothing else.
        ScrubbedTo: ({ context, event, self }, enq) => {
          enq.raise({ type: 'ReaderMoved' });
          const active = activeQueueOf(self.getSnapshot());
          if (
            context.focus[active] === event.key ||
            !readerQueuesOf(context)[active].some((i) => i.key === event.key)
          )
            return;
          return {
            context: jumpTo(
              focusedOn(context, active, event.key),
              event.key,
              false,
            ),
          };
        },
        Moved: ({ context, event, self }, enq) =>
          stepped(
            context,
            activeQueueOf(self.getSnapshot()),
            (keys, at) => keys[at + event.by],
            enq,
          ),
        MovedToEnd: ({ context, event, self }, enq) => {
          return stepped(
            context,
            activeQueueOf(self.getSnapshot()),
            (keys) => (event.end === 'first' ? keys[0] : keys.at(-1)),
            enq,
          );
        },
        MovedToHighlight: ({ context, event, self }, enq) => {
          const active = activeQueueOf(self.getSnapshot());
          if (active !== 'inbox') return;
          const marked = new Set(
            readerQueuesOf(context)
              .inbox.filter((i) => i.question.highlight !== undefined)
              .map((i) => i.key),
          );
          return stepped(
            context,
            active,
            (keys, at) =>
              event.by === 1
                ? keys.slice(at + 1).find((k) => marked.has(k))
                : keys
                    .slice(0, Math.max(at, 0))
                    .filter((k) => marked.has(k))
                    .at(-1),
            enq,
          );
        },
        QueueChosen: ({ context, event, self }, enq) => {
          enq.raise({ type: 'ReaderMoved' });
          if (event.queue === activeQueueOf(self.getSnapshot())) return;
          enq.raise({ type: 'PlaceStarted' });
          const left = letGo(context);
          return {
            target: QUEUE_TARGETS[event.queue],
            context: jumpTo(left, left.focus[event.queue], false),
          };
        },
        QueueStepped: ({ context, event, self }, enq) => {
          const active = activeQueueOf(self.getSnapshot());
          const queue = QUEUE_NAMES[QUEUE_NAMES.indexOf(active) + event.by];
          if (queue === undefined) return;
          enq.raise({ type: 'ReaderMoved' });
          enq.raise({ type: 'PlaceStarted' });
          const left = letGo(context);
          return {
            target: QUEUE_TARGETS[queue],
            context: jumpTo(left, left.focus[queue], false),
          };
        },
        // A held question is not on the board, so this finds nothing for it:
        // its machine cannot be reached, and the send is off.
        AnswerSent: ({ context, event, self }, enq) => {
          const item = context.queues.inbox.find((i) => i.key === event.key);
          if (
            item === undefined ||
            context.sends.some((s) => s.item.key === event.key)
          )
            return;
          const sent = settled(context, {
            ...context,
            sends: [
              ...context.sends,
              {
                item,
                response: event.response,
                deferred: event.deferred,
                macros: event.macros,
                comments: event.comments,
                landed: false,
              },
            ],
            troubles: context.troubles.filter((t) => t.key !== event.key),
          });
          return refocused(
            context,
            sent,
            activeQueueOf(self.getSnapshot()),
            enq,
            false,
          );
        },
        AnswerLanded: ({ context, event, self }, enq) => {
          const onBoard = context.queues.inbox.some((i) => i.key === event.key);
          const landed = settled(context, {
            ...context,
            sends: context.sends.flatMap((s) =>
              s.item.key !== event.key
                ? [s]
                : onBoard
                  ? [{ ...s, landed: true }]
                  : [],
            ),
          });
          return refocused(
            context,
            landed,
            activeQueueOf(self.getSnapshot()),
            enq,
          );
        },
        // It comes back to its place in time and takes no focus. A
        // question gone from the board has nowhere to say this: that failure is
        // a stray, which `sendWrite` lists in `strayWritesAtom`.
        AnswerFailed: ({ context, event, self }, enq) => {
          const send = context.sends.find((s) => s.item.key === event.key);
          if (send === undefined) return;
          const { machine } = send.item;
          const here =
            context.queues.inbox.some((i) => i.key === event.key) ||
            context.folded.includes(machine);
          const failed = settled(context, {
            ...context,
            sends: context.sends.filter((s) => s !== send),
            troubles: here
              ? [
                  ...context.troubles,
                  {
                    key: event.key,
                    inboxId: send.item.inboxId,
                    number: send.item.question.number,
                    machine,
                    tag: event.tag,
                    text: event.text,
                  },
                ]
              : context.troubles,
          });
          return refocused(
            context,
            failed,
            activeQueueOf(self.getSnapshot()),
            enq,
          );
        },
        // Only while the composer is still on that Inbox: a reader who moved on
        // stays where they are. The question shows at the next read.
        AskLanded: ({ context, event, self }, enq) => {
          if (context.askTo !== event.inboxId) return;
          enq.raise({ type: 'ReaderMoved' });
          const awaiting = { ...letGo(context), awaited: event.key };
          return activeQueueOf(self.getSnapshot()) === 'agent'
            ? { context: awaiting }
            : { target: QUEUE_TARGETS.agent, context: awaiting };
        },
      },
    },
    composer: {
      initial: 'replying',
      states: {
        // The box belongs to the lit question: `composerOf` says how.
        replying: {
          on: {
            AskToggled: ({ context, event }) =>
              event.inboxId === undefined
                ? { target: 'asking.picking' }
                : {
                    target: 'asking.writing',
                    context: { ...context, askTo: event.inboxId },
                  },
          },
        },
        asking: {
          initial: 'picking',
          states: {
            picking: {
              on: {
                AskCursorSet: ({ context, event }) => ({
                  context: { ...context, askCursor: event.inboxId },
                }),
              },
            },
            writing: {
              on: {
                AskInboxCleared: ({ context }) => ({
                  target: 'picking',
                  context: {
                    ...context,
                    askTo: undefined,
                    askCursor: context.askTo,
                  },
                }),
              },
            },
          },
          on: {
            // The list stays on the page while the question is written, so a
            // row picks in either step.
            AskInboxPicked: ({ context, event }) => ({
              target: '.writing',
              context: {
                ...context,
                askTo: event.inboxId,
                askCursor: undefined,
              },
            }),
            AskToggled: ({ context }) => ({
              target: 'replying',
              context: { ...context, ...NOT_ASKING },
            }),
            AskClosed: ({ context }) => ({
              target: 'replying',
              context: { ...context, ...NOT_ASKING },
            }),
            ReaderMoved: ({ context }) => ({
              target: 'replying',
              context: { ...context, ...NOT_ASKING },
            }),
          },
        },
      },
    },
    // `docked` stays open while it fits, in the gutter or in a column of its own
    // (`railPushesAtom`); below that the same toggle opens a drawer. `railWanted`
    // remembers the pin through a narrow spell.
    rail: {
      initial: 'shut',
      on: {
        RailFitChanged: ({ context, event, self }) => {
          const next = { ...context, railFits: event.fits };
          const { rail } = self.getSnapshot().value as {
            readonly rail: string;
          };
          if (rail === 'docked' && !event.fits)
            return { target: '.shut', context: next };
          if (rail !== 'docked' && event.fits && context.railWanted)
            return { target: '.docked', context: next };
          return { context: next };
        },
      },
      states: {
        shut: {
          on: {
            RailHovered: { target: 'peeking' },
            RailFocused: { target: 'drawer' },
            RenameOpened: { target: 'drawer' },
            RailToggled: ({ context }) => toggledRail(context),
          },
        },
        peeking: {
          on: {
            RailLeft: { target: 'shut' },
            RailDismissed: { target: 'shut' },
            RailFocused: { target: 'drawer' },
            RenameOpened: { target: 'drawer' },
            RailToggled: ({ context }) => toggledRail(context),
          },
        },
        drawer: {
          on: {
            RailDismissed: { target: 'shut' },
            RailToggled: ({ context }) =>
              context.railFits ? toggledRail(context) : { target: 'shut' },
          },
        },
        docked: {
          on: {
            RailToggled: ({ context }) => ({
              target: 'shut',
              context: { ...context, railWanted: false },
            }),
          },
        },
      },
    },
    // One Inbox's rename at a time. A name refused, an unchanged one included
    // (`decideRename`, in core), is the write's failure: the form stays open and
    // `railRenameAtom` says why.
    rename: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            RenameOpened: ({ context, event }) => ({
              target: 'editing',
              context: { ...context, renaming: event.inboxId },
            }),
          },
        },
        editing: {
          on: {
            RenameOpened: ({ context, event }) => ({
              context: { ...context, renaming: event.inboxId },
            }),
            RenameClosed: ({ context }) => ({
              target: 'idle',
              context: { ...context, renaming: undefined },
            }),
            RenameLanded: ({ context, event }) =>
              context.renaming === event.inboxId
                ? {
                    target: 'idle',
                    context: { ...context, renaming: undefined },
                  }
                : undefined,
          },
        },
      },
    },
    // Who is moving the list. `reading` leaves it to the reader, and the focus
    // follows their scroll. `jumping` is a slide to a question, whose passing questions
    // must not take the focus, or a draft typed after a minimap click lands on
    // the one before. `placing` swallows the scroll an instant placement causes.
    // `scrubbing` is a finger on the minimap, placing each question it passes,
    // and holds until the finger lifts: the scroll follows the finger, so the
    // reading line must not move the focus under it. The queue region reads the
    // lock for `ScrolledTo`.
    scroll: {
      initial: 'reading',
      on: {
        JumpStarted: { target: '.jumping', reenter: true },
        PlaceStarted: { target: '.placing', reenter: true },
        ScrubbedTo: { target: '.scrubbing' },
      },
      states: {
        reading: {},
        jumping: {
          after: { jumpLock: { target: 'reading' } },
          on: {
            // A newer jump's lock is not this one's to end.
            JumpEnded: ({ context, event }) =>
              context.jump?.id === event.id ? { target: 'reading' } : undefined,
            ScrollTaken: { target: 'reading' },
          },
        },
        placing: {
          after: { placeLock: { target: 'reading' } },
          on: { ScrollTaken: { target: 'reading' } },
        },
        // The last placement's scroll may still be on its way when the finger
        // lifts, so the end swallows it as a placement does.
        scrubbing: {
          on: { ScrubEnded: { target: 'placing' } },
        },
      },
    },
  },
});

export type ReaderSnapshot = SnapshotFrom<typeof readerMachine>;

// --- reading the snapshot -------------------------------------------------------

/** The focused question in the queue on screen. */
export const litOf = (
  snapshot: ReaderSnapshot,
): ReaderQueues[QueueName][number] | undefined => {
  const active = activeQueueOf(snapshot);
  const { context } = snapshot;
  return readerQueuesOf(context)[active].find(
    (i) => i.key === context.focus[active],
  );
};

/**
 * What the box at the foot writes. On With the agent and Processed it is a
 * follow-up, which the operator ruled a linked ask for now.
 */
export type Composer =
  | { readonly _tag: 'Empty' }
  | { readonly _tag: 'Picking' }
  | { readonly _tag: 'Asking'; readonly inboxId: InboxId }
  | { readonly _tag: 'Answer'; readonly item: InboxItem }
  // Typing stays on and sending is off: the question's machine has folded.
  | { readonly _tag: 'Held'; readonly item: InboxItem }
  // On its way, so there is nothing yet to follow up.
  | { readonly _tag: 'Sending'; readonly item: SendingRow }
  // `held` as above: typing stays on and sending is off.
  | {
      readonly _tag: 'FollowUp';
      readonly item: AgentItem | ProcessedItem;
      readonly held: boolean;
    };

export const composerOf = (snapshot: ReaderSnapshot): Composer => {
  const { context } = snapshot;
  if (snapshot.matches({ composer: 'asking' }))
    return context.askTo === undefined
      ? { _tag: 'Picking' }
      : { _tag: 'Asking', inboxId: context.askTo };
  const active = activeQueueOf(snapshot);
  const queues = readerQueuesOf(context);
  const focus = context.focus[active];
  if (active === 'inbox') {
    const item = queues.inbox.find((i) => i.key === focus);
    if (item === undefined) return { _tag: 'Empty' };
    return item.key === context.held?.item.key
      ? { _tag: 'Held', item }
      : { _tag: 'Answer', item };
  }
  const item = queues[active].find((i) => i.key === focus);
  if (item === undefined) return { _tag: 'Empty' };
  return 'sending' in item
    ? { _tag: 'Sending', item }
    : { _tag: 'FollowUp', item, held: item.key === context.held?.item.key };
};

/** The row the ask list's cursor is on: the one the reader put it on, else the top. */
export const askCursorOf = <C extends { readonly inboxId: InboxId }>(
  choices: ReadonlyArray<C>,
  cursor: InboxId | undefined,
): C | undefined => choices.find((c) => c.inboxId === cursor) ?? choices[0];

// --- the binding ----------------------------------------------------------------

/**
 * The machine as Atoms. The actor lives while something reads them and dies
 * 400 ms after the last reader goes, so the page holds it at its root with
 * `useAtomMount`. An event sent before the actor is ready is dropped.
 */
export const inboxReaderAtoms = createActorAtoms(
  Atom.runtime(Layer.empty),
  readerMachine,
);
