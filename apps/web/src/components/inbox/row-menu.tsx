import { Menu } from '@base-ui/react/menu';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { InboxId } from '@operator-inbox/core/api';
import {
  archiveAtom,
  drawnBoardAtom,
  muteAtom,
  pinAtom,
  pinKey,
} from '../../inbox';
import { openRenameAtom } from '../../inbox-rail';
import { keyHintAtom } from '../../keymap';
import { LitMetaItem, MetaItem } from './colophon';
import { Icon } from './icon';
import { OpenSessionItem } from './open-session';

// What acts on an Inbox, and on one of its groups: a sidebar row's menu, opened
// by a right-click or a long press on the row, and on a touch screen the
// selected Inbox's ⋯ over the box, beside the metadata icon.

export interface PinPlace {
  readonly inboxId: InboxId;
  readonly group?: string;
}

export const POPUP =
  'border border-fg/12 bg-bg py-s1 font-zen text-11 outline-none';

/** One item of a row's menu, in either of its two ways in. */
export const MENU_ITEM =
  'flex cursor-pointer items-center justify-between gap-s4 px-s2 py-s1 text-fg/70 outline-none data-disabled:cursor-default data-disabled:text-fg/30 data-highlighted:bg-fg/8 data-highlighted:text-fg';

// Pin or unpin, from the row's menu. The write is read on the row, so its
// failure stays once the menu has shut.
export const PinItem = ({
  inboxId,
  group,
  pinned,
  name,
}: PinPlace & { readonly pinned: boolean; readonly name: string }) => {
  const [result, pin] = useAtom(pinAtom(pinKey(inboxId, group)));
  const what = group === undefined ? `the inbox ${name}` : `the group ${name}`;
  return (
    <Menu.Item
      className={MENU_ITEM}
      disabled={result.waiting}
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${what}`}
      data-pin={group ?? ''}
      onClick={() =>
        pin({
          inboxId,
          pinned: !pinned,
          ...(group === undefined ? {} : { group }),
        })
      }
    >
      {pinned ? 'Unpin' : 'Pin to the top'}
    </Menu.Item>
  );
};

// A row's menu: what acts on the Inbox itself. Each write is read on the row,
// so it stays on the page after the menu has shut.
export const InboxMenuItems = ({
  inboxId,
  label,
  archived,
  muted,
  pinned,
  lit = false,
}: {
  readonly inboxId: InboxId;
  readonly label: string;
  readonly archived: boolean;
  readonly muted: boolean;
  readonly pinned: boolean;
  // Over the box with a question lit: Metadata opens that question's card.
  readonly lit?: boolean;
}) => {
  const [result, archive] = useAtom(archiveAtom(inboxId));
  const [muting, mute] = useAtom(muteAtom(inboxId));
  const openRename = useAtomSet(openRenameAtom);
  const renameKeys = useAtomValue(keyHintAtom('rename_inbox'));
  const archiveKeys = useAtomValue(keyHintAtom('toggle_archive'));
  return (
    <>
      <OpenSessionItem inboxId={inboxId} className={MENU_ITEM} />
      {lit ? (
        <LitMetaItem className={MENU_ITEM} />
      ) : (
        <MetaItem inboxId={inboxId} className={MENU_ITEM} />
      )}
      <Menu.Item className={MENU_ITEM} onClick={() => openRename(inboxId)}>
        Rename
        <span className="text-fg/30">{renameKeys.first}</span>
      </Menu.Item>
      <PinItem inboxId={inboxId} pinned={pinned} name={label} />
      <Menu.Item
        className={MENU_ITEM}
        disabled={result.waiting}
        onClick={() => archive({ archived: !archived })}
      >
        {archived ? 'Unarchive' : 'Archive'}
        <span className="text-fg/30">{archiveKeys.first}</span>
      </Menu.Item>
      <Menu.Item
        className={MENU_ITEM}
        disabled={muting.waiting}
        onClick={() => mute(!muted)}
        data-zen-mute
      >
        {muted ? 'Unmute' : 'Mute'}
      </Menu.Item>
    </>
  );
};

const MENU_ICON = 'M5 12h.01M12 12h.01M19 12h.01';

/**
 * The selected Inbox's menu, over the box, on a touch screen only: by the
 * device, not the width. A pointer that can right-click has the row's menu.
 */
export const InboxMenuButton = ({
  inboxId,
  lit = false,
}: {
  readonly inboxId: string;
  readonly lit?: boolean;
}) => {
  const board = useAtomValue(drawnBoardAtom);
  const row = board?.inboxes.find((i) => i.inboxId === inboxId);
  if (row === undefined) return null;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`More for ${row.label}`}
        data-zen-inbox-menu
        className="hidden shrink-0 cursor-pointer items-center text-fg/30 hover:text-fg pointer-coarse:flex"
      >
        <Icon d={MENU_ICON} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={4} className="z-40">
          <Menu.Popup finalFocus={false} className={POPUP}>
            <InboxMenuItems
              inboxId={row.inboxId}
              label={row.label}
              archived={row.archived}
              muted={row.muted === true}
              pinned={row.pinned}
              lit={lit}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};
