import { RegistryProvider, useAtomValue } from '@effect/atom-react';
import { InboxId } from '@operator-inbox/core/api';
import { KEYMAP_ACTIONS } from '@operator-inbox/core/keymap';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxPage } from '../src/components/inbox/page';
import { strayWritesAtom } from '../src/inbox';
import { isActionHandled } from '../src/keymap';
import { json } from './fixture';

// Every key on the real page, machine and Atoms, over a fetch that answers as
// serve does. All names are invented.

const GROVE = InboxId.make('inbox-grove');
const ORCHARD = InboxId.make('inbox-orchard');

const question = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: `<p>Body of ${number}</p>`,
  askedSeq: number,
  askedAt: `2026-11-05T0${number}:00:00.000Z`,
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  inboxId: GROVE,
  label: 'grove',
  metadata: {},
  archived: false,
  pinnedGroups: [],
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
  ...over,
});

const grove = view({
  awaitingOperator: [
    question(1),
    question(2, {
      highlight: { seq: 9, at: '2026-11-05T09:00:00.000Z', note: 'look' },
    }),
    question(3),
  ],
  awaitingAgent: [
    {
      ...question(4),
      response: 'Done',
      answeredSeq: 4,
      answeredAt: '2026-11-05T04:30:00.000Z',
    },
  ],
});
const orchard = view({ inboxId: ORCHARD, label: 'orchard' });

const BOARD = {
  inboxes: [grove, orchard].map((v) => ({
    inboxId: v.inboxId,
    label: v.label,
    archived: false,
    pinned: false,
    awaitingOperator: v.awaitingOperator.length,
    awaitingAgent: v.awaitingAgent.length,
    processed: 0,
  })),
  totalAwaitingOperator: 3,
  views: [grove, orchard],
};

const writes: Array<{ path: string; body: unknown }> = [];
let refuse = false;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  writes.length = 0;
  refuse = false;
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/inbox');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), 'http://x');
    if ((request?.method ?? init?.method ?? 'GET') === 'POST') {
      const text =
        request === undefined
          ? await new Response(init?.body ?? null).text()
          : await request.clone().text();
      writes.push({
        path: url.pathname,
        body: text === '' ? undefined : JSON.parse(text),
      });
      return refuse ? new Response('nope', { status: 500 }) : json(view());
    }
    if (url.pathname === '/api/inbox-config')
      return json({ metadata: { extras: 'allow', keys: [] } });
    if (url.pathname === '/api/keybindings') return json({ text: null });
    return json(BOARD);
  });
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const Strays = () => (
  <output data-testid="strays">
    {useAtomValue(strayWritesAtom)
      .map((s) => s.text)
      .join('|')}
  </output>
);

const mount = async () => {
  render(
    <RegistryProvider>
      <InboxPage />
      <Strays />
    </RegistryProvider>,
  );
  await screen.findByRole('heading', { name: 'Question 1' });
  await waitFor(() => expect(lit()).toBe('Question 1'));
};

const lit = () =>
  document.querySelector('[data-zen-lit] h1')?.textContent ?? undefined;

const box = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[data-zen-box]');

const rail = () =>
  document.querySelector<HTMLElement>('[data-inbox-sidebar]')?.dataset
    .inboxSidebar;

const press = (
  init: KeyboardEventInit,
  target: Element | Document = document,
) => {
  act(() => {
    fireEvent.keyDown(target, init);
  });
};

const ctrl = (key: string, more: KeyboardEventInit = {}) =>
  press({ key, ctrlKey: true, ...more });

const prefix = (key: string, more: KeyboardEventInit = {}) => {
  press({ key: ' ', code: 'Space', ctrlKey: true });
  press({ key, ...more });
};

const swipe = (deltaX: number, target?: Element) => {
  const flow = target ?? document.querySelector('[data-zen-flow]');
  if (flow === null) throw new Error('no flow');
  act(() => {
    fireEvent.wheel(flow, { deltaX, deltaY: 0 });
    fireEvent.wheel(flow, { deltaX, deltaY: 0 });
    fireEvent.wheel(flow, { deltaX, deltaY: 0 });
  });
};

const touch = (fromX: number, toX: number) => {
  const flow = document.querySelector('[data-zen-flow]');
  if (flow === null) throw new Error('no flow');
  act(() => {
    fireEvent.touchStart(flow, {
      touches: [{ clientX: fromX, clientY: 100 }],
    });
    fireEvent.touchEnd(flow, {
      changedTouches: [{ clientX: toX, clientY: 104 }],
    });
  });
};

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 200));
  });

describe('swiping the middle panel', () => {
  const on = (name: RegExp) =>
    screen.getByRole('tab', { name }).getAttribute('aria-selected');

  it('goes Ask, Your inbox, With the agent, Processed, and stops at each end', async () => {
    await mount();
    swipe(60);
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    await settle();
    swipe(60);
    await waitFor(() => expect(on(/Processed/)).toBe('true'));
    await settle();
    swipe(60);
    await settle();
    expect(on(/Processed/)).toBe('true');
    swipe(-60);
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    await settle();
    swipe(-60);
    await waitFor(() => expect(on(/Your inbox/)).toBe('true'));
    await settle();
    swipe(-60);
    await screen.findByRole('heading', { name: 'Ask the agent' });
    await settle();
    swipe(-60);
    await settle();
    expect(screen.queryByRole('heading', { name: 'Ask the agent' })).not.toBe(
      null,
    );
    swipe(60);
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Ask the agent' }),
      ).toBeNull(),
    );
    expect(on(/Your inbox/)).toBe('true');
  });

  it('comes out of an ask to Your inbox, wherever the ask began', async () => {
    await mount();
    swipe(60);
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    prefix('a');
    await screen.findByRole('heading', { name: 'Ask the agent' });
    await settle();
    swipe(60);
    await waitFor(() => expect(on(/Your inbox/)).toBe('true'));
    expect(screen.queryByRole('heading', { name: 'Ask the agent' })).toBeNull();
  });

  it('steps on a finger too, the way the finger pushes the page', async () => {
    await mount();
    touch(300, 100);
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    touch(100, 300);
    await waitFor(() => expect(on(/Your inbox/)).toBe('true'));
  });

  it('leaves a block that scrolls sideways to scroll', async () => {
    await mount();
    const flow = document.querySelector('[data-zen-flow]');
    const wide = document.createElement('pre');
    wide.style.overflowX = 'auto';
    Object.defineProperty(wide, 'scrollWidth', { value: 900 });
    Object.defineProperty(wide, 'clientWidth', { value: 300 });
    flow?.append(wide);
    swipe(60, wide);
    await settle();
    expect(on(/Your inbox/)).toBe('true');
    wide.remove();
  });

  it('keeps the browser from taking the swipe as back or forward', async () => {
    // A registry lets go of its nodes a moment after the last reader leaves.
    const root = document.documentElement.classList;
    await waitFor(() => expect(root).not.toContain('overscroll-x-none'));
    await mount();
    expect(root).toContain('overscroll-x-none');
    cleanup();
    await waitFor(() => expect(root).not.toContain('overscroll-x-none'));
  });
});

describe('the keymap on the inbox page', () => {
  it('has a handler for every action core declares', () => {
    expect(KEYMAP_ACTIONS.filter((a) => !isActionHandled(a.id))).toEqual([]);
  });

  it('marks no row of the key bindings as dead', async () => {
    await mount();
    prefix('?', { shiftKey: true });
    const help = await screen.findByTestId('keymap-help');
    expect(help.querySelectorAll('[data-action]').length).toBe(
      KEYMAP_ACTIONS.length,
    );
    expect(help.textContent).not.toContain('Not on this page');
  });

  it('moves down the queue, to its ends and between highlights', async () => {
    await mount();
    ctrl(']');
    await waitFor(() => expect(lit()).toBe('Question 2'));
    ctrl('[');
    await waitFor(() => expect(lit()).toBe('Question 1'));
    press({ key: 'ArrowDown', metaKey: true });
    await waitFor(() => expect(lit()).toBe('Question 3'));
    press({ key: 'ArrowUp', metaKey: true });
    await waitFor(() => expect(lit()).toBe('Question 1'));
    ctrl('}', { shiftKey: true, code: 'BracketRight' });
    await waitFor(() => expect(lit()).toBe('Question 2'));
  });

  it('steps between the queues', async () => {
    await mount();
    ctrl('>', { shiftKey: true });
    await waitFor(() => expect(lit()).toBe('Question 4'));
    ctrl('<', { shiftKey: true });
    await waitFor(() => expect(lit()).toBe('Question 1'));
  });

  it('opens, closes and focuses the sidebar through the machine', async () => {
    await mount();
    expect(rail()).toBeUndefined();
    ctrl('b');
    await waitFor(() => expect(rail()).toBe('drawer'));
    press({ key: 'Escape' });
    await waitFor(() => expect(rail()).toBeUndefined());
    prefix('/');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.querySelector('[data-sidebar-search]'),
      ),
    );
    press({ key: 'Escape' });
    await waitFor(() => expect(rail()).toBeUndefined());
    prefix('h');
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-current')).toBe('page'),
    );
  });

  it('gives the box the caret back when the drawer holding it goes', async () => {
    await mount();
    prefix('/');
    await waitFor(() => expect(rail()).toBe('drawer'));
    await waitFor(() =>
      expect(document.activeElement?.hasAttribute('data-sidebar-search')).toBe(
        true,
      ),
    );
    press({ key: 'Escape' });
    await waitFor(() => expect(rail()).toBeUndefined());
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('nudges the list from the box, and leaves ⌘↓ to a draft and a modal', async () => {
    await mount();
    const scrollTo = Element.prototype.scrollTo as unknown as {
      mock: { calls: ReadonlyArray<unknown> };
      mockClear: () => void;
    };
    scrollTo.mockClear();
    const answer = box();
    if (answer === null) throw new Error('no box');
    // Whether the browser keeps the key.
    const step = () => {
      let kept = false;
      act(() => {
        kept = fireEvent.keyDown(answer, {
          key: ']',
          code: 'BracketRight',
          ctrlKey: true,
          altKey: true,
        });
      });
      return kept;
    };
    step();
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(0));
    // A draft keeps ⌘↓, the platform's, but this chord is no platform's.
    fireEvent.change(answer, { target: { value: 'Two\nlines' } });
    const before = scrollTo.mock.calls.length;
    expect(step()).toBe(false);
    await waitFor(() =>
      expect(scrollTo.mock.calls.length).toBeGreaterThan(before),
    );
    expect(fireEvent.keyDown(answer, { key: 'ArrowDown', metaKey: true })).toBe(
      true,
    );
    expect(lit()).toBe('Question 1');
    const stepped = scrollTo.mock.calls.length;
    fireEvent.change(answer, { target: { value: '' } });
    press({ key: 'p', ctrlKey: true });
    await screen.findByTestId('search-field');
    expect(step()).toBe(true);
    expect(scrollTo.mock.calls).toHaveLength(stepped);
  });

  it('puts the caret back in the box from another field', async () => {
    await mount();
    prefix('/');
    await waitFor(() => expect(rail()).toBe('drawer'));
    prefix('i');
    await waitFor(() => expect(document.activeElement).toBe(box()));
    await waitFor(() => expect(rail()).toBeUndefined());
  });

  it('sends from the box, and leaves another field its chord', async () => {
    await mount();
    const answer = box();
    if (answer === null) throw new Error('no box');
    fireEvent.change(answer, { target: { value: 'Yes' } });
    prefix('/');
    const search = await waitFor(() => {
      const el = document.querySelector('[data-sidebar-search]');
      if (el === null) throw new Error('no search');
      return el;
    });
    press({ key: 'Enter', ctrlKey: true }, search);
    expect(writes).toEqual([]);
    press({ key: 'Enter', ctrlKey: true }, answer);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toBe(`/api/inbox/${GROVE}/questions/1/answer`);
    await waitFor(() => expect(lit()).toBe('Question 2'));
  });

  it('defers with nothing in the box, by chord and by sequence', async () => {
    await mount();
    prefix('u');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({ deferred: true, response: '' });
  });

  // Ctrl+< and Ctrl+> step to the previous and next column. On macOS Shift does nothing under Control, so the
  // press carries `,` and `.`.
  it('steps the queues on Ctrl+< and Ctrl+> as macOS sends them', async () => {
    await mount();
    const on = (name: RegExp) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');
    press({ key: '.', code: 'Period', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    press({ key: ',', code: 'Comma', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(on(/Your inbox/)).toBe('true'));
  });

  it('steps the queues on the same keys without Shift', async () => {
    await mount();
    const on = (name: RegExp) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');
    press({ key: '.', code: 'Period', ctrlKey: true });
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    press({ key: ',', code: 'Comma', ctrlKey: true });
    await waitFor(() => expect(on(/Your inbox/)).toBe('true'));
  });

  // Ask is a fourth panel, left of Your inbox, with no
  // tab of its own.
  it('steps into Ask left of Your inbox, and stops there', async () => {
    await mount();
    const on = (name: RegExp) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');
    const asking = () =>
      screen.queryByRole('heading', { name: 'Ask the agent' });
    press({ key: ',', code: 'Comma', ctrlKey: true });
    await waitFor(() => expect(asking()).not.toBeNull());
    expect(on(/Your inbox/)).toBe('false');
    press({ key: ',', code: 'Comma', ctrlKey: true });
    expect(asking()).not.toBeNull();
    press({ key: '.', code: 'Period', ctrlKey: true });
    await waitFor(() => expect(asking()).toBeNull());
    expect(on(/Your inbox/)).toBe('true');
  });

  it('leaves Ask for Your inbox on Ctrl+>, wherever it was opened', async () => {
    await mount();
    const on = (name: RegExp) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');
    press({ key: '.', code: 'Period', ctrlKey: true });
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await screen.findByRole('heading', { name: 'Ask the agent' });
    press({ key: '.', code: 'Period', ctrlKey: true });
    await waitFor(() => expect(on(/Your inbox/)).toBe('true'));
  });

  it('goes back to the tab it left on Esc', async () => {
    await mount();
    const on = (name: RegExp) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected');
    press({ key: '.', code: 'Period', ctrlKey: true });
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await screen.findByRole('heading', { name: 'Ask the agent' });
    press({ key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(on(/With the agent/)).toBe('true'));
  });

  it('keeps Ctrl+A for the field while there is text to edit', async () => {
    await mount();
    const answer = box();
    if (answer === null) throw new Error('no box');
    fireEvent.change(answer, { target: { value: 'Half a thought' } });
    press({ key: 'a', ctrlKey: true }, answer);
    expect(screen.queryByRole('heading', { name: 'Ask the agent' })).toBeNull();
    prefix('a');
    await screen.findByRole('heading', { name: 'Ask the agent' });
    press({ key: 'Escape' });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Ask the agent' }),
      ).toBeNull(),
    );
  });

  it('asks from the empty box, but not behind a modal', async () => {
    await mount();
    ctrl('p');
    await screen.findByTestId('search-field');
    ctrl('a');
    expect(screen.queryByRole('heading', { name: 'Ask the agent' })).toBeNull();
    ctrl('p');
    await waitFor(() =>
      expect(screen.queryByTestId('search-field')).toBeNull(),
    );
    const answer = box();
    if (answer === null) throw new Error('no box');
    press({ key: 'a', ctrlKey: true }, answer);
    await screen.findByRole('heading', { name: 'Ask the agent' });
  });

  it('opens the metadata with Ctrl+M', async () => {
    await mount();
    ctrl('m');
    // Nothing is folded here, so the toggle only has to take the press.
    expect(lit()).toBe('Question 1');
  });

  it('copies the lit question', async () => {
    await mount();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    prefix('y');
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]).toEqual([
      expect.stringContaining(`Inbox ${GROVE} · #1 — Question 1`),
    ]);
  });

  it('dismisses only a highlight, and files a failed dismissal', async () => {
    await mount();
    prefix('d');
    expect(writes).toEqual([]);
    ctrl(']');
    await waitFor(() => expect(lit()).toBe('Question 2'));
    refuse = true;
    prefix('d');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.path).toContain('/questions/2/');
    await waitFor(() =>
      expect(screen.getByTestId('strays').textContent).toContain(
        'Dismissing the highlight on #2',
      ),
    );
  });

  it('acts on the lit question’s Inbox in All', async () => {
    await mount();
    prefix('m');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      path: `/api/inbox/${GROVE}/pin`,
      body: { pinned: true },
    });
    prefix('&', { shiftKey: true });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({
      path: `/api/inbox/${GROVE}/archive`,
      body: { archived: true },
    });
    prefix(',');
    await waitFor(() => expect(rail()).toBe('drawer'));
    await waitFor(() =>
      expect(document.querySelector('[data-zen-rename]')).not.toBeNull(),
    );
  });

  it('files a failed archive by key while the sidebar is shut', async () => {
    await mount();
    refuse = true;
    prefix('&', { shiftKey: true });
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('strays').textContent).toContain(
        'Archiving grove',
      ),
    );
  });

  it('steps round the Inboxes and back to All', async () => {
    await mount();
    prefix('n');
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${GROVE}`));
    prefix('2');
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${ORCHARD}`));
    prefix('0');
    await waitFor(() => expect(location.pathname).toBe('/inbox'));
  });

  it('refreshes with Ctrl+R', async () => {
    await mount();
    const reads = () =>
      fetchMock.mock.calls.filter(([input]) =>
        (input instanceof Request ? input.url : String(input)).includes(
          'inbox-board',
        ),
      ).length;
    const before = reads();
    ctrl('r');
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});
