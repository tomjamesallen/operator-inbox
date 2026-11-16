import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A,
  asked,
  board,
  litKey,
  mounted,
  serve,
  settle,
  useInboxPage,
  VIEW_A,
} from './inbox-page-harness';

// The question being read stays where it is when a question above it changes
// size with nothing rendered (a picture drawn late), and a slide still under
// way when its target moves is aimed again, so it lands centred.

useInboxPage();

const VH = 1_000;
const GAP = 100;
const FIRST = `${A}/1`;
const SECOND = `${A}/3`;
const THIRD = `${A}/7`;
const FOURTH = `${A}/8`;
const KEYS = [FIRST, SECOND, THIRD, FOURTH];

const four = () =>
  board([
    {
      ...VIEW_A,
      awaitingOperator: [
        asked(1, 'First', 2),
        asked(3, 'Third', 9),
        asked(7, 'Seventh', 10),
        asked(8, 'Eighth', 11),
      ],
    },
  ]);

// Nothing is laid out here, so this draws the list: each question as tall as
// `heights` says, one under the other with a gap, in a viewport `VH` tall,
// with no bars. A question's height changes with no render, as a picture's
// arriving does.
const heights = new Map<string, number>();
const topOf = (key: string) => {
  let top = 0;
  for (const k of KEYS) {
    if (k === key) return top;
    top += (heights.get(k) ?? 0) + GAP;
  }
  return 0;
};

// Each ResizeObserver the page makes, and what it watches, so a test fires
// the ones a change would.
const observers: Array<{
  readonly callback: ResizeObserverCallback;
  readonly watched: Set<Element>;
  readonly self: ResizeObserver;
}> = [];

class StubObserver {
  readonly watched = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    observers.push({
      callback,
      watched: this.watched,
      self: this as unknown as ResizeObserver,
    });
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
}

/** Fires every observer watching `key`'s question, as its resize would. */
const resized = (key: string) => {
  const el = item(key);
  for (const o of observers) if (o.watched.has(el)) o.callback([], o.self);
};

const item = (key: string) =>
  document.querySelector(`[data-zen-item="${key}"]`) as HTMLElement;
const flow = () => document.querySelector('[data-zen-flow]') as HTMLElement;
const scrollCalls = () =>
  (
    Element.prototype.scrollTo as unknown as {
      mock: { calls: ReadonlyArray<ReadonlyArray<ScrollToOptions>> };
    }
  ).mock.calls.map(([options]) => options);

beforeEach(() => {
  observers.length = 0;
  for (const k of KEYS) heights.set(k, 300);
  vi.stubGlobal('ResizeObserver', StubObserver);
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
    function (this: HTMLElement) {
      const key = this.dataset.zenItem;
      return key === undefined ? 0 : topOf(key);
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      const key = this.dataset.zenItem;
      return key === undefined ? 0 : (heights.get(key) ?? 0);
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VH,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 10 * VH,
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
});

// Where a question 300 tall rests: centred in the 1,000 of room.
const restingTop = (key: string) =>
  topOf(key) - (VH - (heights.get(key) ?? 0)) / 2;

// The browser's slide, done: the list where it was aimed, and its events.
const landed = async (top: number) => {
  flow().scrollTop = top;
  fireEvent.scroll(flow());
  fireEvent(flow(), new Event('scrollend'));
  await settle();
};

// A link brings the third question up, and the slide lands.
const onThird = async () => {
  serve.board = four();
  await mounted(`/inbox/${A}#q=7`);
  await waitFor(() => expect(litKey()).toBe(THIRD));
  expect(scrollCalls().at(-1)).toEqual({
    top: restingTop(THIRD),
    behavior: 'smooth',
  });
  await landed(restingTop(THIRD));
  expect(litKey()).toBe(THIRD);
};

describe('the question being read', () => {
  it('stays put when a question above it grows, with nothing rendered', async () => {
    await onThird();
    const was = flow().scrollTop;
    heights.set(SECOND, 450);
    // The observer alone: no render runs between the growth and the check.
    resized(SECOND);
    expect(flow().scrollTop).toBe(was + 150);
    // A render after it does not correct again.
    await settle();
    expect(flow().scrollTop).toBe(was + 150);
  });

  it('counts a shrink above once, though the browser clamps the scroll first', async () => {
    await onThird();
    const was = flow().scrollTop;
    // A question above shrinks by 150, and the end of the list comes up past
    // the scroll, so the browser has already pulled the scroll back by it.
    heights.set(SECOND, 150);
    flow().scrollTop = was - 150;
    resized(SECOND);
    expect(flow().scrollTop).toBe(was - 150);
    await settle();
    expect(flow().scrollTop).toBe(was - 150);
  });

  it('is held by a scroll that comes before the observer, and keeps the focus', async () => {
    await onThird();
    const was = flow().scrollTop;
    // A picture above grows between frames, and a scroll event from the frame
    // before reaches the list before the observer has run.
    heights.set(SECOND, 900);
    fireEvent.scroll(flow());
    await settle();
    expect(flow().scrollTop).toBe(was + 600);
    expect(litKey()).toBe(THIRD);
  });

  it('leaves the reader’s own scroll alone, and a change below it', async () => {
    await onThird();
    fireEvent.wheel(flow());
    flow().scrollTop = restingTop(THIRD) + 50;
    fireEvent.scroll(flow());
    await settle();
    expect(litKey()).toBe(THIRD);
    heights.set(FOURTH, 900);
    resized(FOURTH);
    expect(flow().scrollTop).toBe(restingTop(THIRD) + 50);
    resized(THIRD);
    expect(flow().scrollTop).toBe(restingTop(THIRD) + 50);
  });
});

describe('a slide under way', () => {
  it('is aimed again when its target moves, and lands centred', async () => {
    serve.board = four();
    await mounted();
    await waitFor(() => expect(litKey()).toBe(FIRST));
    await settle();
    expect(flow().scrollTop).toBe(0);
    fireEvent.click(item(THIRD).querySelector('article') as HTMLElement);
    await waitFor(() => expect(litKey()).toBe(THIRD));
    expect(scrollCalls().at(-1)).toEqual({ top: 450, behavior: 'smooth' });
    // The second question's picture arrives while the list slides: the third
    // now rests 150 further down.
    heights.set(SECOND, 450);
    resized(SECOND);
    expect(scrollCalls().at(-1)).toEqual({ top: 600, behavior: 'smooth' });
    expect(restingTop(THIRD)).toBe(600);
    // Re-aimed, not stopped dead by a jump of `scrollTop`.
    expect(flow().scrollTop).toBe(0);
  });

  it('is not aimed again once it has landed', async () => {
    serve.board = four();
    await mounted();
    await settle();
    fireEvent.click(item(THIRD).querySelector('article') as HTMLElement);
    await waitFor(() => expect(litKey()).toBe(THIRD));
    await landed(restingTop(THIRD));
    const calls = scrollCalls().length;
    const was = flow().scrollTop;
    heights.set(SECOND, 450);
    resized(SECOND);
    // Held as a reader's place is, by the growth, with no new slide.
    expect(scrollCalls()).toHaveLength(calls);
    expect(flow().scrollTop).toBe(was + 150);
  });
});
