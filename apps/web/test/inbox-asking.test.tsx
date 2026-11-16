import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { json } from './fixture';
import {
  A,
  answered,
  B,
  BOARD,
  BOARD_WITH_ARCHIVED,
  board,
  box,
  footNote,
  lit,
  litKey,
  mount,
  mounted,
  note,
  onQueue,
  openRail,
  prefix,
  press,
  queueTab,
  reread,
  send,
  serve,
  settle,
  stubClipboard,
  summary,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  type WireView,
} from './inbox-page-harness';

// The operator can post a question to an Inbox for its agent. The page's own
// box takes it: it asks which Inbox unless
// one is selected, and the list stands where the question would be.

useInboxPage();

const plus = () => screen.getByRole('button', { name: 'Ask the agent' });

const asking = () => screen.queryByRole('heading', { name: 'Ask the agent' });

const options = () =>
  within(asking()?.parentElement as HTMLElement)
    .queryAllByRole('option')
    .map((b) => b.textContent);

const cursor = () =>
  document.querySelector('[data-zen-choice]')?.textContent ?? undefined;

const isShut = () => waitFor(() => expect(asking()).toBeNull());

describe('asking the agent', () => {
  it('opens on the +, with the open inboxes listed and the filter behind Change', async () => {
    serve.board = BOARD_WITH_ARCHIVED;
    await mounted('/inbox');
    fireEvent.click(plus());
    await waitFor(() => expect(asking()).not.toBeNull());
    // The archived inbox (kiln) is not offered.
    expect(options()).toEqual(['orchard', 'quarry']);
    // The lit question's inbox is the default, and the box takes the question.
    await screen.findByText(/In orchard/);
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(cursor()).toBe('orchard');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() =>
      expect(box().getAttribute('placeholder')).toBe('Which inbox?'),
    );
    expect(cursor()).toBe('orchard');
    type('quar');
    await waitFor(() => expect(options()).toEqual(['quarry']));
    type('nothing like it');
    await screen.findByText('No inbox matches.');
  });

  it('picks an inbox with ↓ and Enter, goes back, and Esc closes', async () => {
    await mounted('/inbox');
    fireEvent.click(plus());
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await waitFor(() => expect(cursor()).toBe('orchard'));
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    await waitFor(() => expect(cursor()).toBe('quarry'));
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText(/In quarry/);
    await waitFor(() =>
      expect(box().getAttribute('placeholder')).toBe(
        'What do you want to ask?',
      ),
    );
    await waitFor(() => expect(document.activeElement).toBe(box()));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() =>
      expect(box().getAttribute('placeholder')).toBe('Which inbox?'),
    );
    fireEvent.keyDown(box(), { key: 'Escape' });
    await isShut();
    expect(litKey()).toBe(`${A}/1`);
  });

  // A regression: the list stayed on the page once an Inbox was chosen, and
  // every row of it was dead, so no other Inbox could be picked.
  it('moves the ask to a row clicked while writing, keeping the caret and the text', async () => {
    serve.post = () => json(VIEW_B);
    await mounted();
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await screen.findByText(/In orchard/);
    await waitFor(() => expect(cursor()).toBe('orchard'));
    type('Why the cache?');
    const row = () => screen.getByRole('option', { name: 'quarry' });
    // A press on a row leaves the caret in the box.
    expect(fireEvent.mouseDown(row())).toBe(false);
    fireEvent.click(row());
    await screen.findByText(/In quarry/);
    await waitFor(() => expect(cursor()).toBe('quarry'));
    await waitFor(() => expect(box().value).toBe('Why the cache?'));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    press({ key: 'Enter', code: 'Enter', metaKey: true });
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.path).toBe(`/api/inbox/${B}/questions`);
  });

  it('lights the row the ask is going to, once picked', async () => {
    await mounted('/inbox');
    fireEvent.click(plus());
    await waitFor(() => expect(cursor()).toBe('orchard'));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() =>
      expect(box().getAttribute('placeholder')).toBe('Which inbox?'),
    );
    fireEvent.click(screen.getByRole('option', { name: 'quarry' }));
    await screen.findByText(/In quarry/);
    await waitFor(() => expect(cursor()).toBe('quarry'));
  });

  it('keeps both drafts when the box moves to an inbox holding one', async () => {
    await mounted();
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await screen.findByText(/In orchard/);
    type('Held there');
    fireEvent.click(screen.getByRole('option', { name: 'quarry' }));
    await screen.findByText(/In quarry/);
    press({ key: 'Escape' });
    await isShut();
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await screen.findByText(/In orchard/);
    await waitFor(() => expect(box().value).toBe(''));
    type('Written here');
    fireEvent.click(screen.getByRole('option', { name: 'quarry' }));
    await screen.findByText(/In quarry/);
    await waitFor(() => expect(box().value).toBe('Held there\n\nWritten here'));
  });

  // An ask starts on the lit question's Inbox, else the selected Inbox, else
  // the first. In every case the mouse, or Cmd+Up and Cmd+Down, switches it.
  describe('where an ask starts', () => {
    const empty = (inboxId: string, label: string): WireView => ({
      ...VIEW_B,
      inboxId,
      label,
      awaitingOperator: [],
    });
    const cmd = (key: 'ArrowUp' | 'ArrowDown') =>
      press({ key, code: key, metaKey: true }, box());

    // Switch with each of the three, the text going with the ask.
    const switches = async (start: string, below: string): Promise<void> => {
      await screen.findByText(new RegExp(`In ${start}`));
      await waitFor(() => expect(cursor()).toBe(start));
      await waitFor(() => expect(document.activeElement).toBe(box()));
      type('Why the cache?');
      cmd('ArrowDown');
      await screen.findByText(new RegExp(`In ${below}`));
      await waitFor(() => expect(cursor()).toBe(below));
      await waitFor(() => expect(box().value).toBe('Why the cache?'));
      cmd('ArrowUp');
      await screen.findByText(new RegExp(`In ${start}`));
      await waitFor(() => expect(box().value).toBe('Why the cache?'));
      fireEvent.click(screen.getByRole('option', { name: below }));
      await screen.findByText(new RegExp(`In ${below}`));
      await waitFor(() => expect(cursor()).toBe(below));
      await waitFor(() => expect(box().value).toBe('Why the cache?'));
    };

    it('starts on the lit question’s inbox, in All', async () => {
      serve.board = board([VIEW_A, VIEW_B, empty('inbox-d', 'dell')]);
      await mounted('/inbox');
      press({ key: ']', code: 'BracketRight', ctrlKey: true });
      await waitFor(() => expect(litKey()).toBe(`${B}/1`));
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await switches('quarry', 'dell');
    });

    it('starts on the selected inbox while no question is lit', async () => {
      serve.board = board([
        VIEW_A,
        empty('inbox-d', 'dell'),
        empty('inbox-e', 'esker'),
      ]);
      mount('/inbox/inbox-d');
      await screen.findByText(/Nothing waiting/);
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await switches('dell', 'esker');
    });

    it('starts on the first inbox with neither', async () => {
      serve.board = board([
        empty('inbox-d', 'dell'),
        empty('inbox-e', 'esker'),
      ]);
      mount('/inbox');
      await screen.findByText(/Nothing waiting/);
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await switches('dell', 'esker');
    });

    it('passes over a lit question’s inbox it cannot send to', async () => {
      serve.board = board([VIEW_A, VIEW_B], {
        clashes: [
          {
            inboxId: A,
            outcome: 'refused',
            claims: [
              { machine: { key: 'laptop', label: 'laptop' }, label: 'orchard' },
              {
                machine: { key: 'desktop', label: 'desktop' },
                label: 'orchard',
              },
            ],
          },
        ],
      });
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In quarry/);
    });

    it('stops at the ends of the list, a press still not moving the caret', async () => {
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In orchard/);
      await waitFor(() => expect(cursor()).toBe('orchard'));
      type('Text');
      const up = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        box().dispatchEvent(up);
      });
      expect(up.defaultPrevented).toBe(true);
      await screen.findByText(/In orchard/);
    });

    it('moves one row at a time on the filter step, text or none', async () => {
      serve.board = board([
        VIEW_A,
        VIEW_B,
        empty('inbox-d', 'dell'),
        empty('inbox-e', 'esker'),
      ]);
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
      await waitFor(() => expect(cursor()).toBe('orchard'));
      cmd('ArrowDown');
      await waitFor(() => expect(cursor()).toBe('quarry'));
      type('e');
      await waitFor(() => expect(options()).toEqual(['dell', 'esker']));
      await waitFor(() => expect(cursor()).toBe('dell'));
      cmd('ArrowDown');
      await waitFor(() => expect(cursor()).toBe('esker'));
    });

    it('moves the row with plain arrows while the box is empty, and not once it holds text', async () => {
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In orchard/);
      await waitFor(() => expect(document.activeElement).toBe(box()));
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      await screen.findByText(/In quarry/);
      await waitFor(() => expect(document.activeElement).toBe(box()));
      type('Text');
      fireEvent.keyDown(box(), { key: 'ArrowUp' });
      await settle();
      expect(screen.queryByText(/In orchard/)).toBeNull();
    });

    // A key held down sends its repeats faster than the page draws: each
    // must step on from where the last went, not from the row drawn lit.
    it('moves a row per press while a key is held, before anything is drawn', async () => {
      serve.board = board([
        VIEW_A,
        VIEW_B,
        empty('inbox-d', 'dell'),
        empty('inbox-e', 'esker'),
      ]);
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In orchard/);
      await waitFor(() => expect(document.activeElement).toBe(box()));
      const held = box();
      act(() => {
        for (let i = 0; i < 3; i++)
          fireEvent.keyDown(held, { key: 'ArrowDown', repeat: i > 0 });
      });
      await screen.findByText(/In esker/);
      expect(cursor()).toBe('esker');
    });

    it('brings the row a key moves to into sight, and not one the pointer lights', async () => {
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In orchard/);
      const scrolled = vi.mocked(Element.prototype.scrollIntoView);
      scrolled.mockClear();
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      await waitFor(() =>
        expect(
          scrolled.mock.contexts.some(
            (el) => (el as Element).textContent === 'quarry',
          ),
        ).toBe(true),
      );
      await settle();
      scrolled.mockClear();
      fireEvent.mouseEnter(screen.getByRole('option', { name: 'orchard' }));
      await settle();
      expect(
        scrolled.mock.contexts.map((el) => (el as Element).textContent),
      ).toEqual([]);
    });

    it('leaves another field its ⌘↑', async () => {
      await mounted('/inbox');
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In orchard/);
      await openRail();
      const search = await screen.findByLabelText('Search inboxes and groups');
      press({ key: 'ArrowDown', metaKey: true }, search);
      await settle();
      expect(screen.queryByText(/In quarry/)).toBeNull();
    });
  });

  it('opens on Ctrl+A, but not with ⌘ or shift', async () => {
    await mounted('/inbox');
    press({ key: 'a', code: 'KeyA', metaKey: true });
    press({ key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true });
    expect(asking()).toBeNull();
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await waitFor(() => expect(asking()).not.toBeNull());
  });

  it('opens straight on the box for the selected inbox, its draft kept across a close', async () => {
    await mounted();
    press({ key: 'A', code: 'KeyA', ctrlKey: true });
    await screen.findByText(/In orchard/);
    await waitFor(() => expect(document.activeElement).toBe(box()));
    const ask = () =>
      screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement;
    expect(ask().disabled).toBe(true);
    type('Why the cache?');
    await waitFor(() => expect(ask().disabled).toBe(false));
    press({ key: 'Escape' });
    await isShut();
    fireEvent.click(plus());
    await screen.findByText(/In orchard/);
    expect(box().value).toBe('Why the cache?');
  });

  it('sends on ⌘↩ to the inbox’s questions, closes, and clears the draft', async () => {
    serve.post = () =>
      json({
        ...VIEW_A,
        awaitingAgent: [
          {
            ...answered(7, '', 15, 'Why the cache?\nSay more.'),
            operatorQuestion: true,
          },
        ],
      });
    await mounted();
    fireEvent.click(plus());
    await screen.findByText(/In orchard/);
    type('Why the cache?\nSay more.');
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(serve.posts).toEqual([
        {
          path: `/api/inbox/${A}/questions`,
          body: { text: 'Why the cache?\nSay more.' },
        },
      ]),
    );
    await isShut();
    fireEvent.click(plus());
    await screen.findByText(/In orchard/);
    expect(box().value).toBe('');
  });

  const followingUp = async () => {
    await mounted();
    await onQueue(/With the agent/);
    await waitFor(() => expect(footNote()).toBe(''));
    type('First thought');
  };

  it('says a follow-up is on its way, and keeps what is typed after Send', async () => {
    let land: (r: Response) => void = () => undefined;
    serve.post = () =>
      new Promise((resolve) => {
        land = resolve;
      });
    await followingUp();
    send();
    await waitFor(() => expect(footNote()).toBe('Sending…'));
    type('First thought, and a second');
    land(json(VIEW_A));
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await reread();
    expect(box().value).toBe('First thought, and a second');
  });

  it('clears a follow-up that landed untouched, and says so', async () => {
    serve.post = () => json(VIEW_A);
    await followingUp();
    send();
    await waitFor(() => expect(footNote()).toBe('Sent'));
    expect(box().value).toBe('');
  });

  it('files a follow-up that fails after its box has gone, and guards a resend', async () => {
    let land: (r: Response) => void = () => undefined;
    serve.post = () =>
      new Promise((resolve) => {
        land = resolve;
      });
    await followingUp();
    const was = litKey();
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    press({ key: ']', ctrlKey: true });
    await waitFor(() => expect(litKey()).not.toBe(was));
    // Past the 400 ms an unread Atom is kept for.
    await new Promise((resolve) => setTimeout(resolve, 450));
    press({ key: '[', ctrlKey: true });
    await waitFor(() => expect(litKey()).toBe(was));
    expect(
      (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    press({ key: ']', ctrlKey: true });
    await waitFor(() => expect(litKey()).not.toBe(was));
    await new Promise((resolve) => setTimeout(resolve, 0));
    land(json({ _tag: 'AskRefused', message: 'too late' }, 409));
    await openRail();
    await waitFor(() => expect(note('stray')).not.toBeNull());
    expect(note('stray')?.textContent).toContain('Your follow-up in');
  });

  it('leaves out an inbox the board refuses as a clash', async () => {
    serve.board = {
      ...BOARD,
      inboxes: [summary(VIEW_A)],
      views: [VIEW_A],
      clashes: [
        {
          inboxId: B,
          outcome: 'refused',
          claims: [
            { machine: { key: 'laptop', label: 'laptop' }, label: 'quarry' },
            { machine: { key: 'desktop', label: 'desktop' }, label: 'quarry' },
          ],
        },
      ],
    };
    mount(`/inbox/${B}`);
    await screen.findByText(/laptop calls it/);
    // The selected inbox is refused, so it starts on the first it can send to.
    fireEvent.click(plus());
    await screen.findByText(/In orchard/);
    expect(options()).toEqual(['orchard']);
  });

  it('draws a question the operator posted as “You asked:”, with no context', async () => {
    const mine = {
      ...answered(7, 'Why the cache?', 15, 'Why the cache?\nSay more.'),
      body: '',
      bodyHtml: '',
      operatorQuestion: true,
    };
    serve.board = board([
      { ...VIEW_A, awaitingAgent: [mine, ...VIEW_A.awaitingAgent] },
      VIEW_B,
    ]);
    await mounted();
    fireEvent.click(queueTab(/With the agent/));
    await waitFor(() => expect(litKey()).toBe(`${A}/7`));
    expect(within(lit()).getByText('You asked:')).toBeDefined();
    expect(within(lit()).queryByText('You answered:')).toBeNull();
    expect(
      [...lit().querySelectorAll('[data-zen-when]')].map(
        (w) => w.textContent?.split(' ')[0],
      ),
    ).toEqual(['Asked']);
    const writeText = stubClipboard();
    prefix();
    press({ key: 'y', code: 'KeyY' });
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `Inbox ${A} · #7 — Why the cache?\n\nMy question:\nWhy the cache?\nSay more.`,
      ),
    );
  });
});
