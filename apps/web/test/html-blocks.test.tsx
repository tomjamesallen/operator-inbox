import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  columnInset,
  frameRunAgain,
  frameStateAfter,
  HTML_BLOCK_HEIGHTS_KEPT,
  isFrameMessage,
  rememberedHeights,
  wheelPixels,
} from '../src/html-blocks';
import { json } from './fixture';
import {
  A,
  asked,
  board,
  lit,
  mounted,
  serve,
  useInboxPage,
  VIEW_A,
} from './inbox-page-harness';

// HTML blocks in a question's body: the documents read from their own
// endpoint, never with the board; each run in a frame the page writes,
// sandboxed to scripts alone, with the policy first; covered until it says it
// has loaded; sized by what it reports, and remembered; a failure said once,
// under it; and a message from anything but its own frame ignored.

const SHA = 'c'.repeat(64);
const CHART =
  '<title>Two runs</title><meta name="oi-block" content="height=320"><svg id="drawn"></svg>';

useInboxPage();

// What the documents endpoint answers, and the paths it was asked for.
const blocks = vi.hoisted(() => ({
  reads: [] as Array<string>,
  vendor: [] as Array<string>,
  answer: {} as Record<string, { sha: string; doc: string }>,
}));

beforeEach(() => {
  blocks.reads = [];
  blocks.vendor = [];
  blocks.answer = { chart: { sha: SHA, doc: CHART } };
  const board = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        'http://x',
      );
      if (url.pathname.endsWith('/html-blocks')) {
        blocks.reads.push(url.pathname);
        return json({ blocks: blocks.answer });
      }
      if (url.pathname.startsWith('/vendor/')) {
        blocks.vendor.push(url.pathname);
        return new Response(`/* ${url.pathname} */ globalThis.d3 = {};`, {
          headers: { 'content-type': 'text/javascript' },
        });
      }
      return board(input, init);
    },
  );
});

const withBlocks = () =>
  board([
    {
      ...VIEW_A,
      awaitingOperator: [
        {
          ...asked(1, 'First', 2),
          bodyParts: [
            { kind: 'html', html: '<p>Before.</p>' },
            { kind: 'html-block', id: 'chart', width: 'wide' },
            { kind: 'html-block', id: 'gone' },
            { kind: 'html', html: '<p>After.</p>' },
          ],
          htmls: { chart: { sha: SHA, bytes: CHART.length } },
        },
      ],
    },
  ]);

const block = (id: string) =>
  lit().querySelector<HTMLElement>(`[data-html-block="${id}"]`);
const frame = (id: string) =>
  block(id)?.querySelector<HTMLIFrameElement>('iframe[data-html-frame]') ??
  null;

const post = (from: Window | null, data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: from }));
  });

describe('an HTML block inline', () => {
  it('reads the documents for the question, and runs each in a sandboxed frame the page writes', async () => {
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    expect(blocks.reads).toEqual([`/api/inbox/${A}/questions/1/html-blocks`]);
    expect(el.getAttribute('sandbox')).toBe('allow-scripts');
    expect(el.getAttribute('title')).toBe('Two runs');
    const srcdoc = el.getAttribute('srcdoc') ?? '';
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeGreaterThan(0);
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(
      srcdoc.indexOf('<script'),
    );
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain('<svg id="drawn"></svg>');
    // Its declared height holds its room before it reports.
    expect(el.style.height).toBe('320px');
    expect(
      block('chart')
        ?.querySelector('[data-html-width]')
        ?.getAttribute('data-html-width'),
    ).toBe('wide');
    // A tag with no such block says so.
    expect(lit().querySelector('[data-html-missing]')?.textContent).toBe(
      'This Question has no HTML block named “gone”.',
    );
  });

  it('is covered until its frame says it is ready, then sized by what it reports, and remembered', async () => {
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    const veil = () => block('chart')?.querySelector('[data-html-veil]');
    // jsdom may fire the frame's own `load`; the bootstrap's `ready` is the
    // other way in, so it is sent either way.
    await post(el.contentWindow, { oi: 'ready' });
    expect(veil()).toBeNull();
    await post(el.contentWindow, { oi: 'size', height: 512 });
    expect(el.style.height).toBe('512px');
    // Past the cap, it scrolls inside.
    await post(el.contentWindow, { oi: 'size', height: 9000 });
    expect(el.style.height).toBe('2400px');
    await waitFor(() =>
      expect(
        JSON.parse(
          localStorage.getItem('operator-inbox:html-block-heights') ?? '{}',
        ),
      ).toEqual({ [`${A}/1/chart/${SHA}`]: 9000 }),
    );
  });

  it('ignores a message from anything but its own frame', async () => {
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    await post(window, { oi: 'size', height: 700 });
    await post(null, { oi: 'error', message: 'forged' });
    expect(el.style.height).toBe('320px');
    expect(block('chart')?.textContent).not.toContain('forged');
  });

  it('says a failure once, under the frame, and runs it again on asking', async () => {
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    await post(el.contentWindow, { oi: 'ready' });
    await post(el.contentWindow, { oi: 'error', message: 'Script error.' });
    await post(el.contentWindow, { oi: 'error', message: 'a second' });
    const bar = block('chart')?.querySelector('[data-html-failure]');
    expect(bar?.textContent).toContain(
      'A script in this block failed (the browser hides the message).',
    );
    expect(bar?.textContent).not.toContain('a second');
    fireEvent.click(
      within(bar as HTMLElement).getByRole('button', { name: 'RUN AGAIN' }),
    );
    await waitFor(() =>
      expect(block('chart')?.querySelector('[data-html-failure]')).toBeNull(),
    );
    expect(frame('chart')).not.toBe(el);
  });
});

describe('the wheel over a block', () => {
  const flow = () => document.querySelector('[data-zen-flow]') as HTMLElement;

  it('scrolls the reader by a wheel its own frame hands back, in pixels, and by no other', async () => {
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    flow().scrollTop = 100;
    await post(el.contentWindow, { oi: 'wheel', dx: 0, dy: 40, mode: 0 });
    expect(flow().scrollTop).toBe(140);
    // Lines: jsdom has no line height, so a line is 16px.
    await post(el.contentWindow, { oi: 'wheel', dx: 0, dy: -2, mode: 1 });
    expect(flow().scrollTop).toBe(108);
    await post(window, { oi: 'wheel', dx: 0, dy: 500, mode: 0 });
    await post(el.contentWindow, { oi: 'wheel', dx: 0, dy: 'x', mode: 0 });
    expect(flow().scrollTop).toBe(108);
  });

  it('marks the row while the reader has clicked into the block, and tells the frame when the mouse leaves', async () => {
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    const row = () =>
      block('chart')?.querySelector<HTMLElement>('[data-html-controls]');
    expect(row()?.hasAttribute('data-html-engaged')).toBe(false);
    await post(el.contentWindow, { oi: 'engaged', on: true });
    expect(row()?.hasAttribute('data-html-engaged')).toBe(true);
    expect(row()?.querySelector('span')?.className).toContain('text-fg ');
    const sent: Array<unknown> = [];
    vi.spyOn(el.contentWindow as Window, 'postMessage').mockImplementation(
      (m: unknown) => {
        sent.push(m);
      },
    );
    fireEvent.mouseLeave(el);
    expect(sent).toStrictEqual([{ oi: 'disengage' }]);
    await post(el.contentWindow, { oi: 'engaged', on: false });
    expect(row()?.hasAttribute('data-html-engaged')).toBe(false);
  });

  it('tells the frame where the text column sits in it, again as the layout moves', async () => {
    // jsdom lays nothing out: a stand-in ResizeObserver, fired by hand.
    const watchers: Array<(entries: ReadonlyArray<unknown>) => void> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(readonly f: (entries: ReadonlyArray<unknown>) => void) {
          watchers.push(f);
        }
        observe() {}
        disconnect() {}
      },
    );
    serve.board = withBlocks();
    await mounted();
    const el = await waitFor(() => {
      const f = frame('chart');
      expect(f).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    await post(el.contentWindow, { oi: 'ready' });
    const room = block('chart') as HTMLElement;
    vi.spyOn(room, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 300, y: 0, width: 640, height: 10 }),
    );
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 60, y: 0, width: 1100, height: 10 }),
    );
    const sent: Array<unknown> = [];
    vi.spyOn(el.contentWindow as Window, 'postMessage').mockImplementation(
      (m: unknown) => {
        sent.push(m);
      },
    );
    expect(watchers.length).toBeGreaterThan(0);
    for (const f of watchers) f([]);
    expect(sent).toContainEqual({ oi: 'column', left: 240, width: 640 });
    // The frame is told, not rebuilt.
    expect(frame('chart')).toBe(el);
  });

  it('keeps the control row in the text column for a wide block', async () => {
    serve.board = withBlocks();
    await mounted();
    await waitFor(() => expect(frame('chart')).not.toBeNull());
    const room = block('chart') as HTMLElement;
    // The row and the failure bar are the room's own children, never the
    // widened box's, so they start where the prose does.
    expect(room.querySelector(':scope > [data-html-controls]')).not.toBeNull();
    expect(
      room.querySelector('[data-html-width] [data-html-controls]'),
    ).toBeNull();
  });

  it('puts the column at 0 in a block no wider than it', () => {
    expect(columnInset({ left: 300, width: 640 }, { left: 300 })).toStrictEqual(
      { oi: 'column', left: 0, width: 640 },
    );
    expect(columnInset({ left: 300, width: 640 }, { left: 320 }).left).toBe(0);
  });

  it('turns lines and pages into pixels', () => {
    expect(wheelPixels({ dx: 1, dy: 2, mode: 0 }, 20, 600)).toStrictEqual({
      x: 1,
      y: 2,
    });
    expect(wheelPixels({ dx: 0, dy: 3, mode: 1 }, 20, 600).y).toBe(60);
    expect(wheelPixels({ dx: 0, dy: -1, mode: 2 }, 20, 600).y).toBe(-600);
    expect(
      wheelPixels({ dx: Number.NaN, dy: null, mode: 0 }, 20, 600),
    ).toStrictEqual({
      x: 0,
      y: 0,
    });
  });
});

describe('the libraries a block uses', () => {
  it('reads each from the page’s own origin once, and hands only those in, as text', async () => {
    const PLOT =
      '<div id="plot"></div><script type="module">import "d3"; window.d3;</script>';
    blocks.answer = {
      chart: { sha: SHA, doc: CHART },
      plot: { sha: 'd'.repeat(64), doc: PLOT },
      again: { sha: 'e'.repeat(64), doc: PLOT },
    };
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          {
            ...asked(1, 'First', 2),
            bodyParts: [
              { kind: 'html-block', id: 'chart' },
              { kind: 'html-block', id: 'plot' },
              { kind: 'html-block', id: 'again' },
            ],
            htmls: {
              chart: { sha: SHA, bytes: 1 },
              plot: { sha: 'd'.repeat(64), bytes: 1 },
              again: { sha: 'e'.repeat(64), bytes: 1 },
            },
          },
        ],
      },
    ]);
    await mounted();
    const plot = await waitFor(() => {
      const f = frame('plot');
      expect(f).not.toBeNull();
      expect(frame('again')).not.toBeNull();
      return f as HTMLIFrameElement;
    });
    expect(blocks.vendor).toEqual(['/vendor/d3.min.js']);
    const srcdoc = plot.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('/* /vendor/d3.min.js */ globalThis.d3 = {};');
    expect(srcdoc).toContain('createObjectURL');
    // The frame is told no host to load from.
    expect(srcdoc).not.toMatch(/https?:\/\//);
    // A block that imports nothing is handed nothing.
    expect(frame('chart')?.getAttribute('srcdoc')).not.toContain(
      'createObjectURL',
    );
  });
});

describe('a frame’s state', () => {
  const idle = { run: 0, loaded: false };

  it('loads on ready, takes a size of 2px or more, and keeps the first error', () => {
    const ready = frameStateAfter(idle, { oi: 'ready' });
    expect(ready.loaded).toBe(true);
    const sized = frameStateAfter(ready, { oi: 'size', height: 300 });
    expect(sized.height).toBe(300);
    expect(frameStateAfter(sized, { oi: 'size', height: 301 })).toBe(sized);
    expect(frameStateAfter(sized, { oi: 'size', height: -1 })).toBe(sized);
    const failed = frameStateAfter(sized, { oi: 'error', message: 'first' });
    expect(frameStateAfter(failed, { oi: 'error', message: 'second' })).toBe(
      failed,
    );
    expect(frameRunAgain(failed)).toStrictEqual({
      run: 1,
      loaded: false,
      height: 300,
    });
  });

  it('reads only the bootstrap’s messages', () => {
    expect(isFrameMessage({ oi: 'size', height: 3 })).toBe(true);
    for (const data of [null, 'size', { oi: 'theme' }, { height: 3 }])
      expect(isFrameMessage(data)).toBe(false);
  });

  it('remembers the most recent heights, the oldest let go', () => {
    let heights: Record<string, number> = {};
    for (let i = 0; i < HTML_BLOCK_HEIGHTS_KEPT + 5; i++)
      heights = rememberedHeights(heights, `k${i}`, i);
    expect(Object.keys(heights)).toHaveLength(HTML_BLOCK_HEIGHTS_KEPT);
    expect(heights.k0).toBeUndefined();
    expect(rememberedHeights(heights, 'k10', 999).k10).toBe(999);
  });
});
