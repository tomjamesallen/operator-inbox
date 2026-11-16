import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  A,
  B,
  box,
  burger,
  litKey,
  mounted,
  openRail,
  prefix,
  press,
  serve,
  useInboxPage,
} from './inbox-page-harness';

// The key bindings sheet, the prefix and its badges, the keybindings file, and
// what the question keys leave alone. What each action does on the page is
// `inbox-keymap.test.tsx`.

useInboxPage();

const openHelp = async () => {
  prefix();
  press({ key: '?', shiftKey: true });
  return screen.findByTestId('keymap-help');
};

const closed = () =>
  waitFor(() => expect(screen.queryByTestId('keymap-help')).toBeNull());

const badges = () =>
  [...document.querySelectorAll<HTMLElement>('[data-key-badge]')].map(
    (b) => b.dataset.keyBadge,
  );

describe('the key bindings sheet', () => {
  it('opens on prefix ?, showing the prefix while it waits', async () => {
    await mounted();
    prefix();
    expect(screen.getByTestId('keymap-pending').textContent).toContain('Space');
    press({ key: 'Shift', shiftKey: true });
    press({ key: '?', shiftKey: true });
    expect(screen.queryByTestId('keymap-pending')).toBeNull();
    const help = await screen.findByTestId('keymap-help');
    const row = help.querySelector('[data-action="toggle_sidebar"]');
    expect(
      [...(row?.querySelectorAll('[data-binding]') ?? [])].map(
        (b) => (b as HTMLElement).dataset.binding,
      ),
    ).toEqual(['super+b', 'ctrl+b']);
    expect(within(help).getByTestId('keymap-source').textContent).toContain(
      '/c/operator-inbox/keybindings',
    );
  });

  it('puts the focus in its search box when it opens', async () => {
    await mounted();
    await openHelp();
    const search = screen.getByRole('searchbox', {
      name: 'Search key bindings',
    });
    await waitFor(() => expect(document.activeElement).toBe(search));
  });

  it('closes on Esc and on a click on the backdrop, with no button of its own', async () => {
    await mounted();
    const help = await openHelp();
    expect(within(help).queryByRole('button')).toBeNull();
    fireEvent.keyDown(
      within(help).getByRole('searchbox', { name: 'Search key bindings' }),
      { key: 'Escape' },
    );
    await closed();
    await openHelp();
    const backdrop = screen.getByTestId('modal-backdrop');
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    await closed();
  });

  it('filters by every word of the query, in a row or its keys, and starts clear again', async () => {
    await mounted();
    const help = await openHelp();
    const search = within(help).getByRole('searchbox', {
      name: 'Search key bindings',
    });
    const rows = () =>
      [...help.querySelectorAll<HTMLElement>('[data-action]')].map(
        (r) => r.dataset.action,
      );
    expect(rows()).toContain('toggle_sidebar');
    fireEvent.change(search, { target: { value: 'close sidebar open' } });
    await waitFor(() => expect(rows()).toEqual(['toggle_sidebar']));
    // A key, written as it is shown.
    fireEvent.change(search, { target: { value: 'ctrl+b' } });
    await waitFor(() => expect(rows()).toEqual(['toggle_sidebar']));
    fireEvent.change(search, { target: { value: 'no such binding at all' } });
    await within(help).findByText('No key binding matches.');
    expect(rows()).toEqual([]);
    fireEvent.keyDown(search, { key: 'Escape' });
    await closed();
    await openHelp();
    expect(
      (
        screen.getByRole('searchbox', {
          name: 'Search key bindings',
        }) as HTMLInputElement
      ).value,
    ).toBe('');
  });
});

describe('the prefix', () => {
  it('badges the keys left to press while it waits, and only then', async () => {
    await mounted();
    await openRail();
    expect(badges()).toEqual([]);
    prefix();
    const all = document.querySelector('[data-rail-inbox=""]');
    expect(
      all?.closest('[data-greyed-faded]')?.querySelector('[data-key-badge]')
        ?.textContent,
    ).toBe('0');
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-rail-inbox]:not([data-rail-inbox=""])',
      ),
    ];
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.map(
        (r) =>
          r.closest('[data-greyed-faded]')?.querySelector('[data-key-badge]')
            ?.textContent,
      ),
    ).toEqual(rows.map((_, i) => (i < 9 ? String(i + 1) : undefined)));
    // Completing the sequence takes them away again.
    press({ key: '0', code: 'Digit0' });
    expect(badges()).toEqual([]);
    prefix();
    expect(badges().length).toBeGreaterThan(0);
    press({ key: 'Escape' });
    expect(badges()).toEqual([]);
  });

  it('is spent on an unbound key, so the key does nothing else', async () => {
    await mounted();
    prefix();
    // `fireEvent` answers false when the event's default was prevented.
    expect(fireEvent.keyDown(document, { key: 'q' })).toBe(false);
    expect(screen.queryByTestId('keymap-pending')).toBeNull();
    expect(fireEvent.keyDown(document, { key: 'q' })).toBe(true);
  });

  it('steps through the inboxes as tmux steps through windows', async () => {
    await mounted();
    const to = async (key: string, code: string, path: string) => {
      prefix();
      press({ key, code });
      await waitFor(() => expect(location.pathname).toBe(path));
    };
    await to('n', 'KeyN', `/inbox/${B}`);
    await to('0', 'Digit0', '/inbox');
    await to('p', 'KeyP', `/inbox/${B}`);
    await to('1', 'Digit1', `/inbox/${A}`);
  });
});

describe('the keybindings file', () => {
  it('applies the file, and reports a line it skipped', async () => {
    serve.keybindings = [
      'keybind = ctrl+b=unbind',
      'keybind = ctrl+k=toggle_sidebar',
      'keybind = ctrl+q=launch_rockets',
    ].join('\n');
    await mounted();
    const open = () => burger().getAttribute('aria-expanded');
    // The file is in once the burger's hint names its key.
    await waitFor(() =>
      expect(burger().getAttribute('title')).toContain('Ctrl+K'),
    );
    press({ key: 'k', ctrlKey: true });
    await waitFor(() => expect(open()).toBe('true'));
    press({ key: 'b', ctrlKey: true });
    expect(open()).toBe('true');
    const help = await openHelp();
    expect(within(help).getByTestId('keymap-issues').textContent).toContain(
      'Line 3 skipped: unknown action "launch_rockets"',
    );
    expect(
      help
        .querySelector('[data-action="toggle_sidebar"] [data-source="config"]')
        ?.getAttribute('data-binding'),
    ).toBe('ctrl+k');
  });

  it('names the live keys in every hint, and none for an unbound action', async () => {
    serve.keybindings = [
      'keybind = super+b=unbind',
      'keybind = ctrl+b=unbind',
      'keybind = ctrl+k=toggle_sidebar',
      'keybind = ctrl+a=unbind',
      'keybind = prefix>a=unbind',
    ].join('\n');
    await mounted();
    await waitFor(() =>
      expect(burger().getAttribute('title')).toBe('Sidebar (Ctrl+K)'),
    );
    expect(burger().getAttribute('aria-keyshortcuts')).toBe('Control+K');
    expect(
      screen
        .getByRole('button', { name: 'Ask the agent' })
        .hasAttribute('aria-keyshortcuts'),
    ).toBe(false);
  });
});

describe('the question keys', () => {
  const marked = () => document.querySelector('[data-zen-item] .bg-blue');

  it('moves from the box too, and the box stays in hand', async () => {
    await mounted();
    press({ key: ']', code: 'BracketRight', ctrlKey: true }, box());
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('leaves ⌘] to the browser, as its Forward', async () => {
    await mounted();
    press({ key: ']', code: 'BracketRight', metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(litKey()).toBe(`${A}/1`);
  });

  it('clears the mark on Ctrl+C, and leaves a selection to copy', async () => {
    await mounted(`/inbox/${A}#q=3`);
    await waitFor(() => expect(marked()).not.toBeNull());
    const text = document.querySelector('[data-zen-lit] h1');
    if (text !== null) document.getSelection()?.selectAllChildren(text);
    press({ key: 'c', code: 'KeyC', ctrlKey: true });
    expect(marked()).not.toBeNull();
    document.getSelection()?.removeAllRanges();
    press({ key: 'c', code: 'KeyC', ctrlKey: true });
    await waitFor(() => expect(marked()).toBeNull());
  });
});
