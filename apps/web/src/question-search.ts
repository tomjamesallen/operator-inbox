import type {
  InboxBoardDto,
  InboxId,
  InboxViewDto,
} from '@operator-inbox/core/api';
import { Atom } from 'effect/reactivity';
import Fuse from 'fuse.js';
import {
  drawnBoardAtom,
  groupOf,
  linkTargetAtom,
  selectedInboxAtom,
  selectSidebarAtom,
  TARGET_PARAM,
  writeTargetHash,
} from './inbox';

// --- the question search: ⌘P / Ctrl+P ---------------------------------------------

// A ⌘P search menu. It matches a question number exactly when the input
// starts with `#` (`#330`), and is otherwise a text search over the title and
// body. It searches what the
// board already holds: every Inbox's waiting questions and the newest
// `PROCESSED_VIEW_CAP` processed ones, archived Inboxes too. An older
// processed question has no card to open, so it is not offered.

/** The column a question sits in, in the order the results show them. */
export type SearchColumn = 'operator' | 'agent' | 'processed';

export const SEARCH_COLUMNS: ReadonlyArray<SearchColumn> = [
  'operator',
  'agent',
  'processed',
];

export const SEARCH_HEADINGS: Record<SearchColumn, string> = {
  operator: 'Your inbox',
  agent: 'With the agent',
  processed: 'Processed',
};

export interface SearchEntry {
  readonly key: string;
  readonly inboxId: InboxId;
  readonly label: string;
  // Its machine's name, on another machine. Local is not named.
  readonly machine?: string;
  readonly archived: boolean;
  readonly column: SearchColumn;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly group: string;
}

export interface SearchSection {
  readonly column: SearchColumn;
  readonly heading: string;
  readonly items: ReadonlyArray<SearchEntry>;
}

// How many matches each column lists, at most.
export const SEARCH_SECTION_CAP = 20;

/** Every question on the board, one entry each. */
export const searchEntriesOf = (
  board: InboxBoardDto,
): ReadonlyArray<SearchEntry> => {
  const entries: Array<SearchEntry> = [];
  const add = (
    view: InboxViewDto,
    column: SearchColumn,
    questions: ReadonlyArray<
      | InboxViewDto['awaitingOperator'][number]
      | InboxViewDto['awaitingAgent'][number]
      | InboxViewDto['processed'][number]
    >,
  ) => {
    for (const q of questions)
      entries.push({
        key: `${view.inboxId}#${q.number}`,
        inboxId: view.inboxId,
        label: view.label,
        ...(view.machine === undefined ? {} : { machine: view.machine.label }),
        archived: view.archived,
        column,
        number: q.number,
        title: q.title,
        body: q.body,
        group: groupOf(q),
      });
  };
  for (const view of board.views) {
    add(view, 'operator', view.awaitingOperator);
    add(view, 'agent', view.awaitingAgent);
    add(view, 'processed', view.processed);
  }
  return entries;
};

// The title counts for twice the body. `ignoreLocation`, because a body runs
// long and a word near its end must match as well as one at its start.
const fuseOf = (entries: ReadonlyArray<SearchEntry>): Fuse<SearchEntry> =>
  new Fuse(entries, {
    keys: [
      { name: 'title', weight: 2 },
      { name: 'body', weight: 1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true,
  });

export interface SearchIndex {
  readonly entries: ReadonlyArray<SearchEntry>;
  readonly fuse: Fuse<SearchEntry>;
}

export const searchIndexOf = (board: InboxBoardDto): SearchIndex => {
  const entries = searchEntriesOf(board);
  return { entries, fuse: fuseOf(entries) };
};

/**
 * The matches for `query`, under one heading per column: Your inbox, With
 * the agent, Processed, each left out when it has none. `#330` (or `#` and
 * any number) matches that number exactly, in every Inbox, with the Inbox on
 * screen first; anything else is Fuse's ranking over title and body. An
 * archived Inbox's questions come after the active ones in either.
 */
export const searchQuestions = (
  index: SearchIndex,
  query: string,
  current: InboxId | undefined,
): ReadonlyArray<SearchSection> => {
  const text = query.trim();
  if (text === '') return [];
  let found: ReadonlyArray<SearchEntry>;
  if (text.startsWith('#')) {
    const digits = text.slice(1).trim();
    if (!/^\d+$/.test(digits)) return [];
    const number = Number(digits);
    found = index.entries
      .filter((e) => e.number === number)
      .map((e, at) => ({ e, at }))
      .sort(
        (x, y) =>
          Number(x.e.inboxId !== current) - Number(y.e.inboxId !== current) ||
          x.at - y.at,
      )
      .map(({ e }) => e);
  } else {
    found = index.fuse.search(text).map((r) => r.item);
  }
  // Archived last; otherwise the order above is kept.
  const ordered = [
    ...found.filter((e) => !e.archived),
    ...found.filter((e) => e.archived),
  ];
  return SEARCH_COLUMNS.flatMap((column) => {
    const items = ordered
      .filter((e) => e.column === column)
      .slice(0, SEARCH_SECTION_CAP);
    return items.length === 0
      ? []
      : [{ column, heading: SEARCH_HEADINGS[column], items }];
  });
};

// Whether the search is open, and what it holds. A fresh open starts empty.
export const questionSearchOpenAtom = Atom.make(false).pipe(Atom.keepAlive);
export const questionSearchQueryAtom = Atom.make('').pipe(Atom.keepAlive);

// The questions on the page, a greyed machine's included, indexed once per
// board read rather than per key.
const searchIndexAtom = Atom.make((get): SearchIndex | undefined => {
  const board = get(drawnBoardAtom);
  return board === undefined ? undefined : searchIndexOf(board);
});

export const questionSearchResultsAtom = Atom.make(
  (get): ReadonlyArray<SearchSection> => {
    const index = get(searchIndexAtom);
    if (index === undefined) return [];
    return searchQuestions(
      index,
      get(questionSearchQueryAtom),
      get(selectedInboxAtom),
    );
  },
);

/** Open or close the search; opening starts it empty. */
export const setQuestionSearchOpenAtom = Atom.writable<void, boolean>(
  () => undefined,
  (ctx, open) => {
    if (open) ctx.set(questionSearchQueryAtom, '');
    ctx.set(questionSearchOpenAtom, open);
  },
);

// Open a match: its Inbox and group in the sidebar, and its question as the link
// target, so the reader goes to it, in whichever queue it sits, and marks it.
export const openSearchEntryAtom = Atom.writable<void, SearchEntry>(
  () => undefined,
  (ctx, entry) => {
    ctx.set(questionSearchOpenAtom, false);
    ctx.set(selectSidebarAtom, {
      inboxId: entry.inboxId,
      groups: [entry.group],
    });
    // The hash names the question too, as a link does, so a reload lands on
    // it again; the next screen-state write takes it out, as it does a link's.
    if (typeof history !== 'undefined') {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      params.set(TARGET_PARAM, String(entry.number));
      history.replaceState(null, '', `${location.pathname}#${params}`);
    }
    ctx.set(linkTargetAtom, {
      target: { inboxId: entry.inboxId, number: entry.number },
      scrolled: false,
    });
  },
);

// ⌘P / Ctrl+P opens it by default (`search_questions`), and again closes
// it; the browser's print is not wanted here.
export const toggleSearchByKey = (get: Atom.AtomContext): boolean => {
  get.set(setQuestionSearchOpenAtom, !get.once(questionSearchOpenAtom));
  return true;
};

// --- clearing the mark: Ctrl+C ----------------------------------------------------

// Ctrl+C clears a link's mark, and takes `q` out of the hash, so a reload does not
// bring it back. Not while text is selected: off a Mac, Ctrl+C is copy, and copy
// wins.

/** Clear the mark, and `q` from the hash, so a reload does not bring it back. */
export const clearSelectionByKey = (get: Atom.AtomContext): boolean => {
  if ((document.getSelection()?.toString() ?? '') !== '') return false;
  if (get.once(linkTargetAtom).target === undefined) return false;
  get.set(linkTargetAtom, { target: undefined, scrolled: true });
  writeTargetHash(undefined);
  return true;
};
