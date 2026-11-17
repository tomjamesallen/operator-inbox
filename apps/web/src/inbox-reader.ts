import {
  type Attachment,
  DEFAULT_CHASE_AFTER_MINUTES,
  DEFAULT_DIAGRAM_SIZE,
  DEFAULT_INBOX_METADATA,
  DEFAULT_PRIORITY_PULL,
  DEFAULT_SEND_KEY,
  DEFAULT_WIDE_BLOCKS,
  DiagramSize,
  type InboxId,
  type InboxMachineKey,
  type InboxMetadataRules,
  type InboxViewDto,
  type MacroInvoked,
  type PriorityPull,
  type QuestionComment,
  SendKey,
  WideBlocks,
} from '@operator-inbox/core/api';
import { Effect, Exit, Option } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import {
  clearSentFiles,
  type PendingFile,
  pendingFilesAtom,
  uploadsOf,
} from './attachments';
import { cardRemovalsAtom } from './card-undo';
import { clockAtom, nowMillis } from './clock';
import {
  type Anchor,
  commentsAtom,
  commentsToSend,
  startCommentAtom,
} from './comments';
import {
  drawingConflicts,
  drawingDraftAtom,
  drawingKey,
  drawingsToSend,
  questionDrawingDraftsAtom,
} from './drawings';
import {
  failureText,
  isUnconfirmed,
  refusalText,
  type WriteRefusedTag,
} from './failure';
import {
  addStrayWrite,
  answerKey,
  answerLabel,
  askableInboxesOf,
  askDraftAtom,
  askMatches,
  askQueryAtom,
  askStartOf,
  type DrawnBoard,
  deferralText,
  drawnBoardAtom,
  followUpDraftAtom,
  inboxBoardAtom,
  isUnreadMachine,
  linkTargetAtom,
  machineSectionsOf,
  questionPath,
  responseDraftAtom,
  screenStateAtom,
  selectedInboxAtom,
  sendWrite,
  sidebarPinnedOnlyAtom,
  viewsShown,
  withdrawalReason,
  writeTargetHash,
} from './inbox';
import {
  askedTextOf,
  type FreshMark,
  followUpText,
  freshAt,
  type InboxItem,
  type QueueName,
  queuesOf,
  type SeenFold,
  SPENT_FADE_MS,
  seenAfter,
  spentAfter,
} from './inbox-queues';
import {
  type AnswerTrouble,
  activeQueueOf,
  askCursorOf,
  type Composer,
  composerOf,
  inboxReaderAtoms,
  litOf,
  type ReaderContext,
  type ReaderQueues,
  type ReaderSnapshot,
  readerQueuesOf,
} from './inbox-reader-machine';
import {
  askCardsKeyOf,
  askMacroFocusAtom,
  firstMissingOf,
  macroCardsAtom,
  macroHeldAtom,
  macrosToSend,
  missingKeyOf,
  withCards,
} from './macros';

// The zen inbox reader's Atoms: what joins the board, the machine and the
// writes. The board and the drafts live in `inbox.ts`, the flow in the machine;
// here the board reaches the machine, the machine reaches the components, and
// a write tells the machine how it ended.

export type ReaderItem = ReaderQueues[QueueName][number];

// --- reading the machine --------------------------------------------------------

/** The machine's snapshot, undefined until the actor is running. */
export const readerSnapshotAtom = Atom.make((get) =>
  Option.getOrUndefined(AsyncResult.value(get(inboxReaderAtoms.snapshot))),
);

const fromSnapshot = <A>(pick: (s: ReaderSnapshot) => A, none: A) =>
  Atom.make((get): A => {
    const snapshot = get(readerSnapshotAtom);
    return snapshot === undefined ? none : pick(snapshot);
  });

export const activeQueueAtom = fromSnapshot<QueueName>(activeQueueOf, 'inbox');
export const litKeyAtom = fromSnapshot<string | undefined>(
  (s) => litOf(s)?.key,
  undefined,
);
export const composerAtom = fromSnapshot<Composer>(composerOf, {
  _tag: 'Empty',
});
export const askingAtom = fromSnapshot(
  (s) => s.matches({ composer: 'asking' }),
  false,
);
// A scrub places each question it passes, so it holds as a placement does.
export const placingAtom = fromSnapshot((s) => {
  const { scroll } = s.value as { readonly scroll: string };
  return scroll === 'placing' || scroll === 'scrubbing';
}, false);
/** A finger is dragging down the minimap. */
export const scrubbingAtom = fromSnapshot(
  (s) => s.matches({ scroll: 'scrubbing' }),
  false,
);
export const jumpAtom = fromSnapshot<ReaderContext['jump']>(
  (s) => s.context.jump,
  undefined,
);
export const troublesAtom = fromSnapshot<ReadonlyArray<AnswerTrouble>>(
  (s) => s.context.troubles,
  [],
);
export const heldKeyAtom = fromSnapshot<string | undefined>(
  (s) => s.context.held?.item.key,
  undefined,
);

export type RailState = 'shut' | 'peeking' | 'drawer' | 'docked';

export const railStateAtom = fromSnapshot<RailState>(
  (s) => (s.value as { readonly rail: RailState }).rail,
  'shut',
);

/** The sidebar over the page: the tabs give way to the long wordmark. */
export const railRaisedAtom = Atom.make((get) => {
  const rail = get(railStateAtom);
  return rail === 'peeking' || rail === 'drawer';
});

/** The Inbox whose row is being renamed. */
export const renamingAtom = fromSnapshot<InboxId | undefined>(
  (s) => s.context.renaming,
  undefined,
);

const NO_ITEMS: ReaderQueues = { inbox: [], agent: [], processed: [] };

interface QueuesMemo {
  readonly from: Pick<ReaderContext, 'queues' | 'sends' | 'held'>;
  readonly shown: ReaderQueues;
}

// A scroll is a new snapshot and rarely new queues, so what is drawn from them
// keeps its identity while they do.
const queuesMemoAtom = Atom.make((get): QueuesMemo | undefined => {
  const context = get(readerSnapshotAtom)?.context;
  if (context === undefined) return undefined;
  const was = Option.getOrUndefined(get.self<QueuesMemo | undefined>());
  return was !== undefined &&
    was.from.queues === context.queues &&
    was.from.sends === context.sends &&
    was.from.held === context.held
    ? was
    : { from: context, shown: readerQueuesOf(context) };
});

export const shownQueuesAtom = Atom.make(
  (get): ReaderQueues => get(queuesMemoAtom)?.shown ?? NO_ITEMS,
);

// --- the board reaches the machine ----------------------------------------------

/** What identifies a view: a change of it is not a question folding. */
export const viewKeyOf = (
  selected: InboxId | undefined,
  filter: ReadonlyArray<InboxId>,
  groups: ReadonlyArray<string>,
  onlyPinned: boolean,
): string => JSON.stringify([selected ?? null, filter, groups, onlyPinned]);

/** Machines gone from the board past their one greyed read. */
export const foldedOf = (board: DrawnBoard): ReadonlyArray<InboxMachineKey> =>
  machineSectionsOf(board)
    .filter((m) => isUnreadMachine(m) && !board.greyed.has(m.key))
    .map((m) => m.key);

const readAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  if (board === undefined) return undefined;
  const selected = get(selectedInboxAtom);
  const { inboxes, groups } = get(screenStateAtom);
  const onlyPinned = get(sidebarPinnedOnlyAtom);
  return {
    view: viewKeyOf(selected, inboxes, groups, onlyPinned),
    queues: queuesOf(viewsShown(board, selected, inboxes, groups, onlyPinned)),
    folded: foldedOf(board),
    waiting: board.views.flatMap((v) =>
      v.awaitingOperator.map((q) => answerKey(v.inboxId, q.number)),
    ),
  };
});

/**
 * Hands every read to the machine. Mounted at the reader's root, and it waits
 * for the actor, since an event sent before the runtime is ready is dropped.
 */
export const readerFeedAtom: Atom.Atom<void> = Atom.readable((get) => {
  const actor = get(inboxReaderAtoms.actor);
  if (!AsyncResult.isSuccess(actor)) return;
  const read = get(readAtom);
  if (read !== undefined) actor.value.send({ type: 'ItemsChanged', ...read });
});

/** A link's question: it is brought up once, and stays marked until cleared. */
export const linkKeyAtom = Atom.make((get): string | undefined => {
  const { target } = get(linkTargetAtom);
  return target === undefined
    ? undefined
    : answerKey(target.inboxId, target.number);
});

export const readerLinkAtom: Atom.Atom<void> = Atom.readable((get) => {
  const actor = get(inboxReaderAtoms.actor);
  if (!AsyncResult.isSuccess(actor)) return;
  const { target, scrolled } = get(linkTargetAtom);
  const key = get(linkKeyAtom);
  if (target === undefined || key === undefined || scrolled) return;
  actor.value.send({ type: 'MovedTo', key });
  get.set(linkTargetAtom, { target, scrolled: true });
});

// --- the first load -------------------------------------------------------------

/** How long the full wordmark holds once the first read is back. */
export const INTRO_HOLD_MS = 900;

/**
 * True until the first read has been back for `INTRO_HOLD_MS`, so a fast load
 * does not skip the wordmark. A failed read ends it too: what failed must show.
 */
export const readerIntroAtom: Atom.Atom<boolean> = Atom.readable((get) => {
  if (Option.getOrUndefined(get.self<boolean>()) === false) return false;
  if (AsyncResult.isInitial(get(inboxBoardAtom))) return true;
  const hold = setTimeout(() => get.setSelf(false), INTRO_HOLD_MS);
  get.addFinalizer(() => clearTimeout(hold));
  return true;
}).pipe(Atom.keepAlive);

// --- how much of a question shows ------------------------------------------------

// An unfocused question shows by how much of it is in the reading area, in parts
// of the viewport's height: nothing under FADE_FROM_VH, a slow rise to
// SLOW_OPACITY at SLOW_TO_VH, then up to SHOWN_OPACITY at FADE_TO_VH.
const FADE_FROM_VH = 0.15;
const SLOW_TO_VH = 0.3;
const FADE_TO_VH = 0.5;
const SLOW_OPACITY = 0.25;
export const SHOWN_OPACITY = 0.75;

/**
 * An unfocused question's opacity. `visible` and `height` are the question's, in
 * pixels; `area` the height of the reading area, under the header and above the
 * answer; `vh` the viewport's. A question wholly in view, or filling the area,
 * can show no more, so it is fully shown however short.
 */
export const dimmedOpacity = ({
  visible,
  height,
  area,
  vh,
}: {
  readonly visible: number;
  readonly height: number;
  readonly area: number;
  readonly vh: number;
}): number => {
  if (visible >= Math.min(height, area) - 1) return SHOWN_OPACITY;
  const from = vh * FADE_FROM_VH;
  const knee = vh * SLOW_TO_VH;
  const to = vh * FADE_TO_VH;
  if (visible <= from) return 0;
  if (visible <= knee) return (SLOW_OPACITY * (visible - from)) / (knee - from);
  const rise = Math.min(1, (visible - knee) / (to - knee));
  return SLOW_OPACITY + (SHOWN_OPACITY - SLOW_OPACITY) * rise;
};

// Every fade runs on one spring: following a scroll and the focus changing hands
// alike. A spring keeps its speed when its target moves, where a transition
// starts again. A little under critical damping, about 0.7s to settle.
const SPRING_STIFFNESS = 60;
const SPRING_DAMPING = 14;
/** The longest step a frame may take, so a stalled frame cannot throw it. */
export const SPRING_MAX_STEP_S = 0.05;

export interface Spring {
  readonly value: number;
  readonly velocity: number;
}

/** The spring after `dt` seconds of chasing `target`. */
export const springStep = (s: Spring, target: number, dt: number): Spring => {
  const pull = SPRING_STIFFNESS * (target - s.value);
  const velocity = s.velocity + (pull - SPRING_DAMPING * s.velocity) * dt;
  return { value: s.value + velocity * dt, velocity };
};

export const springSettled = (s: Spring, target: number): boolean =>
  Math.abs(target - s.value) < 0.002 && Math.abs(s.velocity) < 0.01;

// --- what is new ----------------------------------------------------------------

const seenFoldAtom = Atom.make((get): SeenFold | undefined => {
  const previous = Option.getOrUndefined(get.self<SeenFold | undefined>());
  const board = get(drawnBoardAtom);
  if (board === undefined) return previous;
  const answered = machineSectionsOf(board)
    .filter((m) => !isUnreadMachine(m))
    .map((m) => m.key);
  return seenAfter(previous, board.views, answered, nowMillis(get(clockAtom)));
}).pipe(Atom.keepAlive);

const NOT_SPENT: ReadonlyMap<string, number> = new Map();

// An answer on its way counts as gone, so the dot goes with the press and not
// with the read after it lands.
const spentMarksAtom = Atom.make((get): ReadonlyMap<string, number> => {
  const previous = Option.getOrElse(
    get.self<ReadonlyMap<string, number>>(),
    () => NOT_SPENT,
  );
  const seen = get(seenFoldAtom);
  const board = get(drawnBoardAtom);
  if (seen === undefined || board === undefined) return previous;
  const sends = get(queuesMemoAtom)?.from.sends ?? [];
  const sending = new Set(sends.map((s) => s.item.key));
  const waiting = board.views
    .flatMap((v) =>
      v.awaitingOperator.map((q) => answerKey(v.inboxId, q.number)),
    )
    .filter((key) => !sending.has(key));
  return spentAfter(
    previous,
    seen.fresh,
    new Set(waiting),
    nowMillis(get(clockAtom)),
  );
}).pipe(Atom.keepAlive);

/** The dots still lit, read again with each board and each send. */
export const freshMarksAtom = Atom.make((get): ReadonlyArray<FreshMark> => {
  const seen = get(seenFoldAtom);
  if (seen === undefined) return [];
  const now = nowMillis(get(clockAtom));
  const spent = get(spentMarksAtom);
  return freshAt(seen, now).flatMap((f) => {
    const since = spent.get(f.key);
    if (since === undefined) return [f];
    return now - since < SPENT_FADE_MS ? [{ ...f, spent: true as const }] : [];
  });
});

// --- the metadata rules ---------------------------------------------------------

const inboxConfigAtom = InboxClient.query('inboxConfig', 'read', {});

/** The rules in force. Unreadable, the defaults show and the page says why. */
export const metadataRulesAtom = Atom.make(
  (get): InboxMetadataRules =>
    Option.match(AsyncResult.value(get(inboxConfigAtom)), {
      onNone: () => DEFAULT_INBOX_METADATA,
      onSome: (config) => config.metadata,
    }),
);

/**
 * How long a question may sit with the agent before it needs chasing, in
 * milliseconds: config.json's `chaseAfterMinutes`, or the default until the
 * config is read, or when it cannot be.
 */
export const chaseAfterMsAtom = Atom.make(
  (get): number =>
    Option.match(AsyncResult.value(get(inboxConfigAtom)), {
      onNone: () => DEFAULT_CHASE_AFTER_MINUTES,
      onSome: (config) =>
        config.chaseAfterMinutes ?? DEFAULT_CHASE_AFTER_MINUTES,
    }) * 60_000,
);

/**
 * How the page pulls the operator back to the priority Inbox: config.json's
 * `priorityPull`, or the default (`interjection`) until the config is read,
 * or when it cannot be.
 */
export const priorityPullAtom = Atom.make(
  (get): PriorityPull =>
    Option.match(AsyncResult.value(get(inboxConfigAtom)), {
      onNone: () => DEFAULT_PRIORITY_PULL,
      onSome: (config) => config.priorityPull ?? DEFAULT_PRIORITY_PULL,
    }),
);

// The diagram size last read, kept in this browser's localStorage, so a
// reload sizes each picture by it from the first render, before config.json
// is read again: a picture's box, reserved before it is drawn, is what keeps
// the reader's place (`PictureFrame`). Where localStorage cannot be read, the
// default stands in until the config arrives.
const rememberedDiagramSizeAtom = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: 'operator-inbox:diagram-size',
  schema: DiagramSize,
  defaultValue: (): DiagramSize => DEFAULT_DIAGRAM_SIZE,
}).pipe(Atom.keepAlive);

/**
 * How a picture in a question's body is sized (`pictureFrameStyle`):
 * config.json's `diagramSize`, or `box` when it is unset. Until the config is
 * read, or when it cannot be, the one last read in this browser.
 */
export const diagramSizeAtom = Atom.make((get): DiagramSize => {
  const remembered = get(rememberedDiagramSizeAtom);
  return Option.match(AsyncResult.value(get(inboxConfigAtom)), {
    onNone: () => remembered,
    onSome: (config) => {
      const size = config.diagramSize ?? DEFAULT_DIAGRAM_SIZE;
      if (size !== remembered) get.set(rememberedDiagramSizeAtom, size);
      return size;
    },
  });
}).pipe(Atom.keepAlive);

// How wide blocks widen, as last read, kept in this browser's localStorage as
// the diagram size is, so a reload places each table and picture by it from
// the first render, rather than moving them sideways when config.json is
// read again.
const rememberedWideBlocksAtom = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: 'operator-inbox:wide-blocks',
  schema: WideBlocks,
  defaultValue: (): WideBlocks => DEFAULT_WIDE_BLOCKS,
}).pipe(Atom.keepAlive);

/**
 * How a table or a picture wider than the text column widens in the reader
 * (`data-wide-blocks`, `index.css`): config.json's `wideBlocks`, or `both`
 * when it is unset. Until the config is read, or when it cannot be, the one
 * last read in this browser.
 */
export const wideBlocksAtom = Atom.make((get): WideBlocks => {
  const remembered = get(rememberedWideBlocksAtom);
  return Option.match(AsyncResult.value(get(inboxConfigAtom)), {
    onNone: () => remembered,
    onSome: (config) => {
      const wide = config.wideBlocks ?? DEFAULT_WIDE_BLOCKS;
      if (wide !== remembered) get.set(rememberedWideBlocksAtom, wide);
      return wide;
    },
  });
}).pipe(Atom.keepAlive);

// The send key last read, kept in this browser's localStorage as the wide
// blocks are, so Enter pressed in the first moments after a reload does what
// it did before it, rather than what the default does until config.json is
// read again.
const rememberedSendKeyAtom = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: 'operator-inbox:send-key',
  schema: SendKey,
  defaultValue: (): SendKey => DEFAULT_SEND_KEY,
}).pipe(Atom.keepAlive);

/**
 * Which key sends from the answer, follow-up and ask boxes: config.json's
 * `sendKey`, or `mod+enter` (Send's keybinding sends, Enter is a new line)
 * when it is unset. Until the config is read, or when it cannot be, the one
 * last read in this browser.
 */
export const sendKeyAtom = Atom.make((get): SendKey => {
  const remembered = get(rememberedSendKeyAtom);
  return Option.match(AsyncResult.value(get(inboxConfigAtom)), {
    onNone: () => remembered,
    onSome: (config) => {
      const key = config.sendKey ?? DEFAULT_SEND_KEY;
      if (key !== remembered) get.set(rememberedSendKeyAtom, key);
      return key;
    },
  });
}).pipe(Atom.keepAlive);

/** Why the rules could not be read, for the sidebar's notes. */
export const metadataRulesFailureAtom = Atom.make((get): string | undefined => {
  const result = get(inboxConfigAtom);
  return AsyncResult.isFailure(result)
    ? failureText(result.cause).message
    : undefined;
});

/** Counts each ask for the caret in the box, which the box watches for. */
export const boxFocusAskedAtom = Atom.make(0).pipe(Atom.keepAlive);

/** Counts each step of the list a key asks for, which the list watches for. */
export const flowStepAskedAtom = Atom.make<{
  readonly id: number;
  readonly by: 1 | -1;
}>({ id: 0, by: 1 }).pipe(Atom.keepAlive);

/**
 * The room at each end of the list, as last measured, and the foot's height,
 * which an empty queue keeps its stand-in clear of.
 */
export const flowEndsAtom = Atom.make<
  | { readonly lead: number; readonly trail: number; readonly foot: number }
  | undefined
>(undefined);

/** Whether the metadata card is up, over the lit question. */
export const colophonOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

// The Inbox whose metadata card a sidebar row's menu has open.
export const inboxMetaCardAtom = Atom.make<InboxId | undefined>(undefined).pipe(
  Atom.keepAlive,
);

// --- what a question says -------------------------------------------------------

export const isSending = (
  item: ReaderItem,
): item is Extract<ReaderItem, { readonly sending: unknown }> =>
  'sending' in item;

/** The operator put it to the agent, so its text is its `response`. */
export const isAsked = (q: ReaderItem['question']): boolean =>
  'operatorQuestion' in q && q.operatorQuestion === true;

interface Head {
  readonly title: string;
  // Over an operator's own question, which is its own title.
  readonly caption?: string;
  // The question this one follows up.
  readonly followsUp?: string;
}

/** A question's heading. An operator's own question heads itself. */
export const headOf = (item: ReaderItem): Head => {
  const q = item.question;
  if (isAsked(q) && 'response' in q) {
    const { text, followsUp } = askedTextOf(q.response ?? '');
    return {
      // A question of macros alone has no text: its title names them.
      title: text.trim() === '' ? q.title : text,
      caption: answerLabel(false, true),
      ...(followsUp === undefined
        ? {}
        : { followsUp: answerKey(item.inboxId, followsUp) }),
    };
  }
  return {
    title: q.title === '' && 'response' in q ? (q.response ?? '') : q.title,
  };
};

export interface Answer {
  readonly label: string;
  readonly text: string;
  // The macros the operator invoked with it, in order.
  readonly macros: ReadonlyArray<MacroInvoked>;
  // The operator's comments on the Question's text, in body order.
  readonly comments: ReadonlyArray<QuestionComment>;
  // The files the operator attached to it, in the order they added them.
  readonly attachments: ReadonlyArray<Attachment>;
}

/** What was said to a question, under its body. */
export const answerOf = (item: ReaderItem): Answer | undefined => {
  if (isSending(item)) {
    const { deferred, response, macros, comments } = item.sending;
    return {
      label: answerLabel(false, false, deferred),
      text: macroText(deferred, response, [...macros, ...comments]),
      macros,
      comments,
      attachments: [],
    };
  }
  const q = item.question;
  if (isAsked(q)) return undefined;
  if ('withdrawn' in q && q.withdrawn)
    return {
      label: answerLabel(true, false),
      text: withdrawalReason(q.reason),
      macros: [],
      comments: [],
      attachments: [],
    };
  if (!('response' in q) || q.response === undefined) return undefined;
  const deferred = q.deferred === true;
  const macros = 'macros' in q ? (q.macros ?? []) : [];
  const comments = 'comments' in q ? (q.comments ?? []) : [];
  const attachments = attachmentsOf(q);
  return {
    label: answerLabel(false, false, deferred),
    text: macroText(deferred, q.response, [
      ...macros,
      ...comments,
      ...attachments,
    ]),
    macros,
    comments,
    attachments,
  };
};

// An answer of macros or comments alone has no text to show, and a
// deferral's "no note" line is not wanted when they say what to do.
const macroText = (
  deferred: boolean,
  response: string,
  carried: ReadonlyArray<unknown>,
): string =>
  deferred && !(carried.length > 0 && response.trim() === '')
    ? deferralText(response)
    : response;

/** The macros an operator's own question carries, in order. */
export const askedMacrosOf = (
  q: ReaderItem['question'],
): ReadonlyArray<MacroInvoked> =>
  isAsked(q) && 'macros' in q ? (q.macros ?? []) : [];

/** The files a question's answer carries, or an operator's question itself. */
export const attachmentsOf = (
  q: ReaderItem['question'],
): ReadonlyArray<Attachment> =>
  'attachments' in q ? (q.attachments ?? []) : [];

/** The files the agent attached to its question, shown under its body. */
export const askedAttachmentsOf = (
  q: ReaderItem['question'],
): ReadonlyArray<Attachment> =>
  'askedAttachments' in q ? (q.askedAttachments ?? []) : [];

export interface FollowUp {
  readonly key: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
}

/** The operator's follow-ups to `item`, oldest first. */
export const followUpsOf = (
  queues: ReaderQueues,
  item: ReaderItem,
): ReadonlyArray<FollowUp> =>
  [...queues.processed, ...queues.agent]
    .flatMap((candidate) => {
      if (candidate.inboxId !== item.inboxId || isSending(candidate)) return [];
      const q = candidate.question;
      if (!isAsked(q) || q.response === undefined) return [];
      const { text, followsUp } = askedTextOf(q.response);
      return followsUp === item.question.number
        ? [
            {
              key: candidate.key,
              text,
              number: q.number,
              attachments: attachmentsOf(q),
            },
          ]
        : [];
    })
    .sort((a, b) => a.number - b.number)
    .map(({ key, text, attachments }) => ({ key, text, attachments }));

// --- the drawings the box waits on ----------------------------------------------

/**
 * The drawings of the question in the answer box whose draft the agent's
 * change has overtaken, by id. While there are any, the box sends nothing,
 * answer or deferral, and its foot note says why: an answer never carries a
 * scene drawn on a drawing the agent has since changed, as it never carries a
 * reply to a question changed since it was read (`seenRevision`).
 */
export const answerDrawingConflictsAtom = Atom.make(
  (get): ReadonlyArray<string> => {
    const composer = get(composerAtom);
    if (composer._tag !== 'Answer' && composer._tag !== 'Held') return [];
    const { item } = composer;
    return drawingConflicts(
      get(questionDrawingDraftsAtom(item.key)),
      item.question,
    );
  },
);

/** What the foot note says while drawings wait on the operator's choice. */
export const drawingConflictText = (ids: ReadonlyArray<string>): string =>
  `The agent changed ${ids.length === 1 ? 'the drawing' : 'the drawings'} ${ids.map((id) => `“${id}”`).join(', ')} since you edited ${ids.length === 1 ? 'it' : 'them'}: choose Keep mine or Take theirs before you send.`;

// --- the foot note --------------------------------------------------------------

export type FootTone = 'red' | 'orange' | 'quiet';

export interface FootNote {
  readonly tone: FootTone;
  readonly text: string;
}

export interface MachineWords {
  readonly greyed: ReadonlySet<InboxMachineKey>;
  readonly labelOf: (key: InboxMachineKey) => string;
  // More than one machine, so "Sending…" can say where.
  readonly machined: boolean;
}

// An ask or a follow-up on its way. An ask lands by moving to its question, so
// only a follow-up, whose box stays, has a `sent` to say.
export type AskProgress = 'sending' | 'sent' | undefined;

/**
 * The one line over the box, only when an answer may not do what it looks like
 * it will, or to say a write is on its way. `askMachine` is the machine of the
 * Inbox being asked in, and `progress` the write of the box on screen.
 */
export const footNoteOf = (
  composer: Composer,
  troubles: ReadonlyArray<AnswerTrouble>,
  words: MachineWords,
  askMachine: InboxMachineKey | undefined,
  progress: AskProgress = undefined,
  // The drawings the box waits on (`answerDrawingConflictsAtom`).
  drawingConflicts: ReadonlyArray<string> = [],
): FootNote | undefined => {
  const missed = (machine: InboxMachineKey, what: string) =>
    words.greyed.has(machine)
      ? ({
          tone: 'orange',
          text: `${words.labelOf(machine)} missed the last read: ${what}`,
        } as const)
      : undefined;
  const cannotReach = (machine: InboxMachineKey): FootNote => ({
    tone: 'red',
    text: `${words.labelOf(machine)} cannot be reached. Your draft is kept for when it is back.`,
  });
  const sendingTo = (machine: InboxMachineKey | undefined): FootNote => ({
    tone: 'quiet',
    text:
      words.machined && machine !== undefined
        ? `Sending to ${words.labelOf(machine)}…`
        : 'Sending…',
  });
  switch (composer._tag) {
    case 'Asking':
      if (progress === 'sending') return sendingTo(askMachine);
      return askMachine === undefined
        ? undefined
        : missed(askMachine, 'this may not reach it.');
    case 'Answer':
    case 'Held': {
      const { item } = composer;
      const trouble = troubles.find((t) => t.key === item.key);
      if (trouble !== undefined) return { tone: 'red', text: trouble.text };
      if (drawingConflicts.length > 0)
        return { tone: 'orange', text: drawingConflictText(drawingConflicts) };
      return composer._tag === 'Held'
        ? cannotReach(item.machine)
        : missed(item.machine, 'a send may not reach it.');
    }
    case 'Sending': {
      const { item } = composer;
      if (item.sending.landed) return { tone: 'quiet', text: 'Sent' };
      return sendingTo(item.machine);
    }
    case 'FollowUp': {
      const { item, held } = composer;
      if (held) return cannotReach(item.machine);
      if (progress === 'sending') return sendingTo(item.machine);
      if (progress === 'sent') return { tone: 'quiet', text: 'Sent' };
      return missed(item.machine, 'this may not reach it.');
    }
    default:
      return undefined;
  }
};

// --- the writes -----------------------------------------------------------------

const troubleTagOf = (
  failure: ReturnType<typeof failureText>,
  refused: WriteRefusedTag,
): AnswerTrouble['tag'] =>
  isUnconfirmed(failure) || failure.kind === 'mismatch'
    ? 'uncertain'
    : failure.tag === refused
      ? 'refused'
      : 'unsent';

interface AnswerWrite {
  readonly item: InboxItem;
  readonly response: string;
  readonly deferred: boolean;
  readonly highlightReply: boolean;
  // The drawings the operator changed, by id, each the whole edited scene.
  readonly drawings: Readonly<Record<string, string>> | undefined;
  // The macros the operator invoked, in order.
  readonly macros: ReadonlyArray<MacroInvoked>;
  // The operator's written comments, in body order.
  readonly comments: ReadonlyArray<QuestionComment>;
  // The files the operator attached, in the order they added them.
  readonly files: ReadonlyArray<PendingFile>;
}

// --- highlight your reply ---------------------------------------------------------

const isNonEmpty = <A>(as: ReadonlyArray<A>): as is readonly [A, ...Array<A>] =>
  as.length > 0;

/** The box's place for its "Highlight reply" switch: one per box that sends to an agent. */
export const highlightPlaceOf = (composer: Composer): string | undefined => {
  switch (composer._tag) {
    case 'Answer':
    case 'Held':
      return answerPlaceOf(composer.item.key);
    case 'Asking':
      return askPlaceOf(composer.inboxId);
    case 'FollowUp':
      return followUpPlaceOf(composer.item.key);
    default:
      return undefined;
  }
};

export const answerPlaceOf = (key: string): string => `answer:${key}`;

/**
 * Whether the box at `place` asks the agent to highlight the Question it asks
 * in reply. Kept in memory only, by box, as a draft is: moving to another
 * question leaves this one's switch as it was. One-shot: a send that lands
 * turns it off, and a send that fails leaves it on for the retry.
 */
export const highlightReplyAtom = Atom.family((_place: string) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

/** Flip the switch of the box on screen; false when no box sends to an agent. */
export const toggleHighlightReplyAtom = Atom.writable<void, void>(
  () => undefined,
  (ctx) => {
    const snapshot = ctx.get(readerSnapshotAtom);
    const place =
      snapshot === undefined
        ? undefined
        : highlightPlaceOf(composerOf(snapshot));
    if (place === undefined) return;
    ctx.set(highlightReplyAtom(place), !ctx.get(highlightReplyAtom(place)));
  },
);

// One per question, and kept alive: the answer's place leaves the page the
// moment it is sent, and a write whose Atom drops is filed a stray
// by `sendWrite` even while its question is on the board. This one decides for
// itself: a failure the question can still say goes to the machine, and only
// one with nowhere to be said is a stray.
const answerWriteAtom = Atom.family((key: string) =>
  InboxClient.runtime
    .fn(
      Effect.fnUntraced(function* (req: AnswerWrite, get: Atom.FnContext) {
        const client = yield* InboxClient;
        const { registry } = get;
        const { inboxId, question } = req.item;
        const what = `Your ${req.deferred ? 'deferral' : 'answer'} to #${question.number}`;
        const attachments = yield* uploadsOf(req.files);
        const exit = yield* Effect.exit(
          sendWrite(
            get,
            {
              inboxId,
              what: (label) => `${what} in ${label}`,
              notDone: 'Not sent',
              refused: 'AnswerRefused',
            },
            client.inbox.answer({
              query: {},
              params: { inboxId, number: question.number },
              payload: {
                response: req.response,
                seenRevision: question.revision,
                ...(req.deferred ? { deferred: true as const } : {}),
                ...(req.highlightReply
                  ? { highlightReply: true as const }
                  : {}),
                ...(req.drawings === undefined
                  ? {}
                  : { drawings: req.drawings }),
                ...(isNonEmpty(req.macros) ? { macros: req.macros } : {}),
                ...(isNonEmpty(req.comments) ? { comments: req.comments } : {}),
                ...(isNonEmpty(attachments) ? { attachments } : {}),
              },
            }),
            () => {
              // And the files; a failed send keeps them.
              clearSentFiles(registry, answerPlaceOf(key), req.files);
              // The drawings went with it; a failed send keeps them.
              for (const id of Object.keys(req.drawings ?? {}))
                registry.set(drawingDraftAtom(drawingKey(key, id)), undefined);
              registry.set(responseDraftAtom(key), {
                inboxId,
                number: question.number,
                text: '',
              });
              registry.set(highlightReplyAtom(answerPlaceOf(key)), false);
              // The macros went with it too; a failed send keeps their cards.
              registry.set(macroCardsAtom(key), {
                inboxId,
                number: question.number,
                cards: [],
              });
              registry.set(macroHeldAtom(key), undefined);
              // And the comments; a failed send keeps them too.
              registry.set(commentsAtom(key), []);
              // Nothing removed from it can come back now.
              registry.set(cardRemovalsAtom(key), []);
              const { target } = registry.get(linkTargetAtom);
              if (
                target?.inboxId === inboxId &&
                target.number === question.number
              ) {
                registry.set(linkTargetAtom, {
                  target: undefined,
                  scrolled: true,
                });
                writeTargetHash(undefined);
              }
              registry.set(inboxReaderAtoms.send, {
                type: 'AnswerLanded',
                key,
              });
              registry.refresh(inboxBoardAtom);
            },
          ),
        );
        if (Exit.isFailure(exit)) {
          const failure = failureText(exit.cause);
          const text = refusalText(
            'Not sent',
            failure,
            inboxId,
            'AnswerRefused',
          );
          const context = registry.get(readerSnapshotAtom)?.context;
          const here =
            context?.queues.inbox.some((i) => i.key === key) === true ||
            context?.folded.includes(req.item.machine) === true;
          if (!here)
            addStrayWrite(
              registry,
              `${what} in ${req.item.inboxLabel} — ${text}`,
            );
          registry.set(inboxReaderAtoms.send, {
            type: 'AnswerFailed',
            key,
            tag: troubleTagOf(failure, 'AnswerRefused'),
            text,
          });
        }
        return yield* exit;
      }),
    )
    .pipe(Atom.keepAlive),
);

interface AskWrite {
  readonly inboxId: InboxId;
  readonly text: string;
  // The box's text as sent: more typed after Send is the reader's to keep.
  readonly draft: string;
  // The question it follows up, by key, else a plain ask.
  readonly followUp?: string;
  // The agent is to highlight the Question it asks in reply.
  readonly highlightReply: boolean;
  // The files the operator attached, in the order they added them.
  readonly files: ReadonlyArray<PendingFile>;
  // The macros the operator invoked, in order: a plain ask's only.
  readonly macros?: ReadonlyArray<MacroInvoked>;
}

/** The question just asked in `view`: the agent's newest of the operator's. */
export const askedKeyOf = (view: InboxViewDto): string | undefined => {
  const asked = view.awaitingAgent
    .filter((q) => q.operatorQuestion === true)
    .sort((a, b) => b.answeredSeq - a.answeredSeq)[0];
  return asked === undefined
    ? undefined
    : answerKey(view.inboxId, asked.number);
};

// The ask box's place is its cards' key too (`askCardsKeyOf`).
export const askPlaceOf = (inboxId: InboxId): string => askCardsKeyOf(inboxId);
export const followUpPlaceOf = (key: string): string => `follow:${key}`;

export const placeOf = (composer: Composer): string | undefined => {
  switch (composer._tag) {
    case 'Asking':
      return askPlaceOf(composer.inboxId);
    case 'FollowUp':
      return followUpPlaceOf(composer.item.key);
    default:
      return undefined;
  }
};

/**
 * An ask or a follow-up, one Atom per place: `ask:<inboxId>` or
 * `follow:<question key>`. Kept alive, as an answer's is: the box goes with any
 * move of the lit question, and a dropped Atom would lose both the failure and
 * the guard against sending the same draft twice. While the box is on screen it
 * says a failure from this Atom; if it has gone, the failure is a stray too.
 */
export const readerAskAtom = Atom.family((place: string) =>
  InboxClient.runtime
    .fn(
      Effect.fnUntraced(function* (req: AskWrite, get: Atom.FnContext) {
        const client = yield* InboxClient;
        const { registry } = get;
        const { inboxId, followUp, draft } = req;
        const attachments = yield* uploadsOf(req.files);
        const view = yield* sendWrite(
          get,
          {
            inboxId,
            what: (label) =>
              followUp === undefined
                ? `Your question to the agent in ${label}`
                : `Your follow-up in ${label}`,
            notDone: 'Not sent',
            refused: 'AskRefused',
            placeless: () => {
              const snapshot = registry.get(readerSnapshotAtom);
              return (
                snapshot === undefined ||
                placeOf(composerOf(snapshot)) !== place
              );
            },
          },
          client.inbox.ask({
            query: {},
            params: { inboxId },
            payload: {
              text: req.text,
              ...(req.highlightReply ? { highlightReply: true as const } : {}),
              ...(isNonEmpty(attachments) ? { attachments } : {}),
              ...(req.macros !== undefined && isNonEmpty(req.macros)
                ? { macros: req.macros }
                : {}),
            },
          }),
          () => {
            registry.set(highlightReplyAtom(place), false);
            clearSentFiles(registry, place, req.files);
            // The macros went with it; a failed send keeps their cards.
            if (followUp === undefined) {
              registry.set(macroCardsAtom(place), { inboxId, cards: [] });
              registry.set(macroHeldAtom(place), undefined);
              registry.set(cardRemovalsAtom(place), []);
            }
            const box =
              followUp === undefined
                ? askDraftAtom(inboxId)
                : followUpDraftAtom(followUp);
            if (registry.get(box) === draft) registry.set(box, '');
            registry.refresh(inboxBoardAtom);
          },
        );
        const key = askedKeyOf(view);
        if (followUp === undefined && key !== undefined)
          registry.set(inboxReaderAtoms.send, {
            type: 'AskLanded',
            key,
            inboxId,
          });
        return view;
      }),
    )
    .pipe(Atom.keepAlive),
);

/** The write of the box on screen, for the line over it. */
export const askProgressAtom = Atom.make((get): AskProgress => {
  const composer = get(composerAtom);
  const place = placeOf(composer);
  if (place === undefined) return undefined;
  const write = get(readerAskAtom(place));
  if (write.waiting) return 'sending';
  return composer._tag === 'FollowUp' &&
    AsyncResult.isSuccess(write) &&
    get(followUpDraftAtom(composer.item.key)) === ''
    ? 'sent'
    : undefined;
});

/**
 * What the composer's send does, by what the box is writing: `true` hands the
 * question to the agent. Every send path goes through here, so a key and the
 * button cannot differ.
 */
export const sendComposerAtom = Atom.writable<void, boolean>(
  () => undefined,
  (ctx, deferred) => {
    const snapshot = ctx.get(readerSnapshotAtom);
    if (snapshot === undefined) return;
    const composer = composerOf(snapshot);
    if (composer._tag === 'Answer') {
      const { item } = composer;
      const write = answerWriteAtom(item.key);
      const response = ctx.get(responseDraftAtom(item.key));
      const drawings = ctx.get(questionDrawingDraftsAtom(item.key));
      const cards = ctx.get(macroCardsAtom(item.key));
      // A written comment can be the whole answer; one never written is not
      // sent. A deferral carries them too.
      const comments = commentsToSend(ctx.get(commentsAtom(item.key)));
      const files = ctx.get(pendingFilesAtom(answerPlaceOf(item.key)));
      if (
        (response.trim() === '' &&
          cards.length === 0 &&
          comments.length === 0 &&
          files.length === 0 &&
          !deferred) ||
        ctx.get(write).waiting ||
        // A drawing the agent changed since the operator's edit waits on
        // their choice (`answerDrawingConflictsAtom`).
        drawingConflicts(drawings, item.question).length > 0
      )
        return;
      // A required macro field left empty holds the send once, on that
      // field; the same fields still empty at the next send go as `null`.
      const missing = missingKeyOf(cards);
      const first = firstMissingOf(cards);
      if (
        missing !== undefined &&
        first !== undefined &&
        ctx.get(macroHeldAtom(item.key)) !== missing
      ) {
        ctx.set(macroHeldAtom(item.key), missing);
        ctx.set(askMacroFocusAtom, {
          key: item.key,
          to: { _tag: 'Field', ...first },
        });
        return;
      }
      const macros = macrosToSend(cards);
      ctx.set(inboxReaderAtoms.send, {
        type: 'AnswerSent',
        key: item.key,
        response,
        deferred,
        macros,
        comments,
      });
      ctx.set(write, {
        item,
        response,
        deferred,
        highlightReply: ctx.get(highlightReplyAtom(answerPlaceOf(item.key))),
        drawings: drawingsToSend(drawings, item.question),
        macros,
        comments,
        files,
      });
    } else if (composer._tag === 'Asking' && !deferred) {
      const { inboxId } = composer;
      const place = askPlaceOf(inboxId);
      const write = readerAskAtom(place);
      const text = ctx.get(askDraftAtom(inboxId));
      const cards = ctx.get(macroCardsAtom(place));
      // A macro is a whole request on its own, as it is a whole answer.
      if ((text.trim() === '' && cards.length === 0) || ctx.get(write).waiting)
        return;
      // Held once on an empty required field, as an answer is.
      const missing = missingKeyOf(cards);
      const first = firstMissingOf(cards);
      if (
        missing !== undefined &&
        first !== undefined &&
        ctx.get(macroHeldAtom(place)) !== missing
      ) {
        ctx.set(macroHeldAtom(place), missing);
        ctx.set(askMacroFocusAtom, {
          key: place,
          to: { _tag: 'Field', ...first },
        });
        return;
      }
      ctx.set(write, {
        inboxId,
        text,
        draft: text,
        highlightReply: ctx.get(highlightReplyAtom(place)),
        files: ctx.get(pendingFilesAtom(place)),
        macros: macrosToSend(cards),
      });
    } else if (composer._tag === 'FollowUp' && !composer.held && !deferred) {
      const { key, inboxId, question } = composer.item;
      const write = readerAskAtom(followUpPlaceOf(key));
      const draft = ctx.get(followUpDraftAtom(key));
      const files = ctx.get(pendingFilesAtom(followUpPlaceOf(key)));
      if ((draft.trim() === '' && files.length === 0) || ctx.get(write).waiting)
        return;
      ctx.set(write, {
        inboxId,
        followUp: key,
        draft,
        highlightReply: ctx.get(highlightReplyAtom(followUpPlaceOf(key))),
        files,
        text: followUpText(
          draft,
          question.number,
          questionPath(inboxId, question.number),
        ),
      });
    }
  },
);

/**
 * Send the ask to `inboxId`. What is in the box goes with it, since a draft is
 * kept by Inbox and the operator is moving the question, not leaving it. An
 * Inbox already holding a draft keeps it, above what arrives. A draft on its
 * way stays put: it has been sent, and it clears where it was sent from.
 */
export const pickAskInboxAtom = Atom.writable<void, InboxId>(
  () => undefined,
  (ctx, inboxId) => {
    const from = ctx.get(readerSnapshotAtom)?.context.askTo;
    ctx.set(askQueryAtom, '');
    if (
      from !== undefined &&
      from !== inboxId &&
      !ctx.get(readerAskAtom(askPlaceOf(from))).waiting
    ) {
      const text = ctx.get(askDraftAtom(from));
      const held = ctx.get(askDraftAtom(inboxId));
      if (text !== '') {
        ctx.set(
          askDraftAtom(inboxId),
          held === '' ? text : `${held}\n\n${text}`,
        );
        ctx.set(askDraftAtom(from), '');
      }
      // Its macros go with it, after any the Inbox holds.
      const moving = ctx.get(macroCardsAtom(askPlaceOf(from)));
      if (moving.length > 0) {
        ctx.set(macroCardsAtom(askPlaceOf(inboxId)), {
          inboxId,
          cards: withCards(
            ctx.get(macroCardsAtom(askPlaceOf(inboxId))),
            moving,
          ),
        });
        ctx.set(macroCardsAtom(askPlaceOf(from)), { inboxId: from, cards: [] });
        ctx.set(macroHeldAtom(askPlaceOf(from)), undefined);
      }
    }
    ctx.set(inboxReaderAtoms.send, { type: 'AskInboxPicked', inboxId });
  },
);

const askCursorIn = <C extends { readonly inboxId: InboxId }>(
  choices: ReadonlyArray<C>,
  context: ReaderSnapshot['context'] | undefined,
): C | undefined =>
  // An archived Inbox can be asked in but is not listed, so no row lights.
  context?.askTo === undefined
    ? askCursorOf(choices, context?.askCursor)
    : choices.find((c) => c.inboxId === context.askTo);

/** The Inboxes on offer, and the row lit: where the ask is going, once it has an Inbox. */
export const askChoicesAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  const choices =
    board === undefined
      ? []
      : askMatches(askableInboxesOf(board), get(askQueryAtom));
  return {
    choices,
    cursor: askCursorIn(choices, get(readerSnapshotAtom)?.context),
  };
});

/** The row a key last stepped the ask list to, for the list to bring into sight. */
export const askSteppedAtom = Atom.make<{
  readonly seq: number;
  readonly inboxId: InboxId | undefined;
}>({ seq: 0, inboxId: undefined }).pipe(Atom.keepAlive);

/**
 * The last step through the ask list, from where to where, until the machine
 * has moved off the row it left. The pointer lighting or picking a row
 * forgets it (`forgetAskStepAtom`).
 */
const askStepAtom = Atom.make<
  { readonly from: InboxId | undefined; readonly to: InboxId } | undefined
>(undefined).pipe(Atom.keepAlive);

export const forgetAskStepAtom = Atom.writable<void, void>(
  () => undefined,
  (ctx) => ctx.set(askStepAtom, undefined),
);

/**
 * One row up or down the list, stopping at its ends. While the box holds the
 * filter that moves the cursor, and Enter picks; while it holds the question
 * the ask itself moves, as a click would.
 */
export const stepAskAtom = Atom.writable<void, 1 | -1>(
  () => undefined,
  (ctx, by) => {
    const { choices, cursor } = ctx.get(askChoicesAtom);
    // A key held down sends its repeats faster than the machine moves the
    // row, so while it still shows the row the last step left, this one goes
    // on from where that step went.
    const last = ctx.get(askStepAtom);
    const from =
      last !== undefined &&
      last.from === cursor?.inboxId &&
      choices.some((c) => c.inboxId === last.to)
        ? last.to
        : cursor?.inboxId;
    const at = choices.findIndex((c) => c.inboxId === from);
    const next = choices[at === -1 ? 0 : at + by];
    if (next === undefined) return;
    ctx.set(askStepAtom, { from: cursor?.inboxId, to: next.inboxId });
    ctx.set(askSteppedAtom, {
      seq: ctx.get(askSteppedAtom).seq + 1,
      inboxId: next.inboxId,
    });
    if (ctx.get(readerSnapshotAtom)?.context.askTo === undefined)
      ctx.set(inboxReaderAtoms.send, {
        type: 'AskCursorSet',
        inboxId: next.inboxId,
      });
    else ctx.set(pickAskInboxAtom, next.inboxId);
  },
);

/** Ask the agent, or stop asking: it starts where `askStartOf` says. */
export const toggleAskAtom = Atom.writable<void, void>(
  () => undefined,
  (ctx) => {
    const snapshot = ctx.get(readerSnapshotAtom);
    ctx.set(askQueryAtom, '');
    ctx.set(askStepAtom, undefined);
    ctx.set(inboxReaderAtoms.send, {
      type: 'AskToggled',
      inboxId: askStartOf(
        ctx.get(drawnBoardAtom),
        snapshot === undefined ? undefined : litOf(snapshot)?.inboxId,
        ctx.get(selectedInboxAtom),
      ),
    });
  },
);

/**
 * A comment on a span of the body of a Question waiting on the operator, by
 * `c`, ⌘⌥M, the floating button or the context menu. Only a Question in Your
 * inbox has a commentable body, so `key` is one the operator can answer. One
 * not lit yet is lit, so its answer box opens; the comment's card takes the
 * focus as it is drawn, whenever that is (`commentFocusAskedAtom`), and the
 * box, opening first, leaves the focus to it.
 */
export const commentHereAtom = Atom.writable(
  () => undefined,
  (ctx, req: { readonly key: string; readonly anchor: Anchor }): void => {
    const snapshot = ctx.get(readerSnapshotAtom);
    if (snapshot === undefined || snapshot.matches({ composer: 'asking' }))
      return;
    if (litOf(snapshot)?.key !== req.key)
      ctx.set(inboxReaderAtoms.send, { type: 'MovedTo', key: req.key });
    ctx.set(startCommentAtom, req);
  },
);
