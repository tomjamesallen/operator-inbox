import {
  type InboxBoardDto,
  type InboxClashDto,
  type InboxId,
  type InboxMachineStatusDto,
  machineKeyOf,
} from '@operator-inbox/core/api';
import { Effect } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import { failureText, fetchSentence } from './failure';
import {
  archivedGroupsOf,
  type DrawnBoard,
  drawnBoardAtom,
  groupRowsOf,
  INBOX_RAIL_MAX_PX,
  inboxBoardAtom,
  inboxRailWidthAtom,
  inboxRowOrder,
  isUnreadMachine,
  type MachineSection,
  machineLabelOf,
  machineSectionsOf,
  pinnedGroupsShown,
  pinnedOnly,
  type SidebarSelection,
  type StrayWrite,
  searchSidebar,
  selectedInboxAtom,
  selectSidebarAtom,
  sendWrite,
  sidebarPinnedOnlyAtom,
  sidebarQueryAtom,
  strayWritesAtom,
  topMatches,
} from './inbox';
import type { FreshMark } from './inbox-queues';
import {
  activeQueueAtom,
  freshMarksAtom,
  metadataRulesFailureAtom,
  railStateAtom,
  shownQueuesAtom,
  troublesAtom,
} from './inbox-reader';
import { type AnswerTrouble, inboxReaderAtoms } from './inbox-reader-machine';
import {
  inboxClashHeading,
  inboxClashNotice,
  machinesOffBanner,
} from './machine-notices';

// The zen inbox's sidebar as Atoms: what it lists, what it warns of, and whether
// it fits beside the question. Whether it is open is the machine's rail region;
// the page measures, and this says what the measure means.

// --- whether it fits ------------------------------------------------------------

/** The floor of a dragged width, raised from the old page's for the larger type. */
export const RAIL_MIN_PX = 240;
/** As `--container-rail-cap`: the most of the window a drawer may take. */
const RAIL_CAP_SHARE = 0.85;

/**
 * What the page measured, in pixels: `room` is `--spacing-rail-room`, `pushRoom`
 * is `--spacing-rail-push-room`, `design` is `--spacing-rail`. Undefined until
 * something has measured.
 */
export interface RailMeasure {
  readonly room: number;
  readonly pushRoom: number;
  readonly design: number;
  readonly viewport: number;
}

export const railMeasureAtom = Atom.make<RailMeasure | undefined>(
  undefined,
).pipe(Atom.keepAlive);

/** The sidebar's width: what was dragged, else the design's. */
export const railWidthOf = (stored: number | null, design: number): number =>
  stored === null ? design : Math.max(RAIL_MIN_PX, stored);

/** The widest a pinned sidebar can be, in the gutter or in a column of its own. */
const pinRoomOf = (measure: RailMeasure): number =>
  Math.max(measure.room, measure.pushRoom);

/** A dragged width, kept to what the sidebar may take as it now stands. */
export const clampRail = (
  px: number,
  measure: RailMeasure | undefined,
  docked: boolean,
): number => {
  const room =
    measure === undefined
      ? INBOX_RAIL_MAX_PX
      : docked
        ? pinRoomOf(measure)
        : measure.viewport * RAIL_CAP_SHARE;
  // Down, never up: a width rounded past the room no longer fits, and a pinned
  // sidebar would shut under the drag.
  return Math.min(
    INBOX_RAIL_MAX_PX,
    Math.floor(room),
    Math.round(Math.max(RAIL_MIN_PX, px)),
  );
};

export const railFitsAtom = Atom.make((get): boolean => {
  const measure = get(railMeasureAtom);
  if (measure === undefined) return false;
  return (
    railWidthOf(get(inboxRailWidthAtom), measure.design) <= pinRoomOf(measure)
  );
});

/** Too wide for the gutter, so pinned it takes a column and moves the question. */
export const railPushesAtom = Atom.make((get): boolean => {
  const measure = get(railMeasureAtom);
  if (measure === undefined || get(railStateAtom) !== 'docked') return false;
  return railWidthOf(get(inboxRailWidthAtom), measure.design) > measure.room;
});

/** Tells the machine when the fit changes. Mounted at the page's root. */
export const railFitFeedAtom: Atom.Atom<void> = Atom.readable((get) => {
  const actor = get(inboxReaderAtoms.actor);
  if (!AsyncResult.isSuccess(actor)) return;
  actor.value.send({ type: 'RailFitChanged', fits: get(railFitsAtom) });
});

// --- what it lists --------------------------------------------------------------

type Row = InboxBoardDto['inboxes'][number];

export type RailHit = ReturnType<typeof searchSidebar<Row>>[number];

export interface RailPart {
  readonly section: MachineSection;
  readonly active: ReadonlyArray<RailHit>;
  readonly archived: ReadonlyArray<RailHit>;
}

export interface RailList {
  readonly parts: ReadonlyArray<RailPart>;
  // The search's best matches, by `sidebarKey`. Empty when not searching.
  readonly top: ReadonlySet<string>;
  // What Enter in the search box opens.
  readonly first: RailHit | undefined;
  readonly searching: boolean;
}

/** Machines gone past their one greyed read, so nothing of theirs is drawn. */
export const unreadNowOf = (
  board: Pick<DrawnBoard, 'machines' | 'greyed'>,
): ReadonlyArray<InboxMachineStatusDto> =>
  (board.machines ?? []).filter(
    (m) => isUnreadMachine(m) && !board.greyed.has(m.key),
  );

/**
 * The sidebar's rows. Only the selected Inbox lists its groups: every other
 * Inbox's are collapsed (`groups` an empty set) until it is picked, unless a
 * search or the pinned filter reaches into them, which lists the groups it
 * kept. An archived group is searched like the rest, and drawn in its Inbox's
 * "Archived groups"; the pinned filter never shows one, as it never shows an
 * archived Inbox.
 */
export const railListOf = (
  board: DrawnBoard | undefined,
  query: string,
  onlyPinned: boolean,
  selected?: InboxId,
): RailList => {
  const viewOf = (row: Row) =>
    board?.views.find((v) => v.inboxId === row.inboxId);
  // A muted Inbox's groups fold away, so they are neither drawn nor searched.
  const groupNames = (row: Row) => {
    const view = viewOf(row);
    return view === undefined || row.muted === true
      ? []
      : groupRowsOf(view).map((g) => g.group);
  };
  const querying = query.trim().length > 0;
  const shown = (hit: RailHit): RailHit => {
    if (!querying && hit.groups === undefined && hit.row.inboxId !== selected)
      return { ...hit, groups: new Set() };
    const view = viewOf(hit.row);
    const archived = view === undefined ? [] : archivedGroupsOf(view);
    if (!onlyPinned || archived.length === 0) return hit;
    const left = hit.groups ?? new Set(groupNames(hit.row));
    return {
      ...hit,
      groups: new Set([...left].filter((g) => !archived.includes(g))),
    };
  };
  const filtered = (rows: ReadonlyArray<Row>) => {
    const hits = searchSidebar(inboxRowOrder(rows), groupNames, query);
    return (
      onlyPinned
        ? pinnedOnly(hits, groupNames, (r) => {
            const view = viewOf(r);
            return view === undefined ? [] : pinnedGroupsShown(view);
          })
        : hits
    ).map(shown);
  };
  const parts = (board === undefined ? [] : machineSectionsOf(board)).map(
    (section) => ({
      section,
      active: filtered(section.inboxes.filter((i) => !i.archived)),
      // A pin on an archived Inbox waits for it to come back: only pinned, the
      // Archived fold is not there: an archived Inbox never shows under
      // pinned.
      archived: onlyPinned
        ? []
        : filtered(section.inboxes.filter((i) => i.archived)),
    }),
  );
  const active = parts.flatMap((p) => p.active);
  const archived = parts.flatMap((p) => p.archived);
  return {
    parts,
    top: topMatches([...active, ...archived].flatMap((h) => h.matches)),
    first: active[0] ?? archived[0],
    searching: query.trim().length > 0 || onlyPinned,
  };
};

export const railListAtom = Atom.make((get) =>
  railListOf(
    get(drawnBoardAtom),
    get(sidebarQueryAtom),
    get(sidebarPinnedOnlyAtom),
    get(selectedInboxAtom),
  ),
);

export const unreadNowAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  return board === undefined ? [] : unreadNowOf(board);
});

/** New questions the page is not showing, so a row or the burger says so. */
export const freshElsewhereAtom = Atom.make((get): ReadonlyArray<FreshMark> => {
  const shown = get(shownQueuesAtom)[get(activeQueueAtom)];
  return get(freshMarksAtom).filter((f) => !shown.some((i) => i.key === f.key));
});

// --- what it warns of -----------------------------------------------------------

export type NoteTone = 'red' | 'orange';

/** What is wrong beyond one machine, above the machines. */
export interface SideNote {
  readonly id: string;
  readonly kind:
    | 'serve'
    | 'answer'
    | 'stray'
    | 'rules'
    | 'machines-off'
    | 'clash';
  readonly tone: NoteTone;
  readonly text: string;
  readonly more?: string;
  // A stray's id, so it can be cleared.
  readonly stray?: number;
  // The question a failed answer goes back to.
  readonly go?: string;
}

export interface NotesInput {
  readonly serve: string | undefined;
  readonly troubles: ReadonlyArray<AnswerTrouble>;
  readonly stray: ReadonlyArray<StrayWrite>;
  readonly rules: string | undefined;
  readonly board: DrawnBoard | undefined;
  readonly selected: InboxId | undefined;
}

// A clash shows in All, and in the view of the Inbox it is about.
const clashesShown = (
  board: DrawnBoard | undefined,
  selected: InboxId | undefined,
): ReadonlyArray<InboxClashDto> =>
  (board?.clashes ?? []).filter(
    (c) =>
      selected === undefined ||
      (c.inboxId === selected && c.outcome === 'kept-on-local'),
  );

export const sideNotesOf = (input: NotesInput): ReadonlyArray<SideNote> => {
  const { serve, troubles, stray, rules, board, selected } = input;
  const off = board === undefined ? undefined : machinesOffBanner(board);
  const unread = board === undefined ? [] : unreadNowOf(board);
  return [
    ...(serve === undefined
      ? []
      : [
          {
            id: 'serve',
            kind: 'serve',
            tone: 'red',
            text: `${serve} Showing the last view that loaded.`,
          } as const,
        ]),
    ...troubles.map((t): SideNote => {
      // Its question has gone with its machine: there is nowhere to go yet.
      const gone = unread.find((m) => m.key === t.machine);
      return {
        id: `answer:${t.key}`,
        kind: 'answer',
        tone: 'red',
        text:
          t.tag === 'uncertain'
            ? `Answer to #${t.number} unconfirmed`
            : `Answer to #${t.number} not sent`,
        ...(gone === undefined
          ? { go: t.key }
          : { more: `${gone.label} cannot be reached.` }),
      };
    }),
    ...stray.map(
      (w): SideNote => ({
        id: `stray:${w.id}`,
        kind: 'stray',
        tone: 'red',
        text: w.text,
        stray: w.id,
      }),
    ),
    ...(rules === undefined
      ? []
      : [
          {
            id: 'rules',
            kind: 'rules',
            tone: 'orange',
            text: `Metadata rules not read, so the defaults show: ${rules}`,
          } as const,
        ]),
    ...(off === undefined
      ? []
      : [
          {
            id: 'machines-off',
            kind: 'machines-off',
            tone: 'orange',
            text: off,
          } as const,
        ]),
    ...clashesShown(board, selected).map(
      (c): SideNote => ({
        id: `clash:${c.inboxId}`,
        kind: 'clash',
        tone: 'orange',
        text: `${inboxClashHeading(c)}.`,
        more: `${inboxClashNotice(c)}. ${c.claims
          .map((x) => `${x.machine.label} calls it “${x.label}”`)
          .join('; ')}.`,
      }),
    ),
  ];
};

export const sideNotesAtom = Atom.make((get): ReadonlyArray<SideNote> => {
  const result = get(inboxBoardAtom);
  const board = get(drawnBoardAtom);
  return sideNotesOf({
    // With no board the reader says it in the question's place.
    serve:
      board !== undefined && AsyncResult.isFailure(result)
        ? fetchSentence(failureText(result.cause))
        : undefined,
    troubles: get(troublesAtom),
    stray: get(strayWritesAtom),
    rules: get(metadataRulesFailureAtom),
    board,
    selected: get(selectedInboxAtom),
  });
});

/**
 * The burger's dot: something in the shut sidebar needs the reader. A one-read
 * flap does not count: it has usually passed before anyone could act, and the
 * dot would flicker.
 */
export const attentionOf = (
  notes: ReadonlyArray<SideNote>,
  unread: ReadonlyArray<InboxMachineStatusDto>,
): NoteTone | undefined =>
  notes.some((n) => n.tone === 'red') ||
  unread.some((m) => m.status === 'unreachable')
    ? 'red'
    : notes.length > 0 || unread.length > 0
      ? 'orange'
      : undefined;

export const attentionAtom = Atom.make((get) =>
  attentionOf(get(sideNotesAtom), get(unreadNowAtom)),
);

// The page's sentence for a screen reader while a machine is greyed, which no
// question says aloud. In All it names every greyed machine.
export const greyedLineOf = (
  board: DrawnBoard,
  selected: InboxId | undefined,
): string | undefined => {
  if (selected !== undefined) {
    const view = board.views.find((v) => v.inboxId === selected);
    if (view === undefined) return undefined;
    return board.greyed.has(machineKeyOf(view))
      ? `${machineLabelOf(view)} did not answer the last read, so this is what it held at the read before, and any change made here now may not reach it.`
      : undefined;
  }
  const names = (board.machines ?? [])
    .filter((m) => board.greyed.has(m.key))
    .map((m) => m.label);
  if (names.length === 0) return undefined;
  const one = names.length === 1;
  return `${names.join(' and ')} did not answer the last read, so what ${
    one ? 'it' : 'they'
  } held at the read before still shows, and a change sent now may not reach ${
    one ? 'it' : 'them'
  }.`;
};

export const greyedLineAtom = Atom.make((get) => {
  const board = get(drawnBoardAtom);
  return board === undefined
    ? undefined
    : greyedLineOf(board, get(selectedInboxAtom));
});

// --- what it does ---------------------------------------------------------------

/** A row picked: the view changes, and a sidebar lying over it has done its job. */
export const pickRowAtom = Atom.writable<void, SidebarSelection>(
  () => undefined,
  (ctx, next) => {
    ctx.set(selectSidebarAtom, next);
    ctx.set(inboxReaderAtoms.send, { type: 'RailDismissed' });
  },
);

/**
 * A failed answer's line: back to its question. A view that does not show it
 * gives way to its Inbox, or the jump would wait for the reader to go there. A
 * folded machine's line is no link (`sideNotesOf`), so its question is on the
 * board.
 */
export const goToQuestionAtom = Atom.writable<void, string>(
  () => undefined,
  (ctx, key) => {
    const inboxId = ctx.get(troublesAtom).find((t) => t.key === key)?.inboxId;
    const queues = ctx.get(shownQueuesAtom);
    const shown = [...queues.inbox, ...queues.agent, ...queues.processed].some(
      (i) => i.key === key,
    );
    if (!shown && inboxId !== undefined) {
      ctx.set(sidebarPinnedOnlyAtom, false);
      ctx.set(selectSidebarAtom, { inboxId, groups: [] });
    }
    ctx.set(inboxReaderAtoms.send, { type: 'MovedTo', key });
    ctx.set(inboxReaderAtoms.send, { type: 'RailDismissed' });
  },
);

// Rename an Inbox from its row. The write is the field's: while the field is on
// the page it says a refusal, an unchanged name included (`decideRename`, in
// core), and stays open; once it has gone, `sendWrite` files the failure as a
// stray.
export const railRenameAtom = Atom.family((inboxId: InboxId) =>
  InboxClient.runtime.fn(
    Effect.fnUntraced(function* (label: string, get: Atom.FnContext) {
      const client = yield* InboxClient;
      return yield* sendWrite(
        get,
        {
          inboxId,
          what: (was) => `Renaming ${was} to “${label}”`,
          notDone: 'Not renamed',
          refused: 'RenameRefused',
        },
        client.inbox.rename({
          query: {},
          params: { inboxId },
          payload: { label },
        }),
        (registry) => {
          registry.set(inboxReaderAtoms.send, {
            type: 'RenameLanded',
            inboxId,
          });
          registry.refresh(inboxBoardAtom);
        },
      );
    }),
  ),
);

/**
 * Open a row's rename, shut or not: the machine brings the sidebar out. A fresh
 * attempt clears what the last came to, unless that write is still running.
 */
export const openRenameAtom = Atom.writable<void, InboxId>(
  () => undefined,
  (ctx, inboxId) => {
    if (!ctx.get(railRenameAtom(inboxId)).waiting)
      ctx.set(railRenameAtom(inboxId), Atom.Reset);
    ctx.set(inboxReaderAtoms.send, { type: 'RenameOpened', inboxId });
  },
);

/** Where a key wants the focus in the sidebar. */
export type RailFocus = 'row' | 'search';

// A key can ask for this while the sidebar is shut, so the request waits here
// until the sidebar is drawn, and the sidebar takes it.
export const railFocusAskedAtom = Atom.make<RailFocus | undefined>(
  undefined,
).pipe(Atom.keepAlive);

// --- the tab --------------------------------------------------------------------

export const INBOX_TITLE = 'Operator Inbox';

export const inboxTabTitleAtom: Atom.Atom<void> = Atom.readable(() => {
  if (typeof document !== 'undefined') document.title = INBOX_TITLE;
});
