// A scrolling list that fades at an edge only while there is more to scroll
// to that way. The escape hatch, all DOM: a ref callback marks the element
// `data-fade-top` / `data-fade-bottom` from its scroll position, and the
// element's classes draw the fade from those marks (`edgeFade`).

/** The classes that draw the fade: a mask at each marked edge. */
export const edgeFade =
  'data-fade-top:mask-t-from-(--fade-from) data-fade-bottom:mask-b-from-(--fade-from)';

const mark = (el: HTMLElement): void => {
  const top = el.scrollTop > 0;
  const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  if ((el.dataset.fadeTop !== undefined) !== top)
    el.toggleAttribute('data-fade-top', top);
  if ((el.dataset.fadeBottom !== undefined) !== bottom)
    el.toggleAttribute('data-fade-bottom', bottom);
};

/**
 * The ref for a list that fades: marks it on scroll, on a change of its own
 * size and on a change of any child's (a card added, a field wrapping).
 * Stable, so React attaches it once.
 */
export const fadeEdges = (el: HTMLElement | null): (() => void) | undefined => {
  if (el === null) return undefined;
  const again = () => mark(el);
  const sizes = new ResizeObserver(again);
  const watch = () => {
    sizes.disconnect();
    sizes.observe(el);
    for (const child of el.children) sizes.observe(child);
  };
  const children = new MutationObserver(() => {
    watch();
    again();
  });
  watch();
  children.observe(el, { childList: true });
  el.addEventListener('scroll', again, { passive: true });
  again();
  return () => {
    sizes.disconnect();
    children.disconnect();
    el.removeEventListener('scroll', again);
  };
};
