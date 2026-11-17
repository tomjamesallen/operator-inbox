import {
  type InboxBoardDto,
  type InboxClashDto,
  InboxId,
  type InboxMachineKey,
  type InboxMachineRef,
  type InboxMachineStatusDto,
  InboxOperatorQuestionDto,
  type InboxViewDto,
  inboxMachineAdvice,
  isSessionLink,
  LOCAL_MACHINE,
  LOCAL_MACHINE_KEY,
  machineKeyOf,
  SERVE_MACHINES_READ_WORST,
  SESSION_LINK_KEY,
  SessionLink,
  type UnreadMachineStatusDto,
} from '@operator-inbox/core/api';
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Exit,
  Option,
  Schema,
} from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import { COPY_FEEDBACK_MS, copyText } from './clipboard';
import { clockAtom } from './clock';
import {
  type FailureText,
  failureText,
  ReadTimedOut,
  refusalText,
  type WriteRefusedTag,
} from './failure';
import { answerKey } from './inbox-queues';
import { tickEvery } from './poll';

export { answerKey };

// The inbox screen's data: ONE polled read of every Inbox
// (`/api/inbox-board`), the sidebar's selection in the path, the inbox filter
// and the groups in the hash, and the writes beside the board. The drafts are
// Atoms too (`responseDraftAtom`), so a draft outlives its question leaving the
// page. The reader's flow is the machine's, in `inbox-reader-machine.ts`.

// How often the inbox screen re-fetches: a question should show within a few
// seconds of being asked.
export const INBOX_POLL_INTERVAL_MS = 5_000;

// The one poll: the board reads on it, and so do the sidebar's widgets
// (`widgets.ts`), so the page keeps one timer.
export const inboxPollSignalAtom = tickEvery(INBOX_POLL_INTERVAL_MS);

// --- the path: All, or one Inbox ---------------------------------------------------

// The inbox id the path names, or none for All (and for any other page). The
// path is `/inbox/<inboxId>`, with an optional trailing slash.
export const inboxIdFromPath = (pathname: string): Option.Option<InboxId> => {
  const m = /^\/inbox\/([^/]+)\/?$/.exec(pathname);
  const raw = m?.[1];
  if (raw === undefined) return Option.none();
  try {
    return Option.some(InboxId.make(decodeURIComponent(raw)));
  } catch {
    // A malformed escape is not an id this page can ask for.
    return Option.none();
  }
};

export const inboxPath = (inboxId: InboxId | undefined): string =>
  inboxId === undefined ? '/inbox' : `/inbox/${encodeURIComponent(inboxId)}`;

const pathname = (): string =>
  typeof location === 'undefined' ? '/inbox' : location.pathname;

const hash = (): string =>
  typeof location === 'undefined' ? '' : location.hash;

// The sidebar's selection: an Inbox, or undefined for All. It is the path:
// read from it, written to it with `pushState` (the hash rides along), and
// read again on Back and Forward. The listener lives and dies with the node.
export const selectedInboxAtom: Atom.Writable<
  InboxId | undefined,
  InboxId | undefined
> = Atom.writable<InboxId | undefined, InboxId | undefined>(
  (get) => {
    if (typeof window !== 'undefined') {
      const onPop = () =>
        get.setSelf(Option.getOrUndefined(inboxIdFromPath(pathname())));
      window.addEventListener('popstate', onPop);
      get.addFinalizer(() => window.removeEventListener('popstate', onPop));
    }
    return Option.getOrUndefined(inboxIdFromPath(pathname()));
  },
  (ctx, next) => {
    // A link target names a question in the Inbox being left, so it stays
    // behind; the rest of the hash rides along.
    if (typeof history !== 'undefined')
      history.pushState(
        null,
        '',
        `${inboxPath(next)}${hashWithoutTarget(location.hash)}`,
      );
    ctx.setSelf(next);
  },
).pipe(Atom.keepAlive);

// --- the link target: one question, `/inbox/<id>#q=<n>` ---------------------------

// A link to one question is its Inbox's path with `q=<number>` in the hash.
// The reader goes to the question once, when it first shows, and marks it. The
// hash keeps `q` until the screen state is next written, so a reload of the link
// lands on it again.
export const TARGET_PARAM = 'q';

export interface LinkTarget {
  readonly inboxId: InboxId;
  readonly number: number;
}

/** The question a link names, or none: it needs an Inbox in the path. */
export const linkTargetOf = (
  pathname: string,
  hash: string,
): LinkTarget | undefined => {
  const inboxId = Option.getOrUndefined(inboxIdFromPath(pathname));
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get(TARGET_PARAM);
  if (inboxId === undefined || raw === null || !/^\d+$/.test(raw))
    return undefined;
  return { inboxId, number: Number(raw) };
};

/** The path and hash that link to one question. */
export const questionPath = (inboxId: InboxId, number: number): string =>
  `${inboxPath(inboxId)}#${TARGET_PARAM}=${number}`;

const hashWithoutTarget = (hash: string): string => {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete(TARGET_PARAM);
  const text = params.toString();
  return text === '' ? '' : `#${text}`;
};

/** Name a question in the hash, or none, so a reload lands where the bar is. */
export const writeTargetHash = (number: number | undefined): void => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (number === undefined) params.delete(TARGET_PARAM);
  else params.set(TARGET_PARAM, String(number));
  const text = params.toString();
  history.replaceState(
    null,
    '',
    `${location.pathname}${text === '' ? '' : `#${text}`}`,
  );
};

export interface LinkTargetState {
  readonly target: LinkTarget | undefined;
  // Whether the reader has been sent to it, so a redraw does not send it again.
  readonly scrolled: boolean;
}

// Read from the location when first used, and again when the hash changes to
// another question (a link pasted into the open tab), which scrolls to it.
export const linkTargetAtom: Atom.Writable<LinkTargetState, LinkTargetState> =
  Atom.writable<LinkTargetState, LinkTargetState>(
    (get) => {
      const read = (): LinkTargetState => ({
        target: linkTargetOf(pathname(), hash()),
        scrolled: false,
      });
      if (typeof window !== 'undefined') {
        // Only a link to another question scrolls again: a hash change
        // that keeps the same `q` (another key moving) leaves it be.
        const onHash = () => {
          const next = read();
          const now = Option.getOrUndefined(
            get.self<LinkTargetState>(),
          )?.target;
          if (
            next.target?.inboxId !== now?.inboxId ||
            next.target?.number !== now?.number
          )
            get.setSelf(next);
        };
        window.addEventListener('hashchange', onHash);
        get.addFinalizer(() =>
          window.removeEventListener('hashchange', onHash),
        );
      }
      return read();
    },
    (ctx, next) => ctx.setSelf(next),
  ).pipe(Atom.keepAlive);

// --- the hash: inbox filter and groups --------------------------------------------

// How the reader is looking at the screen. `inboxes` narrows the All view to
// the chosen Inboxes; empty means every Inbox.
// `groups` narrows the selected Inbox to the chosen groups (`DEFAULT_GROUP`
// for the ungrouped Questions); empty means the whole Inbox.
export interface InboxScreenState {
  readonly inboxes: ReadonlyArray<InboxId>;
  readonly groups: ReadonlyArray<string>;
}

export const DEFAULT_SCREEN_STATE: InboxScreenState = {
  inboxes: [],
  groups: [],
};

/**
 * `#inboxes=a,b&group=x&group=`; anything unreadable falls back
 * to the default. A group name is free text, so each group is its own `group`
 * parameter rather than a comma list, and the default group is the empty one.
 */
export const screenStateFromHash = (hash: string): InboxScreenState => {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const inboxes = (params.get('inboxes') ?? '')
    .split(',')
    .filter((s) => s.length > 0)
    .map((s) => InboxId.make(s));
  return {
    inboxes,
    groups: [...new Set(params.getAll('group').map((g) => g.trim()))],
  };
};

/** The hash for a state; the default state is no hash at all. */
export const hashOfScreenState = (s: InboxScreenState): string => {
  const params = new URLSearchParams();
  if (s.inboxes.length > 0) params.set('inboxes', s.inboxes.join(','));
  for (const g of s.groups) params.append('group', g);
  const text = params.toString();
  return text === '' ? '' : `#${text}`;
};

// Read from the hash when first used and again on Back and Forward, so a
// history entry brings back the groups it was on; every write writes the
// hash, so a reload keeps the filter and the groups.
export const screenStateAtom: Atom.Writable<
  InboxScreenState,
  InboxScreenState
> = Atom.writable<InboxScreenState, InboxScreenState>(
  (get) => {
    if (typeof window !== 'undefined') {
      const onPop = () => get.setSelf(screenStateFromHash(hash()));
      window.addEventListener('popstate', onPop);
      get.addFinalizer(() => window.removeEventListener('popstate', onPop));
    }
    return screenStateFromHash(hash());
  },
  (ctx, next) => {
    if (typeof history !== 'undefined')
      history.replaceState(
        null,
        '',
        `${location.pathname}${hashOfScreenState(next)}`,
      );
    ctx.setSelf(next);
  },
).pipe(Atom.keepAlive);

// --- groups ------------------------------------------------------------------------

// A group is a key in a Question's metadata dictionary, and only a filter. The
// agent puts a Question in one with
// `--meta group=<name>` and moves it with `operator-inbox meta <n>`.
export const GROUP_KEY = 'group';

// The group of every Question with no `group` key: "Default" in the sidebar.
export const DEFAULT_GROUP = '';

type AnyViewQuestion =
  | InboxViewDto['awaitingOperator'][number]
  | InboxViewDto['awaitingAgent'][number]
  | InboxViewDto['processed'][number];

export const groupOf = (question: AnyViewQuestion): string => {
  const group = question.metadata[GROUP_KEY];
  return typeof group === 'string' ? group.trim() : DEFAULT_GROUP;
};

/**
 * The groups holding a highlighted question waiting for the operator, so the
 * sidebar can mark where they are, in the highlight's yellow. Empty: nothing
 * in the Inbox is highlighted.
 */
export const highlightedGroups = (view: InboxViewDto): ReadonlySet<string> =>
  new Set(
    view.awaitingOperator
      .filter((q) => q.highlight !== undefined)
      .map((q) => groupOf(q)),
  );

export interface GroupRow {
  readonly group: string;
  readonly awaitingOperator: number;
  // Archived (core's `GroupArchived`): the sidebar folds it away under its
  // Inbox's "Archived groups", and its questions leave All and the Inbox's
  // own view.
  readonly archived: boolean;
}

/** An Inbox's archived groups: none from a serve that predates them. */
export const archivedGroupsOf = (view: InboxViewDto): ReadonlyArray<string> =>
  view.archivedGroups ?? [];

/**
 * An Inbox's groups for the sidebar: none while no Question has a group, so
 * the Inbox stays one row. Once any has, Default first, for the rest (shown
 * even when empty, so it is always there to pick), then every named
 * group A–Z, each with how many of its Questions wait for the operator and
 * whether it is archived.
 */
export const groupRowsOf = (view: InboxViewDto): ReadonlyArray<GroupRow> => {
  const counts = new Map<string, number>([[DEFAULT_GROUP, 0]]);
  for (const q of [...view.awaitingAgent, ...view.processed])
    counts.set(groupOf(q), counts.get(groupOf(q)) ?? 0);
  for (const q of view.awaitingOperator)
    counts.set(groupOf(q), (counts.get(groupOf(q)) ?? 0) + 1);
  if (counts.size === 1) return [];
  const named = [...counts.keys()]
    .filter((g) => g !== DEFAULT_GROUP)
    .sort((a, b) => a.localeCompare(b));
  const archived = archivedGroupsOf(view);
  return [DEFAULT_GROUP, ...named].map((group) => ({
    group,
    awaitingOperator: counts.get(group) ?? 0,
    archived: archived.includes(group),
  }));
};

/**
 * A view without its archived groups' questions: what All shows of an Inbox,
 * and the Inbox's own view with no group in force, as an archived Inbox's
 * cards leave All.
 */
export const withoutArchivedGroups = (view: InboxViewDto): InboxViewDto => {
  const archived = archivedGroupsOf(view);
  if (archived.length === 0) return view;
  const keep = (q: AnyViewQuestion) => !archived.includes(groupOf(q));
  return {
    ...view,
    awaitingOperator: view.awaitingOperator.filter(keep),
    awaitingAgent: view.awaitingAgent.filter(keep),
    processed: view.processed.filter(keep),
  };
};

/**
 * The groups that narrow a view: those chosen that the Inbox has. A group
 * the Inbox no longer has narrows nothing, so a stale hash shows the whole
 * Inbox rather than an empty one.
 */
export const groupsInForce = (
  view: InboxViewDto,
  chosen: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const has = new Set(groupRowsOf(view).map((r) => r.group));
  return chosen.filter((g) => has.has(g));
};

// With no group in force the Inbox shows whole, but for its archived groups,
// which show only when picked.
const narrowToGroups = (
  view: InboxViewDto,
  chosen: ReadonlyArray<string>,
): InboxViewDto => {
  const groups = groupsInForce(view, chosen);
  if (groups.length === 0) return withoutArchivedGroups(view);
  const keep = (q: AnyViewQuestion) => groups.includes(groupOf(q));
  return {
    ...view,
    awaitingOperator: view.awaitingOperator.filter(keep),
    awaitingAgent: view.awaitingAgent.filter(keep),
    processed: view.processed.filter(keep),
  };
};

export interface SidebarSelection {
  readonly inboxId: InboxId | undefined;
  readonly groups: ReadonlyArray<string>;
}

// A sidebar click: an Inbox (or All) and the groups it narrows to. The path
// moves first, so the new history entry is the one that gets the new groups
// and the entry left behind keeps its own.
export const selectSidebarAtom = Atom.writable<void, SidebarSelection>(
  () => undefined,
  (ctx, next) => {
    ctx.set(selectedInboxAtom, next.inboxId);
    // A filter comes only from an old link's hash, and nothing on the page shows
    // it: picking anything in the sidebar is what leaves it.
    ctx.set(screenStateAtom, {
      ...ctx.get(screenStateAtom),
      inboxes: [],
      groups: next.groups,
    });
  },
);

// --- the sidebar's width ----------------------------------------------------------

// The operator drags the sidebar wider or narrower. The width is remembered in this browser's
// localStorage, so a reload keeps it; `null` is the design's own width
// (`w-rail`), which a double-click or Enter on the handle goes back to. Where
// localStorage cannot be read, the sidebar keeps the design's width.
export const INBOX_RAIL_MAX_PX = 520;
export const INBOX_RAIL_KEY_STEP_PX = 16;

const browserStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => localStorage),
);

export const inboxRailWidthAtom = Atom.kvs({
  runtime: browserStorage,
  key: 'operator-inbox:inbox-rail-width',
  schema: Schema.NullOr(Schema.Number),
  defaultValue: () => null,
}).pipe(Atom.keepAlive);

// --- the sidebar's search ---------------------------------------------------------

// What the sidebar's search box holds, matched fuzzily. Empty shows every row. It is not remembered:
// a reload starts with the whole sidebar.
export const sidebarQueryAtom = Atom.make('').pipe(Atom.keepAlive);

/**
 * How well `text` matches `query`, or undefined for no match. Each word of
 * the query must appear in the text with its letters in order, gaps allowed
 * ("mkchk" matches "Markdown check"), ignoring case. A letter that follows
 * the one before it, or starts a word, scores more, so the closest match
 * ranks first. An empty query matches everything with score 0.
 */
export const fuzzyScore = (query: string, text: string): number | undefined => {
  const hay = text.toLowerCase();
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/)) {
    if (word.length === 0) continue;
    let at = -1;
    let previous = -2;
    let score = 0;
    for (const ch of word) {
      at = hay.indexOf(ch, at + 1);
      if (at === -1) return undefined;
      score += 1;
      if (at === previous + 1) score += 3;
      if (at === 0 || /[^a-z0-9]/.test(hay[at - 1] ?? '')) score += 2;
      previous = at;
    }
    total += score;
  }
  return total;
};

// How good a match must be to show, as a share of the best possible score
// for the query (the query matched against itself): below it, a match is too
// scattered to mean anything, so it is hidden.
export const SEARCH_THRESHOLD = 0.5;

// How many of the best matches the sidebar marks.
export const SEARCH_TOP = 3;

/** A match's quality from 0 to 1, or undefined below the threshold. */
const quality = (query: string, text: string): number | undefined => {
  const score = fuzzyScore(query, text);
  const ideal = fuzzyScore(query, query);
  if (score === undefined || ideal === undefined || ideal === 0)
    return undefined;
  const q = score / ideal;
  return q < SEARCH_THRESHOLD ? undefined : q;
};

/** One sidebar match: an Inbox's name (`group` absent) or one of its groups. */
export interface SidebarMatch {
  readonly key: string;
  readonly quality: number;
}

/** The key of an Inbox's own row, or of one of its group rows. */
export const sidebarKey = (inboxId: InboxId, group?: string): string =>
  group === undefined ? inboxId : `${inboxId}/${group}`;

/**
 * The sidebar's rows for a query: the Inboxes whose name matches, or one of
 * whose named groups does, best match first (ties keep the server's order):
 * an Inbox still shows when one of its groups matches. For each, `groups` is
 * the groups to show: every group when the name matches, only the matching
 * ones otherwise; `matches` is what matched, for marking the
 * best. With an empty query, every row as it is.
 */
export const searchSidebar = <
  R extends { readonly inboxId: InboxId; readonly label: string },
>(
  rows: ReadonlyArray<R>,
  groupsOf: (row: R) => ReadonlyArray<string>,
  query: string,
): ReadonlyArray<{
  readonly row: R;
  readonly groups?: ReadonlySet<string>;
  readonly matches: ReadonlyArray<SidebarMatch>;
}> => {
  if (query.trim().length === 0)
    return rows.map((row) => ({ row, matches: [] }));
  return rows
    .flatMap((row, order) => {
      const own = quality(query, row.label);
      // "Default" is not a name the agent gave, so the search skips it.
      const groups = groupsOf(row).flatMap((g) => {
        if (g === DEFAULT_GROUP) return [];
        const q = quality(query, g);
        return q === undefined ? [] : [{ g, q }];
      });
      const matches: Array<SidebarMatch> = [
        ...(own === undefined
          ? []
          : [{ key: sidebarKey(row.inboxId), quality: own }]),
        ...groups.map((x) => ({
          key: sidebarKey(row.inboxId, x.g),
          quality: x.q,
        })),
      ];
      if (matches.length === 0) return [];
      const best = Math.max(...matches.map((m) => m.quality));
      return [
        {
          row,
          order,
          best,
          matches,
          ...(own === undefined
            ? { groups: new Set(groups.map((x) => x.g)) }
            : {}),
        },
      ];
    })
    .sort((a, b) => b.best - a.best || a.order - b.order)
    .map(({ row, groups, matches }) =>
      groups === undefined ? { row, matches } : { row, groups, matches },
    );
};

// Whether the sidebar shows only what is pinned, by the same rules as the
// text search for whether a parent shows. Not remembered across a reload.
export const sidebarPinnedOnlyAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * Narrow the search's rows to what is pinned, by the search's own rules: a
 * pinned Inbox shows with the groups the search left it (all of them when its
 * name matched); an unpinned Inbox shows only if one of those groups is
 * pinned, with only its pinned groups. "Default" cannot be pinned, so it
 * shows only under a pinned Inbox.
 */
export const pinnedOnly = <
  R extends { readonly pinned: boolean },
  H extends { readonly row: R; readonly groups?: ReadonlySet<string> },
>(
  hits: ReadonlyArray<H>,
  groupsOf: (row: R) => ReadonlyArray<string>,
  pinnedGroupsOf: (row: R) => ReadonlyArray<string>,
): ReadonlyArray<H> =>
  hits.flatMap((hit) => {
    if (hit.row.pinned) return [hit];
    const left = hit.groups ?? new Set(groupsOf(hit.row));
    const pinned = pinnedGroupsOf(hit.row).filter((g) => left.has(g));
    return pinned.length === 0 ? [] : [{ ...hit, groups: new Set(pinned) }];
  });

/** The keys of the best `SEARCH_TOP` matches, best first; ties keep order. */
export const topMatches = (
  matches: ReadonlyArray<SidebarMatch>,
): ReadonlySet<string> =>
  new Set(
    matches
      .map((m, i) => ({ m, i }))
      .sort((a, b) => b.m.quality - a.m.quality || a.i - b.i)
      .slice(0, SEARCH_TOP)
      .map(({ m }) => m.key),
  );

// The sidebar's Archived section: the archived Inboxes, under a fold that
// starts closed: archiving an Inbox moves it there. Each machine section has its
// own, keyed by the machine's key (`InboxMachineKey`), never its label.
export const archivedSectionOpenAtom = Atom.family(
  (_machine: InboxMachineKey) => Atom.make(false).pipe(Atom.keepAlive),
);

// --- the sidebar's machine sections ----------------------------------------------

// The combined inbox: below All, one section per machine, in the board's
// `machines` order, which puts Local first (Local is the machine the operator
// sits at).
// Inbox names are unique only within one machine, so a section holds its own
// machine's Inboxes, matched by key (`machineKeyOf`), and nothing is merged
// across sections by name. A board with no `machines` (a serve from before
// Inbox machines), or an empty list (a serve with no Inbox machines), is
// Local's alone, with the board's own total.

type InboxRow = InboxBoardDto['inboxes'][number];

export type MachineSection = InboxMachineStatusDto & {
  readonly inboxes: ReadonlyArray<InboxRow>;
  // The machine missed this poll after answering the one before, so these
  // are the Inboxes it held then, drawn greyed (`drawnBoardOf`).
  readonly greyed: boolean;
  // The waiting count its heading shows: serve's for Local and a reachable
  // machine; for a greyed one, what its greyed Inboxes hold, so the count
  // agrees with the cards drawn;
  // none for a machine with nothing drawn.
  readonly waiting: number | undefined;
};

/** What the operator's column draws for these rows: their waiting questions, archived and muted Inboxes left out, as serve counts them. */
export const waitingOf = (rows: ReadonlyArray<InboxRow>): number =>
  rows.reduce(
    (n, r) => (r.archived || r.muted === true ? n : n + r.awaitingOperator),
    0,
  );

/** The label of the machine a row, a view or a refusal is on: Local's when it carries none. */
export const machineLabelOf = (x: {
  readonly machine?: InboxMachineRef;
}): string => x.machine?.label ?? LOCAL_MACHINE;

/** A machine that could not be read: what advice is given for. */
export const isUnreadMachine = (
  m: InboxMachineStatusDto,
): m is UnreadMachineStatusDto =>
  m.status === 'unreachable' || m.status === 'incompatible';

const machinesOf = (
  board: Pick<InboxBoardDto, 'machines' | 'totalAwaitingOperator'>,
): ReadonlyArray<InboxMachineStatusDto> =>
  board.machines !== undefined && board.machines.length > 0
    ? board.machines
    : [
        {
          status: 'local',
          key: LOCAL_MACHINE_KEY,
          label: LOCAL_MACHINE,
          awaitingOperator: board.totalAwaitingOperator,
        },
      ];

/**
 * The board's machine sections, in the board's order (Local first), each
 * holding its own Inboxes in the board's order and the waiting count serve
 * gave it. The sidebar draws one section per entry, and leaves the heading
 * off while there is only one.
 */
export const machineSectionsOf = (
  board: Pick<
    DrawnBoard,
    'inboxes' | 'machines' | 'totalAwaitingOperator' | 'greyed'
  >,
): ReadonlyArray<MachineSection> =>
  machinesOf(board).map((m) => {
    const inboxes = board.inboxes.filter((i) => machineKeyOf(i) === m.key);
    const greyed = board.greyed.has(m.key);
    return {
      ...m,
      inboxes,
      greyed,
      waiting:
        'awaitingOperator' in m
          ? m.awaitingOperator
          : greyed
            ? waitingOf(inboxes)
            : undefined,
    };
  });

// Which machine sections the operator has folded or opened, by machine key,
// kept in this browser's localStorage as the sidebar's width is. A key not
// in it takes its section's default (`machineSectionOpen`).
export const machineSectionsOpenAtom = Atom.kvs({
  runtime: browserStorage,
  key: 'operator-inbox:inbox-machine-sections-open',
  schema: Schema.Record(Schema.String, Schema.Boolean),
  defaultValue: (): Record<string, boolean> => ({}),
}).pipe(Atom.keepAlive);

/**
 * Whether a machine section is open: the operator's own choice for its key
 * when there is one; otherwise open, except an unreachable machine, which
 * starts folded, unless it is greyed: its last sections stay in sight rather
 * than folding at once.
 */
export const machineSectionOpen = (
  stored: Readonly<Record<string, boolean>>,
  section: Pick<MachineSection, 'key' | 'status' | 'greyed'>,
): boolean =>
  stored[section.key] ?? (section.status !== 'unreachable' || section.greyed);

/**
 * What an opened section of a machine that cannot be read shows, from core's
 * one advice (`inboxMachineAdvice`, which doctor gives too): the tunnel
 * command, to copy, when its tunnel is down; otherwise the detail Local's
 * serve gave, with what to do about it. Undefined for Local and for a
 * reachable machine.
 */
export type MachineHint =
  | { readonly _tag: 'Tunnel'; readonly command: string }
  | { readonly _tag: 'Detail'; readonly text: string };

export const machineHintOf = (
  machine: InboxMachineStatusDto,
): MachineHint | undefined => {
  if (!isUnreadMachine(machine)) return undefined;
  const { advice, command } = inboxMachineAdvice(machine);
  return command === undefined
    ? { _tag: 'Detail', text: `${machine.detail}. ${advice}.` }
    : { _tag: 'Tunnel', command };
};

// What this page last saw of each Inbox, by id, from every board it has
// loaded: which machine it is on, and its name. Only that, never what the
// Inbox held. When a poll comes back without the selected Inbox, this says
// whether it lives on a machine that could not be read, rather than calling
// it missing; and the tab keeps the Inbox's name while it is out of reach.
export interface InboxSeen {
  readonly machine: InboxMachineKey;
  readonly label: string;
}
export type InboxesSeen = ReadonlyMap<InboxId, InboxSeen>;

// The most Inboxes the page remembers seeing, the one gone from the boards
// longest forgotten first. No requirement sets it, and nothing on the
// wire bounds how many Inboxes a board holds, so it cannot be derived: it is
// a bound on memory only. Each entry is an id, a machine key and a name, so
// 500 is tens of kilobytes at most, and it is far more Inboxes than any
// board holds today (a few dozen across every machine), so only an Inbox
// long gone from every board is forgotten, and then is called missing or
// unknown rather than out of reach. Raise it if one board ever holds near
// that many.
export const INBOXES_SEEN_LIMIT = 500;

/** What was seen before, with each of the board's Inboxes seen last, kept to INBOXES_SEEN_LIMIT. */
export const inboxesSeenAfter = (
  previous: InboxesSeen,
  board: Pick<InboxBoardDto, 'inboxes'>,
): InboxesSeen => {
  const seen = new Map(previous);
  for (const i of board.inboxes) {
    seen.delete(i.inboxId);
    seen.set(i.inboxId, { machine: machineKeyOf(i), label: i.label });
  }
  const over = seen.size - INBOXES_SEEN_LIMIT;
  for (const id of [...seen.keys()].slice(0, Math.max(0, over)))
    seen.delete(id);
  return seen;
};

export const inboxesSeenAtom: Atom.Atom<InboxesSeen> = Atom.make((get) => {
  const previous = Option.getOrElse(
    get.self<InboxesSeen>(),
    () => new Map<InboxId, InboxSeen>(),
  );
  const board = Option.getOrUndefined(AsyncResult.value(get(inboxBoardAtom)));
  return board === undefined ? previous : inboxesSeenAfter(previous, board);
}).pipe(Atom.keepAlive);

/**
 * What the page says when the selected Inbox is not on the board.
 * `Clashed`: two machines claim it, so it is refused. `Unreached`: it was last seen on a machine this poll could not read,
 * so it is there, out of reach, with that machine's hint. `Unknown`: it has
 * not been seen, or was last seen on a machine key the board no longer has,
 * and some machines could not be read, so it may be on one of them.
 * `Missing`: it is not where it was last seen, and that machine answered
 * (Local always has, when the board loads), or nothing on the board was seen
 * of it and every machine answered.
 */
export type MissingInbox =
  | { readonly _tag: 'Clashed'; readonly clash: InboxClashDto }
  | { readonly _tag: 'Unreached'; readonly machine: UnreadMachineStatusDto }
  | {
      readonly _tag: 'Unknown';
      readonly machines: ReadonlyArray<UnreadMachineStatusDto>;
    }
  | { readonly _tag: 'Missing' };

export const missingInboxOf = (
  board: Pick<InboxBoardDto, 'machines' | 'clashes' | 'totalAwaitingOperator'>,
  selected: InboxId,
  seen: InboxesSeen,
): MissingInbox => {
  const clash = board.clashes?.find(
    (c) => c.inboxId === selected && c.outcome === 'refused',
  );
  if (clash !== undefined) return { _tag: 'Clashed', clash };
  const machines = machinesOf(board);
  const unread = machines.filter(isUnreadMachine);
  // A machine key no longer on the board (its entry moved to another port,
  // or was removed) did not answer this read, so what was seen of it says
  // nothing about where the Inbox is now: it counts as never seen, never as
  // Missing on a machine that answered.
  const seenOn = seen.get(selected)?.machine;
  const owner = machines.some((m) => m.key === seenOn) ? seenOn : undefined;
  if (owner === undefined)
    return unread.length > 0
      ? { _tag: 'Unknown', machines: unread }
      : { _tag: 'Missing' };
  const machine = unread.find((m) => m.key === owner);
  return machine === undefined
    ? { _tag: 'Missing' }
    : { _tag: 'Unreached', machine };
};

// --- a machine that misses one poll ---------------------------------------------

// The board as the page draws it. When an Inbox machine that answered the
// last poll misses this one, its Inboxes and views from that last poll are
// kept on the page, greyed (`greyed` holds its key), instead of folding at
// once: one miss is a flap, as a slow answer is. A machine that misses a
// second poll in a row folds: its Inboxes leave the page until it answers
// again, and the selected one's notice says its machine cannot be reached.
// The copy lives in the browser only; serve keeps none.
export interface DrawnBoard extends InboxBoardDto {
  readonly greyed: ReadonlySet<InboxMachineKey>;
}

interface MachineHeld {
  readonly inboxes: ReadonlyArray<InboxRow>;
  readonly views: ReadonlyArray<InboxViewDto>;
}

// What `drawnBoardAtom` keeps between polls: the board it last drew from,
// what it drew, and each machine's Inboxes and views from the last poll it
// answered, for the machines that answered that last poll.
export interface DrawnBoardState {
  readonly source: InboxBoardDto;
  readonly drawn: DrawnBoard;
  readonly held: ReadonlyMap<InboxMachineKey, MachineHeld>;
}

const NONE_GREYED: ReadonlySet<InboxMachineKey> = new Set();

/**
 * The next board to draw: `board` itself, with each machine that answered
 * the previous board and misses this one drawn from what it held then.
 * Sections keep the board's machine order; a held Inbox the board now holds
 * itself (from another machine), or refuses as a clash, is left out.
 */
export const drawnBoardOf = (
  previous: DrawnBoardState | undefined,
  board: InboxBoardDto,
): DrawnBoardState => {
  const machines = machinesOf(board);
  const held = new Map<InboxMachineKey, MachineHeld>();
  const greyed = new Set<InboxMachineKey>();
  const onBoard = new Set<InboxId>(board.inboxes.map((i) => i.inboxId));
  for (const c of board.clashes ?? [])
    if (c.outcome === 'refused') onBoard.add(c.inboxId);
  const parts = machines.map((m): MachineHeld => {
    const own = <R extends { readonly machine?: InboxMachineRef }>(
      rows: ReadonlyArray<R>,
    ) => rows.filter((r) => machineKeyOf(r) === m.key);
    const now = { inboxes: own(board.inboxes), views: own(board.views) };
    if (m.status === 'reachable') held.set(m.key, now);
    const last = previous?.held.get(m.key);
    if (!isUnreadMachine(m) || last === undefined) return now;
    greyed.add(m.key);
    const kept = (id: InboxId) => !onBoard.has(id);
    return {
      inboxes: last.inboxes.filter((i) => kept(i.inboxId)),
      views: last.views.filter((v) => kept(v.inboxId)),
    };
  });
  // Greyed cards are counted: All's total adds what each greyed
  // machine's kept Inboxes hold, as serve's total counts a reachable one's, so
  // every count agrees with the cards drawn.
  const heldWaiting = parts.reduce(
    (n, p, i) =>
      greyed.has(machines[i]?.key ?? LOCAL_MACHINE_KEY)
        ? n + waitingOf(p.inboxes)
        : n,
    0,
  );
  const drawn: DrawnBoard =
    greyed.size === 0
      ? { ...board, greyed: NONE_GREYED }
      : {
          ...board,
          inboxes: parts.flatMap((p) => p.inboxes),
          views: parts.flatMap((p) => p.views),
          totalAwaitingOperator: board.totalAwaitingOperator + heldWaiting,
          greyed,
        };
  return { source: board, drawn, held };
};

// --- the reads -------------------------------------------------------------------

// How long the page waits for one board read before it gives it up. The longest serve waits on its machines for a board read is
// one machine read timeout (`SERVE_MACHINES_READ_WORST` in core: every
// machine read at once, none read again, and Herdr never on the path). A read
// well past that is one serve is not answering at all (a stalled proxy, a
// half-open socket), and nothing else would end it, since a read in flight is
// never cut off by the poll. So the bound is three times serve's
// worst, 30 s: a read that serve answers slowly still lands.
export const BOARD_READ_BOUND = Duration.times(SERVE_MACHINES_READ_WORST, 3);

// The board, read through the page's client and given up after
// `BOARD_READ_BOUND` on the clock `clockAtom` holds, so a test drives it with a
// `TestClock`.
const boardReadAtom = InboxClient.runtime.atom((get) =>
  InboxClient.use((client) => client.inbox.board({ query: {} })).pipe(
    Effect.timeoutOrElse({
      duration: BOARD_READ_BOUND,
      orElse: () =>
        Effect.fail(
          new ReadTimedOut({
            message: `operator-inbox serve did not answer within ${Duration.format(BOARD_READ_BOUND)}, so the page gave the read up and reads again.`,
          }),
        ),
    }),
    Effect.provideService(Clock.Clock, get(clockAtom)),
  ),
);

// Each refresh of `inboxBoardAtom` asks through this Atom: refreshed, it
// builds a new object, so its listener hears every ask.
const boardAskAtom: Atom.Atom<object> = Atom.readable(() => ({}));

// The whole screen, re-read on every poll tick: the sidebar's rows and every
// Inbox's view. Every write, Ctrl+R and the tab shown again refresh it, so
// everything fetches through this one Atom.
//
// A read in flight is never cut off by a refresh. Re-reading interrupts the
// read in flight, and serve may take up to its machine read timeout (10 s) to
// answer while a machine hangs, longer than the
// poll: so a refresh asked for while a read is in flight, by a tick or
// anything else, waits for that read to land, and then one more read
// follows. Otherwise no board would land while one machine hangs, Local's
// Inboxes included, and the machine would never grey. Only the read's own
// bound (`BOARD_READ_BOUND`) gives it up, so one read that never settles
// cannot freeze the page.
export const inboxBoardAtom: Atom.Atom<Atom.Type<typeof boardReadAtom>> =
  Atom.readable(
    (get) => {
      let again = false;
      const ask = () => {
        if (get.once(boardReadAtom).waiting) again = true;
        else get.refresh(boardReadAtom);
      };
      // Read once first, so each is built (the poll's timer started) and its
      // listener hears its next change.
      get.once(inboxPollSignalAtom);
      get.once(boardAskAtom);
      get.subscribe(inboxPollSignalAtom, ask);
      get.subscribe(boardAskAtom, ask);
      get.subscribe(boardReadAtom, (result) => {
        get.setSelf(result);
        if (!again || result.waiting) return;
        again = false;
        get.refresh(boardReadAtom);
      });
      return get.once(boardReadAtom);
    },
    (refresh) => refresh(boardAskAtom),
  );

// The board as the page draws it (`drawnBoardOf`): the last board that
// loaded, with a machine that missed this one poll kept greyed. Undefined
// until a board has loaded. The state is kept between polls; each board is
// read once, so a refresh that brings no new board counts no miss.
const drawnBoardStateAtom = Atom.make((get): DrawnBoardState | undefined => {
  const previous = Option.getOrUndefined(
    get.self<DrawnBoardState | undefined>(),
  );
  const board = Option.getOrUndefined(AsyncResult.value(get(inboxBoardAtom)));
  if (board === undefined || board === previous?.source) return previous;
  return drawnBoardOf(previous, board);
}).pipe(Atom.keepAlive);

export const drawnBoardAtom: Atom.Atom<DrawnBoard | undefined> = Atom.make(
  (get) => get(drawnBoardStateAtom)?.drawn,
);

// A browser throttles timers in a hidden tab, so on return the 5s poll can be
// a minute behind. When the page becomes visible again it refreshes at once.
export const inboxVisibleRefreshAtom: Atom.Atom<void> = Atom.readable((get) => {
  if (typeof document === 'undefined') return;
  const onVisibility = () => {
    if (document.visibilityState === 'visible') get.refresh(inboxBoardAtom);
  };
  document.addEventListener('visibilitychange', onVisibility);
  get.addFinalizer(() =>
    document.removeEventListener('visibilitychange', onVisibility),
  );
});

// --- what the screen shows ---------------------------------------------------------

/**
 * The views the screen shows: the selected Inbox's (archived or not), narrowed
 * to the chosen groups when it has any of them, or for All every ACTIVE
 * Inbox's, narrowed by the filter when it names any. An archived Inbox's
 * cards leave the All view, and so do a muted one's; an archived group's
 * leave All and the Inbox's own view, and show when the group is picked. An id the board no
 * longer holds narrows to nothing it can show. Groups narrow only a selected
 * Inbox: the sidebar nests them under one.
 */
export const viewsShown = (
  board: InboxBoardDto,
  selected: InboxId | undefined,
  filter: ReadonlyArray<InboxId>,
  groups: ReadonlyArray<string>,
  onlyPinned = false,
): ReadonlyArray<InboxViewDto> => {
  const pinned = (v: InboxViewDto) =>
    onlyPinned ? narrowToPinned(board, v) : v;
  if (selected !== undefined)
    return board.views
      .filter((v) => v.inboxId === selected)
      .map((v) => pinned(narrowToGroups(v, groups)));
  const active = board.views.filter((v) => !v.archived && v.muted !== true);
  return (
    filter.length === 0
      ? active
      : active.filter((v) => filter.includes(v.inboxId))
  ).map((v) => pinned(withoutArchivedGroups(v)));
};

/** The pinned groups the pinned filter shows: an archived one's pin waits. */
export const pinnedGroupsShown = (view: InboxViewDto): ReadonlyArray<string> =>
  view.pinnedGroups.filter((g) => !archivedGroupsOf(view).includes(g));

/**
 * A view narrowed to what is pinned, by the sidebar filter's rules: with the
 * pin toggle on, the inbox panel keeps only what belongs to a pinned group or
 * Inbox. Every question of a pinned Inbox, and of an unpinned one only those in a
 * pinned group. Nothing of an archived Inbox, whose pins wait for it to come
 * back: the sidebar leaves it out too, so its own page narrows to nothing. An
 * archived group's pin waits in the same way.
 */
const narrowToPinned = (
  board: InboxBoardDto,
  view: InboxViewDto,
): InboxViewDto => {
  if (
    !view.archived &&
    board.inboxes.find((i) => i.inboxId === view.inboxId)?.pinned === true
  )
    return view;
  const keep = (q: AnyViewQuestion) =>
    !view.archived && pinnedGroupsShown(view).includes(groupOf(q));
  return {
    ...view,
    awaitingOperator: view.awaitingOperator.filter(keep),
    awaitingAgent: view.awaitingAgent.filter(keep),
    processed: view.processed.filter(keep),
  };
};

/**
 * The line under "Your inbox" that says what the panel shows, and whether
 * only the pinned is in view: the Inbox and its groups in force, or the
 * Inboxes the filter picks, or all of them. The page adds the pin icon when
 * the pinned filter is on. With it on, an unpinned Inbox shows only its
 * pinned groups, so the line names those: the pinned groups among those in force, or all of them when none is.
 */
export const scopeLine = (
  board: InboxBoardDto,
  selected: InboxId | undefined,
  filter: ReadonlyArray<InboxId>,
  groups: ReadonlyArray<string>,
  onlyPinned = false,
): string => {
  const labelOf = (id: InboxId) =>
    board.inboxes.find((i) => i.inboxId === id)?.label ?? id;
  let scope: string;
  if (selected !== undefined) {
    const view = board.views.find((v) => v.inboxId === selected);
    let inForce = view === undefined ? [] : groupsInForce(view, groups);
    const inboxPinned =
      board.inboxes.find((i) => i.inboxId === selected)?.pinned === true;
    if (onlyPinned && !inboxPinned && view !== undefined) {
      const pinned = view.archived ? [] : pinnedGroupsShown(view);
      inForce =
        inForce.length === 0
          ? pinned
          : inForce.filter((g) => pinned.includes(g));
    }
    const named = inForce.map((g) => (g === DEFAULT_GROUP ? 'Default' : g));
    scope =
      named.length === 0
        ? labelOf(selected)
        : `${labelOf(selected)} › ${named.join(', ')}`;
  } else
    scope =
      filter.length === 0 ? 'All inboxes' : filter.map(labelOf).join(', ');
  return scope;
};

const DAY_MS = 86_400_000;

// Compact relative age: 40m, 5h, 3d, 6w, 4mo, or an em dash when unknown.
export const relAge = (days: number | undefined): string => {
  if (days === undefined) return '—';
  const h = days * 24;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 24) return `${Math.round(h)}h`;
  if (h < 24 * 14) return `${Math.round(h / 24)}d`;
  if (h < 24 * 90) return `${Math.round(h / 24 / 7)}w`;
  return `${Math.round(h / 24 / 30)}mo`;
};

/** "3h ago" from an ISO stamp and now; undefined when the stamp is absent. */
export const agoOf = (
  at: string | undefined,
  nowMs: number,
): string | undefined => {
  if (at === undefined) return undefined;
  const then = Option.getOrUndefined(
    Option.map(DateTime.make(at), DateTime.toEpochMillis),
  );
  if (then === undefined) return undefined;
  return `${relAge(Math.max(0, nowMs - then) / DAY_MS)} ago`;
};

// --- the writes ------------------------------------------------------------------

// What the operator has typed in the response boxes, by card (keyed like
// `answerKey`), each draft naming its own Inbox and question, so nothing
// takes the key apart again. It lives here rather than in the boxes, so a
// draft survives its card leaving the screen: when an Inbox machine cannot be
// read its cards unmount, and when it answers again each box comes back with
// its draft. It is kept in this tab's sessionStorage, so a reload keeps it
// too: "reload to check", after a write whose
// outcome is unknown, throws nothing typed away, while a machine is down
// included. The tab's storage, not localStorage, so a draft never outlives
// its tab or shows in another. An emptied box, and an answer sent from this
// page, drop the entry; so does a board on which the question's Inbox no
// longer waits on the operator for it: answered in another tab or
// on its machine, withdrawn, or processed (`draftsStillWaiting`).
export const ResponseDraft = Schema.Struct({
  inboxId: InboxId,
  number: InboxOperatorQuestionDto.fields.number,
  text: Schema.String,
});
export type ResponseDraft = typeof ResponseDraft.Type;
export type ResponseDrafts = ReadonlyMap<string, ResponseDraft>;

/**
 * The drafts whose question still waits on the operator, as far as `board`
 * can say: a draft is dropped only when its Inbox is on the board and the
 * question is not among those waiting there. A draft whose Inbox is not on
 * the board (its machine was not read, or the Inbox is refused as a clash)
 * is kept. The same map when nothing is dropped.
 */
export const draftsStillWaiting = (
  drafts: ResponseDrafts,
  board: Pick<InboxBoardDto, 'views'>,
): ResponseDrafts => {
  const onBoard = new Set<InboxId>(board.views.map((v) => v.inboxId));
  const waiting = new Set(
    board.views.flatMap((v) =>
      v.awaitingOperator.map((q) => answerKey(v.inboxId, q.number)),
    ),
  );
  const gone = [...drafts].filter(
    ([key, d]) => onBoard.has(d.inboxId) && !waiting.has(key),
  );
  if (gone.length === 0) return drafts;
  const kept = new Map(drafts);
  for (const [key] of gone) kept.delete(key);
  return kept;
};

const tabStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => sessionStorage),
);

const storedDraftsAtom = Atom.kvs({
  runtime: tabStorage,
  key: 'operator-inbox:inbox-response-drafts',
  schema: Schema.Array(ResponseDraft),
  defaultValue: (): ReadonlyArray<ResponseDraft> => [],
}).pipe(Atom.keepAlive);

export const responseDraftsAtom: Atom.Atom<ResponseDrafts> = Atom.make(
  (get): ResponseDrafts => {
    const drafts: ResponseDrafts = new Map(
      get(storedDraftsAtom).map((d) => [answerKey(d.inboxId, d.number), d]),
    );
    const board = Option.getOrUndefined(AsyncResult.value(get(inboxBoardAtom)));
    return board === undefined ? drafts : draftsStillWaiting(drafts, board);
  },
).pipe(Atom.keepAlive);

// One card's draft text, '' when it has none. Writing it keeps the drafts
// still waiting and this one, so a dropped draft leaves the tab's storage
// at the next keystroke.
export const responseDraftAtom = Atom.family((key: string) =>
  Atom.writable(
    (get) => get(responseDraftsAtom).get(key)?.text ?? '',
    (ctx, draft: ResponseDraft) => {
      const drafts = new Map(ctx.get(responseDraftsAtom));
      if (draft.text === '') drafts.delete(key);
      else drafts.set(key, draft);
      ctx.set(storedDraftsAtom, [...drafts.values()]);
    },
  ),
);

// --- the writes ------------------------------------------------------------------

// A write's failure whose card, row or header left the page while it was in
// flight (a card folds, the Inbox is switched, a row is filtered out), so its own place cannot say it. The page lists each until the
// operator clears it.
export interface StrayWrite {
  readonly id: number;
  readonly text: string;
}

export const strayWritesAtom = Atom.make<ReadonlyArray<StrayWrite>>([]).pipe(
  Atom.keepAlive,
);

export const addStrayWrite = (
  registry: Atom.FnContext['registry'],
  text: string,
): void =>
  registry.update(strayWritesAtom, (stray) => [
    ...stray,
    { id: (stray.at(-1)?.id ?? 0) + 1, text },
  ]);

// What a write was, for its failure's words: "Your answer to #2 in grove",
// what was not done ("Not sent"), and the endpoint's own refusal.
export interface WriteWords {
  readonly inboxId: InboxId;
  readonly what: (inboxLabel: string) => string;
  readonly notDone: string;
  readonly refused: WriteRefusedTag;
  // No place on the page reads this write: a key sent it with its row out of
  // sight, or nothing but a key ever sends it. Its failure is a stray from the
  // start. A function asks at the failure, for a place that may have left.
  readonly placeless?: boolean | (() => boolean);
}

const isPlaceless = ({ placeless }: WriteWords): boolean =>
  typeof placeless === 'function' ? placeless() : placeless === true;

/**
 * Send a write, and run it to its end: it is never cut off when its place
 * leaves the page, which would abort the request serve may be forwarding,
 * leaving it unknown whether it landed. When it lands, `landed`
 * runs (a board refresh, at least) whether its place is still there or not.
 * When it fails after its place has left, the failure joins
 * `strayWritesAtom`; while its place is there, the place says it, from the
 * write's own Atom.
 */
export const sendWrite = <A, E, R>(
  get: Atom.FnContext,
  words: WriteWords,
  call: Effect.Effect<A, E, R>,
  landed: (registry: Atom.FnContext['registry']) => void,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    // The write's Atom drops its state when its place leaves the page (or a
    // new write on the same Atom starts): from then on, nothing on the page
    // shows this write's outcome.
    let left = false;
    get.addFinalizer(() => {
      left = true;
    });
    const { registry } = get;
    return Effect.exit(call).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) landed(registry);
        else if (left || isPlaceless(words)) {
          const label =
            registry.get(inboxesSeenAtom).get(words.inboxId)?.label ??
            words.inboxId;
          const text = `${words.what(label)} — ${refusalText(
            words.notDone,
            failureText(exit.cause),
            words.inboxId,
            words.refused,
          )}`;
          addStrayWrite(registry, text);
        }
        return exit;
      }),
      Effect.uninterruptible,
    );
  });

// Take a question's highlight away, one Atom per question (keyed like
// `answerKey`). Only a key does this, so no place on the page reads the Atom. On
// success it refreshes the board.
export const dismissHighlightAtom = Atom.family((_key: string) =>
  InboxClient.runtime.fn(
    Effect.fnUntraced(function* (
      req: {
        readonly inboxId: InboxId;
        readonly number: InboxViewDto['awaitingOperator'][number]['number'];
      },
      get: Atom.FnContext,
    ) {
      const client = yield* InboxClient;
      return yield* sendWrite(
        get,
        {
          inboxId: req.inboxId,
          what: (label) =>
            `Dismissing the highlight on #${req.number} in ${label}`,
          notDone: 'Not dismissed',
          refused: 'HighlightRefused',
          placeless: true,
        },
        client.inbox.dismissHighlight({
          query: {},
          params: { inboxId: req.inboxId, number: req.number },
        }),
        (registry) => registry.refresh(inboxBoardAtom),
      );
    }),
  ),
);

export interface PinRequest {
  readonly inboxId: InboxId;
  readonly pinned: boolean;
  readonly group?: string;
  // A key sent it with the row out of sight (`WriteWords`).
  readonly placeless?: boolean | (() => boolean);
}

/** The key of a pin's Atom: the Inbox, and the group when there is one. */
export const pinKey = (inboxId: InboxId, group?: string): string =>
  group === undefined ? inboxId : `${inboxId}/${group}`;

// What a row's pin last asked for, keyed like `pinAtom`, so its failure is
// worded by the attempt, never by the row as a later board draws it.
const pinAskedAtom = Atom.family((_key: string) =>
  Atom.make<PinRequest | undefined>(undefined),
);

// Pin or unpin an Inbox or a group, one Atom per row (keyed by `pinKey`).
// On success it refreshes the board, so the row moves.
export const pinAtom = Atom.family((key: string) =>
  InboxClient.runtime.fn(
    Effect.fnUntraced(function* (req: PinRequest, get: Atom.FnContext) {
      get.set(pinAskedAtom(key), req);
      const client = yield* InboxClient;
      return yield* sendWrite(
        get,
        {
          inboxId: req.inboxId,
          what: (label) =>
            `${req.pinned ? 'Pinning' : 'Unpinning'} ${
              req.group === undefined
                ? label
                : `the group ${req.group} in ${label}`
            }`,
          notDone: req.pinned ? 'Not pinned' : 'Not unpinned',
          refused: 'PinRefused',
          placeless: req.placeless === true,
        },
        client.inbox.pin({
          query: {},
          params: { inboxId: req.inboxId },
          payload: {
            pinned: req.pinned,
            ...(req.group === undefined ? {} : { group: req.group }),
          },
        }),
        (registry) => registry.refresh(inboxBoardAtom),
      );
    }),
  ),
);

/**
 * A failed write's outcome, as its place shows it: what it asked for, and
 * why it failed. `settled` once a board has shown what it asked for: the change landed after all, or another writer made it,
 * so the failure says nothing true any more and is not shown. It stays
 * settled for that failure, whatever later boards show, until the next
 * attempt.
 */
export interface WriteOutcome<Asked> {
  readonly asked: Asked;
  readonly failure: FailureText;
  readonly settled: boolean;
  // The write's result the outcome is of, so a new attempt starts afresh.
  readonly result: AsyncResult.AsyncResult<unknown, unknown>;
}

export const writeOutcomeOf = <Asked>(
  previous: WriteOutcome<Asked> | undefined,
  result: AsyncResult.AsyncResult<unknown, unknown>,
  asked: Asked | undefined,
  shown: (asked: Asked) => boolean,
): WriteOutcome<Asked> | undefined => {
  if (!AsyncResult.isFailure(result) || asked === undefined) return undefined;
  // A new attempt in flight: Atom keeps the last attempt's failure, as a new
  // object, while `asked` has already moved to the new attempt, so that
  // failure would read as the new one's. Nothing is said until
  // the new attempt ends.
  if (result.waiting) return undefined;
  const settled =
    (previous?.result === result && previous.settled) || shown(asked);
  return { asked, failure: failureText(result.cause), settled, result };
};

/** Whether `board` draws the row a pin asked about pinned; undefined when it does not draw the row. */
export const pinnedOnBoard = (
  board: Pick<InboxBoardDto, 'inboxes' | 'views'> | undefined,
  req: Pick<PinRequest, 'inboxId' | 'group'>,
): boolean | undefined => {
  if (board === undefined) return undefined;
  if (req.group === undefined)
    return board.inboxes.find((i) => i.inboxId === req.inboxId)?.pinned;
  const { group } = req;
  return board.views
    .find((v) => v.inboxId === req.inboxId)
    ?.pinnedGroups.includes(group);
};

// A row's pin outcome (`writeOutcomeOf`), keyed like `pinAtom`.
export const pinOutcomeAtom = Atom.family((key: string) =>
  Atom.make((get): WriteOutcome<PinRequest> | undefined =>
    writeOutcomeOf(
      Option.getOrUndefined(get.self<WriteOutcome<PinRequest> | undefined>()),
      get(pinAtom(key)),
      get(pinAskedAtom(key)),
      (asked) => pinnedOnBoard(get(drawnBoardAtom), asked) === asked.pinned,
    ),
  ),
);

/**
 * Pinned rows first, the rest after, each keeping its order.
 */
export const pinnedFirst = <R>(
  rows: ReadonlyArray<R>,
  isPinned: (row: R) => boolean,
): ReadonlyArray<R> => [
  ...rows.filter(isPinned),
  ...rows.filter((r) => !isPinned(r)),
];

/**
 * The sidebar's order for one section's Inboxes: muted ones at the bottom,
 * pinned first within each part, each keeping its order.
 */
export const inboxRowOrder = <
  R extends { readonly pinned: boolean; readonly muted?: boolean },
>(
  rows: ReadonlyArray<R>,
): ReadonlyArray<R> => [
  ...pinnedFirst(
    rows.filter((r) => r.muted !== true),
    (r) => r.pinned,
  ),
  ...pinnedFirst(
    rows.filter((r) => r.muted === true),
    (r) => r.pinned,
  ),
];

// Whether an Inbox's archive last asked to archive it or bring it back, for
// its failure's words.
const archiveAskedAtom = Atom.family((_inboxId: InboxId) =>
  Atom.make<boolean | undefined>(undefined),
);

export interface ArchiveRequest {
  readonly archived: boolean;
  // A key sent it with the row out of sight (`WriteWords`).
  readonly placeless?: boolean | (() => boolean);
}

// Archive the Inbox or bring it back, one Atom per Inbox. On success it
// refreshes the board, so the sidebar moves the row.
export const archiveAtom = Atom.family((inboxId: InboxId) =>
  InboxClient.runtime.fn(
    Effect.fnUntraced(function* (req: ArchiveRequest, get: Atom.FnContext) {
      const { archived } = req;
      get.set(archiveAskedAtom(inboxId), archived);
      const client = yield* InboxClient;
      return yield* sendWrite(
        get,
        {
          inboxId,
          what: (label) => `${archived ? 'Archiving' : 'Unarchiving'} ${label}`,
          notDone: archived ? 'Not archived' : 'Not unarchived',
          refused: 'ArchiveRefused',
          placeless: req.placeless === true,
        },
        client.inbox.archive({
          query: {},
          params: { inboxId },
          payload: { archived },
        }),
        (registry) => registry.refresh(inboxBoardAtom),
      );
    }),
  ),
);

// Pake's window cannot open a `claude://` link: its click listener takes every
// off-site `<a>` before the page sees it, and its way out accepts only web
// addresses. So there serve opens it. `pakeConfig` is what Pake puts
// on every page.
export const inDesktopWindow = () => 'pakeConfig' in window;

/** Where an Inbox's session is, when it has a link that means anything. */
export type SessionTarget =
  | { readonly _tag: 'Here'; readonly link: string }
  | { readonly _tag: 'Elsewhere'; readonly machine: string };

/**
 * The session working an Inbox. Only a whole link by core's own check counts,
 * since a write through serve skips the rules, and a link opens only on the
 * machine that ran the session.
 */
export const sessionTargetOf = (
  board: DrawnBoard | undefined,
  inboxId: string,
): SessionTarget | undefined => {
  const view = board?.views.find((v) => v.inboxId === inboxId);
  const link = view?.metadata[SESSION_LINK_KEY];
  if (view === undefined || !isSessionLink(link)) return undefined;
  const key = machineKeyOf(view);
  return key === LOCAL_MACHINE_KEY
    ? { _tag: 'Here', link }
    : {
        _tag: 'Elsewhere',
        machine:
          board?.machines?.find((m) => m.key === key)?.label ??
          'another machine',
      };
};

// Ask serve to open a session link, one Atom per link, for the desktop app's
// window. Kept alive: a menu or a modal asks and is gone, and nothing
// else may be holding the Atom while the request runs.
export const openSessionAtom = Atom.family((link: string) =>
  InboxClient.runtime
    .fn(
      Effect.fnUntraced(function* (_: void) {
        const client = yield* InboxClient;
        return yield* client.inbox.openSession({
          payload: { link: SessionLink.make(link) },
        });
      }),
    )
    .pipe(Atom.keepAlive),
);

/** Open a session link the way this window can. */
export const openSessionLinkAtom = Atom.writable<void, string>(
  () => undefined,
  (ctx, link) => {
    if (inDesktopWindow()) ctx.set(openSessionAtom(link), undefined);
    else location.assign(link);
  },
);

/**
 * Open the session working an Inbox, when this machine can: the one command
 * behind the keymap's `open_session` and the empty state's Ctrl+Enter. An Inbox
 * with no session link, or whose session is on another machine, opens nothing.
 */
export const openInboxSessionAtom = Atom.writable<void, string>(
  () => undefined,
  (ctx, inboxId) => {
    const target = sessionTargetOf(ctx.get(drawnBoardAtom), inboxId);
    if (target?._tag === 'Here') ctx.set(openSessionLinkAtom, target.link);
  },
);

// Whether an Inbox's mute last asked to mute it or unmute it, for its
// failure's words.
const muteAskedAtom = Atom.family((_inboxId: InboxId) =>
  Atom.make<boolean | undefined>(undefined),
);

// Mute the Inbox or unmute it, one Atom per Inbox. On success it refreshes
// the board, so the sidebar greys the row and All drops its cards.
export const muteAtom = Atom.family((inboxId: InboxId) =>
  InboxClient.runtime.fn(
    Effect.fnUntraced(function* (muted: boolean, get: Atom.FnContext) {
      get.set(muteAskedAtom(inboxId), muted);
      const client = yield* InboxClient;
      return yield* sendWrite(
        get,
        {
          inboxId,
          what: (label) => `${muted ? 'Muting' : 'Unmuting'} ${label}`,
          notDone: muted ? 'Not muted' : 'Not unmuted',
          refused: 'MuteRefused',
          placeless: false,
        },
        client.inbox.mute({
          query: {},
          params: { inboxId },
          payload: { muted },
        }),
        (registry) => registry.refresh(inboxBoardAtom),
      );
    }),
  ),
);

// A row's mute outcome (`writeOutcomeOf`), gone once a board shows it.
export const muteOutcomeAtom = Atom.family((inboxId: InboxId) =>
  Atom.make((get): WriteOutcome<boolean> | undefined =>
    writeOutcomeOf(
      Option.getOrUndefined(get.self<WriteOutcome<boolean> | undefined>()),
      get(muteAtom(inboxId)),
      get(muteAskedAtom(inboxId)),
      (asked) =>
        (get(drawnBoardAtom)?.views.find((v) => v.inboxId === inboxId)
          ?.muted ===
          true) ===
        asked,
    ),
  ),
);

// The header's archive outcome (`writeOutcomeOf`): `asked` is whether it
// asked to archive.
export const archiveOutcomeAtom = Atom.family((inboxId: InboxId) =>
  Atom.make((get): WriteOutcome<boolean> | undefined =>
    writeOutcomeOf(
      Option.getOrUndefined(get.self<WriteOutcome<boolean> | undefined>()),
      get(archiveAtom(inboxId)),
      get(archiveAskedAtom(inboxId)),
      (asked) =>
        get(drawnBoardAtom)?.views.find((v) => v.inboxId === inboxId)
          ?.archived === asked,
    ),
  ),
);

// --- a group's archive ------------------------------------------------------------

export interface GroupArchiveRequest {
  readonly inboxId: InboxId;
  readonly group: string;
  readonly archived: boolean;
  // A key sent it with the row out of sight (`WriteWords`).
  readonly placeless?: boolean | (() => boolean);
}

// What a group row's archive last asked for, keyed like `groupArchiveAtom`,
// so its failure is worded by the attempt.
const groupArchiveAskedAtom = Atom.family((_key: string) =>
  Atom.make<GroupArchiveRequest | undefined>(undefined),
);

// Archive a group or bring it back, one Atom per group row (keyed by
// `pinKey`). On success it refreshes the board, so the row moves to its
// Inbox's "Archived groups", or out of it.
export const groupArchiveAtom = Atom.family((key: string) =>
  InboxClient.runtime.fn(
    Effect.fnUntraced(function* (
      req: GroupArchiveRequest,
      get: Atom.FnContext,
    ) {
      get.set(groupArchiveAskedAtom(key), req);
      const client = yield* InboxClient;
      return yield* sendWrite(
        get,
        {
          inboxId: req.inboxId,
          what: (label) =>
            `${req.archived ? 'Archiving' : 'Unarchiving'} the group ${req.group} in ${label}`,
          notDone: req.archived ? 'Not archived' : 'Not unarchived',
          refused: 'ArchiveRefused',
          placeless: req.placeless === true,
        },
        client.inbox.archiveGroup({
          query: {},
          params: { inboxId: req.inboxId },
          payload: { group: req.group, archived: req.archived },
        }),
        (registry) => registry.refresh(inboxBoardAtom),
      );
    }),
  ),
);

// A group row's archive outcome (`writeOutcomeOf`), gone once a board shows
// the group as it asked.
export const groupArchiveOutcomeAtom = Atom.family((key: string) =>
  Atom.make((get): WriteOutcome<GroupArchiveRequest> | undefined =>
    writeOutcomeOf(
      Option.getOrUndefined(
        get.self<WriteOutcome<GroupArchiveRequest> | undefined>(),
      ),
      get(groupArchiveAtom(key)),
      get(groupArchiveAskedAtom(key)),
      (asked) => {
        const view = get(drawnBoardAtom)?.views.find(
          (v) => v.inboxId === asked.inboxId,
        );
        return (
          view !== undefined &&
          archivedGroupsOf(view).includes(asked.group) === asked.archived
        );
      },
    ),
  ),
);

// Each Inbox's "Archived groups" fold, under its groups. It starts closed:
// archiving a group moves it there. Not remembered across a reload.
export const archivedGroupsOpenAtom = Atom.family((_inboxId: InboxId) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

// --- asking the agent: the + and Ctrl+A -------------------------------------------

// The operator can post a question to an Inbox for its agent: to one Inbox,
// never to a group. It has two steps: pick an Inbox, from the open ones the sidebar lists, then write
// the question. It starts on the second, on the Inbox `askStartOf` names, with
// the list still live beside the box. A question sent lands in "With the agent"
// (core's `operatorQuestion`).

/** An Inbox the operator can ask in, as the dialog's list shows it. */
export interface AskableInbox {
  readonly inboxId: InboxId;
  readonly label: string;
  // The label of the machine section it sits in.
  readonly machine: string;
}

/** The Inboxes two machines claim and the board refuses. */
export const refusedInboxesOf = (board: DrawnBoard): ReadonlySet<InboxId> =>
  new Set(
    (board.clashes ?? [])
      .filter((c) => c.outcome === 'refused')
      .map((c) => c.inboxId),
  );

/**
 * The priority Inbox: the one the board marks `priority`, unless two machines
 * claim it. Each machine's log holds one at most; were two machines' logs to
 * hold one each (a mark on one whose clearing of the other did not land), the
 * first in the board's order is the one, and the other keeps only its flag.
 */
export const priorityInboxOf = (
  board: DrawnBoard | undefined,
): InboxRow | undefined => {
  if (board === undefined) return undefined;
  const refused = refusedInboxesOf(board);
  return board.inboxes.find(
    (i) => i.priority === true && !refused.has(i.inboxId),
  );
};

/**
 * The open Inboxes the sidebar lists, in its order: machine section by
 * section, pinned first and muted last within each. Archived Inboxes are
 * left out, and so is an Inbox two machines claim and the board refuses, since
 * nothing can be sent to it.
 */
export const askableInboxesOf = (
  board: DrawnBoard,
): ReadonlyArray<AskableInbox> => {
  const refused = refusedInboxesOf(board);
  return machineSectionsOf(board).flatMap((section) =>
    inboxRowOrder(
      section.inboxes.filter((i) => !i.archived && !refused.has(i.inboxId)),
    ).map((i) => ({
      inboxId: i.inboxId,
      label: i.label,
      machine: section.label,
    })),
  );
};

/** The Inboxes whose name or id holds `query`, ignoring case; all of them for an empty one. */
export const askMatches = <I extends AskableInbox>(
  inboxes: ReadonlyArray<I>,
  query: string,
): ReadonlyArray<I> => {
  const text = query.trim().toLowerCase();
  if (text === '') return inboxes;
  return inboxes.filter(
    (i) =>
      i.label.toLowerCase().includes(text) ||
      i.inboxId.toLowerCase().includes(text),
  );
};

// The list's filter. A fresh ask starts it empty.
export const askQueryAtom = Atom.make('').pipe(Atom.keepAlive);

/**
 * The Inbox an ask starts on: the lit question's, else the selected Inbox,
 * else the first in the list. The lit question's or the selected Inbox counts
 * while the board holds it and can send to it (an archived one too: asking
 * brings it back, as the agent asking does); the first is the list's. None
 * only when there is nothing to ask in, and the ask starts on the list.
 */
export const askStartOf = (
  board: DrawnBoard | undefined,
  lit: InboxId | undefined,
  selected: InboxId | undefined,
): InboxId | undefined => {
  if (board === undefined) return undefined;
  const sendable = (inboxId: InboxId | undefined): boolean =>
    board.inboxes.some((i) => i.inboxId === inboxId) &&
    !(board.clashes ?? []).some(
      (c) => c.inboxId === inboxId && c.outcome === 'refused',
    );
  return [lit, selected].find(sendable) ?? askableInboxesOf(board)[0]?.inboxId;
};

// What the operator has typed to ask, by Inbox, kept in this tab's
// sessionStorage as the response drafts are, so closing the ask, or a reload,
// throws nothing typed away. A question sent, and an emptied box,
// drop the entry.
const storedAskDraftsAtom = Atom.kvs({
  runtime: tabStorage,
  key: 'operator-inbox:inbox-ask-drafts',
  schema: Schema.Record(Schema.String, Schema.String),
  defaultValue: (): Record<string, string> => ({}),
}).pipe(Atom.keepAlive);

export const askDraftAtom = Atom.family((inboxId: InboxId) =>
  Atom.writable(
    (get) => get(storedAskDraftsAtom)[inboxId] ?? '',
    (ctx, text: string) => {
      const drafts = { ...ctx.get(storedAskDraftsAtom) };
      if (text === '') delete drafts[inboxId];
      else drafts[inboxId] = text;
      ctx.set(storedAskDraftsAtom, drafts);
    },
  ),
);

// What the operator has typed to follow up a question, by question (keyed like
// `answerKey`), kept as an ask's draft is.
const storedFollowUpDraftsAtom = Atom.kvs({
  runtime: tabStorage,
  key: 'operator-inbox:inbox-follow-up-drafts',
  schema: Schema.Record(Schema.String, Schema.String),
  defaultValue: (): Record<string, string> => ({}),
}).pipe(Atom.keepAlive);

export const followUpDraftAtom = Atom.family((key: string) =>
  Atom.writable(
    (get) => get(storedFollowUpDraftsAtom)[key] ?? '',
    (ctx, text: string) => {
      const drafts = { ...ctx.get(storedFollowUpDraftsAtom) };
      if (text === '') delete drafts[key];
      else drafts[key] = text;
      ctx.set(storedFollowUpDraftsAtom, drafts);
    },
  ),
);

// The fields where Ctrl+A is the platform's own key (on macOS, "line start"),
// so the shortcut leaves them alone.
const NOT_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

export const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !NOT_TEXT_INPUTS.has(target.type)));

// --- copy --------------------------------------------------------------------------

/**
 * A card as plain text, for pasting into the agent's session: the inbox id and
 * number let the agent find it, the body is the markdown it wrote, and the
 * operator's answer follows when there is one. A withdrawn question ends with
 * the agent's reason instead.
 */
export const questionClipText = (
  inboxId: InboxId,
  question: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly response?: string;
    readonly withdrawn?: boolean;
    readonly reason?: string;
    readonly operatorQuestion?: true;
  },
): string => {
  const lines = [`Inbox ${inboxId} · #${question.number} — ${question.title}`];
  if (question.body.trim().length > 0) lines.push(question.body.trimEnd());
  // A question the operator posted has no body: its text is the response.
  if (question.response !== undefined)
    lines.push(
      '',
      question.operatorQuestion === true ? 'My question:' : 'My answer:',
      question.response.trimEnd(),
    );
  if (question.withdrawn === true)
    lines.push('', `Withdrawn: ${withdrawalReason(question.reason)}`);
  return lines.join('\n');
};

/**
 * The agent's reason for a withdrawal, as the page and the copy show it. A
 * withdrawal logged before reasons were required carries "".
 */
export const withdrawalReason = (reason: string | undefined): string =>
  reason === undefined || reason.trim().length === 0
    ? '(no reason recorded)'
    : reason.trim();

/** What a question says over the text under its head: the agent's reason for a withdrawal, the operator's question, or their answer. */
export const answerLabel = (
  withdrawn: boolean,
  asked: boolean,
  deferred = false,
): string =>
  withdrawn
    ? 'Withdrawn by the agent:'
    : asked
      ? 'You asked:'
      : deferred
        ? 'You deferred to the agent:'
        : 'You answered:';

/** A deferral's text: its note, or a line saying there was none. */
export const deferralText = (response: string): string =>
  response.trim() === '' ? 'No note: the agent decides.' : response;

export type CopyMark = 'idle' | 'ok' | 'bad';

// What a card's copy button shows: ⧉, then ✓ or ✗ for `COPY_FEEDBACK_MS`.
// Keyed like `answerKey`.
export const copyMarkAtom = Atom.family((_key: string) =>
  Atom.make<CopyMark>('idle'),
);

// Copy one card's text and show the outcome. A second click while the mark
// shows interrupts the first run, so the mark always lasts its full time.
export const copyQuestionAtom = Atom.family((key: string) =>
  Atom.fn(
    Effect.fnUntraced(function* (text: string, get: Atom.FnContext) {
      const ok = yield* Effect.promise(() => copyText(text));
      get.set(copyMarkAtom(key), ok ? 'ok' : 'bad');
      yield* Effect.sleep(Duration.millis(COPY_FEEDBACK_MS));
      get.set(copyMarkAtom(key), 'idle');
    }),
  ),
);
