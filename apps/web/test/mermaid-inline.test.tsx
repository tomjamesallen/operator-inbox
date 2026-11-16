import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  MERMAID_SIZES_KEPT,
  mermaidHash,
  rememberedSizes,
  svgSizeOf,
} from '../src/mermaid';
import {
  A,
  asked,
  board,
  lit,
  litKey,
  mounted,
  serve,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// A ```mermaid fence drawn inline, in the frame every picture shares, with a
// full-screen view; drawn as the board arrives, and its frame sized before
// the drawing is, from the size this browser remembers.

// Mermaid stands in: each drawing is 300 by 100, and `hold` keeps a drawing
// from finishing until it is released.
const mermaid = vi.hoisted(() => ({
  drawn: [] as Array<string>,
  hold: undefined as Promise<void> | undefined,
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: async (_id: string, source: string) => {
      mermaid.drawn.push(source);
      if (mermaid.hold !== undefined) await mermaid.hold;
      if (source.includes('broken')) throw new Error('Parse error on line 1');
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><text>${source}</text></svg>`,
      };
    },
  },
}));

useInboxPage();

const SIZES_KEY = 'operator-inbox:mermaid-sizes';

// The page keeps each drawing for as long as it is loaded, so each test
// draws its own source.
const withDiagram = (source: string, other = 'graph LR; Z-->Y') =>
  board([
    {
      ...VIEW_A,
      awaitingOperator: [
        {
          ...asked(1, 'First', 2),
          bodyParts: [
            { kind: 'html', html: '<p>Before.</p>' },
            { kind: 'mermaid', source },
            { kind: 'html', html: '<p>After.</p>' },
          ],
        },
        asked(3, 'Third', 9),
      ],
    },
    {
      ...VIEW_B,
      // Not on screen: another Inbox's question.
      awaitingOperator: [
        {
          ...asked(1, 'Quarry one', 7),
          bodyParts: [{ kind: 'mermaid', source: other }],
        },
      ],
    },
  ]);

const decoded = (img: Element | null) =>
  atob((img?.getAttribute('src') ?? '').split(',')[1] ?? '');

const frame = () =>
  lit().querySelector<HTMLElement>('[data-mermaid] [data-picture-frame]');

// The frame's shape, as width over height; the DOM may write `3` as `3 / 1`.
const shape = () => frame()?.style.aspectRatio.replace(/\s*\/\s*1$/, '');

describe('a diagram inline', () => {
  it('draws it in place, with no fold, in a frame of its own shape', async () => {
    serve.board = withDiagram('graph TD; A-->B');
    await mounted();
    const body = lit();
    expect(within(body).getByText('After.')).toBeTruthy();
    expect(within(body).queryByRole('button', { name: /^Diagram/ })).toBeNull();
    await waitFor(() =>
      expect(frame()?.querySelector('[data-mermaid-image]')).not.toBeNull(),
    );
    const image = frame()?.querySelector('[data-mermaid-image]') ?? null;
    expect(decoded(image)).toContain('graph TD; A-->B');
    expect(image?.className).toContain('size-full');
    expect(image?.className).toContain('object-contain');
    expect(shape()).toBe('3');
  });

  it('draws each diagram on the board as it arrives, shown or not, and remembers its size', async () => {
    serve.board = withDiagram('graph TD; C-->D', 'graph LR; Elsewhere');
    await mounted();
    await waitFor(() => expect(mermaid.drawn).toContain('graph LR; Elsewhere'));
    // Inbox B's question is not on the page.
    expect(litKey()).toBe(`${A}/1`);
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}')[
          mermaidHash('graph LR; Elsewhere')
        ],
      ).toEqual([300, 100]),
    );
  });

  it('reserves the frame from the remembered size before the drawing comes', async () => {
    const source = 'graph TD; Remembered';
    localStorage.setItem(
      SIZES_KEY,
      JSON.stringify({ [mermaidHash(source)]: [400, 200] }),
    );
    let release = () => {};
    mermaid.hold = new Promise((done) => {
      release = done;
    });
    try {
      serve.board = withDiagram(source);
      await mounted();
      await waitFor(() => expect(frame()).not.toBeNull());
      expect(shape()).toBe('2');
      expect(frame()?.querySelector('[data-mermaid-drawing]')).not.toBeNull();
      expect(frame()?.querySelector('[data-mermaid-image]')).toBeNull();
    } finally {
      release();
      mermaid.hold = undefined;
    }
    await waitFor(() =>
      expect(frame()?.querySelector('[data-mermaid-image]')).not.toBeNull(),
    );
    expect(shape()).toBe('3');
  });

  it('stands a line in while nothing is known of it', async () => {
    let release = () => {};
    mermaid.hold = new Promise((done) => {
      release = done;
    });
    try {
      serve.board = withDiagram('graph TD; Unknown');
      await mounted();
      await waitFor(() =>
        expect(lit().querySelector('[data-mermaid-drawing]')).not.toBeNull(),
      );
      expect(frame()).toBeNull();
    } finally {
      release();
      mermaid.hold = undefined;
    }
    await waitFor(() => expect(frame()).not.toBeNull());
  });

  it('says why a diagram cannot be drawn, and shows its source', async () => {
    serve.board = withDiagram('broken one');
    await mounted();
    const alert = await within(lit()).findByRole('alert');
    expect(alert.textContent).toContain('Parse error on line 1');
    expect(alert.textContent).toContain('broken one');
    expect(frame()).toBeNull();
  });
});

describe('the full-screen view', () => {
  it('opens from ⤢, a button the keyboard reaches, and closes on Escape', async () => {
    serve.board = withDiagram('graph TD; Full');
    await mounted();
    const open = within(lit()).getByRole('button', {
      name: 'Show the diagram full screen',
    });
    expect(open.tagName).toBe('BUTTON');
    expect(open.tabIndex).toBe(0);
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    const dialog = await screen.findByTestId('mermaid-full-screen');
    await waitFor(() =>
      expect(dialog.querySelector('[data-mermaid-image]')).not.toBeNull(),
    );
    expect(
      dialog
        .querySelector('[data-mermaid-image]')
        ?.classList.contains('object-contain'),
    ).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
      code: 'Escape',
    });
    await waitFor(() =>
      expect(screen.queryByTestId('mermaid-full-screen')).toBeNull(),
    );
  });
});

describe('the sizes', () => {
  it('reads an SVG’s own width and height, else its viewBox', () => {
    expect(
      svgSizeOf('<svg width="120" height="40px" viewBox="0 0 1 1"></svg>'),
    ).toEqual({ width: 120, height: 40 });
    expect(
      svgSizeOf(
        '<svg width="100%" stroke-width="2" viewBox="-8 -8 316.5 108"></svg>',
      ),
    ).toEqual({ width: 316.5, height: 108 });
    expect(svgSizeOf('<svg></svg>')).toBeUndefined();
    expect(svgSizeOf('no svg')).toBeUndefined();
  });

  it('keeps the newest sizes, a bounded number of them', () => {
    let sizes = {};
    for (let i = 0; i < MERMAID_SIZES_KEPT + 5; i += 1)
      sizes = rememberedSizes(sizes, `h${i}`, { width: i + 1, height: 1 });
    const keys = Object.keys(sizes);
    expect(keys).toHaveLength(MERMAID_SIZES_KEPT);
    expect(keys[0]).toBe('h5');
    // Drawn again, a size moves to the newest end.
    const again = rememberedSizes(sizes, 'h5', { width: 9, height: 3 });
    expect(Object.keys(again).at(-1)).toBe('h5');
  });

  it('names a source by a stable hash', () => {
    expect(mermaidHash('graph TD; A-->B')).toBe(mermaidHash('graph TD; A-->B'));
    expect(mermaidHash('graph TD; A-->B')).not.toBe(
      mermaidHash('graph TD; A-->C'),
    );
  });
});
