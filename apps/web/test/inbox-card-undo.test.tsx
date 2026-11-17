import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  A,
  asked,
  board,
  box,
  litKey,
  mounted,
  press,
  serve,
  settle,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Undo for a card removed from an answer: ⌘Z (Ctrl+Z) in the box or its cards
// brings back the latest removal, whole, in its place, with the focus in it,
// while it is the newest thing done to the answer, whatever typing the field
// holds from before it; after an edit the press is the browser's. A notice
// over the box offers its removal back for a few seconds, edited since or not. All names are
// invented.

useInboxPage();

const LONG = 'The old order breaks scripts nobody could predict, so keep it.';

const VIEW = {
  ...VIEW_A,
  awaitingOperator: [
    { ...asked(1, 'First', 2), body: LONG, bodyHtml: `<p>${LONG}</p>` },
    asked(3, 'Third', 9),
  ],
};

const MACROS = {
  macros: [
    {
      name: 'agenda',
      description: 'Add an item to someone’s agenda',
      instruction: 'Add the item to the named person’s agenda.',
      params: [
        { name: 'person', type: 'enum', options: ['Mira', 'Tobin'] },
        { name: 'item', type: 'text' },
      ],
    },
    {
      name: 'park',
      description: 'Park this thread',
      instruction: 'Stop work on this thread until asked.',
      params: [],
    },
  ],
};

const active = () => document.activeElement as HTMLElement | null;
const menu = () => document.querySelector<HTMLElement>('#macro-menu');
const macroCards = () =>
  [...document.querySelectorAll<HTMLElement>('[data-macro-card]')].filter(
    (c) => c.dataset.commentCard === undefined,
  );
const card = (name: string) =>
  macroCards().find((c) => c.getAttribute('aria-label') === `/${name}`);
const commentCards = () => [
  ...document.querySelectorAll<HTMLElement>('[data-comment-card]'),
];
const fieldOf = (n: number) =>
  screen.getByRole('textbox', { name: `Comment ${n}` }) as HTMLTextAreaElement;
const notice = () => document.querySelector<HTMLElement>('[data-undo-notice]');

/** ⌘Z on `target`; true when the page took it from the browser. */
const undo = (
  target: Element = active() ?? document.body,
  init: KeyboardEventInit = { metaKey: true },
): boolean => {
  let free = true;
  act(() => {
    free = fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', ...init });
  });
  return !free;
};

const removeByKey = (target: Element) =>
  press({ key: 'Backspace', code: 'Backspace', metaKey: true }, target);

const typeBox = (text: string) => {
  const el = box();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
};

const invoke = async (name: string) => {
  typeBox(`/${name}`);
  await waitFor(() => expect(menu()).not.toBeNull());
  press({ key: 'Enter', code: 'Enter' }, box());
  await waitFor(() => expect(card(name)).toBeDefined());
};

const page = async () => {
  serve.board = board([VIEW, VIEW_B]);
  serve.macros = JSON.stringify(MACROS);
  await mounted(`/inbox/${A}`);
  typeBox('/');
  await waitFor(() => expect(menu()).not.toBeNull());
  typeBox('');
  await settle();
};

const bodyOf = (key: string): HTMLElement =>
  document.querySelector(
    `[data-commentable="${key}"] [data-question-body]`,
  ) as HTMLElement;

const comment = async (text: string, written: string) => {
  const key = litKey() as string;
  const walker = document.createTreeWalker(bodyOf(key), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = n.textContent?.indexOf(text) ?? -1;
    if (at === -1) continue;
    act(() => {
      document.getSelection()?.setBaseAndExtent(n, at, n, at + text.length);
      document.dispatchEvent(new Event('selectionchange'));
    });
    break;
  }
  const before = commentCards().length;
  act(() => box().blur());
  press({ key: 'c', code: 'KeyC' }, document.body);
  await waitFor(() => expect(commentCards()).toHaveLength(before + 1));
  const field = active() as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: written } });
};

// happy-dom lays nothing out, so each span is given one line to sit on.
const laidOut = () =>
  vi
    .spyOn(Range.prototype, 'getClientRects')
    .mockImplementation(
      () => [new DOMRect(40, 100, 120, 18)] as unknown as DOMRectList,
    );

describe('undoing a removed comment', () => {
  it('⌘Z brings it back whole, its highlight drawn again and its field focused', async () => {
    laidOut();
    await page();
    await comment('nobody could predict', 'Say which scripts.');
    const highlights = () =>
      document.querySelectorAll('[data-comment-highlight]').length;
    expect(highlights()).toBeGreaterThan(0);
    removeByKey(fieldOf(1));
    await waitFor(() => expect(commentCards()).toHaveLength(0));
    expect(highlights()).toBe(0);
    await waitFor(() => expect(active()).toBe(box()));
    expect(undo()).toBe(true);
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    expect(fieldOf(1).value).toBe('Say which scripts.');
    expect(commentCards()[0]?.textContent).toContain('“nobody could predict”');
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    expect(highlights()).toBeGreaterThan(0);
    // The answer carries it as if it had never gone.
    press({ key: 'Enter', code: 'Enter', ctrlKey: true }, fieldOf(1));
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      comments: [
        {
          quote: 'nobody could predict',
          at: { part: 0, start: 29, end: 49 },
          text: 'Say which scripts.',
        },
      ],
    });
  });

  it('a comment removed from the body’s menu comes back by the notice', async () => {
    await page();
    await comment('old order', 'One.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment 1' }));
    await waitFor(() => expect(commentCards()).toHaveLength(0));
    await waitFor(() => expect(notice()).not.toBeNull());
    expect(notice()?.textContent).toContain('Comment removed');
    // Its keys, after Undo, are a hint a touch-only device never shows.
    const undoKeys = notice()?.lastElementChild;
    expect(undoKeys?.textContent).not.toBe('');
    expect(undoKeys?.classList).toContain('touch-only:hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    expect(fieldOf(1).value).toBe('One.');
    await waitFor(() => expect(notice()).toBeNull());
  });

  it('Esc on a comment never written is no removal to undo', async () => {
    await page();
    await comment('old order', '');
    press({ key: 'Escape', code: 'Escape' }, fieldOf(1));
    await waitFor(() => expect(commentCards()).toHaveLength(0));
    expect(notice()).toBeNull();
    expect(undo(box())).toBe(false);
    expect(commentCards()).toHaveLength(0);
  });
});

describe('undoing a removed macro card', () => {
  it('brings it back in its place, its values kept, its first field focused', async () => {
    await page();
    await invoke('agenda');
    fireEvent.click(screen.getByRole('radio', { name: 'Tobin' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'item' }), {
      target: { value: 'Opening date' },
    });
    await invoke('park');
    fireEvent.click(screen.getByRole('button', { name: 'Remove /agenda' }));
    await waitFor(() => expect(card('agenda')).toBeUndefined());
    await waitFor(() =>
      expect(notice()?.textContent).toContain('Macro removed'),
    );
    expect(undo(card('park') ?? box(), { ctrlKey: true })).toBe(true);
    await waitFor(() =>
      expect(macroCards().map((c) => c.getAttribute('aria-label'))).toEqual([
        '/agenda',
        '/park',
      ]),
    );
    expect(
      screen.getByRole('radio', { name: 'Tobin' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      (screen.getByRole('textbox', { name: 'item' }) as HTMLInputElement).value,
    ).toBe('Opening date');
    await waitFor(() => expect(card('agenda')?.contains(active())).toBe(true));
    await waitFor(() => expect(notice()).toBeNull());
  });
});

describe('the undo stack', () => {
  it('repeated presses bring back earlier removals in reverse order', async () => {
    await page();
    await comment('old order', 'One.');
    await invoke('park');
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(card('park')).toBeUndefined());
    removeByKey(fieldOf(1));
    await waitFor(() => expect(commentCards()).toHaveLength(0));
    expect(undo()).toBe(true);
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    expect(card('park')).toBeUndefined();
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    expect(undo()).toBe(true);
    await waitFor(() => expect(card('park')).toBeDefined());
    // Nothing left: the press is the browser's.
    expect(undo()).toBe(false);
  });

  it('takes ⌘Z for a removal even though the answer field has earlier typing', async () => {
    await page();
    typeBox('Some earlier typing.');
    await invoke('park');
    typeBox('Some earlier typing.');
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(card('park')).toBeUndefined());
    // The focus lands in the box, which holds its typing from before.
    await waitFor(() => expect(active()).toBe(box()));
    expect(undo(box())).toBe(true);
    await waitFor(() => expect(card('park')).toBeDefined());
    expect(box().value).toBe('Some earlier typing.');
  });

  it('leaves ⌘Z to the field once something is typed after the removal', async () => {
    await page();
    await invoke('park');
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(card('park')).toBeUndefined());
    await waitFor(() => expect(notice()).not.toBeNull());
    typeBox('Never mind.');
    // The typing is the newest: ⌘Z is the text's own undo.
    expect(undo(box())).toBe(false);
    await settle();
    expect(card('park')).toBeUndefined();
    // The field's undo takes the text back to where the removal left it, and
    // the removal is the newest again.
    typeBox('');
    expect(undo(box())).toBe(true);
    await waitFor(() => expect(card('park')).toBeDefined());
  });

  it('the notice still brings its card back after typing, while it shows', async () => {
    await page();
    await invoke('park');
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(notice()).not.toBeNull());
    typeBox('Never mind.');
    await settle();
    expect(notice()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(card('park')).toBeDefined());
    expect(box().value).toBe('Never mind.');
    await waitFor(() => expect(notice()).toBeNull());
  });

  it('belongs to one Question, and is gone once its answer is sent', async () => {
    await page();
    const first = litKey();
    await invoke('park');
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(card('park')).toBeUndefined());
    // On the next Question there is nothing to bring back.
    press({ key: ']', code: 'BracketRight', ctrlKey: true });
    await waitFor(() => expect(litKey()).not.toBe(first));
    expect(undo(box())).toBe(false);
    // Back on the first, its removal is still there to undo.
    press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    await waitFor(() => expect(litKey()).toBe(first));
    expect(undo(box())).toBe(true);
    await waitFor(() => expect(card('park')).toBeDefined());
    // Remove it again and send: what was removed went with the draft.
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(card('park')).toBeUndefined());
    typeBox('Done.');
    press({ key: 'Enter', code: 'Enter', ctrlKey: true }, box());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).not.toHaveProperty('macros');
  });

  it('another field keeps ⌘Z', async () => {
    await page();
    await invoke('park');
    removeByKey(card('park') as HTMLElement);
    await waitFor(() => expect(card('park')).toBeUndefined());
    const other = document.createElement('input');
    document.body.append(other);
    expect(undo(other)).toBe(false);
    other.remove();
    expect(card('park')).toBeUndefined();
  });
});

describe('the help sheet', () => {
  it('lists the undo keys with the keymap’s actions and in its Macros section', async () => {
    await page();
    press({ key: ' ', code: 'Space', ctrlKey: true });
    press({ key: '?', code: 'Slash', shiftKey: true });
    const sheet = await screen.findByTestId('keymap-help');
    expect(sheet.textContent).toContain(
      'Bring back the comment or macro card last removed from the answer',
    );
    expect(sheet.textContent).toContain(
      'Bring back the card last removed, while nothing is typed since',
    );
  });
});
