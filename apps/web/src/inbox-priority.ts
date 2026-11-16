import {
  InboxId,
  type InboxOperatorQuestionDto,
  machineKeyOf,
  type PriorityPull,
} from '@operator-inbox/core/api';
import { Effect, Schema } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import {
  type DrawnBoard,
  drawnBoardAtom,
  inboxBoardAtom,
  priorityInboxOf,
  screenStateAtom,
  selectedInboxAtom,
  sendWrite,
  withoutArchivedGroups,
} from './inbox';
import { focusYourInboxAtom } from './inbox-elsewhere';
import { answerKey } from './inbox-queues';
import { pickRowAtom } from './inbox-rail';
import {
  priorityPullAtom,
  readerSnapshotAtom,
  shownQueuesAtom,
} from './inbox-reader';
import { inboxReaderAtoms } from './inbox-reader-machine';

// The priority Inbox: one Inbox the operator marked (`InboxPriorityMarked`,
// kept in serve's log as a pin is), which pulls them back to it. Never in the
// middle of a Question: only at the step boundary, an answer sent in another
// Inbox (or in All) while the priority Inbox has Questions waiting. How it
// pulls is config.json's `priorityPull`:
//
// - `interjection` (the default): the next thing in the reader is a card, not
//   a Question, saying how many wait there, with their titles. ↩ goes there;
//   Esc carries on here, until the next answer, when the card is back while
//   anything still waits there.
// - `boomerang`: the reader goes straight to the priority Inbox's oldest
//   waiting Question, and once nothing waits there, straight back to where
//   the operator was. The trip is kept in the tab's sessionStorage, so a
//   reload keeps the way home; picking anything but the priority Inbox ends
//   it.
//
// An archived or muted priority Inbox keeps its mark and does not pull: no
// card, no trip, no count. What is pulled and when is pure, here; the drawing
// is `components/inbox/priority.tsx`.

/** The priority Inbox, as the pull reads it. */
export interface PriorityInfo {
  readonly inboxId: InboxId;
  readonly label: string;
  /** Waiting on the operator, oldest asked first, less any answer on its way. */
  readonly waiting: ReadonlyArray<InboxOperatorQuestionDto>;
  /** Neither archived nor muted: it may pull. */
  readonly pulls: boolean;
}

/**
 * The priority Inbox on `board`, with what waits in it as the Inbox's own view
 * shows it (an archived group's Questions are left out). Undefined when no
 * Inbox is marked.
 */
export const priorityInfoOf = (
  board: DrawnBoard | undefined,
  sending: ReadonlySet<string>,
): PriorityInfo | undefined => {
  const row = priorityInboxOf(board);
  if (row === undefined || board === undefined) return undefined;
  const view = board.views.find((v) => v.inboxId === row.inboxId);
  const shown =
    view === undefined ? [] : withoutArchivedGroups(view).awaitingOperator;
  const waiting = [...shown]
    .filter((q) => !sending.has(answerKey(row.inboxId, q.number)))
    .sort((a, b) => a.askedSeq - b.askedSeq);
  return {
    inboxId: row.inboxId,
    label: row.label,
    waiting,
    pulls: !row.archived && row.muted !== true,
  };
};

/**
 * The count the ambient indicator shows: what waits in the priority Inbox
 * while the operator is elsewhere (another Inbox, or All). Nothing while they
 * are in it, or it does not pull.
 */
export const priorityCountOf = (
  priority: PriorityInfo | undefined,
  selected: InboxId | undefined,
): number =>
  priority === undefined || !priority.pulls || selected === priority.inboxId
    ? 0
    : priority.waiting.length;

/** What an answer sent does, at the step boundary. */
export type PullStep = 'stay' | 'interject' | 'boomerang';

/**
 * After an answer in `answeredIn`, sent while `selected` was on screen: pull
 * the operator back when the priority Inbox pulls, has something waiting, and
 * is neither where they are nor where they answered (an answer to a priority
 * Question in All is the priority Inbox's own).
 */
export const pullAfterAnswer = ({
  priority,
  answeredIn,
  selected,
  pull,
}: {
  readonly priority: PriorityInfo | undefined;
  readonly answeredIn: InboxId;
  readonly selected: InboxId | undefined;
  readonly pull: PriorityPull;
}): PullStep => {
  if (
    priority === undefined ||
    !priority.pulls ||
    priority.waiting.length === 0 ||
    answeredIn === priority.inboxId ||
    selected === priority.inboxId
  )
    return 'stay';
  return pull === 'boomerang' ? 'boomerang' : 'interject';
};

// --- the boomerang's trip ----------------------------------------------------------

/**
 * A boomerang out: the priority Inbox it went to, and where it came from, to
 * go back to: the Inbox (`null` for All), its groups, its label for the pill,
 * and the Question the reader would have gone on to there, after the answer
 * that set it off. `null`s, not absent keys, so it is plain JSON in the tab's
 * storage.
 */
export const PriorityTrip = Schema.Struct({
  priority: InboxId,
  from: Schema.Struct({
    inboxId: Schema.NullOr(InboxId),
    label: Schema.String,
    groups: Schema.Array(Schema.String),
    key: Schema.NullOr(Schema.String),
  }),
});
export type PriorityTrip = typeof PriorityTrip.Type;

/** What a trip does as the board or the selection moves. */
export type TripStep = 'keep' | 'end' | 'home';

/**
 * A trip comes home once the priority Inbox has nothing waiting, whatever
 * emptied it: the operator's last answer, another tab, a withdrawal. It ends,
 * where it is, once the operator picks anything else, or the Inbox it went to
 * is no longer the priority one, or stops pulling. Before the first board,
 * nothing is known, so it keeps: a reload must not drop the way home.
 */
export const tripStepOf = ({
  trip,
  priority,
  selected,
  boardRead,
}: {
  readonly trip: PriorityTrip | null;
  readonly priority: PriorityInfo | undefined;
  readonly selected: InboxId | undefined;
  readonly boardRead: boolean;
}): TripStep => {
  if (trip === null || !boardRead) return 'keep';
  if (priority === undefined || priority.inboxId !== trip.priority)
    return 'end';
  if (selected !== trip.priority) return 'end';
  if (priority.waiting.length === 0) return 'home';
  return priority.pulls ? 'keep' : 'end';
};

/**
 * Where a trip lands at home: the Question it left for, if it still waits on
 * the operator; else the oldest still waiting in that Inbox (in All, in any
 * Inbox All shows), since a Question answered meanwhile would land the reader
 * in With the agent, as if the answer had bounced.
 */
export const homeKeyOf = (
  board: DrawnBoard | undefined,
  trip: PriorityTrip,
  sending: ReadonlySet<string>,
): string | undefined => {
  const { inboxId, key } = trip.from;
  const waiting = (board?.views ?? [])
    .filter((v) =>
      inboxId === null
        ? !v.archived && v.muted !== true
        : v.inboxId === inboxId,
    )
    .flatMap((v) =>
      withoutArchivedGroups(v).awaitingOperator.map((q) => ({
        key: answerKey(v.inboxId, q.number),
        seq: q.askedSeq,
      })),
    )
    .filter((q) => !sending.has(q.key))
    .sort((a, b) => a.seq - b.seq)
    .map((q) => q.key);
  return key !== null && waiting.includes(key) ? key : waiting[0];
};

// --- the atoms -----------------------------------------------------------------------

const sendingKeysOf = (get: Atom.AtomContext): ReadonlySet<string> =>
  new Set(
    (get(readerSnapshotAtom)?.context.sends ?? []).map((s) => s.item.key),
  );

/** The priority Inbox and what waits in it now. */
export const priorityInfoAtom = Atom.make((get) =>
  priorityInfoOf(get(drawnBoardAtom), sendingKeysOf(get)),
);

/** The ambient indicator's count: 0 hides it. */
export const priorityCountAtom = Atom.make((get) =>
  priorityCountOf(get(priorityInfoAtom), get(selectedInboxAtom)),
);

// Up from an answer until the operator goes there, carries on, or picks
// anything; drawn only while it still means something.
const interjectionUpAtom = Atom.make(false).pipe(Atom.keepAlive);

/** The interjection card's priority Inbox while the card is up, else undefined. */
export const interjectionAtom = Atom.make((get): PriorityInfo | undefined => {
  const info = get(priorityInfoAtom);
  return get(interjectionUpAtom) &&
    info !== undefined &&
    info.pulls &&
    info.waiting.length > 0 &&
    get(selectedInboxAtom) !== info.inboxId
    ? info
    : undefined;
});

// The tab's storage, not localStorage: a trip belongs to the tab it was taken
// in, and a reload of that tab keeps it.
const tabStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => sessionStorage),
);

const storedTripAtom = Atom.kvs({
  runtime: tabStorage,
  key: 'operator-inbox:priority-trip',
  schema: Schema.NullOr(PriorityTrip),
  defaultValue: (): PriorityTrip | null => null,
}).pipe(Atom.keepAlive);

/** The boomerang out now, or null. */
export const priorityTripAtom = Atom.make((get) => get(storedTripAtom));

type Write = Atom.WriteContext<unknown>;

// To a view and, when given, one Question in it, on Your inbox, with the caret
// in the answer box: as the Inbox picker goes, plus the Question.
const goTo = (
  ctx: Write,
  inboxId: InboxId | undefined,
  groups: ReadonlyArray<string>,
  key: string | undefined,
) => {
  ctx.set(pickRowAtom, { inboxId, groups });
  ctx.set(inboxReaderAtoms.send, { type: 'QueueChosen', queue: 'inbox' });
  if (key !== undefined)
    ctx.set(inboxReaderAtoms.send, { type: 'MovedTo', key });
  ctx.set(focusYourInboxAtom, { orBox: true });
};

// The Question the reader is on in Your inbox, unless it is on its way: after
// an answer the reader has already flowed on to the next one, which is the one
// to come back to.
const resumeKeyOf = (ctx: Write): string | undefined => {
  const focus = ctx.get(readerSnapshotAtom)?.context.focus.inbox;
  return focus !== undefined &&
    ctx.get(shownQueuesAtom).inbox.some((i) => i.key === focus)
    ? focus
    : undefined;
};

const startTrip = (ctx: Write, priority: InboxId) => {
  const selected = ctx.get(selectedInboxAtom);
  const label =
    selected === undefined
      ? 'All inboxes'
      : (ctx.get(drawnBoardAtom)?.inboxes.find((i) => i.inboxId === selected)
          ?.label ?? 'the inbox you were in');
  ctx.set(storedTripAtom, {
    priority,
    from: {
      inboxId: selected ?? null,
      label,
      groups: ctx.get(screenStateAtom).groups,
      key: resumeKeyOf(ctx) ?? null,
    },
  });
};

/**
 * To the priority Inbox: its oldest waiting Question, or the one numbered.
 * Under the boomerang, from elsewhere, it is a trip, so it comes back.
 */
export const goToPriorityAtom = Atom.writable<
  void,
  { readonly number?: number }
>(
  () => undefined,
  (ctx, { number }) => {
    const info = ctx.get(priorityInfoAtom);
    if (info === undefined) return;
    ctx.set(interjectionUpAtom, false);
    const question =
      number === undefined
        ? info.waiting[0]
        : info.waiting.find((q) => q.number === number);
    if (
      ctx.get(priorityPullAtom) === 'boomerang' &&
      info.pulls &&
      ctx.get(selectedInboxAtom) !== info.inboxId &&
      ctx.get(storedTripAtom) === null
    )
      startTrip(ctx, info.inboxId);
    goTo(
      ctx,
      info.inboxId,
      [],
      question === undefined
        ? undefined
        : answerKey(info.inboxId, question.number),
    );
  },
);

/** Carry on past the card, until the next answer. */
export const carryOnAtom = Atom.writable<void, void>(
  () => undefined,
  (ctx) => {
    ctx.set(interjectionUpAtom, false);
    ctx.set(focusYourInboxAtom, { orBox: true });
  },
);

/** The boomerang home: now, by hand, or once the priority Inbox is clear. */
export const priorityBackAtom = Atom.writable<void, void>(
  () => undefined,
  (ctx) => {
    const trip = ctx.get(storedTripAtom);
    if (trip === null) return;
    // Cleared first, so the move home is not taken for the operator leaving.
    ctx.set(storedTripAtom, null);
    const sending = new Set(
      (ctx.get(readerSnapshotAtom)?.context.sends ?? []).map((s) => s.item.key),
    );
    goTo(
      ctx,
      trip.from.inboxId ?? undefined,
      trip.from.groups,
      homeKeyOf(ctx.get(drawnBoardAtom), trip, sending),
    );
  },
);

/**
 * Mounted by the page. It hears three things: an answer sent (a new key among
 * the reader's sends: the step boundary), the board (the priority Inbox
 * emptied or changed, for the trip) and the selection (the operator leaving a
 * trip, or picking anything while the card is up).
 */
export const priorityWatchAtom: Atom.Atom<void> = Atom.readable((get) => {
  let seen: ReadonlySet<string> = new Set(
    (get.once(readerSnapshotAtom)?.context.sends ?? []).map((s) => s.item.key),
  );

  const onSnapshot = () => {
    const sends = get.once(readerSnapshotAtom)?.context.sends ?? [];
    const fresh = sends.filter((s) => !seen.has(s.item.key));
    seen = new Set(sends.map((s) => s.item.key));
    const sent = fresh.at(-1);
    if (sent === undefined) return;
    const step = pullAfterAnswer({
      priority: get.once(priorityInfoAtom),
      answeredIn: sent.item.inboxId,
      selected: get.once(selectedInboxAtom),
      pull: get.once(priorityPullAtom),
    });
    if (step === 'interject') get.set(interjectionUpAtom, true);
    else if (step === 'boomerang') get.set(goToPriorityAtom, {});
  };

  const onTrip = () => {
    const step = tripStepOf({
      trip: get.once(storedTripAtom),
      priority: get.once(priorityInfoAtom),
      selected: get.once(selectedInboxAtom),
      boardRead: get.once(drawnBoardAtom) !== undefined,
    });
    if (step === 'end') get.set(storedTripAtom, null);
    else if (step === 'home') get.set(priorityBackAtom, undefined);
  };

  const onSelected = () => {
    get.set(interjectionUpAtom, false);
    onTrip();
  };

  get.subscribe(readerSnapshotAtom, onSnapshot);
  get.subscribe(priorityInfoAtom, onTrip);
  get.subscribe(selectedInboxAtom, onSelected);
  onTrip();
});

// --- marking it ----------------------------------------------------------------------

interface PriorityRequest {
  readonly inboxId: InboxId;
  readonly priority: boolean;
  // The Inbox another machine's log marks, cleared after the mark lands: one
  // log replaces its own mark in one append, but two logs cannot share one.
  readonly elsewhere?: InboxId;
}

// The priority write, one Atom for the page: a mark or a clearing at a time.
// On success it refreshes the board, so the flag moves. Placeless: the menu
// that asked has shut, and a key may ask with the sidebar shut.
export const priorityWriteAtom = InboxClient.runtime.fn(
  Effect.fnUntraced(function* (req: PriorityRequest, get: Atom.FnContext) {
    const client = yield* InboxClient;
    const write = (inboxId: InboxId, priority: boolean) =>
      sendWrite(
        get,
        {
          inboxId,
          what: (label) =>
            `${priority ? 'Marking' : 'Unmarking'} ${label} as the priority inbox`,
          notDone: priority ? 'Not marked' : 'Not unmarked',
          refused: 'PriorityRefused',
          placeless: true,
        },
        client.inbox.priority({
          query: {},
          params: { inboxId },
          payload: { priority },
        }),
        (registry) => registry.refresh(inboxBoardAtom),
      );
    const view = yield* write(req.inboxId, req.priority);
    if (req.elsewhere !== undefined) yield* write(req.elsewhere, false);
    return view;
  }),
);

/** What marking `inboxId` asks for, by the board: mark it, or clear its mark. */
export const priorityRequestOf = (
  board: DrawnBoard | undefined,
  inboxId: InboxId,
): PriorityRequest | undefined => {
  const row = board?.inboxes.find((i) => i.inboxId === inboxId);
  if (row === undefined) return undefined;
  if (row.priority === true) return { inboxId, priority: false };
  const holder = priorityInboxOf(board);
  return holder !== undefined && machineKeyOf(holder) !== machineKeyOf(row)
    ? { inboxId, priority: true, elsewhere: holder.inboxId }
    : { inboxId, priority: true };
};

/** Mark an Inbox as the priority one, replacing any other; on it, unmark it. */
export const togglePriorityAtom = Atom.writable<void, InboxId>(
  () => undefined,
  (ctx, inboxId) => {
    const req = priorityRequestOf(ctx.get(drawnBoardAtom), inboxId);
    if (req !== undefined) ctx.set(priorityWriteAtom, req);
  },
);
