import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A,
  answered,
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

// Macros in a comment: `/` at a word's start in a comment's field opens the
// answer box's macro menu (every macro, no `/attach`), each pick is a macro
// card nested under the comment's field, and the answer carries each with its
// instruction on that comment. A comment of macros alone, no words, is sent.
// Their required fields join the held send; × and ⌘⌫ remove them, and ⌘Z
// brings them back. All names are invented.

useInboxPage();

afterEach(() => {
  vi.restoreAllMocks();
});

const MACROS = {
  macros: [
    {
      name: 'show-me',
      description: 'Show me what it looks like',
      instruction: 'Show the operator what this looks like.',
      params: [
        { name: 'focus', type: 'text' },
        { name: 'depth', type: 'number', required: false },
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

const LONG = 'The old order breaks scripts nobody could predict, so keep it.';

const VIEW = {
  ...VIEW_A,
  awaitingOperator: [
    { ...asked(1, 'First', 2), body: LONG, bodyHtml: `<p>${LONG}</p>` },
    asked(3, 'Third', 9),
  ],
};

const answerMenu = () => document.querySelector<HTMLElement>('#macro-menu');
const commentMenu = (n = 1) =>
  document.querySelector<HTMLElement>(`#comment-${n}-macro-menu`);
const commentCards = () => [
  ...document.querySelectorAll<HTMLElement>('[data-comment-card]'),
];
const nested = (comment = 1) => [
  ...document.querySelectorAll<HTMLElement>(
    `[data-comment-macros="${comment}"] [data-macro-card]`,
  ),
];
const fieldOf = (n: number) =>
  screen.getByRole('textbox', { name: `Comment ${n}` }) as HTMLTextAreaElement;
const active = () => document.activeElement as HTMLElement | null;

const typeBox = (text: string) => {
  const el = box();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
};

/** Types into comment `n`'s field as a person does: the caret at its end. */
const typeComment = (text: string, n = 1) => {
  const el = fieldOf(n);
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
};

const send = (target: Element = box()) =>
  press({ key: 'Enter', code: 'Enter', ctrlKey: true }, target);

const undo = (target: Element = active() ?? document.body): boolean => {
  let free = true;
  act(() => {
    free = fireEvent.keyDown(target, {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
    });
  });
  return !free;
};

const bodyOf = (key: string): HTMLElement =>
  document.querySelector(
    `[data-commentable="${key}"] [data-question-body]`,
  ) as HTMLElement;

const select = (key: string, text: string): void => {
  const walker = document.createTreeWalker(bodyOf(key), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = n.textContent?.indexOf(text) ?? -1;
    if (at === -1) continue;
    act(() => {
      document.getSelection()?.setBaseAndExtent(n, at, n, at + text.length);
      document.dispatchEvent(new Event('selectionchange'));
    });
    return;
  }
  throw new Error(`no “${text}” in ${key}`);
};

/** A page with the macros read, and one comment on `quote`, its field focused. */
const commented = async (quote = 'nobody could predict') => {
  serve.board = board([VIEW, VIEW_B]);
  serve.macros = JSON.stringify(MACROS);
  await mounted(`/inbox/${A}`);
  typeBox('/');
  await waitFor(() => expect(answerMenu()).not.toBeNull());
  typeBox('');
  await settle();
  select(litKey() as string, quote);
  act(() => box().blur());
  press({ key: 'c', code: 'KeyC' }, document.body);
  await waitFor(() => expect(commentCards()).toHaveLength(1));
  await waitFor(() => expect(active()).toBe(fieldOf(1)));
};

/** `/name` and Enter in comment 1's field: its card, nested under it. */
const invokeOnComment = async (name: string, before = '') => {
  typeComment(`${before}/${name}`);
  await waitFor(() => expect(commentMenu()).not.toBeNull());
  press({ key: 'Enter', code: 'Enter' }, fieldOf(1));
  await waitFor(() =>
    expect(
      nested().some((c) => c.getAttribute('aria-label') === `/${name}`),
    ).toBe(true),
  );
};

describe('the macro menu in a comment', () => {
  it('opens on / at a word’s start with every macro and no /attach, and not mid-word', async () => {
    await commented();
    typeComment('and/or');
    await settle();
    expect(commentMenu()).toBeNull();
    typeComment('Look /');
    await waitFor(() => expect(commentMenu()).not.toBeNull());
    expect(
      [...(commentMenu()?.querySelectorAll('[role="option"]') ?? [])].map(
        (o) => o.querySelector('span')?.textContent,
      ),
    ).toEqual(['/show-me', '/park']);
    // The answer box's own menu stays shut.
    expect(answerMenu()).toBeNull();
    press({ key: 'Escape', code: 'Escape' }, fieldOf(1));
    await waitFor(() => expect(commentMenu()).toBeNull());
    // Esc shut the menu, and left the focus in the comment.
    expect(active()).toBe(fieldOf(1));
  });

  it('a pick is a card nested under the comment, its first field focused, and the answer carries it on the comment', async () => {
    await commented();
    await invokeOnComment('show-me', 'Why this? ');
    // The `/show-me` left the comment's words.
    expect(fieldOf(1).value).toBe('Why this? ');
    expect(commentMenu()).toBeNull();
    // Nested inside the comment's own card, after its field.
    const card = nested()[0] as HTMLElement;
    expect(commentCards()[0]?.contains(card)).toBe(true);
    expect(
      fieldOf(1).compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('focus'),
    );
    // Tab from the comment's field reaches it: its field is a plain stop.
    expect(active()?.tabIndex).toBe(0);
    fireEvent.change(active() as HTMLElement, {
      target: { value: 'the edge case' },
    });
    fireEvent.change(box(), { target: { value: 'Ship it.' } });
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toEqual({
      response: 'Ship it.',
      seenRevision: 1,
      comments: [
        {
          quote: 'nobody could predict',
          prefix: 'The old order breaks scripts ',
          suffix: ', so keep it.',
          at: { part: 0, start: 29, end: 49 },
          text: 'Why this?',
          macros: [
            {
              macro: 'show-me',
              instruction: 'Show the operator what this looks like.',
              args: { focus: 'the edge case', depth: null },
            },
          ],
        },
      ],
    });
    await waitFor(() => expect(commentCards()).toHaveLength(0));
  });

  it('a comment of macros alone, no words, is sent, and is a whole answer', async () => {
    await commented();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty(
      'disabled',
      true,
    );
    await invokeOnComment('park');
    expect(fieldOf(1).value).toBe('');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    // Esc on it now leaves it: it has a macro.
    press({ key: 'Escape', code: 'Escape' }, fieldOf(1));
    await waitFor(() => expect(active()).toBe(box()));
    expect(commentCards()).toHaveLength(1);
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      response: '',
      comments: [
        {
          quote: 'nobody could predict',
          text: '',
          macros: [{ macro: 'park', args: {} }],
        },
      ],
    });
  });

  it('a comment can carry several, in the order picked', async () => {
    await commented();
    await invokeOnComment('park');
    act(() => fieldOf(1).focus());
    await invokeOnComment('show-me');
    expect(nested().map((c) => c.getAttribute('aria-label'))).toEqual([
      '/park',
      '/show-me',
    ]);
  });
});

describe('a comment’s macro cards', () => {
  it('hold the send on an empty required field, then send it as null', async () => {
    await commented();
    await invokeOnComment('show-me', 'Look. ');
    act(() => box().focus());
    send();
    await settle();
    expect(serve.posts).toHaveLength(0);
    const held = nested()[0];
    expect(held?.dataset.macroHeld).toBe('true');
    expect(held?.querySelector('output')?.textContent).toContain('needs focus');
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('focus'),
    );
    send(active() ?? box());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      comments: [
        {
          text: 'Look.',
          macros: [{ macro: 'show-me', args: { focus: null, depth: null } }],
        },
      ],
    });
  });

  it('⌘⌫ removes one, the focus back in the comment, and ⌘Z brings it back', async () => {
    await commented();
    await invokeOnComment('show-me', 'Look. ');
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('focus'),
    );
    fireEvent.change(active() as HTMLElement, { target: { value: 'edges' } });
    press(
      { key: 'Backspace', code: 'Backspace', metaKey: true },
      active() as HTMLElement,
    );
    await waitFor(() => expect(nested()).toHaveLength(0));
    // The comment stays, its words with it, and takes the focus.
    expect(commentCards()).toHaveLength(1);
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    expect(undo()).toBe(true);
    await waitFor(() => expect(nested()).toHaveLength(1));
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('focus'),
    );
    expect((active() as HTMLTextAreaElement).value).toBe('edges');
  });

  it('× removes one too, and the whole comment goes and comes back with its macros', async () => {
    await commented();
    await invokeOnComment('park');
    await invokeOnComment('show-me');
    fireEvent.click(screen.getByRole('button', { name: 'Remove /park' }));
    await waitFor(() =>
      expect(nested().map((c) => c.getAttribute('aria-label'))).toEqual([
        '/show-me',
      ]),
    );
    // The comment's own ⌘⌫ takes it and its macros, and ⌘Z restores both.
    act(() => fieldOf(1).focus());
    press({ key: 'Backspace', code: 'Backspace', metaKey: true }, fieldOf(1));
    await waitFor(() => expect(commentCards()).toHaveLength(0));
    expect(undo()).toBe(true);
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    expect(nested().map((c) => c.getAttribute('aria-label'))).toEqual([
      '/show-me',
    ]);
  });
});

describe('an answered Question’s comments', () => {
  it('show the macros each carried, under its words', async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingAgent: [
          {
            ...answered(2, 'Second', 12, 'Yes.'),
            comments: [
              {
                quote: 'Body of',
                prefix: '',
                suffix: ' Second',
                at: { part: 0, start: 0, end: 7 },
                text: '',
                macros: [
                  {
                    macro: 'park',
                    instruction: 'Stop work on this thread until asked.',
                    args: {},
                  },
                ],
              },
            ],
          },
        ],
      },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}`);
    fireEvent.click(screen.getByRole('tab', { name: /With the agent/ }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-sent-comments] [data-sent-macros]')
          ?.textContent,
      ).toBe('/park'),
    );
  });
});
