import { Atom } from 'effect/reactivity';

// The list scrolls to follow the text being read, inside a catch zone:
// nothing moves while the cursor is comfortably on screen; once it comes
// within `margin` of the bottom of the reading area (over the answer box),
// the list turns the page: one smooth jump that brings the line being read up
// to `margin` under the top (under the header), so the eye reads on down a
// fresh screen rather than chasing text that creeps up line by line. Text
// above the zone is brought down to the same place. A wheel or a touch on the
// list hands the scroll to the operator until the text being read is back in
// the reading area, by their scrolling or by the reading reaching it.

/** The operator has the scroll: following waits for the text to be in view. */
export const followHandsOffAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Listens for the operator's own scrolling of the list. Mounted by `ReadoutController`. */
export const followWatchAtom = Atom.readable((get) => {
  if (typeof document === 'undefined') return;
  const mine = (e: Event) => {
    if (e.target instanceof Element && e.target.closest('[data-zen-flow]'))
      get.set(followHandsOffAtom, true);
  };
  const options = { passive: true, capture: true } as const;
  document.addEventListener('wheel', mine, options);
  document.addEventListener('touchstart', mine, options);
  get.addFinalizer(() => {
    document.removeEventListener('wheel', mine, options);
    document.removeEventListener('touchstart', mine, options);
  });
});

export interface Zone {
  readonly top: number;
  readonly bottom: number;
  readonly margin: number;
}

// The fade over the question's foot, above the answer box.
const FOOT_FADE = 24;

/** The reading area in client pixels, and the catch margin inside it. */
export const zoneOf = (doc: Document): Zone | undefined => {
  const flow = doc.querySelector('[data-zen-flow]');
  const view = doc.defaultView;
  if (flow === null || view === null) return undefined;
  const box = flow.getBoundingClientRect();
  const top = Math.max(
    box.top,
    doc.querySelector('[data-zen-header]')?.getBoundingClientRect().bottom ??
      box.top,
    // A stuck breadcrumb sits under the header, over the text.
    ...[...doc.querySelectorAll('[data-crumb-sticky][data-stuck]')].map(
      (c) => c.getBoundingClientRect().bottom,
    ),
  );
  const answer = doc
    .querySelector('[data-zen-answer]')
    ?.getBoundingClientRect().top;
  const bottom = Math.min(box.bottom, (answer ?? box.bottom) - FOOT_FADE);
  // 150px on a desktop; less on a short or narrow screen, and never more
  // than a third of the room.
  const wanted = view.innerWidth >= 768 && view.innerHeight >= 700 ? 150 : 72;
  return { top, bottom, margin: Math.min(wanted, (bottom - top) / 3) };
};

/**
 * How far to scroll for the span `top`–`bottom` (client pixels): 0 while it
 * is comfortably inside the catch zone; once it reaches the zone's low edge,
 * or is above its high edge, far enough to put its top at the high edge (a
 * page turn). Pure.
 */
export const followBy = (zone: Zone, top: number, bottom: number): number => {
  const low = zone.bottom - zone.margin;
  const high = zone.top + zone.margin;
  const by = bottom > low || top < high ? top - high : 0;
  return Math.abs(by) < 1 ? 0 : by;
};

/** Whether the span is in the reading area at all. */
export const inZone = (zone: Zone, top: number, bottom: number): boolean =>
  top >= zone.top && bottom <= zone.bottom;

/**
 * Follow the span `top`–`bottom`: scroll the list by `followBy`, unless the
 * operator has the scroll, which they keep until the span is in view again.
 */
export const follow = (
  doc: Document,
  handsOff: { readonly get: () => boolean; readonly set: (b: boolean) => void },
  top: number,
  bottom: number,
): void => {
  const flow = doc.querySelector('[data-zen-flow]');
  const zone = zoneOf(doc);
  if (flow === null || zone === undefined) return;
  if (handsOff.get()) {
    if (inZone(zone, top, bottom)) handsOff.set(false);
    return;
  }
  const by = followBy(zone, top, bottom);
  if (by !== 0) flow.scrollBy({ top: by, behavior: 'smooth' });
};
