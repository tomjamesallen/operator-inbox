import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { InboxId } from '@operator-inbox/core/api';
import { Atom } from 'effect/reactivity';
import { Archive, Bot, Inbox, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  DEFAULT_GROUP,
  drawnBoardAtom,
  groupsInForce,
  inboxesSeenAtom,
  pinnedGroupsShown,
  screenStateAtom,
  selectedInboxAtom,
  selectSidebarAtom,
  sidebarPinnedOnlyAtom,
} from '../../inbox';
import type { QueueName } from '../../inbox-queues';
import { activeQueueAtom } from '../../inbox-reader';
import { keyHintAtom } from '../../keymap';
import { focusRing } from '../styles';
import { Tip } from './icon';

// The page's scope, shown where each Question already names its Inbox and
// group, instead of on a line over the answer box: the crumbs in the scope
// are underlined in yellow, and the breadcrumb of a Question in the selected
// Inbox sticks under the header's icons while its Question is in view, the
// next one's taking over as it arrives. While it is stuck the crumbs outside
// the scope fade, so only the scope stays on screen. With nothing selected
// nothing is marked and nothing sticks.

export interface CrumbScope {
  readonly selected: InboxId | undefined;
  readonly inboxes: ReadonlyArray<InboxId>;
  // The selected Inbox's groups the page shows, when it shows only some:
  // those picked that it has, narrowed to its pinned ones while the sidebar
  // shows only what is pinned and the Inbox itself is not pinned.
  readonly groups: ReadonlyArray<string>;
}

export const crumbScopeAtom = Atom.make((get): CrumbScope => {
  const { inboxes, groups } = get(screenStateAtom);
  const selected = get(selectedInboxAtom);
  const board = get(drawnBoardAtom);
  const view = board?.views.find((v) => v.inboxId === selected);
  if (selected === undefined || view === undefined)
    return { selected, inboxes, groups: [] };
  let inForce = groupsInForce(view, groups);
  const pinned =
    board?.inboxes.find((i) => i.inboxId === selected)?.pinned === true;
  if (get(sidebarPinnedOnlyAtom) && !pinned) {
    const shown = view.archived ? [] : pinnedGroupsShown(view);
    inForce =
      inForce.length === 0 ? shown : inForce.filter((g) => shown.includes(g));
  }
  return { selected, inboxes, groups: inForce };
});

/** Whether the page is narrowed to an Inbox or a few. */
export const scoped = (scope: CrumbScope): boolean =>
  scope.selected !== undefined || scope.inboxes.length > 0;

/** Which of a Question's crumbs are the page's scope. */
export const crumbOf = (
  scope: CrumbScope,
  inboxId: InboxId,
  group: string,
): { readonly inbox: boolean; readonly group: boolean } => {
  const inbox = scope.selected === inboxId || scope.inboxes.includes(inboxId);
  return { inbox, group: inbox && scope.groups.includes(group) };
};

/** A crumb in the scope. */
export const MARKED =
  'text-fg underline decoration-yellow decoration-2 underline-offset-4';

/**
 * Every breadcrumb row's box, marked or not, so selecting an Inbox moves
 * nothing. It reaches s2 into the margin on each side, so the queue's icon
 * and the Question's code hang from its edge, s2 from the text. On a phone
 * it is solid, as the header is.
 */
export const CRUMB_BOX =
  '-mx-s2 h-crumb px-s2 compact:h-auto compact:bg-bg compact:py-s1';

/**
 * Marks each sticky breadcrumb `data-stuck` while it is held under the
 * header, so the crumbs outside the scope can fade: read on each scroll, a
 * frame at a time. The escape hatch: CSS cannot yet say "stuck" in every
 * engine the app runs in. Mounted by the page.
 */
export const stuckWatchAtom = Atom.readable((get) => {
  if (typeof document === 'undefined') return;
  let frame = 0;
  const mark = () => {
    frame = 0;
    for (const row of document.querySelectorAll('[data-crumb-sticky]')) {
      const top = row.getBoundingClientRect().top;
      const article = row.parentElement?.getBoundingClientRect().top ?? top;
      // Stuck: held where it sticks while its Question's top has gone above.
      const at = Number.parseFloat(getComputedStyle(row).top);
      const stuck = top <= at + 1 && article < top - 1;
      if (stuck) row.setAttribute('data-stuck', '');
      else row.removeAttribute('data-stuck');
    }
  };
  const onScroll = () => {
    if (frame === 0) frame = requestAnimationFrame(mark);
  };
  const options = { capture: true, passive: true } as const;
  document.addEventListener('scroll', onScroll, options);
  get.addFinalizer(() => {
    cancelAnimationFrame(frame);
    document.removeEventListener('scroll', onScroll, options);
  });
});

// The queue's own icon, as its tab in the header draws it, a step smaller to
// sit with the breadcrumb's text. The bot draws its head narrower than the
// tray and the box, so it gets a box a step larger and a stroke scaled down
// to match. Copied from the header's tabs, not shared: the two may part.
const QUEUE_ICONS: Readonly<
  Record<
    QueueName,
    {
      readonly Icon: LucideIcon;
      readonly size: string;
      readonly stroke: number;
    }
  >
> = {
  inbox: { Icon: Inbox, size: 'size-3', stroke: 2 },
  agent: { Icon: Bot, size: 'size-3.5', stroke: 1.75 },
  processed: { Icon: Archive, size: 'size-3', stroke: 2 },
};

/**
 * A breadcrumb row, with the current queue's icon hanging in the margin to
 * its left, right-aligned with the Question's hanging code: a click goes
 * back to All, as the `all_inboxes` key does. It has no background of its
 * own: the header's glass grows down to hold it while it sticks
 * (`HeaderGlass`).
 */
export const CrumbRow = ({
  className,
  sticky,
  children,
}: {
  readonly className: string;
  readonly sticky?: boolean;
  readonly children: ReactNode;
}) => {
  const select = useAtomSet(selectSidebarAtom);
  const keys = useAtomValue(keyHintAtom('all_inboxes'));
  const queue = useAtomValue(activeQueueAtom);
  const { Icon, size, stroke } = QUEUE_ICONS[queue];
  return (
    <div
      data-crumb-sticky={sticky === true || undefined}
      className={`relative ${className}`}
    >
      {/* Out of the row's flow, so the text never moves for it; its right
          edge is the row's, s2 from the text. A 36px target round a 12px icon. */}
      <span className="absolute inset-y-0 right-full flex items-center">
        <Tip label="All inboxes" keys={keys.first}>
          <button
            type="button"
            data-all-inboxes-crumb
            aria-label="All inboxes"
            onClick={(e) => {
              e.stopPropagation();
              select({ inboxId: undefined, groups: [] });
            }}
            className={`-m-3 flex cursor-pointer items-center p-3 text-fg/40 hover:text-fg ${focusRing}`}
          >
            <Icon aria-hidden="true" className={size} strokeWidth={stroke} />
          </button>
        </Tip>
      </span>
      {children}
    </div>
  );
};

/**
 * The header's glass, as a layer under the header's row, so it can grow down
 * by a breadcrumb row while the page is narrowed: one sheet of glass then
 * holds the header and the stuck breadcrumb, with no seam between two blurs.
 * On a phone the header is solid, and so is the breadcrumb.
 */
export const HeaderGlass = () => {
  const grown = scoped(useAtomValue(crumbScopeAtom));
  return (
    <div
      aria-hidden="true"
      data-header-glass={grown ? 'grown' : 'header'}
      className={`pointer-events-none absolute inset-x-0 top-0 -z-10 bg-bg/70 backdrop-blur-md compact:hidden ${grown ? 'h-header-crumb' : 'h-header'}`}
    />
  );
};

/**
 * With no Question in the list, no breadcrumb carries the scope, so the scope
 * stands alone in a breadcrumb's place, top left, marked as a Question's
 * would be. A Question arriving takes it over.
 */
export const EmptyCrumb = () => {
  const scope = useAtomValue(crumbScopeAtom);
  const seen = useAtomValue(inboxesSeenAtom);
  const select = useAtomSet(selectSidebarAtom);
  const ids =
    scope.inboxes.length > 0
      ? scope.inboxes
      : scope.selected === undefined
        ? []
        : [scope.selected];
  if (ids.length === 0) return null;
  return (
    // The question's measure, then the breadcrumb's own box inside it, so it
    // sits where a Question's breadcrumb would.
    <div
      data-empty-crumb
      className="sticky top-crumb-top z-20 mx-auto -mt-crumb-lift w-full max-w-measure"
    >
      <CrumbRow
        className={`flex items-center gap-s1 text-11 text-fg/40 ${CRUMB_BOX}`}
      >
        {ids.map((id, i) => (
          <span key={id} className="flex min-w-0 items-center gap-s1">
            {i > 0 && <span>,</span>}
            <button
              type="button"
              title="Show this inbox, all its groups"
              onClick={() => select({ inboxId: id, groups: [] })}
              data-crumb-scope
              className={`min-w-0 cursor-pointer truncate hover:text-fg ${MARKED} ${focusRing}`}
            >
              {seen.get(id)?.label ?? 'This inbox'}
            </button>
          </span>
        ))}
        {scope.groups.length > 0 && (
          <>
            <span className="shrink-0">›</span>
            <button
              type="button"
              onClick={() =>
                select({ inboxId: scope.selected, groups: scope.groups })
              }
              data-crumb-scope
              className={`shrink-0 cursor-pointer hover:text-fg ${MARKED} ${focusRing}`}
            >
              {scope.groups
                .map((g) => (g === DEFAULT_GROUP ? 'Default' : g))
                .join(', ')}
            </button>
          </>
        )}
      </CrumbRow>
    </div>
  );
};
