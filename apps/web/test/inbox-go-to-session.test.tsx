import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  B,
  board,
  M,
  MACHINE_BOARD,
  mounted,
  openRail,
  openRowMenu,
  prefix,
  serve,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Reaching a session without its question: the go-to-session modal, and the
// lines a sidebar row's menu gains.

useInboxPage();

const LINK_A = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';
const LINK_B = 'claude://claude.ai/epitaxy/local_4e5f-6a7b';
const linkedA = { ...VIEW_A, metadata: { sessionLink: LINK_A } };
const linkedB = { ...VIEW_B, metadata: { sessionLink: LINK_B } };

const opened = (link: string) => ({
  path: '/api/open-session',
  body: { link },
});

const field = () => screen.getByRole('combobox', { name: 'Which session?' });
const options = () => screen.getAllByRole('option');
const litLabel = () =>
  options().find((o) => o.getAttribute('aria-selected') === 'true')
    ?.textContent;

const openModal = async () => {
  prefix();
  fireEvent.keyDown(document, { key: 's' });
  await screen.findByRole('listbox', { name: 'Inboxes with a session' });
};

describe('go to session', () => {
  beforeEach(() => {
    Object.assign(window, { pakeConfig: {} });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'pakeConfig');
  });

  it('lists only the Inboxes with a session', async () => {
    serve.board = board([linkedA, VIEW_B]);
    await mounted();
    await openModal();
    expect(options().map((o) => o.textContent)).toEqual([VIEW_A.label]);
  });

  it('lists an archived Inbox’s session last, and says so', async () => {
    serve.board = board([{ ...linkedA, archived: true }, linkedB]);
    await mounted();
    await openModal();
    expect(options().map((o) => o.textContent)).toEqual([
      VIEW_B.label,
      `${VIEW_A.label}archived`,
    ]);
  });

  it('says when no Inbox has a session', async () => {
    serve.board = board([VIEW_A, VIEW_B]);
    await mounted();
    await openModal();
    expect(await screen.findByText('No inbox has a session.')).toBeDefined();
  });

  it('walks the list with the arrows, stopping at its ends', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted();
    await openModal();
    const [first, second] = options().map((o) => o.textContent);
    expect(litLabel()).toBe(first);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(litLabel()).toBe(first);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    await waitFor(() => expect(litLabel()).toBe(second));
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(litLabel()).toBe(second);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    await waitFor(() => expect(litLabel()).toBe(first));
  });

  it('filters as the ask’s list does', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted();
    await openModal();
    fireEvent.change(field(), { target: { value: VIEW_B.label } });
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(litLabel()).toBe(VIEW_B.label);
    fireEvent.change(field(), { target: { value: 'nothing like it' } });
    expect(await screen.findByText('No session matches.')).toBeDefined();
  });

  it('opens the lit session on Enter, and shuts', async () => {
    serve.board = board([linkedA, linkedB]);
    await mounted();
    await openModal();
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    const second = await waitFor(() => {
      const lit = options().find(
        (o) => o.getAttribute('aria-selected') === 'true',
      );
      expect(lit).toBe(options()[1]);
      return lit?.textContent;
    });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() =>
      expect(serve.posts).toContainEqual(
        opened(second === VIEW_B.label ? LINK_B : LINK_A),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('opens a clicked session', async () => {
    serve.board = board([linkedA]);
    await mounted();
    await openModal();
    fireEvent.click(screen.getByRole('option', { name: VIEW_A.label }));
    await waitFor(() => expect(serve.posts).toContainEqual(opened(LINK_A)));
  });

  it('shuts on Escape', async () => {
    serve.board = board([linkedA]);
    await mounted();
    await openModal();
    fireEvent.keyDown(field(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('lists a session on another machine, and passes over it', async () => {
    serve.board = {
      ...MACHINE_BOARD,
      views: MACHINE_BOARD.views.map((v) =>
        v.inboxId === M
          ? { ...v, metadata: { sessionLink: LINK_B } }
          : { ...v, metadata: { sessionLink: LINK_A } },
      ),
    };
    await mounted();
    await openModal();
    const away = options().find(
      (o) => o.getAttribute('aria-disabled') === 'true',
    );
    expect(away).toBeDefined();
    fireEvent.click(away as HTMLElement);
    for (let i = 0; i < options().length; i++)
      fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(away?.getAttribute('aria-selected')).toBe('false');
    expect(serve.posts).not.toContainEqual(opened(LINK_B));
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

  it('offers neither to an Inbox with nothing to show', async () => {
    serve.board = board([VIEW_A, { ...VIEW_B, inboxId: B, metadata: {} }]);
    await menu(VIEW_B.label);
    expect(screen.queryByRole('menuitem', { name: /Open session/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Metadata/ })).toBeNull();
  });
});
