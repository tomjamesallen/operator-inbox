import { Toast } from '@base-ui/react/toast';
import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import {
  drawnBoardAtom,
  inDesktopWindow,
  openSessionLinkAtom,
  sessionTargetOf,
} from '../../inbox';
import {
  type ChaseToast,
  chaseLine,
  chaseToastsAtom,
  dismissChaseAtom,
} from '../../inbox-chase';
import { ICON_FAILED, Icon } from './icon';

// The chase: a Chase link beside a stale question's time, and a toast per
// Inbox that stays until dismissed. Which questions are stale, and which
// toasts show, is `inbox-chase.ts`; here they are drawn.

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

// --- the toasts ------------------------------------------------------------------

const manager = Toast.createToastManager<{ readonly chase: ChaseToast }>();

const sameToast = (a: ChaseToast, b: ChaseToast) =>
  chaseLine(a) === chaseLine(b) &&
  a.target?._tag === b.target?._tag &&
  (a.target?._tag !== 'Here' ||
    (b.target?._tag === 'Here' && a.target.link === b.target.link));

// Keeps Base UI's toasts in step with `chaseToastsAtom`. A toast the operator
// closes is dismissed; one this closes, because its questions left With the
// agent, is not. Mounted with the toasts, so its subscription lives with them.
const chaseToastSyncAtom = Atom.readable((get) => {
  const shown = new Map<string, ChaseToast>();
  const sync = (toasts: ReadonlyArray<ChaseToast>) => {
    const wanted = new Set(toasts.map((t) => t.id));
    for (const id of [...shown.keys()])
      if (!wanted.has(id)) {
        shown.delete(id);
        manager.close(id);
      }
    for (const toast of toasts) {
      const was = shown.get(toast.id);
      shown.set(toast.id, toast);
      if (was === undefined)
        manager.add({
          id: toast.id,
          timeout: 0,
          data: { chase: toast },
          onClose: () => {
            const last = shown.get(toast.id);
            if (last === undefined) return;
            shown.delete(toast.id);
            get.set(dismissChaseAtom, last);
          },
        });
      else if (!sameToast(was, toast))
        manager.update(toast.id, { data: { chase: toast } });
    }
  };
  get.subscribe(chaseToastsAtom, sync, { immediate: true });
  get.addFinalizer(() => {
    const ids = [...shown.keys()];
    shown.clear();
    for (const id of ids) manager.close(id);
  });
});

const ChaseToastItem = ({
  toast,
}: {
  readonly toast: Toast.Root.ToastObject<{ readonly chase: ChaseToast }>;
}) => {
  const chase = toast.data?.chase;
  if (chase === undefined) return null;
  return (
    <Toast.Root
      toast={toast}
      data-chase-toast={chase.inboxId}
      className="pointer-events-auto flex w-full items-start gap-s3 border border-orange/40 bg-rail p-s3 font-zen text-12 text-fg/80 shadow-sm"
    >
      <Toast.Content className="min-w-0 flex-1">
        <Toast.Title className="font-medium text-orange">
          Probably needs chasing
        </Toast.Title>
        <Toast.Description className="mt-s1 leading-body">
          {chaseLine(chase)}
        </Toast.Description>
        <ChaseLink inboxId={chase.inboxId} className="mt-s1 inline-block" />
      </Toast.Content>
      <Toast.Close
        aria-label="Dismiss"
        className="flex shrink-0 cursor-pointer items-center text-fg/30 hover:text-fg"
      >
        <Icon d={ICON_FAILED} />
      </Toast.Close>
    </Toast.Root>
  );
};

const ChaseToastList = () => {
  const { toasts } = Toast.useToastManager<{ readonly chase: ChaseToast }>();
  return toasts.map((t) => <ChaseToastItem key={t.id} toast={t} />);
};

/** The chase toasts, top right, under the tabs, over everything but the dialogs. */
export const ChaseToasts = () => {
  useAtomMount(chaseToastSyncAtom);
  // Every stale Inbox shows: a chase hidden behind a limit is no chase.
  return (
    <Toast.Provider toastManager={manager} limit={Number.POSITIVE_INFINITY}>
      <Toast.Portal>
        <Toast.Viewport
          data-chase-toasts
          className="pointer-events-none fixed inset-x-s4 top-header z-20 ml-auto flex max-w-subtitle flex-col gap-s2"
        >
          <ChaseToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
};
