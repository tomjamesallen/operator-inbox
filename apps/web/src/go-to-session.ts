import type { InboxId } from '@operator-inbox/core/api';
import { Atom } from 'effect/reactivity';
import {
  type AskableInbox,
  askMatches,
  type DrawnBoard,
  drawnBoardAtom,
  machineSectionsOf,
  openSessionLinkAtom,
  pinnedFirst,
  refusedInboxesOf,
  sessionTargetOf,
} from './inbox';

// The go-to-session modal: the ask's list of Inboxes, filtered and walked the
// same way, but of every Inbox with a session, the archived ones last: an
// archived Inbox's session is often the one being looked for. A session on
// another machine is listed but cannot open here, so the cursor passes over it.

export interface SessionChoice extends AskableInbox {
  readonly archived: boolean;
  /** Undefined for a session on another machine. */
  readonly link: string | undefined;
}

/** The Inboxes with a session whose name or id holds `query`, open ones first. */
export const sessionChoicesOf = (
  board: DrawnBoard,
  query: string,
): ReadonlyArray<SessionChoice> => {
  const refused = refusedInboxesOf(board);
  const choices = machineSectionsOf(board).flatMap((section) =>
    pinnedFirst(
      section.inboxes.filter((i) => !refused.has(i.inboxId)),
      (i) => i.pinned,
    ).flatMap((i) => {
      const target = sessionTargetOf(board, i.inboxId);
      if (target === undefined) return [];
      return [
        {
          inboxId: i.inboxId,
          label: i.label,
          machine: section.label,
          archived: i.archived,
          link: target._tag === 'Here' ? target.link : undefined,
        },
      ];
    }),
  );
  return askMatches(
    [
      ...choices.filter((c) => !c.archived),
      ...choices.filter((c) => c.archived),
    ],
    query,
  );
};

export const goToSessionOpenAtom = Atom.make(false).pipe(Atom.keepAlive);
export const goToSessionQueryAtom = Atom.make('').pipe(Atom.keepAlive);
const goToSessionCursorAtom = Atom.make<InboxId | undefined>(undefined).pipe(
  Atom.keepAlive,
);

/** A fresh open starts empty, on the first row. */
export const setGoToSessionOpenAtom = Atom.writable<void, boolean>(
  () => undefined,
  (ctx, open) => {
    if (open) {
      ctx.set(goToSessionQueryAtom, '');
      ctx.set(goToSessionCursorAtom, undefined);
    }
    ctx.set(goToSessionOpenAtom, open);
  },
);

const canOpen = (choice: SessionChoice) => choice.link !== undefined;

/** The rows on offer, and the row lit: the first that can open, until the cursor moves. */
export const sessionChoicesAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  const choices =
    board === undefined
      ? []
      : sessionChoicesOf(board, get(goToSessionQueryAtom));
  const reachable = choices.filter(canOpen);
  const at = get(goToSessionCursorAtom);
  return {
    choices,
    cursor: reachable.find((c) => c.inboxId === at) ?? reachable[0],
  };
});

export const setSessionCursorAtom = Atom.writable<void, InboxId>(
  () => undefined,
  (ctx, inboxId) => ctx.set(goToSessionCursorAtom, inboxId),
);

/** One row up or down what can open, stopping at its ends. */
export const stepSessionAtom = Atom.writable<void, 1 | -1>(
  () => undefined,
  (ctx, by) => {
    const { choices, cursor } = ctx.get(sessionChoicesAtom);
    const reachable = choices.filter(canOpen);
    const at = reachable.findIndex((c) => c.inboxId === cursor?.inboxId);
    const next = reachable[at + by];
    if (next !== undefined) ctx.set(goToSessionCursorAtom, next.inboxId);
  },
);

/** Open a row's session, and shut the modal. */
export const pickSessionAtom = Atom.writable<void, string>(
  () => undefined,
  (ctx, link) => {
    ctx.set(goToSessionOpenAtom, false);
    ctx.set(openSessionLinkAtom, link);
  },
);
