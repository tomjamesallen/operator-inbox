import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { TriangleAlert } from 'lucide-react';
import {
  drawnBoardAtom,
  inDesktopWindow,
  openSessionLinkAtom,
  sessionTargetOf,
} from '../../inbox';
import { chasesAtom } from '../../inbox-chase';
import {
  inboxPickerOpenAtom,
  setInboxPickerOpenAtom,
} from '../../inbox-picker';

// The chase: a Chase link beside a stale question's time, and a warning button
// counting the Inboxes that hold one. Which questions are stale is
// `inbox-chase.ts`; here they are drawn.

// Not on a touch screen, by the device, as Open session: a phone has no Claude
// app to hand the link to.
const LINK =
  'pointer-coarse:hidden cursor-pointer text-orange underline decoration-orange/40 hover:decoration-orange';

/**
 * Chase, to the Inbox's session: a link out of a browser, serve's open in the
 * desktop app's window. Greyed and naming the machine for a session on another
 * one; nothing for an Inbox with no session link.
 */
export const ChaseLink = ({
  inboxId,
  className = '',
}: {
  readonly inboxId: string;
  readonly className?: string;
}) => {
  const board = useAtomValue(drawnBoardAtom);
  const open = useAtomSet(openSessionLinkAtom);
  const target = sessionTargetOf(board, inboxId);
  if (target === undefined) return null;
  if (target._tag === 'Elsewhere')
    return (
      <span
        data-chase="elsewhere"
        className={`text-fg/30 pointer-coarse:hidden ${className}`}
      >
        Chase on {target.machine}
      </span>
    );
  // No `target`: the OS hands this to the Claude app, and a new tab would be
  // left behind empty.
  return inDesktopWindow() ? (
    <button
      type="button"
      data-chase="here"
      onClick={(e) => {
        e.stopPropagation();
        open(target.link);
      }}
      className={`${LINK} ${className}`}
    >
      Chase
    </button>
  ) : (
    <a
      href={target.link}
      data-chase="here"
      onClick={(e) => e.stopPropagation()}
      className={`${LINK} ${className}`}
    >
      Chase
    </a>
  );
};

// --- the button ------------------------------------------------------------------

const chasingLabel = (n: number) =>
  `${n} ${n === 1 ? 'Inbox' : 'Inboxes'} probably ${n === 1 ? 'needs' : 'need'} chasing`;

/**
 * The chase button, in the reader's foot: a round warning in the bottom right,
 * there only while some Inbox has a question stale with the agent, with the
 * count of those Inboxes. It never folds away while there is something to
 * chase. A click opens the inbox picker, which lists those Inboxes first, and
 * a second shuts it. Placed as the answer box allows: in the bottom right
 * corner while the column has room beside the centred box (`@chase-beside:`,
 * a container query on the foot), above the foot's right edge otherwise.
 */
export const ChaseButton = () => {
  const chases = useAtomValue(chasesAtom);
  const open = useAtomValue(inboxPickerOpenAtom);
  const setOpen = useAtomSet(setInboxPickerOpenAtom);
  const count = chases.length;
  if (count === 0) return null;
  const label = `${chasingLabel(count)} — open the inbox picker`;
  return (
    <button
      type="button"
      aria-label={label}
      title={chasingLabel(count)}
      aria-expanded={open}
      data-chase-button
      onClick={() => setOpen(!open)}
      className="absolute right-s5 bottom-full z-20 flex size-6 cursor-pointer items-center justify-center rounded-full border border-orange/40 bg-rail text-orange shadow-sm transition-colors hover:bg-orange/10 motion-reduce:transition-none @chase-beside:right-s4 @chase-beside:bottom-s4"
    >
      <TriangleAlert aria-hidden className="size-3.5" />
      <span
        aria-hidden
        data-chase-count
        className="absolute -top-1 -right-1 flex min-w-3 items-center justify-center rounded-full bg-orange px-0.5 font-zen text-9 leading-card text-rail tabular-nums"
      >
        {count}
      </span>
    </button>
  );
};
