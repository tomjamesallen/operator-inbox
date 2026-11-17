import { Toast } from '@base-ui/react/toast';
import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import {
  type CardRemoval,
  latestRemovalAtom,
  removalLabel,
  undoCardRemovalAtom,
} from '../../card-undo';
import { askPlaceOf, composerAtom } from '../../inbox-reader';
import { keyHintAtom } from '../../keymap';

// The notice a card's removal leaves over the answer box, or the ask box: "Comment removed ·
// Undo", for a few seconds. It is Base UI's toast, as the chase's toasts were,
// kept in step with the answer's newest removal (`card-undo.ts`): it goes once
// that removal is undone, another replaces it, the answer is sent, or the box
// goes. Typing since leaves it, and its button still brings the card back,
// though ⌘Z is then the field's. F6 takes the focus to it, as Base UI's toasts
// do.

/** How long the notice stays, unless the pointer or the focus is on it. */
export const UNDO_NOTICE_MS = 5_000;

interface UndoOffer {
  readonly key: string;
  readonly removal: CardRemoval;
}

// The box on screen's newest removal.
const undoOfferAtom = Atom.make((get): UndoOffer | undefined => {
  const composer = get(composerAtom);
  const key =
    composer._tag === 'Answer' || composer._tag === 'Held'
      ? composer.item.key
      : composer._tag === 'Asking'
        ? askPlaceOf(composer.inboxId)
        : undefined;
  if (key === undefined) return undefined;
  const removal = get(latestRemovalAtom(key));
  return removal === undefined ? undefined : { key, removal };
});

const manager = Toast.createToastManager<{ readonly offer: UndoOffer }>();

// Only a new removal raises the notice: one an undo uncovers below it, or one
// come back to on another Question, can still be undone by key, without one.
// Mounted with the notice, so its subscription lives with it.
const undoNoticeSyncAtom = Atom.readable((get) => {
  let shown: string | undefined;
  let newest = 0;
  const sync = (offer: UndoOffer | undefined) => {
    const id = offer === undefined ? undefined : String(offer.removal.seq);
    if (id === shown) return;
    if (shown !== undefined) manager.close(shown);
    shown = undefined;
    if (offer === undefined || id === undefined || offer.removal.seq <= newest)
      return;
    newest = offer.removal.seq;
    shown = id;
    manager.add({
      id,
      timeout: UNDO_NOTICE_MS,
      priority: 'low',
      data: { offer },
    });
  };
  get.subscribe(undoOfferAtom, sync, { immediate: true });
  get.addFinalizer(() => {
    if (shown !== undefined) manager.close(shown);
  });
});

const UndoToast = ({
  toast,
}: {
  readonly toast: Toast.Root.ToastObject<{ readonly offer: UndoOffer }>;
}) => {
  const undo = useAtomSet(undoCardRemovalAtom);
  const hint = useAtomValue(keyHintAtom('undo_card_removal'));
  const offer = toast.data?.offer;
  if (offer === undefined) return null;
  return (
    <Toast.Root
      toast={toast}
      data-undo-notice={offer.removal.removed._tag}
      className="pointer-events-auto flex items-baseline gap-s2 border border-fg/12 bg-bg px-s2 py-0.5 font-zen text-11 text-fg/55 shadow-sm transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
    >
      <Toast.Description>{removalLabel(offer.removal)}</Toast.Description>
      <span aria-hidden className="text-fg/25">
        ·
      </span>
      <Toast.Action
        title={`Undo${hint.all === undefined ? '' : ` (${hint.all})`}`}
        aria-keyshortcuts={hint.aria}
        onClick={() => undo({ key: offer.key, seq: offer.removal.seq })}
        className="cursor-pointer text-fg/80 underline decoration-fg/30 outline-none hover:text-fg hover:decoration-fg focus-visible:decoration-fg"
      >
        Undo
      </Toast.Action>
      {hint.first !== undefined && (
        <span aria-hidden className="text-fg/30 touch-only:hidden">
          {hint.first}
        </span>
      )}
    </Toast.Root>
  );
};

const UndoToastList = () => {
  const { toasts } = Toast.useToastManager<{ readonly offer: UndoOffer }>();
  return toasts.map((t) => <UndoToast key={t.id} toast={t} />);
};

/**
 * The undo notice, over the answer box's top left: in the fade between the
 * Question and the box, so nothing moves as it comes and goes.
 */
export const UndoNotice = () => {
  useAtomMount(undoNoticeSyncAtom);
  return (
    <Toast.Provider toastManager={manager} limit={1}>
      <Toast.Viewport
        data-undo-notices
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-s1 flex outline-none"
      >
        <UndoToastList />
      </Toast.Viewport>
    </Toast.Provider>
  );
};
