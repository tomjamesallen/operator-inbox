import { Menu } from '@base-ui/react/menu';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/reactivity';
import {
  drawnBoardAtom,
  inDesktopWindow,
  openSessionAtom,
  openSessionLinkAtom,
  sessionTargetOf,
} from '../../inbox';
import { keyHintAtom } from '../../keymap';
import { ICON_EXTERNAL, ICON_FAILED, Icon, Tip } from './icon';

const LABEL = 'Open session';

const iconStyle = 'flex cursor-pointer items-center text-fg/30 hover:text-fg';
const failedStyle = 'flex cursor-pointer items-center text-red';

// In the desktop app's window serve opens the link.
const SessionButton = ({ link }: { readonly link: string }) => {
  const [result, open] = useAtom(openSessionAtom(link));
  const hint = useAtomValue(keyHintAtom('open_session'));
  const failed = AsyncResult.isFailure(result);
  return (
    <Tip label={failed ? 'Did not open' : LABEL} keys={hint.first}>
      <button
        type="button"
        aria-label={LABEL}
        aria-keyshortcuts={hint.aria}
        data-open-session
        onClick={() => open()}
        className={failed ? failedStyle : iconStyle}
      >
        <Icon d={failed ? ICON_FAILED : ICON_EXTERNAL} />
      </button>
    </Tip>
  );
};

// No `target`: the OS hands this to the Claude app, and a new tab would be left
// behind empty.
const SessionAnchor = ({ link }: { readonly link: string }) => {
  const hint = useAtomValue(keyHintAtom('open_session'));
  return (
    <Tip label={LABEL} keys={hint.first}>
      <a
        href={link}
        aria-label={LABEL}
        aria-keyshortcuts={hint.aria}
        data-open-session
        className={iconStyle}
      >
        <Icon d={ICON_EXTERNAL} />
      </a>
    </Tip>
  );
};

// The session working an Inbox, one click away. A session on another machine
// cannot open here, so the icon stays, greyed, and says where it is. Not on a
// touch screen, by the device and not the width: a phone has no Claude app to
// hand the link to.
export const OpenSession = ({ inboxId }: { readonly inboxId: string }) => (
  <span className="flex pointer-coarse:hidden" data-open-session-wrap>
    <SessionIcon inboxId={inboxId} />
  </span>
);

const SessionIcon = ({ inboxId }: { readonly inboxId: string }) => {
  const board = useAtomValue(drawnBoardAtom);
  const target = sessionTargetOf(board, inboxId);
  if (target === undefined) return null;
  if (target._tag === 'Elsewhere') {
    const label = `Session on ${target.machine}`;
    return (
      <Tip label={label} keys={undefined}>
        <button
          type="button"
          disabled
          aria-label={label}
          data-open-session
          className="flex items-center text-fg/15"
        >
          <Icon d={ICON_EXTERNAL} />
        </button>
      </Tip>
    );
  }
  return inDesktopWindow() ? (
    <SessionButton link={target.link} />
  ) : (
    <SessionAnchor link={target.link} />
  );
};

/** The same, as a line of a sidebar row's menu. */
export const OpenSessionItem = ({
  inboxId,
  className,
}: {
  readonly inboxId: string;
  readonly className: string;
}) => {
  const board = useAtomValue(drawnBoardAtom);
  const open = useAtomSet(openSessionLinkAtom);
  const hint = useAtomValue(keyHintAtom('open_session'));
  const target = sessionTargetOf(board, inboxId);
  if (target === undefined) return null;
  return target._tag === 'Elsewhere' ? (
    <Menu.Item className={className} disabled>
      Session on {target.machine}
    </Menu.Item>
  ) : (
    <Menu.Item className={className} onClick={() => open(target.link)}>
      {LABEL}
      <span className="text-fg/30 touch-only:hidden">{hint.first}</span>
    </Menu.Item>
  );
};
