import { describe, expect, it } from 'vitest';
import { fadeEdges } from '../src/components/inbox/edge-fade';

// A scrolling list fades at an edge only while there is more to scroll to
// that way: `fadeEdges` marks it, and its classes draw the masks.

const list = (sizes: { scrollHeight: number; clientHeight: number }) => {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: sizes.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { value: sizes.clientHeight });
  document.body.appendChild(el);
  return el;
};

const marks = (el: HTMLElement) => ({
  top: el.hasAttribute('data-fade-top'),
  bottom: el.hasAttribute('data-fade-bottom'),
});

describe('fadeEdges', () => {
  it('marks no edge on a list that fits', () => {
    const el = list({ scrollHeight: 100, clientHeight: 100 });
    fadeEdges(el)?.();
    expect(marks(el)).toEqual({ top: false, bottom: false });
  });

  it('marks the bottom at the top, both midway, and the top at the end', () => {
    const el = list({ scrollHeight: 300, clientHeight: 100 });
    const stop = fadeEdges(el);
    expect(marks(el)).toEqual({ top: false, bottom: true });
    el.scrollTop = 100;
    el.dispatchEvent(new Event('scroll'));
    expect(marks(el)).toEqual({ top: true, bottom: true });
    el.scrollTop = 200;
    el.dispatchEvent(new Event('scroll'));
    expect(marks(el)).toEqual({ top: true, bottom: false });
    stop?.();
    // Unhooked, a scroll marks nothing more.
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    expect(marks(el)).toEqual({ top: true, bottom: false });
  });
});
