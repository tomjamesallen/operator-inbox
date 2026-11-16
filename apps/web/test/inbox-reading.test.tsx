import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from './fixture';
import {
  A,
  answered,
  aside,
  asked,
  B,
  BOARD_WITH_ARCHIVED,
  board,
  box,
  burger,
  items,
  lit,
  litKey,
  M,
  MACHINE_BOARD,
  mount,
  mounted,
  NO_CHASE,
  openRail,
  overBox,
  press,
  queueTab,
  reread,
  send,
  serve,
  stubClipboard,
  summary,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  VIEW_M,
} from './inbox-page-harness';

// Reading on the real page: how it opens, what each queue says, a link, the
// All view, a question's parts, and the board moving under the reader.

useInboxPage();

const withThree = (extra: ReturnType<typeof asked>) =>
  board([
    { ...VIEW_A, awaitingOperator: [...VIEW_A.awaitingOperator, extra] },
    VIEW_B,
  ]);

const onQueue = async (name: RegExp) => {
  fireEvent.click(queueTab(name));
  await waitFor(() =>
    expect(queueTab(name).getAttribute('aria-selected')).toBe('true'),
  );
};

describe('opening the page', () => {
  it('opens with the sidebar shut, on a question link or not, and it opens on request', async () => {
    await mounted(`/inbox/${A}#q=3`);
    expect(aside()).toBeNull();
    fireEvent.click(burger());
    await waitFor(() => expect(aside()).not.toBeNull());
  });

  it('brings a link’s question up once, on its own queue, and marks it', async () => {
    await mounted(`/inbox/${A}#q=5`);
    await waitFor(() => expect(litKey()).toBe(`${A}/5`));
    // #5 is in Processed: the link went to that queue.
    expect(queueTab(/Processed/).getAttribute('aria-selected')).toBe('true');
    expect(
      document
        .querySelector(`[data-zen-item="${A}/5"]`)
        ?.querySelector('[data-zen-mark="selected"]')?.className,
    ).toContain('bg-blue');
    // A later read does not bring it up again.
    fireEvent.click(queueTab(/Your inbox/));
    await waitFor(() => expect(litKey()).toBe(`${A}/1`));
    await reread();
    expect(litKey()).toBe(`${A}/1`);
  });

  it('draws the oldest question, its body as HTML, and each queue’s count', async () => {
    await mounted();
    expect(items()).toEqual([`${A}/1`, `${A}/3`]);
    expect(litKey()).toBe(`${A}/1`);
    // The server-rendered body is rendered as HTML, not as text.
    expect(lit().querySelector('strong')?.textContent).toBe('First');
    expect(box()).toBeDefined();
    expect(queueTab(/Your inbox/).textContent).toContain('2');
    expect(queueTab(/With the agent/).textContent).toContain('2');
    expect(lit().querySelector('[data-zen-when]')?.textContent).toMatch(/ago$/);
  });
});

describe('the settled queues', () => {
  it('runs With the agent and Processed most recent first', async () => {
    await mounted();
    await onQueue(/With the agent/);
    await waitFor(() => expect(items()).toEqual([`${A}/2`, `${A}/6`]));
    await onQueue(/Processed/);
    await waitFor(() => expect(items()).toEqual([`${A}/5`, `${A}/4`]));
  });

  it('shows a With-the-agent question’s body and answer', async () => {
    await mounted();
    await onQueue(/With the agent/);
    await waitFor(() => expect(litKey()).toBe(`${A}/2`));
    expect(within(lit()).getByRole('heading').textContent).toBe('Second');
    expect(lit().querySelector('strong')?.textContent).toBe('Second');
    expect(within(lit()).getByText('You answered:')).toBeDefined();
    expect(within(lit()).getByText(/Yes\.\s+And more\./)).toBeDefined();
    const when = lit().querySelectorAll('[data-zen-when]');
    expect([...when].map((w) => w.textContent?.split(' ')[0])).toEqual([
      'Answered',
    ]);
    // The lit question's `<>` sits over the box.
    fireEvent.click(
      within(overBox()).getByRole('button', { name: 'Metadata' }),
    );
    const card = await screen.findByRole('dialog');
    expect(
      [...card.querySelectorAll('[data-zen-history]')].map(
        (h) => h.textContent?.split(' ')[0],
      ),
    ).toEqual(['Asked', 'Answered']);
  });

  it('shows a withdrawn question’s reason and a processed one’s answer', async () => {
    await mounted();
    await onQueue(/Processed/);
    await waitFor(() => expect(litKey()).toBe(`${A}/5`));
    expect(lit().querySelector('strong')?.textContent).toBe('Fifth');
    expect(within(lit()).getByText('Withdrawn by the agent:')).toBeDefined();
    expect(
      within(lit()).getByText('Settled in the session instead.'),
    ).toBeDefined();
    expect(screen.getByText('Use the cache.')).toBeDefined();
  });

  it('copies what a question came to, for the agent’s session', async () => {
    await mounted();
    await onQueue(/Processed/);
    await waitFor(() => expect(litKey()).toBe(`${A}/5`));
    const writeText = stubClipboard();
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy #5 for the agent session' }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `Inbox ${A} · #5 — Fifth\nBody of **Fifth**\n\nWithdrawn: Settled in the session instead.`,
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy #4 for the agent session' }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `Inbox ${A} · #4 — Fourth\nBody of **Fourth**\n\nMy answer:\nUse the cache.`,
      ),
    );
  });
});

describe('question codes', () => {
  const coded = () => board([{ ...VIEW_A, code: 'toe' }, VIEW_B]);

  it('shows the code where the copy button was, and copies what it copied', async () => {
    serve.board = coded();
    await mounted();
    await onQueue(/Processed/);
    await waitFor(() => expect(litKey()).toBe(`${A}/5`));
    const code = within(lit()).getByRole('button', {
      name: 'Copy toe#5 for the agent session',
    });
    expect(code.textContent).toBe('toe#5');
    expect(code.hasAttribute('data-copy')).toBe(true);
    // The mark's slot is there before the click, so the click shifts nothing.
    const slot = () => code.querySelector('[data-copy-mark]');
    expect(slot()?.classList.contains('invisible')).toBe(true);
    const writeText = stubClipboard();
    fireEvent.click(code);
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `Inbox ${A} · #5 — Fifth\nBody of **Fifth**\n\nWithdrawn: Settled in the session instead.`,
      ),
    );
    await waitFor(() => expect(code.getAttribute('data-mark')).toBe('ok'));
    expect(code.textContent).toBe('toe#5');
    expect(slot()?.classList.contains('invisible')).toBe(false);
  });

  it('shows #n for an Inbox with no code yet', async () => {
    await mounted();
    await waitFor(() => expect(litKey()).not.toBeUndefined());
    expect(lit().querySelector('[data-question-code]')?.textContent).toMatch(
      /^#\d+$/,
    );
  });

  it('may go to the gutter with the sidebar shut, and stays in the eyebrow while it is open', async () => {
    serve.board = coded();
    await mounted();
    const place = () =>
      lit()
        .querySelector('[data-question-code-place]')
        ?.getAttribute('data-question-code-place');
    await waitFor(() => expect(place()).toBe('gutter'));
    fireEvent.click(burger());
    await waitFor(() => expect(aside()).not.toBeNull());
    await waitFor(() => expect(place()).toBe('eyebrow'));
  });
});

describe('metadata', () => {
  const rule = (key: string) => ({
    key,
    description: key,
    presence: 'optional',
    type: 'string',
  });
  const keys = (el: Element) =>
    [...el.querySelectorAll('[data-zen-meta-key]')].map((e) => e.textContent);
  const openCard = async () => {
    fireEvent.click(
      await within(
        document.querySelector<HTMLElement>('[data-zen-answer]') ??
          document.body,
      ).findByRole('button', { name: 'Metadata' }),
    );
    return screen.findByRole('dialog');
  };

  it('lists a waiting question’s metadata in its card, and an answered one’s', async () => {
    serve.config = {
      ...NO_CHASE,
      metadata: { extras: 'allow', keys: [rule('topic'), rule('pr')] },
    };
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          { ...asked(1, 'First', 2), metadata: { topic: 'store' } },
        ],
        awaitingAgent: [
          { ...answered(2, 'Second', 12, 'Yes.'), metadata: { pr: '42' } },
        ],
      },
      VIEW_B,
    ]);
    await mounted();
    expect(keys(await openCard())).toEqual(['topic store']);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await onQueue(/With the agent/);
    await waitFor(() => expect(litKey()).toBe(`${A}/2`));
    expect(keys(await openCard())).toEqual(['pr 42']);
  });

  describe('the session link', () => {
    const LINK = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';
    const linked = { ...VIEW_A, metadata: { sessionLink: LINK } };
    const icon = () => document.querySelector('[data-open-session]');
    const shownIcon = () =>
      waitFor(() => {
        const found = icon();
        expect(found).not.toBeNull();
        return found as HTMLElement;
      });

    it('is an icon beside the copy button, and a real link', async () => {
      serve.board = board([linked]);
      await mounted();
      const link = await shownIcon();
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe(LINK);
      expect(link.hasAttribute('target')).toBe(false);
      expect(link.getAttribute('aria-label')).toBe('Open session');
      const copy = lit().querySelector('[data-copy]');
      expect(
        (copy?.compareDocumentPosition(link) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    });

    describe('in the desktop app’s window', () => {
      // What Pake's own script does to an off-site link: it takes the click
      // on the way down, so a handler on an `<a>` never hears it.
      const pakeTakes = (e: Event) => {
        if (e.target instanceof Element && e.target.closest('a') !== null) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      const opened = { path: '/api/open-session', body: { link: LINK } };

      beforeEach(() => {
        Object.assign(window, { pakeConfig: {} });
        document.addEventListener('click', pakeTakes, true);
      });
      afterEach(() => {
        document.removeEventListener('click', pakeTakes, true);
        Reflect.deleteProperty(window, 'pakeConfig');
      });

      it('asks serve to open it, past Pake’s click listener', async () => {
        serve.board = board([linked]);
        await mounted();
        fireEvent.click(await shownIcon());
        await waitFor(() => expect(serve.posts).toContainEqual(opened));
      });

      it('opens from the keys', async () => {
        serve.board = board([linked]);
        await mounted();
        await shownIcon();
        fireEvent.keyDown(document, { key: ' ', code: 'Space', ctrlKey: true });
        fireEvent.keyDown(document, { key: 'o' });
        await waitFor(() => expect(serve.posts).toContainEqual(opened));
      });
    });

    it('makes no icon of a near miss, and the card says it', async () => {
      const near = 'claude://evil.ai/epitaxy/local_0a1b';
      serve.board = board([{ ...VIEW_A, metadata: { sessionLink: near } }]);
      await mounted();
      expect((await openCard()).textContent).toContain(near);
      expect(icon()).toBeNull();
    });

    it('is no link in the card', async () => {
      serve.board = board([linked]);
      await mounted();
      const card = await openCard();
      expect(card.textContent).toContain(LINK);
      expect(card.querySelector('a[href^="claude:"]')).toBeNull();
    });

    it('takes no link from a Question', async () => {
      serve.board = board([
        {
          ...VIEW_A,
          awaitingOperator: [
            { ...asked(1, 'First', 2), metadata: { sessionLink: LINK } },
          ],
          awaitingAgent: [],
          processed: [],
        },
      ]);
      await mounted();
      await openCard();
      expect(icon()).toBeNull();
    });

    it('is greyed and names the machine on another machine’s', async () => {
      const remote = { ...VIEW_M, metadata: { sessionLink: LINK } };
      serve.board = {
        ...MACHINE_BOARD,
        inboxes: [summary(VIEW_A), summary(remote)],
        views: [VIEW_A, remote],
      };
      await mounted(`/inbox/${M}`);
      const greyed = await shownIcon();
      expect(greyed.tagName).toBe('BUTTON');
      expect(greyed.hasAttribute('disabled')).toBe(true);
      expect(greyed.getAttribute('aria-label')).toBe('Session on laptop');
      expect(document.querySelector('a[href^="claude:"]')).toBeNull();
    });
  });

  describe('under an empty queue', () => {
    const empty = {
      ...VIEW_A,
      metadata: { topic: 'store', note: 'folded' },
      awaitingOperator: [],
      awaitingAgent: [],
      processed: [],
    };

    it('has the selected Inbox’s metadata behind <>', async () => {
      serve.config = {
        ...NO_CHASE,
        metadata: { extras: 'allow', keys: [rule('topic')] },
      };
      serve.board = board([empty]);
      mount(`/inbox/${A}`);
      await screen.findByText('Nothing waiting on you.');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Metadata' })).toBeDefined(),
      );
      expect(keys(await openCard())).toEqual(['topic store', 'note folded']);
    });

    it('keeps the session’s icon', async () => {
      const LINK = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';
      serve.board = board([{ ...empty, metadata: { sessionLink: LINK } }]);
      mount(`/inbox/${A}`);
      await screen.findByText('Nothing waiting on you.');
      await waitFor(() =>
        expect(
          document.querySelector('[data-open-session]')?.getAttribute('href'),
        ).toBe(LINK),
      );
    });

    it('shows none with no Inbox selected', async () => {
      serve.board = board([empty]);
      mount('/inbox');
      await screen.findByText('Nothing waiting on you.');
      expect(screen.queryByRole('button', { name: 'Metadata' })).toBeNull();
    });
  });

  it('has only the history in the card where there is no metadata', async () => {
    await mounted();
    const card = await openCard();
    expect(card.querySelector('[data-zen-meta-key]')).toBeNull();
    expect(card.querySelector('[data-zen-history]')).not.toBeNull();
  });
});

describe('the All view', () => {
  const eyebrows = () =>
    [...document.querySelectorAll('[data-zen-eyebrow]')].map(
      (e) => e.textContent,
    );

  it('merges every inbox’s questions in time order, each named by its inbox', async () => {
    await mounted('/inbox');
    expect(items()).toEqual([`${A}/1`, `${B}/1`, `${A}/3`]);
    expect(eyebrows()).toEqual(['orchard', 'quarry', 'orchard']);
  });

  it('leaves an archived inbox’s questions out', async () => {
    serve.board = BOARD_WITH_ARCHIVED;
    await mounted('/inbox');
    expect(items()).toEqual([`${A}/1`, `${B}/1`, `${A}/3`]);
  });

  it('narrows to the inboxes the hash picks, and says so', async () => {
    await mounted(`/inbox#inboxes=${B}`);
    expect(items()).toEqual([`${B}/1`]);
    expect(document.querySelector('[data-zen-scope]')?.textContent).toBe(
      'quarry',
    );
  });

  it('leaves the hash’s narrowing by the sidebar’s All', async () => {
    await mounted(`/inbox#inboxes=${B}`);
    await openRail();
    const all = document.querySelector(
      'nav a[data-rail-inbox=""]',
    ) as HTMLElement;
    fireEvent.click(all);
    await waitFor(() =>
      expect(items()).toEqual([`${A}/1`, `${B}/1`, `${A}/3`]),
    );
    expect(document.querySelector('[data-zen-scope]')).toBeNull();
  });

  it('posts an answer to the question’s own inbox', async () => {
    await mounted('/inbox');
    press({ key: ']', ctrlKey: true });
    await waitFor(() => expect(litKey()).toBe(`${B}/1`));
    type('Dig');
    send();
    await waitFor(() =>
      expect(serve.posts.map((p) => p.path)).toEqual([
        `/api/inbox/${B}/questions/1/answer`,
      ]),
    );
  });
});

describe('a linked question that leaves', () => {
  const SEVENTH = asked(7, 'Seventh', 10);
  const marked = () => document.querySelector('[data-zen-item] .bg-blue');

  it('flows on to the next question and lets the link go, once answered', async () => {
    serve.board = withThree(SEVENTH);
    await mounted(`/inbox/${A}#q=3`);
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    expect(marked()).not.toBeNull();
    type('Done.');
    send();
    await waitFor(() => expect(litKey()).toBe(`${A}/7`));
    await waitFor(() => expect(location.hash).not.toContain('q='));
    expect(marked()).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('leaves nothing lit when it was the last one', async () => {
    serve.board = board([
      { ...VIEW_A, awaitingOperator: [asked(3, 'Third', 5)] },
      VIEW_B,
    ]);
    await mounted(`/inbox/${A}#q=3`);
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    type('Done.');
    send();
    await waitFor(() => expect(location.hash).not.toContain('q='));
    await waitFor(() => expect(litKey()).toBeUndefined());
  });

  it('stays lit and linked when another question leaves', async () => {
    await mounted(`/inbox/${A}#q=3`);
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    await reread(
      board([{ ...VIEW_A, awaitingOperator: [asked(3, 'Third', 9)] }, VIEW_B]),
    );
    await waitFor(() => expect(items()).toEqual([`${A}/3`]));
    expect(litKey()).toBe(`${A}/3`);
    expect(location.hash).toContain('q=3');
  });
});

describe('a board it cannot use', () => {
  const failure = () =>
    waitFor(() => {
      const el = document.querySelector('[data-zen-failure]');
      expect(el).not.toBeNull();
      return el?.textContent ?? '';
    });

  it('says the store is unavailable and names the command that checks it', async () => {
    serve.read = async () =>
      json({ _tag: 'InboxUnavailable', message: 'connection refused' }, 503);
    mount('/inbox');
    const text = await failure();
    expect(text).toContain('unavailable');
    expect(text).toContain('operator-inbox install');
  });

  // No version rides on the wire: a board this page
  // cannot decode says the page is likely older than serve, and asks for a
  // reload.
  it('says a board it cannot decode comes from a newer serve, and asks for a reload', async () => {
    serve.board = { inboxes: 'from a newer serve' };
    mount('/inbox');
    expect(await failure()).toContain(
      'this page is likely older than operator-inbox serve. Reload the page.',
    );
  });
});

// A new question must not push what is being read while the operator reads
// or types.
describe('the board moving under the reader', () => {
  const ARRIVAL = asked(7, 'Seventh', 30);

  it('adds a new question at the end, leaving the lit one and its count', async () => {
    await mounted();
    await reread(withThree(ARRIVAL));
    expect(items()).toEqual([`${A}/1`, `${A}/3`, `${A}/7`]);
    expect(litKey()).toBe(`${A}/1`);
    expect(queueTab(/Your inbox/).textContent).toContain('3');
  });

  it('keeps a draft typed in the box through an arrival', async () => {
    await mounted();
    const was = box();
    type('Half a thought');
    await reread(withThree(ARRIVAL));
    // The same element, not a remount with an empty box.
    expect(box()).toBe(was);
    expect(was.value).toBe('Half a thought');
  });

  it('updates an edited question in place', async () => {
    await mounted();
    const [first, third] = VIEW_A.awaitingOperator;
    if (first === undefined || third === undefined) throw new Error('none');
    await reread(
      board([
        {
          ...VIEW_A,
          awaitingOperator: [
            { ...first, revision: 2, title: 'First, again' },
            third,
          ],
        },
        VIEW_B,
      ]),
    );
    await waitFor(() =>
      expect(within(lit()).getByRole('heading').textContent).toBe(
        'First, again',
      ),
    );
    expect(items()).toEqual([`${A}/1`, `${A}/3`]);
  });

  // jsdom lays nothing out, so this draws one: each question 100 down from the
  // last, by its place in the list.
  const layOut = () => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return [...(this.parentElement?.children ?? [])].indexOf(this) * 100;
      },
    );
    return document.querySelector('[data-zen-flow]') as HTMLElement;
  };

  it('scrolls on by what lands above the question being read, once', async () => {
    await mounted();
    const flow = layOut();
    await reread();
    // A reader's wheel: it takes the list from whatever was placing it.
    fireEvent.wheel(flow);
    flow.scrollTop = 40;
    // Asked before the lit one, so it comes in over it.
    const next = withThree(asked(7, 'Seventh', 1));
    await reread(next);
    await waitFor(() => expect(items()[0]).toBe(`${A}/7`));
    expect(litKey()).toBe(`${A}/1`);
    expect(flow.scrollTop).toBe(140);
    await reread(next);
    expect(flow.scrollTop).toBe(140);
  });

  it('does not scroll for what lands under the question being read', async () => {
    await mounted();
    const flow = layOut();
    await reread();
    // A reader's wheel: it takes the list from whatever was placing it.
    fireEvent.wheel(flow);
    flow.scrollTop = 40;
    await reread(withThree(ARRIVAL));
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(flow.scrollTop).toBe(40);
  });
});

describe('the question search', () => {
  const hits = () =>
    screen.queryAllByTestId('search-hit').map((h) => h.dataset.key);
  const open = () => {
    press({ key: 'p', code: 'KeyP', ctrlKey: true });
    return screen.findByTestId('search-field');
  };

  it('opens on ⌘P, matches #n in every inbox, and opens the chosen one', async () => {
    await mounted();
    press({ key: 'p', code: 'KeyP', metaKey: true });
    const field = await screen.findByTestId('search-field');
    fireEvent.change(field, { target: { value: '#1' } });
    // The inbox on screen first.
    await waitFor(() => expect(hits()).toEqual([`${A}#1`, `${B}#1`]));
    fireEvent.click(screen.getAllByTestId('search-hit')[1] as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByTestId('question-search')).toBeNull(),
    );
    expect(location.pathname).toBe(`/inbox/${B}`);
    // The URL names the question too, so a reload lands on it again.
    expect(location.hash).toContain('q=1');
    await waitFor(() => expect(litKey()).toBe(`${B}/1`));
  });

  it('puts the focus in its field when it opens', async () => {
    await mounted();
    const field = await open();
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('closes on Esc and on a click on the backdrop, with no button of its own', async () => {
    await mounted();
    await open();
    const popup = await screen.findByTestId('question-search');
    expect(within(popup).queryByRole('button')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('search-field'), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('question-search')).toBeNull(),
    );
    await open();
    const backdrop = screen.getByTestId('modal-backdrop');
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    await waitFor(() =>
      expect(screen.queryByTestId('question-search')).toBeNull(),
    );
  });

  it('lists text matches under Your inbox, With the agent, then Processed', async () => {
    await mounted();
    const field = await open();
    fireEvent.change(field, { target: { value: 'Body of' } });
    await waitFor(() =>
      expect(
        screen.queryAllByTestId('search-section').map((s) => s.dataset.column),
      ).toEqual(['operator', 'agent', 'processed']),
    );
    fireEvent.change(field, { target: { value: 'nothing like it' } });
    await screen.findByText('No question matches “nothing like it”.');
  });

  describe('by code', () => {
    const coded = () =>
      board([
        { ...VIEW_A, code: 'toe' },
        { ...VIEW_B, code: 'tub' },
      ]);
    const inboxHits = () =>
      screen.queryAllByTestId('search-inbox-hit').map((h) => h.dataset.key);

    it('shows each question’s full code', async () => {
      serve.board = coded();
      await mounted();
      const field = await open();
      fireEvent.change(field, { target: { value: '#1' } });
      await waitFor(() => expect(hits()).toEqual([`${A}#1`, `${B}#1`]));
      expect(
        screen
          .getAllByTestId('search-hit')
          .map((h) => h.querySelector('[data-search-code]')?.textContent),
      ).toEqual(['toe#1', 'tub#1']);
    });

    it('lists the inboxes a partial @ code matches, each code beside its name', async () => {
      serve.board = coded();
      await mounted();
      const field = await open();
      fireEvent.change(field, { target: { value: '@t' } });
      await waitFor(() =>
        expect(inboxHits()).toEqual([`inbox:${A}`, `inbox:${B}`]),
      );
      expect(hits()).toEqual([]);
      const first = screen.getAllByTestId('search-inbox-hit')[0];
      expect(first?.textContent).toContain('@toe');
      expect(first?.textContent).toContain('orchard');
      fireEvent.change(field, { target: { value: '@tu' } });
      await waitFor(() => expect(inboxHits()).toEqual([`inbox:${B}`]));
    });

    it('filters to an inbox on @code, and opens it', async () => {
      serve.board = coded();
      await mounted();
      const field = await open();
      fireEvent.change(field, { target: { value: '@TUB' } });
      await waitFor(() => expect(hits()).toEqual([`${B}#1`]));
      expect(inboxHits()).toEqual([`inbox:${B}`]);
      fireEvent.click(screen.getByTestId('search-inbox-hit'));
      await waitFor(() =>
        expect(screen.queryByTestId('question-search')).toBeNull(),
      );
      expect(location.pathname).toBe(`/inbox/${B}`);
    });

    it('filters to exactly one question on @code#n, and goes to it', async () => {
      serve.board = coded();
      await mounted();
      const field = await open();
      fireEvent.change(field, { target: { value: '@toe#3' } });
      await waitFor(() => expect(hits()).toEqual([`${A}#3`]));
      expect(inboxHits()).toEqual([]);
      fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() =>
        expect(screen.queryByTestId('question-search')).toBeNull(),
      );
      expect(location.pathname).toBe(`/inbox/${A}`);
      expect(location.hash).toContain('q=3');
      await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    });

    it('says when no inbox has the code', async () => {
      serve.board = coded();
      await mounted();
      const field = await open();
      fireEvent.change(field, { target: { value: '@zzz' } });
      await screen.findByText('Nothing matches “@zzz”.');
    });
  });
});
