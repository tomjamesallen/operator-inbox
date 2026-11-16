import {
  type InboxId,
  type InboxViewDto,
  SESSION_TITLE_KEY,
} from '@operator-inbox/core/api';
import { DateTime, Option } from 'effect';
import { Atom } from 'effect/reactivity';
import {
  type DrawnBoard,
  drawnBoardAtom,
  groupOf,
  groupsInForce,
  refusedInboxesOf,
  type SessionTarget,
  screenStateAtom,
  selectedInboxAtom,
  sessionTargetOf,
  sidebarPinnedOnlyAtom,
  withoutArchivedGroups,
} from './inbox';
import { chaseNowAtom, isStale } from './inbox-chase';
import { answerKey, type FreshMark, type QueueName } from './inbox-queues';
import { freshElsewhereAtom, pickRowAtom } from './inbox-rail';
import {
  activeQueueAtom,
  askingAtom,
  boxFocusAskedAtom,
  chaseAfterMsAtom,
  readerSnapshotAtom,
  shownQueuesAtom,
  viewKeyOf,
} from './inbox-reader';
import { inboxReaderAtoms } from './inbox-reader-machine';

// Elsewhere: the selected Inbox, or the groups of it on screen, has nothing
// waiting on the operator, but other Inboxes do, or hold a question stuck with
// the agent. With a group on screen, the rest of its Inbox is one of them. The empty state then
// lists them under an owl that is awake, so the operator can go straight to
// the next one. What is listed and in what order is pure, here; the drawing is
// `components/inbox/elsewhere.tsx`.

/** One other Inbox, as its row in the list. */
export interface ElsewhereRow {
  readonly inboxId: InboxId;
  readonly label: string;
  /** Questions waiting on the operator: the sidebar's count. */
  readonly count: number;
  /** Questions with the agent past `chaseAfterMinutes`. */
  readonly stuck: number;
  /** How long the longest-stuck of them has sat with the agent, in ms. */
  readonly stuckForMs: number;
  /** The sidebar's newest pink dot for this Inbox, while it is lit. */
  readonly fresh: FreshMark | undefined;
  /** `lastActivityAt`, in epoch ms. */
  readonly lastAt: number | undefined;
  readonly target: SessionTarget | undefined;
  /** The session's title, shown under the name: see `sessionSubtextOf`. */
  readonly session: string | undefined;
}

/**
 * The line under an Inbox's name: the title of the session working it
 * (`sessionTitle`), where it has one. Left out when it says what the name
 * already says (the same words, ignoring case and spaces at the ends), since
 * a repeat tells the operator nothing.
 */
export const sessionSubtextOf = (
  board: DrawnBoard,
  inboxId: InboxId,
  label: string,
): string | undefined => {
  const title = board.views.find((v) => v.inboxId === inboxId)?.metadata[
    SESSION_TITLE_KEY
  ];
  if (typeof title !== 'string') return undefined;
  const text = title.trim();
  return text === '' || text.toLowerCase() === label.trim().toLowerCase()
    ? undefined
    : text;
};

const millisOf = (at: string | undefined): number | undefined =>
  at === undefined
    ? undefined
    : Option.getOrUndefined(
        Option.map(DateTime.make(at), DateTime.toEpochMillis),
      );

/** Something has sat with the agent too long: the chase button's rule. */
export const needsAttention = (row: ElsewhereRow): boolean => row.stuck > 0;

/**
 * The list's order. Rows that need attention come first, since a stuck session
 * waits on nobody but the operator. Then, within each part alike, the fewest
 * questions first, because emptying an Inbox is the point, and the most recent
 * activity breaks a tie.
 */
export const elsewhereOrder = (a: ElsewhereRow, b: ElsewhereRow): number =>
  Number(needsAttention(b)) - Number(needsAttention(a)) ||
  a.count - b.count ||
  (b.lastAt ?? Number.NEGATIVE_INFINITY) -
    (a.lastAt ?? Number.NEGATIVE_INFINITY);

/**
 * What an Inbox holds outside the groups of it in force: what picking the
 * whole Inbox shows beyond them. Undefined while no group is in force, as the
 * whole Inbox is then what is on screen.
 */
export const outsideGroupsOf = (
  view: InboxViewDto | undefined,
  chosen: ReadonlyArray<string>,
): InboxViewDto | undefined => {
  if (view === undefined) return undefined;
  const inForce = groupsInForce(view, chosen);
  if (inForce.length === 0) return undefined;
  const whole = withoutArchivedGroups(view);
  const keep = (q: Parameters<typeof groupOf>[0]) =>
    !inForce.includes(groupOf(q));
  return {
    ...whole,
    awaitingOperator: whole.awaitingOperator.filter(keep),
    awaitingAgent: whole.awaitingAgent.filter(keep),
    processed: whole.processed.filter(keep),
  };
};

/**
 * Every other active Inbox with something for the operator: a question waiting
 * on them, or one stuck with the agent. With groups of the selected Inbox in
 * force (`groups`), the selected Inbox is listed too, for what it holds
 * outside them, so only the groups on screen are left out. Archived Inboxes,
 * and one two machines claim and the board refuses, are left out, and so are
 * muted ones: muting an Inbox says it is not to call the operator, so it
 * never brings the list on.
 */
export const elsewhereRowsOf = (
  board: DrawnBoard | undefined,
  selected: InboxId | undefined,
  nowMs: number,
  afterMs: number,
  fresh: ReadonlyArray<FreshMark>,
  groups: ReadonlyArray<string> = [],
): ReadonlyArray<ElsewhereRow> => {
  if (board === undefined) return [];
  const refused = refusedInboxesOf(board);
  const outside = outsideGroupsOf(
    board.views.find((v) => v.inboxId === selected),
    groups,
  );
  return board.inboxes
    .filter(
      (r) =>
        !r.archived &&
        r.muted !== true &&
        (r.inboxId !== selected || outside !== undefined) &&
        !refused.has(r.inboxId),
    )
    .map((r): ElsewhereRow => {
      const here = r.inboxId === selected ? outside : undefined;
      const view = here ?? board.views.find((v) => v.inboxId === r.inboxId);
      // As `chasesOf`, which the chase button counts.
      const stale = (view?.awaitingAgent ?? []).filter((q) =>
        isStale(q, nowMs, afterMs),
      );
      const oldest = Math.min(
        ...stale.map((q) => millisOf(q.answeredAt ?? q.askedAt) ?? nowMs),
      );
      return {
        inboxId: r.inboxId,
        label: r.label,
        count: here?.awaitingOperator.length ?? r.awaitingOperator,
        stuck: stale.length,
        stuckForMs: stale.length === 0 ? 0 : Math.max(0, nowMs - oldest),
        fresh: fresh.filter((f) => f.inboxId === r.inboxId).at(-1),
        lastAt: millisOf(r.lastActivityAt),
        target: sessionTargetOf(board, r.inboxId),
        session: sessionSubtextOf(board, r.inboxId, r.label),
      };
    })
    .filter((row) => row.count > 0 || row.stuck > 0)
    .sort(elsewhereOrder);
};

/**
 * What still waits on the operator in the selected Inbox, or in the groups of
 * it in force, by the board: an answer on its way has left it, as it has left
 * the reader's queue.
 */
export const waitingHereOf = (
  board: DrawnBoard | undefined,
  selected: InboxId | undefined,
  sending: ReadonlySet<string>,
  groups: ReadonlyArray<string> = [],
): number => {
  const view = board?.views.find((v) => v.inboxId === selected);
  if (view === undefined || selected === undefined) return 0;
  const inForce = groupsInForce(view, groups);
  return view.awaitingOperator.filter(
    (q) =>
      !sending.has(answerKey(selected, q.number)) &&
      (inForce.length === 0 || inForce.includes(groupOf(q))),
  ).length;
};

/**
 * Whether the empty state lists the other Inboxes: an Inbox is selected and on
 * the board, Your inbox is the queue on screen, nothing in that Inbox (or the
 * groups of it in force) waits on the operator (a filter that only hides its
 * questions does not count), and somewhere else has something.
 */
export const elsewhereAppliesOf = ({
  board,
  selected,
  queue,
  shownWaiting,
  waitingHere,
  rows,
}: {
  readonly board: DrawnBoard | undefined;
  readonly selected: InboxId | undefined;
  readonly queue: QueueName;
  readonly shownWaiting: number;
  readonly waitingHere: number;
  readonly rows: ReadonlyArray<ElsewhereRow>;
}): boolean =>
  board !== undefined &&
  selected !== undefined &&
  board.views.some((v) => v.inboxId === selected) &&
  queue === 'inbox' &&
  shownWaiting === 0 &&
  waitingHere === 0 &&
  rows.length > 0;

// --- the list's lines -------------------------------------------------------------

/** The footer line's key: it goes to All. */
export const SHOW_ALL = 'all';

/** A line of the list: an Inbox's row, or the footer's "Show all inbox items". */
export type ElsewhereLine =
  | {
      readonly _tag: 'Inbox';
      readonly key: InboxId;
      readonly row: ElsewhereRow;
    }
  | { readonly _tag: 'All'; readonly key: typeof SHOW_ALL };

export const linesOf = (
  rows: ReadonlyArray<ElsewhereRow>,
): ReadonlyArray<ElsewhereLine> => [
  ...rows.map((row) => ({ _tag: 'Inbox' as const, key: row.inboxId, row })),
  { _tag: 'All', key: SHOW_ALL },
];

/** The line lit: the one the cursor names while it is listed, else the first. */
export const cursorLineOf = (
  lines: ReadonlyArray<ElsewhereLine>,
  cursor: string | undefined,
): ElsewhereLine | undefined => lines.find((l) => l.key === cursor) ?? lines[0];

/** Where a step takes the cursor: one line on, stopping at the ends, or to an end. */
export const steppedLineOf = (
  lines: ReadonlyArray<ElsewhereLine>,
  cursor: string | undefined,
  by: 1 | -1 | 'first' | 'last',
): ElsewhereLine | undefined => {
  if (by === 'first') return lines[0];
  if (by === 'last') return lines.at(-1);
  const at = lines.findIndex((l) => l.key === cursorLineOf(lines, cursor)?.key);
  return lines[at + by] ?? lines[at];
};

/**
 * Whether the operator has just emptied the Inbox in front of them: the same
 * view, which had something waiting on them and now has nothing. A change of
 * view, or the first read, is never a clearing.
 */
export const clearedOf = (
  was:
    | { readonly view: string | undefined; readonly waiting: number }
    | undefined,
  now: { readonly view: string | undefined; readonly waiting: number },
): boolean =>
  was !== undefined &&
  now.view !== undefined &&
  was.view === now.view &&
  was.waiting > 0 &&
  now.waiting === 0;

// --- the atoms --------------------------------------------------------------------

const sendingKeysAtom = Atom.make(
  (get): ReadonlySet<string> =>
    new Set(
      (get(readerSnapshotAtom)?.context.sends ?? []).map((s) => s.item.key),
    ),
);

const waitingHereAtom = Atom.make((get) =>
  waitingHereOf(
    get(drawnBoardAtom),
    get(selectedInboxAtom),
    get(sendingKeysAtom),
    get(screenStateAtom).groups,
  ),
);

/** The other Inboxes, in the list's order. */
export const elsewhereRowsAtom = Atom.make((get) =>
  elsewhereRowsOf(
    get(drawnBoardAtom),
    get(selectedInboxAtom),
    get(chaseNowAtom),
    get(chaseAfterMsAtom),
    get(freshElsewhereAtom),
    get(screenStateAtom).groups,
  ),
);

/** Whether the empty state is the list of other Inboxes. */
export const elsewhereShownAtom = Atom.make((get) =>
  elsewhereAppliesOf({
    board: get(drawnBoardAtom),
    selected: get(selectedInboxAtom),
    queue: get(activeQueueAtom),
    shownWaiting: get(shownQueuesAtom).inbox.length,
    waitingHere: get(waitingHereAtom),
    rows: get(elsewhereRowsAtom),
  }),
);

// Kept alive, so the line lit survives the list going and coming back.
const elsewhereCursorAtom = Atom.make<string | undefined>(undefined).pipe(
  Atom.keepAlive,
);

/** The lines on offer, and the one lit. */
export const elsewhereLinesAtom = Atom.make((get) => {
  const lines = linesOf(get(elsewhereRowsAtom));
  return { lines, cursor: cursorLineOf(lines, get(elsewhereCursorAtom)) };
});

export const setElsewhereCursorAtom = Atom.writable<void, string>(
  () => undefined,
  (ctx, key) => ctx.set(elsewhereCursorAtom, key),
);

export const stepElsewhereAtom = Atom.writable<void, 1 | -1 | 'first' | 'last'>(
  () => undefined,
  (ctx, by) => {
    const next = steppedLineOf(
      ctx.get(elsewhereLinesAtom).lines,
      ctx.get(elsewhereCursorAtom),
      by,
    );
    if (next !== undefined) ctx.set(elsewhereCursorAtom, next.key);
  },
);

/**
 * A line picked. An Inbox's is the sidebar's own click on that row; one with
 * nothing waiting on the operator, there only for a question stuck with the
 * agent, opens on With the agent, where that question is. The footer's is
 * All. Either way the caret goes to the box at the foot.
 */
export const pickElsewhereAtom = Atom.writable<void, ElsewhereLine>(
  () => undefined,
  (ctx, line) => {
    ctx.set(elsewhereCursorAtom, undefined);
    if (line._tag === 'All')
      ctx.set(pickRowAtom, { inboxId: undefined, groups: [] });
    else {
      ctx.set(pickRowAtom, { inboxId: line.row.inboxId, groups: [] });
      if (line.row.count === 0)
        ctx.set(inboxReaderAtoms.send, { type: 'QueueChosen', queue: 'agent' });
    }
    ctx.set(boxFocusAskedAtom, ctx.get(boxFocusAskedAtom) + 1);
  },
);

/**
 * Set when the list should take the focus as it is drawn; the list clears it.
 * `cleared`: the operator emptied the Inbox, and the list takes the focus only
 * from the answer box or from nowhere. `moved`: a keyboard move landed here
 * (`focusYourInboxAtom`), and the list takes it from wherever it is.
 */
export const elsewhereFocusAskedAtom = Atom.make<false | 'cleared' | 'moved'>(
  false,
).pipe(Atom.keepAlive);

// A keyboard move that may land on Your inbox, waiting for the reader: the
// machine takes the move a moment after the key, so what it showed when the
// key went down (`from`) is not yet where it lands.
interface Landing {
  readonly orBox: boolean;
  readonly from: unknown;
}
const landingAskedAtom = Atom.make<Landing | undefined>(undefined).pipe(
  Atom.keepAlive,
);

/**
 * A keyboard move that may land on Your inbox: a queue switch (`orBox` false),
 * `focus_inbox_column` or a pick in the inbox picker (`orBox` true, a move to
 * it). Once the reader has taken the move, if it is on Your inbox and that
 * shows the empty state's list of other Inboxes, the focus goes to the list,
 * on its first line. Otherwise an `orBox` move puts the caret in the answer
 * box, and a queue switch leaves the focus where it is. A page load asks
 * nothing, so nothing is taken from where the browser put the focus.
 */
export const focusYourInboxAtom = Atom.writable<
  void,
  { readonly orBox: boolean }
>(
  () => undefined,
  (ctx, { orBox }) =>
    ctx.set(landingAskedAtom, { orBox, from: ctx.get(readerSnapshotAtom) }),
);

/**
 * Carries out a landing once the reader shows the view now selected and has
 * moved since the key (or, for a move to Your inbox, is there already). Not on
 * Your inbox, or composing a question, it lets the landing go. Mounted with
 * the page.
 */
export const yourInboxLandingWatchAtom = Atom.make((get): void => {
  const asked = get(landingAskedAtom);
  const snapshot = get(readerSnapshotAtom);
  if (asked === undefined || snapshot === undefined) return;
  const { inboxes, groups } = get(screenStateAtom);
  const view = viewKeyOf(
    get(selectedInboxAtom),
    inboxes,
    groups,
    get(sidebarPinnedOnlyAtom),
  );
  if (snapshot.context.view !== view) return;
  const there = get(activeQueueAtom) === 'inbox' && !get(askingAtom);
  if (snapshot === asked.from && !(asked.orBox && there)) return;
  if (there && get(elsewhereShownAtom)) {
    get.set(elsewhereCursorAtom, undefined);
    get.set(elsewhereFocusAskedAtom, 'moved');
  } else if (there && asked.orBox)
    get.set(boxFocusAskedAtom, get.once(boxFocusAskedAtom) + 1);
  // Last: setting what this atom reads runs it again at once, and the writes
  // after it in this run are lost.
  get.set(landingAskedAtom, undefined);
});

interface ClearWatch {
  readonly view: string | undefined;
  readonly waiting: number;
}

/**
 * Watches for the operator emptying the Inbox in front of them. When that
 * leaves the list of other Inboxes in its place, the list is asked to take the
 * focus, on its first line. A page load or a move to an Inbox that is already
 * empty asks nothing. Mounted with the page.
 */
export const elsewhereClearWatchAtom = Atom.make((get): ClearWatch => {
  const now: ClearWatch = {
    view: get(readerSnapshotAtom)?.context.view,
    waiting: get(waitingHereAtom) + get(shownQueuesAtom).inbox.length,
  };
  const was = Option.getOrUndefined(get.self<ClearWatch>());
  if (clearedOf(was, now) && get(elsewhereShownAtom)) {
    get.set(elsewhereCursorAtom, undefined);
    get.set(elsewhereFocusAskedAtom, 'cleared');
  }
  return now;
});
