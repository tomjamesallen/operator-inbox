import { Atom } from 'effect/reactivity';
import { activeQueueAtom, askingAtom, toggleAskAtom } from './inbox-reader';
import { inboxReaderAtoms } from './inbox-reader-machine';

// A finger's swipe on the middle panel moves along Ask, Your inbox, With the
// agent and Processed, the page following the finger: push it left for the view
// on its right. It meets the keys at `stepViewAtom`. A trackpad's sideways
// scroll steps nothing: it came too easily in the middle of an ordinary scroll.

export const SWIPE_TOUCH_PX = 60;

const sideways = (x: number, y: number): boolean =>
  Math.abs(x) > 2 * Math.abs(y);

/** The step a finger made, from where it started to where it lifted. */
export const touchSwipeOf = (dx: number, dy: number): 1 | -1 | undefined =>
  Math.abs(dx) < SWIPE_TOUCH_PX || !sideways(dx, dy)
    ? undefined
    : dx < 0
      ? 1
      : -1;

/** One step along the views. Each end stops it. */
export const stepViewAtom = Atom.writable<void, 1 | -1>(
  () => undefined,
  (ctx, by) => {
    if (ctx.get(askingAtom)) {
      if (by === -1) return;
      ctx.set(inboxReaderAtoms.send, { type: 'AskClosed' });
      ctx.set(inboxReaderAtoms.send, { type: 'QueueChosen', queue: 'inbox' });
      return;
    }
    if (by === -1 && ctx.get(activeQueueAtom) === 'inbox') {
      ctx.set(toggleAskAtom, undefined);
      return;
    }
    ctx.set(inboxReaderAtoms.send, { type: 'QueueStepped', by });
  },
);

// A wide table or code block scrolls under the same gesture, and keeps it.
const scrollsSideways = (from: Element, reader: Element): boolean => {
  for (let el: Element | null = from; el !== null && el !== reader; ) {
    const overflow = getComputedStyle(el).overflowX;
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      el.scrollWidth > el.clientWidth
    )
      return true;
    el = el.parentElement;
  }
  return false;
};

const panelOf = (target: EventTarget | null): Element | undefined => {
  if (!(target instanceof Element)) return undefined;
  // A finger on the minimap is scrubbing, however far it drifts sideways.
  if (target.closest('[data-zen-minimap]') !== null) return undefined;
  const reader = target.closest('[data-inbox-reader]');
  return reader === null || scrollsSideways(target, reader)
    ? undefined
    : reader;
};

// Chrome on a Mac takes a sideways trackpad swipe as back or forward, which here
// would leave the inbox mid-answer, so the document gives it up for as long as
// the page is up.
const NO_HISTORY_SWIPE = 'overscroll-x-none';

/** The listeners, for as long as the page is up. */
export const readerSwipeAtom: Atom.Atom<void> = Atom.readable((get) => {
  if (typeof document === 'undefined') return;
  let touch: { readonly x: number; readonly y: number } | undefined;
  const step = (by: 1 | -1 | undefined) => {
    if (by !== undefined) get.set(stepViewAtom, by);
  };
  const onTouchStart = (e: TouchEvent) => {
    const first = e.touches[0];
    touch =
      e.touches.length === 1 &&
      first !== undefined &&
      panelOf(e.target) !== undefined
        ? { x: first.clientX, y: first.clientY }
        : undefined;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const last = e.changedTouches[0];
    if (touch !== undefined && last !== undefined)
      step(touchSwipeOf(last.clientX - touch.x, last.clientY - touch.y));
    touch = undefined;
  };
  const onTouchCancel = () => {
    touch = undefined;
  };
  document.documentElement.classList.add(NO_HISTORY_SWIPE);
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true });
  get.addFinalizer(() => {
    document.documentElement.classList.remove(NO_HISTORY_SWIPE);
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchCancel);
  });
});
