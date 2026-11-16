import { Atom } from 'effect/reactivity';
import { activeQueueAtom, askingAtom, toggleAskAtom } from './inbox-reader';
import { inboxReaderAtoms } from './inbox-reader-machine';

// A swipe on the middle panel moves along Ask, Your inbox, With the agent and
// Processed, the page following the fingers: push it left for the view on its
// right. A trackpad reaches the page as a run of wheel events and a finger as
// one touch, so the two are told apart here and meet at `stepViewAtom`, as the
// keys do.

export const SWIPE_WHEEL_PX = 120;
export const SWIPE_TOUCH_PX = 60;

// A trackpad's momentum runs on after the fingers lift, in events close
// together: only a gap this long ends the gesture.
const WHEEL_REST_MS = 150;

export interface WheelGesture {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly stepped: boolean;
}

export const WHEEL_AT_REST: WheelGesture = {
  x: 0,
  y: 0,
  at: Number.NEGATIVE_INFINITY,
  stepped: false,
};

const sideways = (x: number, y: number): boolean =>
  Math.abs(x) > 2 * Math.abs(y);

/** One wheel event on a gesture, and the step it makes, at most one a gesture. */
export const wheelSwipeStep = (
  was: WheelGesture,
  dx: number,
  dy: number,
  at: number,
): { readonly next: WheelGesture; readonly by?: 1 | -1 } => {
  const from = at - was.at > WHEEL_REST_MS ? WHEEL_AT_REST : was;
  const next = { x: from.x + dx, y: from.y + dy, at, stepped: from.stepped };
  if (
    next.stepped ||
    Math.abs(next.x) < SWIPE_WHEEL_PX ||
    !sideways(next.x, next.y)
  )
    return { next };
  return { next: { ...next, stepped: true }, by: next.x > 0 ? 1 : -1 };
};

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

// Chrome on a Mac takes a sideways swipe the page leaves alone as back or
// forward, so the document gives it up for as long as the page is up.
const NO_HISTORY_SWIPE = 'overscroll-x-none';

/** The listeners, for as long as the page is up. */
export const readerSwipeAtom: Atom.Atom<void> = Atom.readable((get) => {
  if (typeof document === 'undefined') return;
  let wheel = WHEEL_AT_REST;
  let touch: { readonly x: number; readonly y: number } | undefined;
  const step = (by: 1 | -1 | undefined) => {
    if (by !== undefined) get.set(stepViewAtom, by);
  };
  const onWheel = (e: WheelEvent) => {
    // Ctrl is how a pinch arrives.
    if (e.ctrlKey || panelOf(e.target) === undefined) return;
    const { next, by } = wheelSwipeStep(wheel, e.deltaX, e.deltaY, e.timeStamp);
    wheel = next;
    step(by);
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
  document.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true });
  get.addFinalizer(() => {
    document.documentElement.classList.remove(NO_HISTORY_SWIPE);
    document.removeEventListener('wheel', onWheel);
    document.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchCancel);
  });
});
