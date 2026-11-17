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

// Comments on a Question's text: select a span of the body, press `c` (or
// ⌘⌥M, the floating button, the context menu), and a card for it joins the
// stack under the answer box, ahead of the macros, its field focused. The
// written ones ride on the answer in body order. All names are invented.

useInboxPage();

afterEach(() => {
  vi.restoreAllMocks();
});

const LONG = 'The old order breaks scripts nobody could predict, so keep it.';

const VIEW = {
  ...VIEW_A,
  awaitingOperator: [
    {
      ...asked(1, 'First', 2),
      body: LONG,
      bodyHtml: `<p>${LONG}</p>`,
    },
    asked(3, 'Third', 9),
  ],
};

const withBody = async () => {
  serve.board = board([VIEW, VIEW_B]);
  await mounted(`/inbox/${A}`);
  // The page's first reads settle before a selection is made in it.
  await settle();
};

const bodyOf = (key: string): HTMLElement =>
  document.querySelector(
    `[data-commentable="${key}"] [data-question-body]`,
  ) as HTMLElement;

/** Selects `text` in the body of `key`, as a drag would, and says so. */
const select = (key: string, text: string): void => {
  const walker = document.createTreeWalker(bodyOf(key), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = n.textContent?.indexOf(text) ?? -1;
    if (at === -1) continue;
    act(() => {
      document.getSelection()?.setBaseAndExtent(n, at, n, at + text.length);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(document.getSelection()?.toString()).toBe(text);
    return;
  }
  throw new Error(`no “${text}” in ${key}`);
};

const commentCards = () => [
  ...document.querySelectorAll<HTMLElement>('[data-comment-card]'),
];
const fieldOf = (n: number) =>
  screen.getByRole('textbox', { name: `Comment ${n}` }) as HTMLTextAreaElement;
const active = () => document.activeElement as HTMLElement | null;

/** `c` with the focus on the page, as after a drag in the body. */
const pressC = () => {
  act(() => box().blur());
  press({ key: 'c', code: 'KeyC' }, document.body);
};

const write = (n: number, text: string) =>
  fireEvent.change(fieldOf(n), { target: { value: text } });

const send = (target: Element = box()) =>
  press({ key: 'Enter', code: 'Enter', ctrlKey: true }, target);

describe('making a comment', () => {
  it('c on a selection makes a card, its field focused, and the answer carries it', async () => {
    await withBody();
    const key = litKey() as string;
    select(key, 'nobody could predict');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    expect(commentCards()[0]?.textContent).toContain('“nobody could predict”');
    // The selection is let go, so the highlight shows in its place.
    expect(document.getSelection()?.toString()).toBe('');
    write(1, 'Say which scripts.');
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
          text: 'Say which scripts.',
        },
      ],
    });
    // A send that lands clears them.
    await waitFor(() => expect(commentCards()).toHaveLength(0));
  });

  it('c typed in a field is typing, and makes no comment', async () => {
    await withBody();
    select(litKey() as string, 'old order');
    press({ key: 'c', code: 'KeyC' }, box());
    await settle();
    expect(commentCards()).toHaveLength(0);
  });

  it('⌘⌥M comments from the answer box', async () => {
    await withBody();
    select(litKey() as string, 'old order');
    press({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }, box());
    await waitFor(() => expect(commentCards()).toHaveLength(1));
  });

  it('c on a Question not lit yet lights it, and its card still takes the focus', async () => {
    await withBody();
    expect(litKey()).toBe(`${A}/1`);
    select(`${A}/3`, 'Third');
    pressC();
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    // So what is typed next is the comment, never the answer.
    expect(box().value).toBe('');
  });

  it('the same span asked for twice is the one comment', async () => {
    await withBody();
    const key = litKey() as string;
    select(key, 'old order');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    select(key, 'old order');
    pressC();
    await settle();
    expect(commentCards()).toHaveLength(1);
  });

  it('numbers and sends them in body order, whatever order they were made in', async () => {
    await withBody();
    const key = litKey() as string;
    select(key, 'keep it');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    write(1, 'Yes.');
    select(key, 'old order');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(2));
    // The new one is first in the body, so it is 1, and the focus is its.
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    expect(fieldOf(2).value).toBe('Yes.');
    write(1, 'Which order?');
    send(fieldOf(1));
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    const body = serve.posts[0]?.body as {
      readonly response: string;
      readonly comments: ReadonlyArray<{ readonly quote: string }>;
    };
    // Comments alone are an answer.
    expect(body.response).toBe('');
    expect(body.comments.map((c) => c.quote)).toEqual(['old order', 'keep it']);
  });

  it('an unwritten comment is not sent, and alone is no answer', async () => {
    await withBody();
    select(litKey() as string, 'old order');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty(
      'disabled',
      true,
    );
    write(1, 'Keep it.');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
  });

  it('a deferral carries the comments too', async () => {
    await withBody();
    select(litKey() as string, 'old order');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    write(1, 'Keep it.');
    press(
      { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true },
      fieldOf(1),
    );
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      deferred: true,
      comments: [{ quote: 'old order', text: 'Keep it.' }],
    });
  });
});

describe('a comment card', () => {
  const twoComments = async () => {
    await withBody();
    const key = litKey() as string;
    select(key, 'old order');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    write(1, 'One.');
    select(key, 'keep it');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(2));
    await waitFor(() => expect(active()).toBe(fieldOf(2)));
    write(2, 'Two.');
  };

  it('↩ goes back to the answer’s text, and ⇧↩ is a new line', async () => {
    await twoComments();
    press({ key: 'Enter', code: 'Enter', shiftKey: true }, fieldOf(2));
    expect(active()).toBe(fieldOf(2));
    press({ key: 'Enter', code: 'Enter' }, fieldOf(2));
    await waitFor(() => expect(active()).toBe(box()));
  });

  it('Esc on a comment never written removes it; on a written one only leaves it', async () => {
    await twoComments();
    press({ key: 'Escape', code: 'Escape' }, fieldOf(2));
    await waitFor(() => expect(active()).toBe(box()));
    expect(commentCards()).toHaveLength(2);
    select(litKey() as string, 'scripts');
    pressC();
    await waitFor(() => expect(commentCards()).toHaveLength(3));
    await waitFor(() => expect(active()).toBe(fieldOf(2)));
    press({ key: 'Escape', code: 'Escape' }, fieldOf(2));
    await waitFor(() => expect(commentCards()).toHaveLength(2));
    expect(active()).toBe(box());
  });

  it('⌘⌫ removes it; the focus goes to the next card, else the one above, else the text', async () => {
    await twoComments();
    act(() => fieldOf(1).focus());
    press({ key: 'Backspace', code: 'Backspace', metaKey: true }, fieldOf(1));
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    // What was 2 is 1 now, and has the focus.
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    expect(fieldOf(1).value).toBe('Two.');
    press({ key: 'Backspace', code: 'Backspace', metaKey: true }, fieldOf(1));
    await waitFor(() => expect(commentCards()).toHaveLength(0));
    await waitFor(() => expect(active()).toBe(box()));
  });

  it('Tab from the text goes to the first comment', async () => {
    await twoComments();
    act(() => box().focus());
    press({ key: 'Tab', code: 'Tab' }, box());
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
  });
});

describe('the floating button and the menu', () => {
  // happy-dom lays nothing out, so the span is given one line to sit on.
  const laidOut = () =>
    vi
      .spyOn(Range.prototype, 'getClientRects')
      .mockImplementation(
        () => [new DOMRect(40, 100, 120, 18)] as unknown as DOMRectList,
      );

  it('shows above a selection, keeps it on a press, and comments on a click', async () => {
    laidOut();
    await withBody();
    select(litKey() as string, 'old order');
    const button = await screen.findByRole('button', {
      name: 'Comment on the selection',
    });
    // Its keys come from the keymap.
    expect(button.getAttribute('aria-keyshortcuts')).toContain('C');
    // Its keys are a hint a touch-only device never shows.
    const keys = button.lastElementChild;
    expect(keys?.textContent).not.toBe('Comment');
    expect(keys?.classList).toContain('touch-only:hidden');
    // A press is cancelled, so the selection it is about stays.
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
    // The selection went, and the button with it.
    expect(
      screen.queryByRole('button', { name: 'Comment on the selection' }),
    ).toBeNull();
    // The highlight is drawn, numbered.
    expect(
      document.querySelectorAll('[data-comment-highlight]').length,
    ).toBeGreaterThan(0);
  });

  it('right-click on a selection offers Comment, which acts once the menu has shut', async () => {
    laidOut();
    await withBody();
    const key = litKey() as string;
    select(key, 'old order');
    const trigger = document.querySelector(
      `[data-commentable="${key}"]`,
    ) as HTMLElement;
    fireEvent.contextMenu(trigger, { clientX: 50, clientY: 50 });
    const item = await screen.findByRole('menuitem', { name: /^Comment/ });
    expect(item.lastElementChild?.classList).toContain('touch-only:hidden');
    fireEvent.click(item);
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    await waitFor(() => expect(active()).toBe(fieldOf(1)));
  });
});

describe('a word or a paragraph picked by clicking', () => {
  // The ranges a browser makes, as measured in Chromium and WebKit: a
  // double-click selects the word's text; a triple-click selects a paragraph
  // from its text's start to the start of whatever follows it, which after a
  // body's last paragraph is outside the body (the highlights' layer).
  const PARAS = ['The first paragraph.', 'The second, in the middle.', 'Last.'];
  const PARTS = ['Words of the first part.', 'Words of the second part.'];
  const ONE = `${A}/1`;
  const PARTED = `${A}/3`;

  const withParagraphs = async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          {
            ...asked(1, 'First', 2),
            body: PARAS.join('\n\n'),
            bodyHtml: PARAS.map((p) => `<p>${p}</p>`).join('\n'),
          },
          {
            ...asked(3, 'Third', 9),
            bodyParts: PARTS.map((p) => ({
              kind: 'html',
              html: `<p>${p}</p>`,
            })),
          },
        ],
      },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}`);
    await settle();
  };

  const laidOut = () =>
    vi
      .spyOn(Range.prototype, 'getClientRects')
      .mockImplementation(
        () => [new DOMRect(40, 100, 120, 18)] as unknown as DOMRectList,
      );

  const wrapperOf = (key: string) =>
    document.querySelector(`[data-commentable="${key}"]`) as HTMLElement;
  const partsOf = (key: string) => [
    ...wrapperOf(key).querySelectorAll<HTMLElement>('[data-question-body]'),
  ];
  const parasOf = (key: string) => [
    ...wrapperOf(key).querySelectorAll<HTMLElement>('[data-question-body] p'),
  ];
  const textOf = (el: Element | undefined): Text => el?.firstChild as Text;
  // What follows a body's last part inside its frame: the highlights' layer.
  const pastBody = (key: string): Element =>
    partsOf(key).at(-1)?.closest('[data-readout-body]')
      ?.nextElementSibling as Element;

  const selectRange = (
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ) =>
    act(() => {
      document
        .getSelection()
        ?.setBaseAndExtent(start, startOffset, end, endOffset);
      document.dispatchEvent(new Event('selectionchange'));
    });

  const button = () =>
    screen.queryByRole('button', { name: 'Comment on the selection' });

  /** Comments on the selection with the button, and gives its card's text. */
  const quoted = async (): Promise<string> => {
    fireEvent.click(
      await screen.findByRole('button', { name: 'Comment on the selection' }),
    );
    await waitFor(() => expect(commentCards()).toHaveLength(1));
    return commentCards()[0]?.textContent ?? '';
  };

  it('a double-clicked word: the range lies in its text', async () => {
    laidOut();
    await withParagraphs();
    const t = textOf(parasOf(ONE)[1]);
    selectRange(t, 4, t, 10);
    expect(await quoted()).toContain('“second”');
  });

  it('a triple-clicked paragraph that ends at the start of the next', async () => {
    laidOut();
    await withParagraphs();
    const [, middle, last] = parasOf(ONE);
    selectRange(textOf(middle), 0, last as HTMLElement, 0);
    expect(await quoted()).toContain(`“${PARAS[1]}”`);
  });

  it('a triple-clicked last paragraph, which ends past the body, quotes the paragraph exactly', async () => {
    laidOut();
    await withParagraphs();
    const after = pastBody(ONE);
    expect(after.getAttribute('aria-hidden')).toBe('true');
    selectRange(textOf(parasOf(ONE).at(-1)), 0, after, 0);
    const text = partsOf(ONE)[0]?.textContent ?? '';
    const start = text.indexOf('Last.');
    expect(await quoted()).toContain('“Last.”');
    write(1, 'Why?');
    fireEvent.change(box(), { target: { value: 'Fine.' } });
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      comments: [
        {
          quote: 'Last.',
          suffix: '',
          at: { part: 0, start, end: start + 'Last.'.length },
        },
      ],
    });
  });

  it('a paragraph that ends at its own element, after its last child', async () => {
    laidOut();
    await withParagraphs();
    const last = parasOf(ONE).at(-1) as HTMLElement;
    selectRange(textOf(last), 0, last, last.childNodes.length);
    expect(await quoted()).toContain('“Last.”');
  });

  it('a paragraph that starts at the end of the one before it', async () => {
    laidOut();
    await withParagraphs();
    const [first, middle] = parasOf(ONE);
    const t = textOf(middle);
    selectRange(first as HTMLElement, 1, t, t.length);
    expect(await quoted()).toContain(`“${PARAS[1]}”`);
  });

  it('right-click on a triple-clicked last paragraph offers Comment', async () => {
    laidOut();
    await withParagraphs();
    selectRange(textOf(parasOf(ONE).at(-1)), 0, pastBody(ONE), 0);
    fireEvent.contextMenu(wrapperOf(ONE), { clientX: 50, clientY: 50 });
    expect(
      await screen.findByRole('menuitem', { name: /^Comment/ }),
    ).toBeTruthy();
  });

  it('a part’s triple-clicked paragraph that ends in the next part', async () => {
    laidOut();
    await withParagraphs();
    const [first, second] = partsOf(PARTED);
    selectRange(
      textOf(first?.querySelector('p') ?? undefined),
      0,
      second as HTMLElement,
      0,
    );
    expect(await quoted()).toContain(`“${PARTS[0]}”`);
  });

  it('a span whose words reach into two parts is still none', async () => {
    laidOut();
    await withParagraphs();
    const [first, second] = partsOf(PARTED);
    selectRange(
      textOf(first?.querySelector('p') ?? undefined),
      6,
      textOf(second?.querySelector('p') ?? undefined),
      5,
    );
    await settle();
    expect(document.getSelection()?.toString()).not.toBe('');
    expect(button()).toBeNull();
  });
});

describe('an answered Question', () => {
  it('shows the comments its answer carried, numbered, under the answer', async () => {
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
                text: 'Short.',
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
      expect(document.querySelector('[data-sent-comments]')?.textContent).toBe(
        '❝ 1“Body of” Short.',
      ),
    );
    // It takes no new comments.
    expect(document.querySelector('[data-commentable]')).toBeNull();
  });
});
