import { keysLabel, resolveKeymap } from '@operator-inbox/core/keymap';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  A,
  B,
  board,
  box,
  C,
  mounted,
  openRail,
  openRowMenu,
  prefix,
  serve,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  VIEW_C,
} from './inbox-page-harness';

// The inbox picker, `Ctrl+Space i` and `Ctrl+Space s`: every Inbox and its
// session in the ⌘P modal. Enter selects the Inbox; Ctrl+Enter or a row's
// session icon opens the session and leaves the picker open. Then the lines a
// sidebar row's menu gains.

useInboxPage();

const LINK_A = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';
const LINK_B = 'claude://claude.ai/epitaxy/local_4e5f-6a7b';
const linkedA = {
  ...VIEW_A,
  code: 'orc',
  metadata: { sessionLink: LINK_A, sessionTitle: 'Prune the apple trees' },
};
const linkedB = { ...VIEW_B, code: 'qua', metadata: { sessionLink: LINK_B } };

const opened = (link: string) => ({
  path: '/api/open-session',
  body: { link },
});

const picker = () => document.querySelector('[data-testid="inbox-picker"]');
const field = () =>
  screen.getByTestId('inbox-picker-field') as HTMLInputElement;
const keys = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="inbox-picker-row"]',
    ),
  ].map((r) => r.dataset.key);
const litKey = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="inbox-picker-row"][data-highlighted]',
  )?.dataset.key;

const openPicker = async (key = 'i') => {
  prefix();
  fireEvent.keyDown(document, { key });
  await screen.findByTestId('inbox-picker-field');
};

describe('the inbox picker', () => {
  beforeEach(() => {
    Object.assign(window, { pakeConfig: {} });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'pakeConfig');
  });

  it('opens on Ctrl+Space i and on Ctrl+Space s, the same modal', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted();
    await openPicker('i');
    fireEvent.keyDown(field(), { key: 'Escape' });
    await waitFor(() => expect(picker()).toBeNull());
    await openPicker('s');
    expect(picker()).not.toBeNull();
    // The line of its keys is a hint a touch-only device never shows.
    const keys = document.querySelector('[data-inbox-picker-keys]');
    expect(keys?.textContent).toContain('Ctrl+↩');
    expect(keys?.classList).toContain('touch-only:hidden');
  });

  it('lists the empty state’s order, the rest after, archived last, then All', async () => {
    serve.board = board([linkedA, linkedB, VIEW_C]);
    await mounted();
    await openPicker();
    // quarry has fewer waiting than orchard; kiln is archived.
    expect(keys()).toEqual([B, A, C, 'all']);
    expect(litKey()).toBe(B);
  });

  it('filters by an Inbox’s name, its session’s title and its code', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted();
    await openPicker();
    fireEvent.change(field(), { target: { value: 'quar' } });
    await waitFor(() => expect(keys()).toEqual([B]));
    fireEvent.change(field(), { target: { value: 'apple' } });
    await waitFor(() => expect(keys()).toEqual([A]));
    fireEvent.change(field(), { target: { value: '@or' } });
    await waitFor(() => expect(keys()).toEqual([A]));
    fireEvent.change(field(), { target: { value: 'nothing like it' } });
    expect(
      await screen.findByText('No inbox matches “nothing like it”.'),
    ).toBeDefined();
  });

  it('selects the lit Inbox on Enter, shuts, and puts the caret in its box', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted(`/inbox/${B}`);
    await openPicker();
    fireEvent.change(field(), { target: { value: 'orchard' } });
    await waitFor(() => expect(litKey()).toBe(A));
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    await waitFor(() => expect(picker()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('opens the session on Ctrl+Enter and stays open, so Enter can follow', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted(`/inbox/${B}`);
    await openPicker();
    fireEvent.change(field(), { target: { value: 'orchard' } });
    await waitFor(() => expect(litKey()).toBe(A));
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(serve.posts).toContainEqual(opened(LINK_A)));
    expect(picker()).not.toBeNull();
    expect(location.pathname).toBe(`/inbox/${B}`);
    expect(litKey()).toBe(A);
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
  });

  it('opens a row’s session from its icon, without selecting the row', async () => {
    serve.board = board([linkedA, VIEW_B]);
    await mounted(`/inbox/${B}`);
    await openPicker();
    // quarry has no session, so no icon.
    expect(
      screen.queryByRole('button', { name: 'Open the session for quarry' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the session for orchard' }),
    );
    await waitFor(() => expect(serve.posts).toContainEqual(opened(LINK_A)));
    expect(picker()).not.toBeNull();
    expect(location.pathname).toBe(`/inbox/${B}`);
  });

  it('leaves Ctrl+Space o on the selected Inbox’s session, not the lit row’s', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted(`/inbox/${B}`);
    await openPicker();
    fireEvent.change(field(), { target: { value: 'orchard' } });
    await waitFor(() => expect(litKey()).toBe(A));
    prefix();
    fireEvent.keyDown(field(), { key: 'o', code: 'KeyO' });
    await waitFor(() => expect(serve.posts).toContainEqual(opened(LINK_B)));
    expect(serve.posts).not.toContainEqual(opened(LINK_A));
  });

  it('shows the session’s title under the name, unless it repeats it', async () => {
    serve.board = board([
      linkedA,
      { ...linkedB, metadata: { ...linkedB.metadata, sessionTitle: 'quarry' } },
    ]);
    await mounted();
    await openPicker();
    const subOf = (key: string) =>
      document
        .querySelector(`[data-testid="inbox-picker-row"][data-key="${key}"]`)
        ?.querySelector('[data-picker-session]')?.textContent;
    expect(subOf(A)).toBe('Prune the apple trees');
    expect(subOf(B)).toBeUndefined();
  });

  it('shuts on Escape', async () => {
    serve.board = board([linkedA]);
    await mounted();
    await openPicker();
    fireEvent.keyDown(field(), { key: 'Escape' });
    await waitFor(() => expect(picker()).toBeNull());
  });
});

describe('a sidebar row’s menu', () => {
  const menu = async (name: string) => {
    await mounted();
    await openRail();
    await openRowMenu(name);
    await screen.findByRole('menuitem', { name: /Rename/ });
  };

  beforeEach(() => {
    Object.assign(window, { pakeConfig: {} });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'pakeConfig');
  });

  it('opens the row’s session, not the lit one', async () => {
    serve.board = board([linkedA, linkedB]);
    await menu(VIEW_B.label);
    fireEvent.click(screen.getByRole('menuitem', { name: /Open session/ }));
    await waitFor(() => expect(serve.posts).toContainEqual(opened(LINK_B)));
  });

  it('shows the row’s metadata on the card', async () => {
    serve.board = board([VIEW_A, { ...VIEW_B, metadata: { topic: 'pears' } }]);
    await menu(VIEW_B.label);
    fireEvent.click(screen.getByRole('menuitem', { name: /Metadata/ }));
    const card = await screen.findByRole('dialog');
    expect(within(card).getByText('pears')).toBeDefined();
    fireEvent.keyDown(card, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names each line’s keys, which a touch-only device never shows', async () => {
    serve.board = board([
      VIEW_A,
      { ...linkedB, metadata: { ...linkedB.metadata, topic: 'pears' } },
    ]);
    await menu(VIEW_B.label);
    const menuEl = screen.getByRole('menu');
    const keymap = resolveKeymap(undefined);
    const actions = [
      'open_session',
      'toggle_metadata',
      'rename_inbox',
      'toggle_priority',
      'toggle_archive',
    ];
    for (const action of actions) {
      const keys = keysLabel(keymap, action, 1);
      expect(keys, action).toBeDefined();
      const hint = [...menuEl.querySelectorAll('span')].find(
        (s) => s.textContent === keys,
      );
      expect(hint, action).toBeDefined();
      expect(hint?.classList, action).toContain('touch-only:hidden');
    }
  });

  it('offers neither to an Inbox with nothing to show', async () => {
    serve.board = board([VIEW_A, { ...VIEW_B, inboxId: B, metadata: {} }]);
    await menu(VIEW_B.label);
    expect(screen.queryByRole('menuitem', { name: /Open session/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Metadata/ })).toBeNull();
  });
});
