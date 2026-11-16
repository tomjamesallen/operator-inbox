import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DrawingDraft,
  drawingConflicts,
  drawingDraftsStillWaiting,
  drawingsToSend,
} from '../src/drawings';
import { inDrawingEditor } from '../src/keymap';
import { json } from './fixture';
import {
  A,
  answered,
  asked,
  board,
  footNote,
  lit,
  mounted,
  onQueue,
  press,
  reread,
  send,
  serve,
  settle,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Excalidraw drawings in a question's body: the picture inline, in a frame
// reserved from the scene before Excalidraw loads; the full-screen editor;
// the operator's edits as drafts in localStorage, sent with the answer; the
// conflict when the agent changes a drawing the operator has edited.

// Excalidraw stands in. Its module waits on `gate` the first time it is
// loaded, and each export on `hold`. A scene's picture names the ids of the
// elements it drew, so a test can tell which scene it is. The editor is a
// div that hands over an API whose state a test sets, and keeps Escape to
// itself as Excalidraw's own key handling does.
const excal = vi.hoisted(() => {
  let open = () => {};
  const gate = new Promise<void>((done) => {
    open = done;
  });
  return {
    gate,
    open: () => open(),
    loaded: false,
    hold: undefined as Promise<void> | undefined,
    props: undefined as
      | {
          readonly onChange: (elements: ReadonlyArray<object>) => void;
        }
      | undefined,
    scene: undefined as ReadonlyArray<object> | undefined,
    state: {} as Record<string, unknown>,
  };
});

const IDLE = {
  newElement: null,
  multiElement: null,
  editingTextElement: null,
  editingLinearElement: null,
  selectedElementIds: {},
  openMenu: null,
  openPopup: null,
  openDialog: null,
  contextMenu: null,
  activeTool: { type: 'selection' },
};

vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
vi.mock('@excalidraw/excalidraw', async () => {
  await excal.gate;
  excal.loaded = true;
  const React = await import('react');
  type El = { readonly id: string; readonly isDeleted?: boolean };
  const Excalidraw = (props: {
    readonly excalidrawAPI: (api: object) => void;
    readonly onChange: (elements: ReadonlyArray<object>) => void;
  }) => {
    excal.props = props;
    React.useEffect(() => {
      props.excalidrawAPI({
        getAppState: () => excal.state,
        updateScene: ({ elements }: { elements: ReadonlyArray<object> }) => {
          excal.scene = elements;
        },
        scrollToContent: () => undefined,
        getSceneElements: () => excal.scene ?? [],
      });
    }, [props.excalidrawAPI]);
    return React.createElement(
      'div',
      {
        tabIndex: 0,
        'data-excalidraw-stub': true,
        onKeyDown: (e: { key: string; stopPropagation: () => void }) => {
          if (e.key === 'Escape') e.stopPropagation();
        },
      },
      'canvas',
    );
  };
  return {
    Excalidraw,
    convertToExcalidrawElements: (els: ReadonlyArray<object>) =>
      els.map((e) => ({ version: 1, ...e })),
    restore: ({ elements }: { elements: ReadonlyArray<object> }) => ({
      elements,
      appState: {},
      files: {},
    }),
    restoreElements: (els: ReadonlyArray<object>) => els,
    exportToCanvas: async () => ({}),
    exportToSvg: async ({ elements }: { elements: ReadonlyArray<El> }) => {
      if (excal.hold !== undefined) await excal.hold;
      return {
        outerHTML: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 324 124"><text>${elements.map((e) => e.id).join(',')}</text></svg>`,
      };
    },
  };
});

useInboxPage();

// Only the first test holds the module back; any other, run alone, lets it load.
const HELD =
  'reserves its frame at the scene’s own shape before Excalidraw has loaded';
beforeEach((ctx) => {
  if (ctx.task.name !== HELD) excal.open();
});

const DRAFTS_KEY = 'operator-inbox:drawing-drafts';

const scene = (...ids: ReadonlyArray<string>) =>
  JSON.stringify({
    elements: ids.map((id, i) => ({
      type: 'rectangle',
      id,
      x: i * 400,
      y: 0,
      width: 300,
      height: 100,
    })),
  });

// The agent's drawings: one box (300 by 100, so 324 by 124 with the
// export's padding), and two boxes side by side.
const LAYOUT = scene('box');
const FLOW = scene('left', 'right');

const parts = (...ids: ReadonlyArray<string>) => [
  { kind: 'html', html: '<p>Before.</p>' },
  ...ids.map((id) => ({ kind: 'excalidraw', id })),
  { kind: 'html', html: '<p>After.</p>' },
];

// #1 waits on the operator with `layout` and `flow`; `revision` is both the
// question's and `layout`'s.
const waiting = (revision = 1) =>
  board([
    {
      ...VIEW_A,
      awaitingOperator: [
        {
          ...asked(1, 'First', 2, revision),
          bodyParts: parts('layout', 'flow'),
          drawings: {
            layout: { scene: LAYOUT, revision },
            flow: { scene: FLOW, revision: 1 },
          },
        },
        asked(3, 'Third', 9),
      ],
    },
    VIEW_B,
  ]);

// A draft as the page stores it (plain JSON: the brands are the decoder's).
const draft = (
  over: { readonly [K in keyof DrawingDraft]?: string | number } = {},
): DrawingDraft =>
  ({
    inboxId: A,
    number: 1,
    id: 'layout',
    scene: scene('moved'),
    revision: 1,
    ...over,
  }) as DrawingDraft;

const seed = (...drafts: ReadonlyArray<object>) =>
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));

const stored = (): ReadonlyArray<DrawingDraft> =>
  JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '[]');

const figure = (id: string) =>
  lit().querySelector<HTMLElement>(`[data-drawing="${id}"]`);

const frameOf = (id: string) =>
  figure(id)?.querySelector<HTMLElement>('[data-picture-frame]');

// The frame's shape, as width over height; the DOM may write `3` as `3 / 1`.
const shapeOf = (id: string) =>
  frameOf(id)?.style.aspectRatio.replace(/\s*\/\s*1$/, '');

const shownIds = (id: string): string => {
  const src =
    figure(id)?.querySelector('[data-drawing-image]')?.getAttribute('src') ??
    '';
  return /<text>([^<]*)<\/text>/.exec(atob(src.split(',')[1] ?? ''))?.[1] ?? '';
};

const editButton = (id: string) =>
  within(figure(id) as HTMLElement).getByRole('button', {
    name: 'Edit the drawing full screen',
  });

// Opens the editor on `id` and waits for the stand-in to have its scene.
const openEditor = async (id: string): Promise<HTMLElement> => {
  excal.scene = undefined;
  fireEvent.click(editButton(id));
  const editor = await screen.findByTestId('drawing-editor');
  await waitFor(() => expect(excal.scene).toBeDefined());
  return editor;
};

describe('a drawing inline', () => {
  // First in the file: Excalidraw's module is loaded once, and here it is
  // held until the frame has been checked.
  it(HELD, async () => {
    serve.board = waiting();
    await mounted();
    await waitFor(() => expect(frameOf('layout')).not.toBeNull());
    expect(excal.loaded).toBe(false);
    // 324 by 124: the box and the export's padding.
    expect(shapeOf('layout')).toBe(String(324 / 124));
    expect(shapeOf('flow')).toBe(String(724 / 124));
    expect(frameOf('layout')?.querySelector('[data-drawing-image]')).toBeNull();
    expect(
      within(figure('layout') as HTMLElement).getByText(/Drawing · layout/),
    ).toBeTruthy();
    excal.open();
    await waitFor(() => expect(shownIds('layout')).toBe('box'));
    const image = frameOf('layout')?.querySelector('[data-drawing-image]');
    expect(image?.className).toContain('size-full');
    expect(image?.className).toContain('object-contain');
    expect(shownIds('flow')).toBe('left,right');
  });

  it('says so when the body names a drawing the question does not carry', async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          { ...asked(1, 'First', 2), bodyParts: parts('nowhere') },
        ],
      },
    ]);
    await mounted();
    const missing = await waitFor(() => {
      const el = lit().querySelector('[data-drawing-missing]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(missing.textContent).toBe(
      'This Question has no drawing named “nowhere”.',
    );
  });
});

describe('an answered question’s drawings', () => {
  it('shows what was sent, marked so, and the agent’s where nothing was, read-only', async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingAgent: [
          {
            ...answered(2, 'Second', 12, 'Like this.'),
            bodyParts: parts('layout', 'flow'),
            drawings: {
              layout: { scene: LAYOUT, revision: 1 },
              flow: { scene: FLOW, revision: 1 },
            },
            sentDrawings: { layout: scene('mine') },
          },
        ],
      },
    ]);
    await mounted();
    await onQueue(/With the agent/);
    await waitFor(() => expect(shownIds('layout')).toBe('mine'));
    await waitFor(() => expect(shownIds('flow')).toBe('left,right'));
    const layout = figure('layout') as HTMLElement;
    const flow = figure('flow') as HTMLElement;
    const mark = layout.querySelector('[data-drawing-sent]');
    expect(mark?.textContent).toBe('Sent with your answer');
    expect(mark?.className).toContain('text-fg/45');
    expect(flow.querySelector('[data-drawing-sent]')).toBeNull();
    for (const f of [layout, flow]) {
      expect(
        within(f).queryByRole('button', {
          name: 'Edit the drawing full screen',
        }),
      ).toBeNull();
      expect(within(f).queryByText('REVERT')).toBeNull();
      expect(
        within(f).getByRole('button', { name: 'Show the drawing full screen' }),
      ).toBeTruthy();
    }
  });
});

describe('the operator’s edit', () => {
  it('is kept in localStorage as a draft, marked Changed, and REVERT drops it', async () => {
    serve.board = waiting();
    await mounted();
    expect(
      figure('layout')?.querySelector('[data-drawing-changed]'),
    ).toBeNull();
    const editor = await openEditor('layout');
    excal.state = IDLE;
    act(() => {
      excal.props?.onChange([
        { type: 'rectangle', id: 'box', version: 2, isDeleted: false },
      ]);
    });
    // CLOSE keeps the last change at once.
    fireEvent.click(within(editor).getByRole('button', { name: 'CLOSE' }));
    await waitFor(() =>
      expect(screen.queryByTestId('drawing-editor')).toBeNull(),
    );
    await waitFor(() => expect(stored()).toHaveLength(1));
    const [kept] = stored();
    expect(kept).toMatchObject({
      inboxId: A,
      number: 1,
      id: 'layout',
      revision: 1,
    });
    expect(JSON.parse(kept?.scene ?? '{}').elements[0]).toMatchObject({
      id: 'box',
      version: 2,
    });
    const changed = figure('layout')?.querySelector('[data-drawing-changed]');
    expect(changed?.textContent).toBe('Changed · goes with your answer');
    fireEvent.click(
      within(figure('layout') as HTMLElement).getByRole('button', {
        name: 'REVERT',
      }),
    );
    await waitFor(() =>
      expect(
        figure('layout')?.querySelector('[data-drawing-changed]'),
      ).toBeNull(),
    );
    expect(stored()).toEqual([]);
  });

  it('opens the editor on the draft, and an unchanged visit writes nothing', async () => {
    seed(draft());
    serve.board = waiting();
    await mounted();
    const editor = await openEditor('layout');
    expect(excal.scene?.map((e) => (e as { id: string }).id)).toEqual([
      'moved',
    ]);
    fireEvent.click(within(editor).getByRole('button', { name: 'CLOSE' }));
    await waitFor(() =>
      expect(screen.queryByTestId('drawing-editor')).toBeNull(),
    );
    expect(stored()).toEqual([draft()]);
  });

  // jsdom lays nothing out, so this holds the row's structure: on a phone
  // the label and its marks wrap as whole one-line items, and ⤢ stays
  // outside the wrap, pinned to the frame's right edge.
  it('keeps the label row tidy on a narrow column: whole items wrap, ⤢ stays pinned', async () => {
    seed(draft());
    serve.board = waiting();
    await mounted();
    const f = figure('layout') as HTMLElement;
    const row = f.firstElementChild as HTMLElement;
    const marks = row.firstElementChild as HTMLElement;
    expect(marks.className).toContain('flex-wrap');
    expect(row.lastElementChild).toBe(editButton('layout'));
    expect(editButton('layout').className).toContain('shrink-0');
    const changed = f.querySelector<HTMLElement>('[data-drawing-changed]');
    expect(changed?.className).toContain('truncate');
    expect(changed?.title).toBe('Changed · goes with your answer');
    // A phone shows "Changed"; the rest stays for a screen reader.
    expect(changed?.querySelector('span')?.className).toContain(
      'compact:sr-only',
    );
    expect(
      within(f).getByRole('button', { name: 'REVERT' }).className,
    ).toContain('whitespace-nowrap');
  });
});

describe('the answer', () => {
  it('carries only the drawings the operator changed, and drops their drafts once taken', async () => {
    seed(draft());
    serve.board = waiting();
    await mounted();
    type('Like this.');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toEqual({
      response: 'Like this.',
      seenRevision: 1,
      drawings: { layout: scene('moved') },
    });
    await waitFor(() => expect(stored()).toEqual([]));
  });

  it('keeps the drafts when the answer is refused', async () => {
    seed(draft());
    serve.board = waiting();
    serve.post = () =>
      json({ _tag: 'AnswerRefused', message: 'too late' }, 409);
    await mounted();
    type('Like this.');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await settle();
    expect(stored()).toEqual([draft()]);
  });

  it('carries them with a deferral too', async () => {
    seed(draft());
    serve.board = waiting();
    await mounted();
    fireEvent.click(
      screen.getByRole('button', { name: 'Leave it to the agent' }),
    );
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      deferred: true,
      drawings: { layout: scene('moved') },
    });
    await waitFor(() => expect(stored()).toEqual([]));
  });

  it('sends no drawings when none was changed', async () => {
    serve.board = waiting();
    await mounted();
    type('Fine as it is.');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toEqual({
      response: 'Fine as it is.',
      seenRevision: 1,
    });
  });
});

describe('a drawing the agent changed after the operator edited it', () => {
  const sendButton = () =>
    screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  const deferButton = () =>
    screen.getByRole('button', {
      name: 'Leave it to the agent',
    }) as HTMLButtonElement;
  const conflict = () =>
    figure('layout')?.querySelector<HTMLElement>('[data-drawing-conflict]');

  // The draft was made on revision 1; the board moves the drawing to 2.
  const overtaken = async () => {
    seed(draft());
    serve.board = waiting(1);
    await mounted();
    type('Like this.');
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(conflict()).toBeNull();
    await reread(waiting(2));
    await waitFor(() => expect(conflict()).not.toBeNull());
  };

  it('says so, and holds Send and the deferral, with the reason under the box', async () => {
    await overtaken();
    expect(conflict()?.textContent).toContain(
      'The agent changed this drawing since you edited it.',
    );
    expect(sendButton().disabled).toBe(true);
    expect(deferButton().disabled).toBe(true);
    expect(footNote()).toContain('The agent changed the drawing “layout”');
    expect(footNote()).toContain('Keep mine or Take theirs');
    // The send key does nothing either.
    press({ key: 'Enter', code: 'Enter', metaKey: true }, document);
    press({ key: 'Enter', code: 'Enter', ctrlKey: true }, document);
    fireEvent.click(sendButton());
    await settle();
    expect(serve.posts).toEqual([]);
  });

  it('keep mine stamps the draft with the new revision and frees Send', async () => {
    await overtaken();
    fireEvent.click(
      within(conflict() as HTMLElement).getByRole('button', {
        name: 'KEEP MINE',
      }),
    );
    await waitFor(() => expect(conflict()).toBeNull());
    expect(stored()).toEqual([draft({ revision: 2 })]);
    expect(sendButton().disabled).toBe(false);
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      seenRevision: 2,
      drawings: { layout: scene('moved') },
    });
  });

  it('take theirs drops the draft and frees Send', async () => {
    await overtaken();
    fireEvent.click(
      within(conflict() as HTMLElement).getByRole('button', {
        name: 'TAKE THEIRS',
      }),
    );
    await waitFor(() => expect(conflict()).toBeNull());
    expect(stored()).toEqual([]);
    expect(
      figure('layout')?.querySelector('[data-drawing-changed]'),
    ).toBeNull();
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toEqual({
      response: 'Like this.',
      seenRevision: 2,
    });
  });
});

describe('the full-screen editor', () => {
  it('opens from ⤢, a button the keyboard reaches', async () => {
    serve.board = waiting();
    await mounted();
    const open = editButton('layout');
    expect(open.tagName).toBe('BUTTON');
    expect(open.tabIndex).toBe(0);
    await openEditor('layout');
  });

  it('keeps the app’s keys out of it', async () => {
    serve.board = waiting();
    await mounted();
    const editor = await openEditor('layout');
    const canvas = editor.querySelector(
      '[data-excalidraw-stub]',
    ) as HTMLElement;
    expect(inDrawingEditor(canvas)).toBe(true);
    expect(inDrawingEditor(document.body)).toBe(false);
    // Ctrl+R rereads the board, but not from inside the editor.
    const was = serve.reads;
    press({ key: 'r', code: 'KeyR', ctrlKey: true }, canvas);
    await settle();
    expect(serve.reads).toBe(was);
  });

  it('closes on Escape when the canvas has nothing to cancel, and leaves it to the canvas otherwise', async () => {
    serve.board = waiting();
    await mounted();
    const editor = await openEditor('layout');
    const canvas = editor.querySelector(
      '[data-excalidraw-stub]',
    ) as HTMLElement;
    // A box is selected: Escape is Excalidraw's.
    excal.state = { ...IDLE, selectedElementIds: { box: true } };
    fireEvent.keyDown(canvas, { key: 'Escape', code: 'Escape' });
    await settle();
    expect(screen.queryByTestId('drawing-editor')).not.toBeNull();
    excal.state = IDLE;
    fireEvent.keyDown(canvas, { key: 'Escape', code: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('drawing-editor')).toBeNull(),
    );
  });

  it('closes on Escape from its CLOSE button too', async () => {
    serve.board = waiting();
    await mounted();
    const editor = await openEditor('layout');
    const close = within(editor).getByRole('button', { name: 'CLOSE' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Escape', code: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('drawing-editor')).toBeNull(),
    );
  });
});

describe('the drafts, pure', () => {
  const question = {
    drawings: {
      layout: { scene: LAYOUT, revision: 3 },
      flow: { scene: FLOW, revision: 1 },
    },
  };
  const d = (id: string, revision: number) => draft({ id, revision });

  it('names the drawings whose revision moved past the draft', () => {
    expect(drawingConflicts([d('layout', 1), d('flow', 1)], question)).toEqual([
      'layout',
    ]);
    expect(drawingConflicts([d('layout', 3)], question)).toEqual([]);
  });

  it('sends only the drafts of drawings the question still carries', () => {
    expect(drawingsToSend([], question)).toBeUndefined();
    expect(drawingsToSend([d('gone', 1), d('flow', 1)], question)).toEqual({
      flow: scene('moved'),
    });
  });

  it('drops a draft once its question no longer waits, and keeps one whose Inbox is off the board', () => {
    const view = {
      ...VIEW_A,
      awaitingOperator: [{ ...asked(1, 'First', 2), ...question }],
    };
    const drafts = [
      d('layout', 1),
      draft({ number: 3 }),
      draft({ inboxId: 'elsewhere' }),
      d('gone', 1),
    ];
    const kept = drawingDraftsStillWaiting(drafts, { views: [view] } as never);
    expect(kept).toEqual([drafts[0], drafts[2]]);
    const all = [drafts[0] as DrawingDraft];
    expect(drawingDraftsStillWaiting(all, { views: [view] } as never)).toBe(
      all,
    );
  });
});
