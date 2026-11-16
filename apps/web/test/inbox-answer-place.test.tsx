import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A,
  asked,
  board,
  litKey,
  mounted,
  serve,
  useInboxPage,
  VIEW_A,
} from './inbox-page-harness';

// Where an answer leaves the page. jsdom lays nothing out, so this draws one:
// a viewport with bars of known height, and questions tall or short by title.

const VIEWPORT = 800;
const HEADER = 80;
const FOOT = 160;
const AREA = VIEWPORT - HEADER - FOOT;
const TALL = 700;
const SHORT = 200;

const heightOf = (el: HTMLElement): number =>
  el.textContent?.includes('Tall') ? TALL : SHORT;

const leadOf = (): number => {
  const list = document.querySelector('[data-zen-questions]');
  const spacer = list?.previousElementSibling as HTMLElement | null;
  return Number.parseFloat(spacer?.style.height ?? '') || 0;
};

const layOut = () => {
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.zenItem === undefined) return 0;
      const siblings = [...(this.parentElement?.children ?? [])];
      return siblings
        .slice(0, siblings.indexOf(this))
        .reduce((top, el) => top + heightOf(el as HTMLElement), leadOf());
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.zenItem !== undefined) return heightOf(this);
      if (this.dataset.zenHeader !== undefined) return HEADER;
      return this.className.includes('bottom-0') ? FOOT : 0;
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  });
};

const flow = () => document.querySelector('[data-zen-flow]') as HTMLElement;
const item = (key: string) =>
  document.querySelector(`[data-zen-item="${key}"]`) as HTMLElement;

// Where the question's top sits in the viewport, against where it should rest.
const restOf = (key: string) => item(key).offsetTop - flow().scrollTop;
const centred = (height: number) => HEADER + (AREA - height) / 2;

const answer = () => {
  const box = document.querySelector('[data-zen-box]') as HTMLElement;
  fireEvent.change(box, { target: { value: 'Go ahead' } });
  act(() => {
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  });
};

describe('after an answer', () => {
  useInboxPage();

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  });

  const opened = async (...titles: ReadonlyArray<string>) => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: titles.map((t, i) => asked(i + 1, t, i + 1)),
      },
    ]);
    layOut();
    await mounted();
    await waitFor(() => expect(leadOf()).toBeGreaterThan(0));
  };

  it('rests a short question where it belongs when a tall one above it goes', async () => {
    await opened('Tall one', 'Short two', 'Tall three');
    answer();
    await waitFor(() => expect(litKey()).toBe(`${A}/2`));
    await waitFor(() => expect(leadOf()).toBe(centred(SHORT)));
    expect(restOf(`${A}/2`)).toBe(centred(SHORT));
    expect(flow().scrollTop).toBe(0);
  });

  it('rests a tall question under the header when a short one above it goes', async () => {
    await opened('Short one', 'Tall two', 'Short three');
    answer();
    await waitFor(() => expect(litKey()).toBe(`${A}/2`));
    await waitFor(() => expect(leadOf()).toBe(HEADER + 24));
    expect(restOf(`${A}/2`)).toBe(HEADER + 24);
    expect(flow().scrollTop).toBe(0);
  });
});
