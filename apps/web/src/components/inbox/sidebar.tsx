import { Input } from '@base-ui/react/input';
import { Toggle } from '@base-ui/react/toggle';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  drawnBoardAtom,
  INBOX_RAIL_KEY_STEP_PX,
  INBOX_RAIL_MAX_PX,
  inboxPath,
  inboxRailWidthAtom,
  selectedInboxAtom,
  sidebarPinnedOnlyAtom,
  sidebarQueryAtom,
} from '../../inbox';
import {
  clampRail,
  pickRowAtom,
  RAIL_MIN_PX,
  type RailPart,
  railFocusAskedAtom,
  railListAtom,
  railMeasureAtom,
  railPushesAtom,
  railWidthOf,
  unreadNowAtom,
} from '../../inbox-rail';
import { railStateAtom } from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { INSIDE_END, KeyBadge } from '../keymap-help';
import { ArchivedFold, MachineFold } from './rail-folds';
import { InboxRows, PinIcon, plainClick, RailRow } from './rail-rows';
import { SideNotes } from './side-notes';

// The sidebar: search, what is wrong, the Inboxes by machine, and the credit.
// It lies over the page, so opening it does not move the question,
// unless it is pinned and too wide for the gutter: then it takes a column of its
// own and the question centres in what is left.

const Search = () => {
  const [query, setQuery] = useAtom(sidebarQueryAtom);
  const [onlyPinned, setOnlyPinned] = useAtom(sidebarPinnedOnlyAtom);
  const { first } = useAtomValue(railListAtom);
  const pick = useAtomSet(pickRowAtom);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'Enter' && first !== undefined) {
      e.preventDefault();
      const [group] = first.groups ?? [];
      pick({
        inboxId: first.row.inboxId,
        groups: group === undefined ? [] : [group],
      });
    }
  };
  return (
    <div className="flex items-center gap-s1 px-s3 pb-s2">
      <div className="relative w-full min-w-0">
        <Input
          type="search"
          value={query}
          onValueChange={setQuery}
          onKeyDown={onKeyDown}
          placeholder="Search"
          aria-label="Search inboxes and groups"
          data-sidebar-search
          className="w-full min-w-0 bg-fg/5 px-s2 py-s1 text-fg/80 outline-none placeholder:text-fg/30 focus:bg-fg/8 pointer-coarse:text-field"
        />
        <KeyBadge action="focus_sidebar_search" at={INSIDE_END} />
      </div>
      <Toggle
        pressed={onlyPinned}
        onPressedChange={setOnlyPinned}
        aria-label="Show only pinned"
        title="Show only pinned"
        data-pinned-filter
        className={`flex shrink-0 cursor-pointer items-center p-s1 ${onlyPinned ? 'text-fg' : 'text-fg/30 hover:text-fg/70'}`}
      >
        <PinIcon filled={onlyPinned} />
      </Toggle>
    </div>
  );
};

const Inboxes = ({ part }: { readonly part: RailPart }) => {
  const board = useAtomValue(drawnBoardAtom);
  const { top, searching } = useAtomValue(railListAtom);
  const rows = (hits: RailPart['active']) =>
    hits.map((hit) => (
      <InboxRows
        key={hit.row.inboxId}
        hit={hit}
        view={board?.views.find((v) => v.inboxId === hit.row.inboxId)}
        top={top}
      />
    ));
  return (
    <>
      {rows(part.active)}
      {part.archived.length > 0 && (
        <ArchivedFold
          machine={part.section.key}
          count={part.archived.length}
          searching={searching}
        >
          {rows(part.archived)}
        </ArchivedFold>
      )}
    </>
  );
};

const AllRow = () => {
  const board = useAtomValue(drawnBoardAtom);
  const selected = useAtomValue(selectedInboxAtom);
  const pick = useAtomSet(pickRowAtom);
  return (
    <RailRow
      href={inboxPath(undefined)}
      label="All"
      count={board?.totalAwaitingOperator}
      on={selected === undefined}
      hooks={{ 'data-rail-inbox': '' }}
      badge={<KeyBadge action="all_inboxes" />}
      onClick={(e) => {
        if (!plainClick(e) || e.shiftKey) return;
        e.preventDefault();
        pick({ inboxId: undefined, groups: [] });
      }}
    />
  );
};

const List = () => {
  const { parts, searching } = useAtomValue(railListAtom);
  const unread = useAtomValue(unreadNowAtom);
  const [only] = parts;
  const none = parts.every(
    (p) => p.active.length === 0 && p.archived.length === 0,
  );
  return (
    <nav aria-label="Inboxes" className="px-s1 pb-s4">
      <AllRow />
      {/* One machine is nothing machine-shaped: no heading, no fold. */}
      {parts.length === 1 && only !== undefined ? (
        <Inboxes part={only} />
      ) : (
        parts.map((part) => (
          <MachineFold
            key={part.section.key}
            section={part.section}
            searching={searching}
          >
            <Inboxes part={part} />
          </MachineFold>
        ))
      )}
      {searching && none && (
        <p className="px-s2 py-s1 text-fg/30" data-sidebar-no-match>
          No inbox or group matches.
        </p>
      )}
      {searching && unread.length > 0 && (
        <p className="px-s2 py-s1 text-fg/40" data-sidebar-not-searched>
          {unread.map((m) => m.label).join(' and ')} not searched: cannot be
          reached.
        </p>
      )}
    </nav>
  );
};

const Foot = () => (
  <div className="flex shrink-0 flex-wrap items-baseline justify-start gap-x-s3 px-s3 py-s2">
    <a
      href="https://www.tomjamesallen.co.uk/"
      target="_blank"
      rel="noreferrer"
      data-zen-credit
      className="whitespace-nowrap text-fg/30 hover:text-fg/60"
    >
      {/* Brighter than its words: at the same faintness it goes muddy. */}
      Made by Tom <span className="text-fg/70">👨‍💻</span>
    </a>
  </div>
);

// Drag it, or focus it and use the arrow keys; a double-click or Enter goes back
// to the design's width. The ARIA window-splitter pattern. A phone has only the
// drawer, and no room to drag in.
const Resizer = () => {
  const [stored, setWidth] = useAtom(inboxRailWidthAtom);
  const measure = useAtomValue(railMeasureAtom);
  const docked = useAtomValue(railStateAtom) === 'docked';
  const clamp = (px: number) => clampRail(px, measure, docked);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const aside = handle.parentElement;
    if (aside === null) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = aside.offsetWidth;
    const move = (m: globalThis.PointerEvent) =>
      setWidth(clamp(start + m.clientX - startX));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const aside = e.currentTarget.parentElement;
    if (aside === null) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      setWidth(null);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step =
        e.key === 'ArrowRight'
          ? INBOX_RAIL_KEY_STEP_PX
          : -INBOX_RAIL_KEY_STEP_PX;
      setWidth(clamp(aside.offsetWidth + step));
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or a drag; this is the ARIA window-splitter pattern.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize the inbox sidebar"
      aria-valuemin={RAIL_MIN_PX}
      aria-valuemax={INBOX_RAIL_MAX_PX}
      aria-valuenow={railWidthOf(stored, measure?.design ?? RAIL_MIN_PX)}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      data-rail-resizer
      onDoubleClick={() => setWidth(null)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className="group absolute inset-y-0 right-0 flex w-s1 cursor-ew-resize touch-none justify-end outline-none compact:hidden"
    >
      <span className="h-full w-px group-hover:bg-fg/25 group-focus-visible:bg-fg/25" />
    </div>
  );
};

const Aside = () => {
  const rail = useAtomValue(railStateAtom);
  const stored = useAtomValue(inboxRailWidthAtom);
  const [focusAsked, setFocusAsked] = useAtom(railFocusAskedAtom);
  const self = useRef<HTMLElement>(null);
  // A key's request, once the sidebar is drawn. Only an element can take focus.
  useLayoutEffect(() => {
    const side = self.current;
    if (focusAsked === undefined || side === null) return;
    const find = (selector: string) =>
      side.querySelector<HTMLElement>(selector);
    const el =
      focusAsked === 'search'
        ? find('[data-sidebar-search]')
        : (find('nav [aria-current]') ?? find('nav a[data-rail-inbox]'));
    el?.focus();
    setFocusAsked(undefined);
  }, [focusAsked, setFocusAsked]);
  return (
    // A dragged width is a runtime value Tailwind cannot express.
    <aside
      ref={self}
      data-inbox-sidebar={rail}
      style={
        stored === null
          ? undefined
          : { width: railWidthOf(stored, RAIL_MIN_PX) }
      }
      className={`relative flex h-full max-w-rail-cap shrink-0 flex-col border-r border-fg/8 bg-rail pt-16 text-11 compact:pt-header ${stored === null ? 'w-rail' : ''}`}
    >
      <Search />
      {/* One scroller for both: on a short screen the notes alone could fill the
          sidebar, and the Inboxes and the foot would go with no way back. */}
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <SideNotes />
        <List />
      </div>
      <Foot />
      <Resizer />
    </aside>
  );
};

/**
 * The sidebar in whichever way it is out. Hovering the burger peeks and leaving
 * shuts it; a focus inside keeps it, as a drawer, until dismissed. `docked` has
 * no veil: it is beside the question, and the question stays in reach. In flow
 * it is the page's first column, which is all pushing the question takes.
 */
export const Rail = () => {
  const rail = useAtomValue(railStateAtom);
  const pushes = useAtomValue(railPushesAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  if (rail === 'shut') return null;
  return (
    <>
      {rail === 'drawer' && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close the inbox sidebar"
          data-rail-veil
          onClick={() => send({ type: 'RailDismissed' })}
          className="fixed inset-0 z-20 cursor-default"
        />
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it only watches the pointer and the focus pass through; what is inside is what is interactive. */}
      <div
        data-rail-layer={pushes ? 'column' : 'over'}
        className={`z-20 ${pushes ? 'relative h-full shrink-0' : 'fixed inset-y-0 left-0'}`}
        onMouseLeave={() => send({ type: 'RailLeft' })}
        onFocusCapture={() => send({ type: 'RailFocused' })}
      >
        <Aside />
      </div>
    </>
  );
};
