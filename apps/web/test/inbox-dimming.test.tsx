import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxPage } from '../src/components/inbox/page';
import {
  dimmedOpacity,
  SHOWN_OPACITY,
  SPRING_MAX_STEP_S,
  type Spring,
  springSettled,
  springStep,
} from '../src/inbox-reader';
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
import { TestRegistry } from './registry';

// How much of a question shows: by how much of it is in the reading area, on
// one spring, painted past React.

const VH = 1_000;
// A question too tall to be wholly in view, in an area most of the viewport.
const tall = (visible: number) =>
  dimmedOpacity({ visible, height: 2_000, area: 800, vh: VH });

describe('the opacity a question reaches', () => {
  it('is nothing under 15vh', () => {
    expect(tall(0)).toBe(0);
    expect(tall(149)).toBe(0);
    expect(tall(150)).toBe(0);
  });

  it('rises slowly to 25% between 15 and 30vh', () => {
    expect(tall(225)).toBeCloseTo(0.125);
    expect(tall(300)).toBeCloseTo(0.25);
  });

  it('rises on to 75% between 30 and 50vh', () => {
    expect(tall(400)).toBeCloseTo(0.5);
    expect(tall(500)).toBeCloseTo(SHOWN_OPACITY);
  });

  it('stays at 75% over 50vh', () => {
    expect(tall(501)).toBeCloseTo(SHOWN_OPACITY);
    expect(tall(799)).toBeCloseTo(SHOWN_OPACITY);
  });

  it('is 75% for a short question wholly in view, however short', () => {
    expect(
      dimmedOpacity({ visible: 100, height: 100, area: 800, vh: VH }),
    ).toBe(SHOWN_OPACITY);
  });

  it('holds a short question to the bands until the whole of it shows', () => {
    const short = (visible: number) =>
      dimmedOpacity({ visible, height: 200, area: 800, vh: VH });
    expect(short(100)).toBe(0);
    expect(short(175)).toBeCloseTo(0.0417, 3);
    expect(short(200)).toBe(SHOWN_OPACITY);
  });

  it('is 75% for a question filling the area, in a viewport too short for 50vh', () => {
    expect(
      dimmedOpacity({ visible: 300, height: 2_000, area: 300, vh: VH }),
    ).toBe(SHOWN_OPACITY);
  });
});

describe('the spring', () => {
  const run = (from: Spring, target: number, seconds: number, dt = 1 / 60) => {
    let s = from;
    const seen = [s.value];
    for (let t = 0; t < seconds; t += dt) {
      s = springStep(s, target, dt);
      seen.push(s.value);
    }
    return { s, seen };
  };

  it('does not move in no time', () => {
    const s = { value: 0.2, velocity: 0.5 };
    expect(springStep(s, 1, 0)).toEqual(s);
  });

  it('pulls towards its target, and takes a step the size the constants say', () => {
    const next = springStep({ value: 0, velocity: 0 }, 1, 0.01);
    expect(next.velocity).toBeCloseTo(0.6);
    expect(next.value).toBeCloseTo(0.006);
  });

  it('is damped by its speed', () => {
    const next = springStep({ value: 1, velocity: 1 }, 1, 0.01);
    expect(next.velocity).toBeCloseTo(0.86);
  });

  it('settles on its target in about 0.7s, barely past it', () => {
    const early = run({ value: 0, velocity: 0 }, 1, 0.3);
    expect(springSettled(early.s, 1)).toBe(false);
    const { s, seen } = run({ value: 0, velocity: 0 }, 1, 1.5);
    expect(springSettled(s, 1)).toBe(true);
    expect(Math.max(...seen)).toBeLessThan(1.01);
  });

  it('keeps its speed when the target moves', () => {
    const { s } = run({ value: 0, velocity: 0 }, 1, 0.2);
    expect(s.velocity).toBeGreaterThan(0);
    expect(springStep(s, 0.9, 1 / 60).velocity).toBeGreaterThan(0);
  });

  it('holds together at the longest step a frame may take', () => {
    const { s } = run({ value: 0, velocity: 0 }, 1, 3, SPRING_MAX_STEP_S);
    expect(springSettled(s, 1)).toBe(true);
  });
});

describe('on the page', () => {
  useInboxPage();

  const FIRST = `${A}/1`;
  const SECOND = `${A}/2`;
  const THIRD = `${A}/3`;

  const three = () =>
    board([
      {
        ...VIEW_A,
        awaitingOperator: [
          asked(1, 'First', 1),
          { ...asked(2, 'Second', 2), highlight: { seq: 1 } },
          asked(3, 'Third', 3),
        ],
      },
    ]);

  // jsdom lays nothing out, so this draws one: questions 1,000 tall, one under
  // the other, in a viewport the same height, with no bars.
  const layOut = () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.zenItem === undefined
          ? 0
          : [...(this.parentElement?.children ?? [])].indexOf(this) * 1_000;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.zenItem === undefined ? 0 : 1_000;
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => VH,
    });
  };

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  });

  const item = (key: string) =>
    document.querySelector<HTMLElement>(
      `[data-zen-item="${key}"]`,
    ) as HTMLElement;
  const opacity = (key: string) => Number(item(key).style.opacity);
  const flow = () => document.querySelector('[data-zen-flow]') as HTMLElement;
  const scrollTo = (top: number) => {
    flow().scrollTop = top;
    fireEvent.scroll(flow());
  };

  const opened = async () => {
    serve.board = three();
    layOut();
    await mounted();
    await waitFor(() => expect(opacity(FIRST)).toBe(1));
  };

  it('starts each question where it belongs, the focused one at 100%', async () => {
    await opened();
    expect(litKey()).toBe(FIRST);
    expect(opacity(SECOND)).toBe(0);
    expect(opacity(THIRD)).toBe(0);
  });

  it('follows what is in view, and takes the clicks back as it comes up', async () => {
    await opened();
    expect(item(SECOND).hasAttribute('data-zen-dark')).toBe(true);
    expect(item(FIRST).hasAttribute('data-zen-dark')).toBe(false);
    scrollTo(300);
    expect(litKey()).toBe(FIRST);
    expect(item(SECOND).hasAttribute('data-zen-dark')).toBe(false);
    await waitFor(() => expect(opacity(SECOND)).toBeCloseTo(0.25, 2));
    expect(opacity(THIRD)).toBe(0);
  });

  it('takes the clicks away at once, while it is still fading out', async () => {
    await opened();
    scrollTo(300);
    await waitFor(() => expect(opacity(SECOND)).toBeCloseTo(0.25, 2));
    scrollTo(0);
    expect(item(SECOND).hasAttribute('data-zen-dark')).toBe(true);
    expect(opacity(SECOND)).toBeGreaterThan(0);
    await waitFor(() => expect(opacity(SECOND)).toBe(0));
  });

  it('rests at 75% once the question is over half the viewport, scroll or no scroll', async () => {
    await opened();
    scrollTo(450);
    await waitFor(() => expect(opacity(SECOND)).toBeCloseTo(0.625, 2));
    // Nothing fades it back when the scrolling stops.
    await act(() => new Promise((done) => setTimeout(done, 700)));
    expect(opacity(SECOND)).toBeCloseTo(0.625, 2);
  });

  it('brings the question taking the focus to 100%, and lets the last one fall', async () => {
    await opened();
    fireEvent.wheel(flow());
    scrollTo(1_000);
    await waitFor(() => expect(litKey()).toBe(SECOND));
    await waitFor(() => expect(opacity(SECOND)).toBe(1));
    await waitFor(() => expect(opacity(FIRST)).toBe(0));
  });

  it('fades the dots with their question, with no fade of their own', async () => {
    await opened();
    const mark = item(SECOND).querySelector('[data-zen-mark="highlight"]');
    expect(mark).not.toBeNull();
    expect(
      mark?.closest('[style*="opacity"]')?.getAttribute('data-zen-item'),
    ).toBe(SECOND);
    expect(
      mark?.closest('[class*="opacity"]')?.closest('[data-zen-item]'),
    ).toBeNull();
  });

  // jsdom paints nothing, so this holds the shape the fade depends on: WebKit
  // drops a box's opacity from a repaint that does not touch the box, so the
  // code that hangs in the gutter must be inside the faded box, not only
  // inside its element.
  it('fades the code with its question, inside the box the fade is set on', async () => {
    await opened();
    const code = item(SECOND).querySelector('[data-question-code]');
    expect(
      code?.closest('[style*="opacity"]')?.getAttribute('data-zen-item'),
    ).toBe(SECOND);
    expect(item(SECOND).classList).toContain('-ml-code-gutter');
    expect(item(SECOND).classList).toContain('pl-code-gutter');
  });

  it('keeps the pointer on a question not lit, and none for the lit one', async () => {
    await opened();
    expect(item(SECOND).querySelector('article')?.className).toContain(
      'cursor-pointer',
    );
    expect(item(SECOND).querySelector('article')?.className).not.toContain(
      'hover:opacity',
    );
    expect(item(FIRST).querySelector('article')?.className).not.toContain(
      'cursor-pointer',
    );
  });

  it('renders nothing for a scroll or a frame of the spring', async () => {
    serve.board = three();
    layOut();
    history.replaceState(null, '', `/inbox/${A}`);
    const commits = vi.fn();
    render(
      <TestRegistry>
        <Profiler id="page" onRender={commits}>
          <InboxPage />
        </Profiler>
      </TestRegistry>,
    );
    await waitFor(() => expect(litKey()).toBeDefined());
    await waitFor(() => expect(opacity(FIRST)).toBe(1));
    await act(() => new Promise((done) => setTimeout(done, 1_200)));
    commits.mockClear();
    scrollTo(300);
    await waitFor(() => expect(opacity(SECOND)).toBeCloseTo(0.25, 2));
    expect(commits).not.toHaveBeenCalled();
  });
});
