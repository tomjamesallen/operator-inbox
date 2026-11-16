import { Button } from '@base-ui/react/button';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Input } from '@base-ui/react/input';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { InboxId, InboxViewDto } from '@operator-inbox/core/api';
import { AsyncResult } from 'effect/reactivity';
import type { MouseEvent, ReactNode } from 'react';
import { clockAtom, nowMillis } from '../../clock';
import {
  failureText,
  isUnconfirmed,
  refusalText,
  unconfirmedShort,
} from '../../failure';
import {
  agoOf,
  archivedGroupsOf,
  archivedGroupsOpenAtom,
  archiveOutcomeAtom,
  DEFAULT_GROUP,
  type GroupRow,
  groupArchiveOutcomeAtom,
  groupRowsOf,
  groupsInForce,
  hashOfScreenState,
  highlightedGroups,
  inboxPath,
  muteOutcomeAtom,
  pinAtom,
  pinKey,
  pinnedFirst,
  pinOutcomeAtom,
  screenStateAtom,
  selectedInboxAtom,
  sidebarKey,
} from '../../inbox';
import type { FreshMark } from '../../inbox-queues';
import {
  freshElsewhereAtom,
  pickRowAtom,
  type RailHit,
  railListAtom,
  railRenameAtom,
} from '../../inbox-rail';
import { renamingAtom } from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { keyHintAtom } from '../../keymap';
import { InboxKeyBadge } from '../keymap-help';
import { freshMark, HIGHLIGHT, MarkStack } from './marks';
import { ArchivedGroupsFold } from './rail-folds';
import {
  GroupArchiveItem,
  InboxMenuItems,
  PinItem,
  type PinPlace,
  POPUP,
} from './row-menu';

// The sidebar's rows: All, an Inbox, and its groups. A row is a link, so a
// modifier click opens a new tab; a plain click picks it in place.

// A row of a machine that missed the last read fades, at half strength, from
// `MachineFold`'s `data-greyed`. On the row, not the section, because what a
// write the operator made came to sits outside the row and reads at full
// strength. A row holding keyboard focus is drawn at full strength while it
// does, so the focus indicator keeps its contrast. `data-greyed-faded` names the
// parts that fade for the tests.
export const FADED =
  'group-data-greyed/greyed:not-focus-visible:not-has-focus-visible:opacity-50';

// A muted Inbox's row, greyed all through, its count too. Kept at full
// strength while it holds keyboard focus, as `FADED` is.
const MUTED = 'not-focus-visible:not-has-focus-visible:opacity-40';

const outcomeLine =
  'px-s2 pb-s1 text-11 whitespace-normal wrap-anywhere text-red';

// A pushpin, drawn in the current colour: filled when pinned.
export const PinIcon = ({ filled }: { readonly filled: boolean }) => (
  <svg
    viewBox="0 0 16 16"
    className="size-3"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M10 1.5 14.5 6l-2 .5-2.5 2.5.5 3.5L9 14 6.5 11.5 2.5 15.5M6.5 11.5 4 9l1.5-1.5L9 5l.5-2.5z" />
  </svg>
);

// A pinned row's pin: a click unpins it, as Unpin in the row's menu does. A
// button beside the row's link, not in it, so the click never picks the row.
const UnpinButton = ({
  inboxId,
  group,
  name,
}: PinPlace & { readonly name: string }) => {
  const [result, pin] = useAtom(pinAtom(pinKey(inboxId, group)));
  const label = `Unpin ${name}`;
  return (
    <Button
      title={label}
      aria-label={label}
      disabled={result.waiting}
      data-pinned-mark
      data-unpin={group ?? ''}
      onClick={() =>
        pin({
          inboxId,
          pinned: false,
          ...(group === undefined ? {} : { group }),
        })
      }
      className="flex shrink-0 cursor-pointer items-center text-fg/45 hover:text-fg focus-visible:text-fg disabled:cursor-default disabled:opacity-50"
    >
      <PinIcon filled />
    </Button>
  );
};

/** A plain click: anything else opens the link as the browser would. */
export const plainClick = (e: MouseEvent<HTMLAnchorElement>): boolean =>
  !(e.metaKey || e.ctrlKey || e.altKey || e.button !== 0);

interface RowProps {
  readonly href: string;
  readonly label: string;
  readonly title?: string;
  readonly count: number | undefined;
  readonly on: boolean;
  // What the current row is to a screen reader.
  readonly current?: 'page' | 'true';
  // One of the search's best matches.
  readonly top?: boolean;
  // Holds a highlighted question.
  readonly lit?: boolean;
  readonly nested?: boolean;
  // Muted by the operator: drawn greyed.
  readonly muted?: boolean;
  readonly fresh?: ReadonlyArray<FreshMark>;
  // The key a waiting prefix would take to reach this row.
  readonly badge?: ReactNode;
  // Drawn as a pin, which unpins the row when clicked; pinning is in the
  // row's menu.
  readonly pinned?: boolean;
  // What the pin unpins, and the name its label gives it.
  readonly pin?: PinPlace & { readonly name: string };
  // The row's menu, opened by a right-click or a long press on the row. On a
  // touch screen the selected Inbox's is over the box too (`InboxMenuButton`).
  readonly menu?: ReactNode;
  // In place of the link, while the row is being renamed.
  readonly editing?: ReactNode;
  // What the keymap and the tests find the link by.
  readonly hooks?: Readonly<Record<`data-${string}`, string | undefined>>;
  readonly onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
}

export const RailRow = ({
  href,
  label,
  title = label,
  count,
  on,
  current = 'page',
  top = false,
  lit = false,
  nested = false,
  muted = false,
  fresh = [],
  badge,
  pinned = false,
  pin,
  menu,
  editing,
  hooks,
  onClick,
}: RowProps) => {
  const className = `group/row relative flex items-center gap-s1 px-s2 ${nested ? 'pl-s4' : ''} ${top && !on ? 'bg-fg/5' : ''} ${muted ? MUTED : ''} ${FADED}`;
  const body = (
    <>
      {editing ?? (
        <a
          href={href}
          onClick={onClick}
          aria-current={on ? current : undefined}
          title={title}
          data-highlighted={lit || undefined}
          data-search-top={top || undefined}
          {...hooks}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-s1 py-s1 pointer-coarse:py-s2 ${on ? 'text-fg' : 'text-fg/50 hover:text-fg/80'}`}
        >
          <span className="truncate">{label}</span>
          <MarkStack
            marks={[...(lit ? [HIGHLIGHT] : []), ...fresh.map(freshMark)]}
          />
        </a>
      )}
      {pinned &&
        (pin === undefined ? (
          <span
            title="Pinned"
            data-pinned-mark
            className="flex shrink-0 items-center text-fg/45"
          >
            <PinIcon filled />
          </span>
        ) : (
          <UnpinButton {...pin} />
        ))}
      <span
        className={`w-4 shrink-0 text-right text-11 tabular-nums ${nested ? 'text-fg/25' : 'text-fg/50'}`}
      >
        {count === undefined || count === 0 ? '' : count}
      </span>
      {badge}
    </>
  );
  if (menu === undefined)
    return (
      <div
        data-greyed-faded
        data-muted={muted || undefined}
        className={className}
      >
        {body}
      </div>
    );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        data-greyed-faded
        data-muted={muted || undefined}
        data-row-menu-area
        className={className}
      >
        {body}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-40">
          <ContextMenu.Popup finalFocus={false} className={POPUP}>
            {menu}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
};

// Worded by what the pin asked for, and gone once a board shows it.
const PinFailure = ({ inboxId, group }: PinPlace) => {
  const outcome = useAtomValue(pinOutcomeAtom(pinKey(inboxId, group)));
  if (outcome === undefined || outcome.settled) return null;
  return (
    <p className={outcomeLine} role="alert" data-pin-outcome={group ?? ''}>
      {isUnconfirmed(outcome.failure)
        ? unconfirmedShort(
            outcome.asked.pinned ? 'Pin' : 'Unpin',
            outcome.failure,
          )
        : refusalText(
            outcome.asked.pinned ? 'Not pinned' : 'Not unpinned',
            outcome.failure,
            inboxId,
            'PinRefused',
          )}
    </p>
  );
};

const ArchiveFailure = ({ inboxId }: { readonly inboxId: InboxId }) => {
  const outcome = useAtomValue(archiveOutcomeAtom(inboxId));
  if (outcome === undefined || outcome.settled) return null;
  return (
    <p className={outcomeLine} role="alert" data-archive-outcome>
      {refusalText(
        outcome.asked ? 'Not archived' : 'Not unarchived',
        outcome.failure,
        inboxId,
        'ArchiveRefused',
      )}
    </p>
  );
};

const GroupArchiveFailure = ({
  inboxId,
  group,
}: {
  readonly inboxId: InboxId;
  readonly group: string;
}) => {
  const outcome = useAtomValue(groupArchiveOutcomeAtom(pinKey(inboxId, group)));
  if (outcome === undefined || outcome.settled) return null;
  return (
    <p className={outcomeLine} role="alert" data-group-archive-outcome={group}>
      {isUnconfirmed(outcome.failure)
        ? unconfirmedShort(
            outcome.asked.archived ? 'Archive' : 'Unarchive',
            outcome.failure,
          )
        : refusalText(
            outcome.asked.archived ? 'Not archived' : 'Not unarchived',
            outcome.failure,
            inboxId,
            'ArchiveRefused',
          )}
    </p>
  );
};

const MuteFailure = ({ inboxId }: { readonly inboxId: InboxId }) => {
  const outcome = useAtomValue(muteOutcomeAtom(inboxId));
  if (outcome === undefined || outcome.settled) return null;
  return (
    <p className={outcomeLine} role="alert" data-mute-outcome>
      {refusalText(
        outcome.asked ? 'Not muted' : 'Not unmuted',
        outcome.failure,
        inboxId,
        'MuteRefused',
      )}
    </p>
  );
};

// After the menu has let go of the focus. A ref's cleanup is the timer's.
const RENAME_FOCUS_MS = 50;
const focusWhenFree = (field: HTMLInputElement | null) => {
  if (field === null) return;
  const id = setTimeout(() => {
    field.focus();
    field.select();
  }, RENAME_FOCUS_MS);
  return () => clearTimeout(id);
};

// Enter asks for the name as it stands, an unchanged one too, which core
// refuses and the line under the row says. Leaving the field saves a changed
// name and quietly drops an unchanged one, since nobody asked for that write;
// after a refusal it stays open, or the reason would go with it.
const RenameField = ({
  inboxId,
  label,
}: {
  readonly inboxId: InboxId;
  readonly label: string;
}) => {
  const [result, rename] = useAtom(railRenameAtom(inboxId));
  const send = useAtomSet(inboxReaderAtoms.send);
  const close = () => send({ type: 'RenameClosed' });
  const save = (name: string) => {
    if (!result.waiting) rename(name);
  };
  return (
    <Input
      ref={focusWhenFree}
      defaultValue={label}
      aria-label="Inbox name"
      data-zen-rename
      onBlur={(e) => {
        const name = e.currentTarget.value.trim();
        if (name === '' || name === label) close();
        else if (!AsyncResult.isFailure(result)) save(name);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') save(e.currentTarget.value.trim());
        if (e.key === 'Escape') close();
      }}
      className="w-full min-w-0 flex-1 bg-fg/8 py-s1 text-fg outline-none pointer-coarse:text-field"
    />
  );
};

const RenameFailure = ({ inboxId }: { readonly inboxId: InboxId }) => {
  const result = useAtomValue(railRenameAtom(inboxId));
  if (!AsyncResult.isFailure(result)) return null;
  return (
    <p className={outcomeLine} role="alert" data-rename-outcome>
      {refusalText(
        'Not renamed',
        failureText(result.cause),
        inboxId,
        'RenameRefused',
      )}
    </p>
  );
};

const GroupRowLink = ({
  inboxId,
  group,
  inForce,
  here,
  pinned,
  lit,
  top,
}: {
  readonly inboxId: InboxId;
  readonly group: GroupRow;
  readonly inForce: ReadonlyArray<string>;
  // Its Inbox is the one selected, so shift adds to what is in force.
  readonly here: boolean;
  readonly pinned: boolean;
  readonly lit: boolean;
  readonly top: boolean;
}) => {
  const pick = useAtomSet(pickRowAtom);
  const hint = useAtomValue(keyHintAtom('toggle_group'));
  const on = inForce.includes(group.group);
  // Default has no name to pin or archive.
  const named = group.group !== DEFAULT_GROUP;
  const name = named ? group.group : 'Default';
  // An archived group's pin waits for it to come back, as an archived
  // Inbox's does: its row shows no pin, and its menu only brings it back.
  const showsPin = pinned && !group.archived;
  return (
    <>
      <RailRow
        nested
        href={`${inboxPath(inboxId)}${hashOfScreenState({
          inboxes: [],
          groups: [group.group],
        })}`}
        label={name}
        title={`${name} — shift-click${
          hint.all === undefined ? '' : `, or ${hint.all} on it,`
        } to add or remove it`}
        count={group.awaitingOperator}
        on={on}
        current="true"
        top={top}
        lit={lit}
        hooks={{
          'data-rail-group': group.group,
          'data-inbox': inboxId,
          'data-group-archived': group.archived ? '' : undefined,
        }}
        pinned={showsPin}
        pin={{ inboxId, group: group.group, name: `the group ${name}` }}
        {...(named
          ? {
              menu: (
                <>
                  {!group.archived && (
                    <PinItem
                      inboxId={inboxId}
                      group={group.group}
                      pinned={pinned}
                      name={name}
                    />
                  )}
                  <GroupArchiveItem
                    inboxId={inboxId}
                    group={group.group}
                    archived={group.archived}
                  />
                </>
              ),
            }
          : {})}
        onClick={(e) => {
          if (!plainClick(e)) return;
          e.preventDefault();
          if (e.shiftKey && here)
            pick({
              inboxId,
              groups: on
                ? inForce.filter((g) => g !== group.group)
                : [...inForce, group.group],
            });
          else pick({ inboxId, groups: [group.group] });
        }}
      />
      {named && <PinFailure inboxId={inboxId} group={group.group} />}
      {named && <GroupArchiveFailure inboxId={inboxId} group={group.group} />}
    </>
  );
};

/**
 * An Inbox's row and, once any of its questions has one and the Inbox is the
 * one selected (or a search reaches into it), its groups' rows: the archived
 * ones under a fold of their own.
 */
export const InboxRows = ({
  hit,
  view,
  top,
}: {
  readonly hit: RailHit;
  readonly view: InboxViewDto | undefined;
  readonly top: ReadonlySet<string>;
}) => {
  const { row, groups: only } = hit;
  const { inboxId, label } = row;
  const selected = useAtomValue(selectedInboxAtom);
  const { groups: chosen } = useAtomValue(screenStateAtom);
  const renaming = useAtomValue(renamingAtom);
  const fresh = useAtomValue(freshElsewhereAtom);
  const { searching } = useAtomValue(railListAtom);
  const [archivedOpen, setArchivedOpen] = useAtom(
    archivedGroupsOpenAtom(inboxId),
  );
  const pick = useAtomSet(pickRowAtom);
  const now = nowMillis(useAtomValue(clockAtom));
  const here = selected === inboxId;
  const pinnedGroups = view?.pinnedGroups ?? [];
  // Default stays first; pinned groups lead the rest.
  const rows = view === undefined ? [] : groupRowsOf(view);
  const all = [
    ...rows.filter((g) => g.group === DEFAULT_GROUP),
    ...pinnedFirst(
      rows.filter((g) => g.group !== DEFAULT_GROUP),
      (g) => pinnedGroups.includes(g.group),
    ),
  ];
  const muted = row.muted === true;
  // A muted Inbox's groups fold away.
  const groups = muted
    ? []
    : only === undefined
      ? all
      : all.filter((g) => only.has(g.group));
  const inForce = here && view !== undefined ? groupsInForce(view, chosen) : [];
  const lit = view === undefined ? new Set<string>() : highlightedGroups(view);
  const active = groups.filter((g) => !g.archived);
  const archived = groups.filter((g) => g.archived);
  // The Inbox row is lit for what its own view shows: not an archived group.
  const putAway = view === undefined ? [] : archivedGroupsOf(view);
  const litShown = [...lit].some((g) => !putAway.includes(g));
  const groupItem = (g: GroupRow) => (
    <li key={g.group}>
      <GroupRowLink
        inboxId={inboxId}
        group={g}
        inForce={inForce}
        here={here}
        pinned={pinnedGroups.includes(g.group)}
        lit={lit.has(g.group)}
        top={top.has(sidebarKey(inboxId, g.group))}
      />
    </li>
  );
  const seen = agoOf(row.lastActivityAt, now);
  const editing = renaming === inboxId;
  return (
    <>
      <RailRow
        href={inboxPath(inboxId)}
        label={label}
        title={`${label}${row.code === undefined ? '' : ` · ${row.code}`} · ${inboxId}${muted ? ' · muted' : ''}${seen === undefined ? '' : `\nLast seen ${seen}`}`}
        count={row.awaitingOperator}
        on={here && inForce.length === 0}
        top={top.has(sidebarKey(inboxId))}
        lit={litShown}
        muted={muted}
        fresh={fresh.filter((f) => f.inboxId === inboxId).slice(-1)}
        hooks={{ 'data-rail-inbox': inboxId }}
        badge={<InboxKeyBadge inboxId={inboxId} />}
        pinned={row.pinned}
        pin={{ inboxId, name: label }}
        menu={
          <InboxMenuItems
            inboxId={inboxId}
            label={label}
            archived={row.archived}
            muted={muted}
            pinned={row.pinned}
          />
        }
        {...(editing
          ? { editing: <RenameField inboxId={inboxId} label={label} /> }
          : {})}
        onClick={(e) => {
          if (!plainClick(e) || e.shiftKey) return;
          e.preventDefault();
          pick({ inboxId, groups: [] });
        }}
      />
      {editing && <RenameFailure inboxId={inboxId} />}
      <PinFailure inboxId={inboxId} />
      <ArchiveFailure inboxId={inboxId} />
      <MuteFailure inboxId={inboxId} />
      {active.length > 0 && (
        <ul aria-label={`Groups in ${label}`} data-rail-groups>
          {active.map(groupItem)}
        </ul>
      )}
      {archived.length > 0 && (
        <ArchivedGroupsFold
          count={archived.length}
          open={
            archivedOpen ||
            searching ||
            archived.some((g) => inForce.includes(g.group))
          }
          onOpenChange={setArchivedOpen}
        >
          <ul aria-label={`Archived groups in ${label}`} data-rail-groups>
            {archived.map(groupItem)}
          </ul>
        </ArchivedGroupsFold>
      )}
    </>
  );
};
