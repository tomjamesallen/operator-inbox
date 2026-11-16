import type { InboxId } from '@operator-inbox/core/api';
import { DateTime, Option } from 'effect';
import { Atom } from 'effect/reactivity';
import {
  type DrawnBoard,
  drawnBoardAtom,
  machineSectionsOf,
  openInboxSessionAtom,
  refusedInboxesOf,
  sessionTargetOf,
} from './inbox';
import { chaseNowAtom } from './inbox-chase';
import {
  type ElsewhereRow,
  elsewhereRowsOf,
  focusYourInboxAtom,
  sessionSubtextOf,
} from './inbox-elsewhere';
import type { FreshMark } from './inbox-queues';
import { freshElsewhereAtom, pickRowAtom } from './inbox-rail';
import { chaseAfterMsAtom } from './inbox-reader';
import { inboxReaderAtoms } from './inbox-reader-machine';

// The inbox picker (`go_to_session`): every Inbox and the session working it,
// in the ⌘P modal. It is the awake owl's list of other Inboxes in a modal, so
// it takes that list's rows and order (`elsewhereRowsOf`), and goes on to the
// Inboxes the owl leaves out, since here any Inbox may be the one wanted. Type
// to filter by an Inbox's name, its session's title or its code (`toe` or
// `@toe`); Enter selects the Inbox as a click on its sidebar row does and puts
// the caret in its answer box; Ctrl+Enter opens its session and leaves the
// modal open on the same row, so an Enter can follow; Escape closes. What is
// listed and how it matches is pure, here; the drawing is
// `components/inbox/inbox-picker.tsx`.

/** One line of the picker: one Inbox, or All at the foot. */
export type PickerRow =
  | {
      readonly _tag: 'Inbox';
      readonly key: InboxId;
      readonly row: ElsewhereRow;
      readonly code: string | undefined;
      // The session's title, from the Inbox's `sessionTitle`, for the filter;
      // `row.session` is what is shown under the name.
      readonly session: string | undefined;
      // Its machine section's label, set while there is more than one.
      readonly machine: string | undefined;
      readonly muted: boolean;
      readonly archived: boolean;
    }
  | { readonly _tag: 'All'; readonly key: 'all'; readonly label: string };

const millisOf = (at: string | undefined): number | undefined =>
  at === undefined
    ? undefined
    : Option.getOrUndefined(
        Option.map(DateTime.make(at), DateTime.toEpochMillis),
      );

const sessionTitleOf = (
  board: DrawnBoard,
  inboxId: InboxId,
): string | undefined => {
  const title = board.views.find((v) => v.inboxId === inboxId)?.metadata
    .sessionTitle;
  return typeof title === 'string' && title.trim() !== '' ? title : undefined;
};

/**
 * Every Inbox in the picker's order: first the awake owl's rows, in its order
 * (something stuck with the agent first, then the fewest waiting, then the
 * most recent activity), with the Inbox on screen among them; then the other
 * active Inboxes, then the muted ones, then the archived ones, each most
 * recent activity first. An Inbox two machines claim is left out.
 */
export const pickerInboxesOf = (
  board: DrawnBoard,
  nowMs: number,
  afterMs: number,
  fresh: ReadonlyArray<FreshMark>,
): ReadonlyArray<PickerRow> => {
  const refused = refusedInboxesOf(board);
  const owl = elsewhereRowsOf(board, undefined, nowMs, afterMs, fresh);
  const listed = new Set<InboxId>(owl.map((r) => r.inboxId));
  const rest = board.inboxes
    .filter((r) => !listed.has(r.inboxId) && !refused.has(r.inboxId))
    .map(
      (r): ElsewhereRow => ({
        inboxId: r.inboxId,
        label: r.label,
        count: r.awaitingOperator,
        stuck: 0,
        stuckForMs: 0,
        fresh: fresh.filter((f) => f.inboxId === r.inboxId).at(-1),
        lastAt: millisOf(r.lastActivityAt),
        target: sessionTargetOf(board, r.inboxId),
        session: sessionSubtextOf(board, r.inboxId, r.label),
      }),
    );
  const summary = new Map(board.inboxes.map((r) => [r.inboxId, r]));
  const recent = (a: ElsewhereRow, b: ElsewhereRow) =>
    (b.lastAt ?? Number.NEGATIVE_INFINITY) -
    (a.lastAt ?? Number.NEGATIVE_INFINITY);
  const part = (keep: (r: ElsewhereRow) => boolean) =>
    rest.filter(keep).sort(recent);
  const isMuted = (r: ElsewhereRow) => summary.get(r.inboxId)?.muted === true;
  const isArchived = (r: ElsewhereRow) =>
    summary.get(r.inboxId)?.archived === true;
  const sections = machineSectionsOf(board);
  const machineOf = (inboxId: InboxId) =>
    sections.length > 1
      ? sections.find((s) => s.inboxes.some((i) => i.inboxId === inboxId))
          ?.label
      : undefined;
  return [
    ...owl,
    ...part((r) => !isArchived(r) && !isMuted(r)),
    ...part((r) => !isArchived(r) && isMuted(r)),
    ...part(isArchived),
  ].map((row) => ({
    _tag: 'Inbox',
    key: row.inboxId,
    row,
    code: summary.get(row.inboxId)?.code,
    session: sessionTitleOf(board, row.inboxId),
    machine: machineOf(row.inboxId),
    muted: isMuted(row),
    archived: isArchived(row),
  }));
};

const ALL: PickerRow = { _tag: 'All', key: 'all', label: 'All inboxes' };

/**
 * The rows for `query`: those whose Inbox name or session title holds it, or
 * whose code starts with it (a leading `@` names a code only, as in the
 * question search). All, at the foot, stays while the query is empty or names
 * it.
 */
export const pickerMatches = (
  rows: ReadonlyArray<PickerRow>,
  query: string,
): ReadonlyArray<PickerRow> => {
  const text = query.trim().toLowerCase();
  if (text === '') return [...rows, ALL];
  const at = text.startsWith('@');
  const code = text.replace(/^@/, '');
  const holds = (s: string | undefined) =>
    s?.toLowerCase().includes(text) === true;
  return [
    ...rows.filter(
      (r) =>
        r._tag === 'Inbox' &&
        ((!at && (holds(r.row.label) || holds(r.session))) ||
          (code !== '' && r.code?.startsWith(code) === true)),
    ),
    ...(!at && holds(ALL.label) ? [ALL] : []),
  ];
};

export const inboxPickerOpenAtom = Atom.make(false).pipe(Atom.keepAlive);
export const inboxPickerQueryAtom = Atom.make('').pipe(Atom.keepAlive);

/** The row the list has lit, for Ctrl+Enter. The list keeps it. */
export const inboxPickerLitAtom = Atom.make<PickerRow | undefined>(
  undefined,
).pipe(Atom.keepAlive);

/** A fresh open starts empty, on the first row. */
export const setInboxPickerOpenAtom = Atom.writable<void, boolean>(
  () => undefined,
  (ctx, open) => {
    if (open) {
      ctx.set(inboxPickerQueryAtom, '');
      ctx.set(inboxPickerLitAtom, undefined);
    }
    ctx.set(inboxPickerOpenAtom, open);
  },
);

export const inboxPickerRowsAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  return board === undefined
    ? []
    : pickerMatches(
        pickerInboxesOf(
          board,
          get(chaseNowAtom),
          get(chaseAfterMsAtom),
          get(freshElsewhereAtom),
        ),
        get(inboxPickerQueryAtom),
      );
});

/**
 * Enter on a row: the modal shuts, the Inbox is selected as a click on its
 * sidebar row selects it, and the caret goes to Your inbox's answer box, or
 * to the empty state's list when that is what Your inbox shows.
 */
export const pickInboxRowAtom = Atom.writable<void, PickerRow>(
  () => undefined,
  (ctx, row) => {
    ctx.set(inboxPickerOpenAtom, false);
    ctx.set(pickRowAtom, {
      inboxId: row._tag === 'All' ? undefined : row.key,
      groups: [],
    });
    ctx.set(inboxReaderAtoms.send, { type: 'QueueChosen', queue: 'inbox' });
    ctx.set(focusYourInboxAtom, { orBox: true });
  },
);

/** Whether Ctrl+Enter on a row opens anything: a session on this machine. */
export const opensSession = (row: PickerRow | undefined): boolean =>
  row?._tag === 'Inbox' && row.row.target?._tag === 'Here';

/**
 * Ctrl+Enter on a row: its Inbox's session, when this machine can open it.
 * The modal stays open on the row, so Enter can select the Inbox after.
 */
export const openPickedSessionAtom = Atom.writable<void, PickerRow>(
  () => undefined,
  (ctx, row) => {
    if (row._tag === 'Inbox' && opensSession(row))
      ctx.set(openInboxSessionAtom, row.key);
  },
);
