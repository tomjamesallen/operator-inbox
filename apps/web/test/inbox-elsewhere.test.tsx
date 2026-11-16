import type { InboxId } from '@operator-inbox/core/api';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearedOf,
  type ElsewhereRow,
  elsewhereAppliesOf,
  elsewhereOrder,
  elsewhereRowsOf,
  linesOf,
  SHOW_ALL,
  steppedLineOf,
  waitingHereOf,
} from '../src/inbox-elsewhere';
import { json } from './fixture';
import {
  A,
  answered,
  asked,
  B,
  board,
  box,
  C,
  items,
  mount,
  press,
  serve,
  settle,
  summary,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  type WireView,
} from './inbox-page-harness';

// The empty state while other Inboxes have something: the owl awake on a box
// listing them, the order they come in, and the list's keys. All names are
// invented.

useInboxPage();

const row = (over: Partial<ElsewhereRow>): ElsewhereRow => ({
  inboxId: 'x' as InboxId,
  label: 'x',
  count: 1,
  stuck: 0,
  stuckForMs: 0,
  fresh: undefined,
  lastAt: 0,
  target: undefined,
  session: undefined,
  ...over,
});

const ids = (rows: ReadonlyArray<ElsewhereRow>) => rows.map((r) => r.inboxId);

describe('the order', () => {
  it('puts what needs attention first, then the fewest questions, then the most recent', () => {
    const rows = [
      row({ inboxId: 'many' as InboxId, count: 5, lastAt: 9 }),
      row({ inboxId: 'one-old' as InboxId, count: 1, lastAt: 1 }),
      row({ inboxId: 'one-new' as InboxId, count: 1, lastAt: 2 }),
      row({ inboxId: 'stuck-3' as InboxId, count: 3, stuck: 1 }),
      row({ inboxId: 'stuck-0' as InboxId, count: 0, stuck: 2 }),
    ];
    expect(ids([...rows].sort(elsewhereOrder))).toEqual([
      'stuck-0',
      'stuck-3',
      'one-new',
      'one-old',
      'many',
    ]);
  });

  it('sorts a row with no activity time after one that has it', () => {
    const rows = [
      row({ inboxId: 'none' as InboxId, lastAt: undefined }),
      row({ inboxId: 'some' as InboxId, lastAt: 5 }),
    ];
    expect(ids([...rows].sort(elsewhereOrder))).toEqual(['some', 'none']);
  });
});

// The fixtures' answers landed at 11:11 and 11:12 on 2026-10-09.
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const FIVE = 5 * 60_000;

const empty = (view: WireView): WireView => ({
  ...view,
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
});

const drawn = (views: ReadonlyArray<WireView>, more: object = {}) =>
  ({ ...board(views, more), greyed: new Set() }) as never;

describe('which Inboxes are listed', () => {
  const stuckOnly: WireView = {
    ...empty(VIEW_B),
    inboxId: C,
    label: 'kiln',
    awaitingAgent: [answered(2, 'Kiln two', 11, 'Go.')],
  };

  it('lists every other open Inbox with a question waiting or one stuck', () => {
    const rows = elsewhereRowsOf(
      drawn([empty(VIEW_A), VIEW_B, stuckOnly]),
      A as InboxId,
      NOW,
      FIVE,
      [],
    );
    expect(rows.map((r) => [r.inboxId, r.count, r.stuck])).toEqual([
      [C, 0, 1],
      [B, 1, 0],
    ]);
  });

  it('leaves out the selected, the archived, and one with nothing for the operator', () => {
    const rows = elsewhereRowsOf(
      drawn([
        VIEW_A,
        { ...VIEW_B, archived: true },
        { ...empty(VIEW_B), inboxId: C, label: 'kiln' },
      ]),
      A as InboxId,
      NOW,
      FIVE,
      [],
    );
    expect(rows).toEqual([]);
  });

  it('leaves out a muted Inbox, waiting or stuck', () => {
    const rows = elsewhereRowsOf(
      drawn([
        empty(VIEW_A),
        { ...VIEW_B, muted: true },
        { ...stuckOnly, muted: true },
      ]),
      A as InboxId,
      NOW,
      FIVE,
      [],
    );
    expect(rows).toEqual([]);
  });

  it('counts a question stuck only once it is past the chase threshold', () => {
    const at = (time: string) => Date.parse(`2026-10-09T${time}:00.000Z`);
    const of = (now: number) =>
      elsewhereRowsOf(
        drawn([empty(VIEW_A), stuckOnly]),
        A as InboxId,
        now,
        FIVE,
        [],
      );
    expect(of(at('11:15'))).toEqual([]);
    expect(of(at('11:16')).map((r) => r.stuck)).toEqual([1]);
  });
});

describe('when the list shows', () => {
  const others = [row({})];
  const base = {
    board: drawn([empty(VIEW_A), VIEW_B]),
    selected: A as InboxId,
    queue: 'inbox' as const,
    shownWaiting: 0,
    waitingHere: 0,
    rows: others,
  };

  it('shows for a selected empty Inbox while another has something', () => {
    expect(elsewhereAppliesOf(base)).toBe(true);
  });

  it('does not show on All, on another queue, or with nothing elsewhere', () => {
    expect(elsewhereAppliesOf({ ...base, selected: undefined })).toBe(false);
    expect(elsewhereAppliesOf({ ...base, queue: 'agent' })).toBe(false);
    expect(elsewhereAppliesOf({ ...base, rows: [] })).toBe(false);
  });

  it('does not show while the Inbox still holds a question a filter hides', () => {
    expect(elsewhereAppliesOf({ ...base, waitingHere: 1 })).toBe(false);
  });

  it('does not show for an Inbox not on the board', () => {
    expect(elsewhereAppliesOf({ ...base, selected: 'gone' as InboxId })).toBe(
      false,
    );
  });

  it('counts an answer on its way as gone from the Inbox', () => {
    const b = drawn([VIEW_A]);
    expect(waitingHereOf(b, A as InboxId, new Set())).toBe(2);
    expect(waitingHereOf(b, A as InboxId, new Set([`${A}/1`]))).toBe(1);
  });

  it('calls only an emptying of the same view a clearing', () => {
    expect(
      clearedOf({ view: 'v', waiting: 1 }, { view: 'v', waiting: 0 }),
    ).toBe(true);
    expect(clearedOf(undefined, { view: 'v', waiting: 0 })).toBe(false);
    expect(
      clearedOf({ view: 'u', waiting: 1 }, { view: 'v', waiting: 0 }),
    ).toBe(false);
    expect(
      clearedOf({ view: 'v', waiting: 0 }, { view: 'v', waiting: 0 }),
    ).toBe(false);
  });
});

describe('the cursor', () => {
  const lines = linesOf([
    row({ inboxId: 'one' as InboxId }),
    row({ inboxId: 'two' as InboxId }),
  ]);
  const keys = lines.map((l) => l.key);

  it('ends with the line to All', () => {
    expect(keys).toEqual(['one', 'two', SHOW_ALL]);
  });

  it('starts on the first line and stops at each end', () => {
    expect(steppedLineOf(lines, undefined, 1)?.key).toBe('two');
    expect(steppedLineOf(lines, SHOW_ALL, 1)?.key).toBe(SHOW_ALL);
    expect(steppedLineOf(lines, 'one', -1)?.key).toBe('one');
    expect(steppedLineOf(lines, 'gone', 1)?.key).toBe('two');
    expect(steppedLineOf(lines, 'one', 'last')?.key).toBe(SHOW_ALL);
    expect(steppedLineOf(lines, SHOW_ALL, 'first')?.key).toBe('one');
  });
});

// --- on the page -----------------------------------------------------------------

const LINK_B = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';

const list = () => screen.queryByRole('listbox', { name: /Other inboxes/ });
const options = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-zen-elsewhere] [role="option"]',
    ),
  ].map((o) => o.textContent ?? '');
const lit = () =>
  document.getElementById(list()?.getAttribute('aria-activedescendant') ?? '');

const emptyHere = () => board([empty(VIEW_A), VIEW_B]);

describe('the empty state', () => {
  it('lists the other Inboxes under the owl awake, with no words over it', async () => {
    serve.board = emptyHere();
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    expect(options()).toEqual(['quarry1', 'Show all inbox items']);
    expect(document.querySelector('[data-zen-owl="awake"]')).not.toBeNull();
    expect(screen.queryByText('Nothing waiting on you.')).toBeNull();
    expect(screen.queryByText('Nothing waiting here.')).toBeNull();
  });

  it('keeps the owl asleep with nothing elsewhere, and on All', async () => {
    serve.board = board([empty(VIEW_A), empty(VIEW_B)]);
    mount(`/inbox/${A}`);
    await screen.findByText('Nothing waiting on you.');
    expect(list()).toBeNull();
  });

  it('marks an Inbox whose question sat with the agent past the threshold', async () => {
    serve.config = {
      metadata: { extras: 'allow', keys: [] },
      chaseAfterMinutes: 5,
    };
    serve.board = board([
      empty(VIEW_A),
      VIEW_B,
      {
        ...empty(VIEW_B),
        inboxId: C,
        label: 'kiln',
        awaitingAgent: [answered(2, 'K', 11, 'Go.')],
      },
    ]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(options()[0]).toContain('needs attention'));
    expect(options()[0]).toContain('kiln');
  });

  it('keeps the owl asleep when only a muted Inbox has something', async () => {
    serve.board = board([empty(VIEW_A), { ...VIEW_B, muted: true }]);
    mount(`/inbox/${A}`);
    await screen.findByText('Nothing waiting on you.');
    expect(list()).toBeNull();
  });

  it('lists no muted Inbox beside one that is not', async () => {
    serve.board = board([
      empty(VIEW_A),
      { ...VIEW_B, muted: true },
      { ...VIEW_B, inboxId: C, label: 'kiln' },
    ]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    expect(options()).toEqual(['kiln1', 'Show all inbox items']);
  });

  it('sits still with reduced motion', async () => {
    serve.board = emptyHere();
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    const owl = document.querySelector('[data-zen-owl="awake"]') as Element;
    for (const part of owl.querySelectorAll('[class*="animate-owl"]'))
      expect(part.getAttribute('class')).toMatch(
        /motion-reduce:(animate-none|hidden)/,
      );
  });

  it('takes no focus on a page load', async () => {
    serve.board = emptyHere();
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    await settle();
    expect(document.activeElement).not.toBe(list());
  });
});

describe('the session under an Inbox’s name', () => {
  it('shows the session’s title, quietly, under the name', async () => {
    serve.board = board([
      empty(VIEW_A),
      { ...VIEW_B, metadata: { sessionTitle: 'Survey the quarry floor' } },
    ]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    const sub = document.querySelector<HTMLElement>('[data-elsewhere-session]');
    expect(sub?.textContent).toBe('Survey the quarry floor');
    expect(sub?.className).toContain('truncate');
  });

  it('leaves it out where there is none, or it repeats the name', () => {
    const rows = (title: string | undefined) =>
      elsewhereRowsOf(
        drawn([
          empty(VIEW_A),
          {
            ...VIEW_B,
            metadata: title === undefined ? {} : { sessionTitle: title },
          },
        ]),
        A as InboxId,
        0,
        Number.POSITIVE_INFINITY,
        [],
      );
    expect(rows(undefined)[0]?.session).toBeUndefined();
    expect(rows(' Quarry ')[0]?.session).toBeUndefined();
    expect(rows('Dig')[0]?.session).toBe('Dig');
  });
});

describe('the list’s keys', () => {
  const three = () =>
    board([
      empty(VIEW_A),
      VIEW_B,
      {
        ...VIEW_B,
        inboxId: C,
        label: 'kiln',
        awaitingOperator: [asked(1, 'Kiln one', 20), asked(2, 'Kiln two', 21)],
      },
    ]);

  const focusList = async () => {
    await waitFor(() => expect(list()).not.toBeNull());
    (list() as HTMLElement).focus();
  };

  it('moves the line lit with the arrows, stopping at the ends', async () => {
    serve.board = three();
    mount(`/inbox/${A}`);
    await focusList();
    expect(lit()?.textContent).toContain('quarry');
    press({ key: 'ArrowUp' }, list() as HTMLElement);
    expect(lit()?.textContent).toContain('quarry');
    press({ key: 'ArrowDown' }, list() as HTMLElement);
    expect(lit()?.textContent).toContain('kiln');
    press({ key: 'ArrowDown' }, list() as HTMLElement);
    press({ key: 'ArrowDown' }, list() as HTMLElement);
    expect(lit()?.textContent).toBe('Show all inbox items');
    expect(lit()?.getAttribute('aria-selected')).toBe('true');
  });

  it('opens the lit Inbox on Enter, with the caret in the box', async () => {
    serve.board = three();
    mount(`/inbox/${A}`);
    await focusList();
    press({ key: 'Enter' }, list() as HTMLElement);
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${B}`));
    await waitFor(() => expect(items()).toEqual([`${B}/1`]));
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('opens an Inbox on a click', async () => {
    serve.board = three();
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    fireEvent.click(
      document.querySelector(`[data-elsewhere="${C}"]`) as Element,
    );
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${C}`));
  });

  it('opens an Inbox with only a stuck question on With the agent', async () => {
    serve.config = {
      metadata: { extras: 'allow', keys: [] },
      chaseAfterMinutes: 5,
    };
    serve.board = board([
      empty(VIEW_A),
      { ...empty(VIEW_B), awaitingAgent: [answered(2, 'Stuck', 11, 'Go.')] },
    ]);
    mount(`/inbox/${A}`);
    await focusList();
    press({ key: 'Enter' }, list() as HTMLElement);
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${B}`));
    await waitFor(() => expect(items()).toEqual([`${B}/2`]));
  });

  it('goes to All from the last line', async () => {
    serve.board = three();
    mount(`/inbox/${A}`);
    await focusList();
    press({ key: 'End' }, list() as HTMLElement);
    press({ key: 'Enter' }, list() as HTMLElement);
    await waitFor(() => expect(location.pathname).toBe('/inbox'));
  });

  describe('Ctrl+Enter, in the desktop window', () => {
    beforeEach(() => {
      Object.assign(window, { pakeConfig: {} });
    });
    afterEach(() => {
      Reflect.deleteProperty(window, 'pakeConfig');
    });

    const opened = () =>
      serve.posts.filter((p) => p.path === '/api/open-session');

    it('opens the lit Inbox’s session, and stays put', async () => {
      serve.post = () => json({});
      serve.board = board([
        empty(VIEW_A),
        { ...VIEW_B, metadata: { sessionLink: LINK_B } },
      ]);
      mount(`/inbox/${A}`);
      await focusList();
      expect(screen.getByText(/Ctrl\+↩ session/)).toBeDefined();
      // The list's key, never the keymap's, where Ctrl+Enter sends.
      const keymap = vi.fn();
      document.addEventListener('keydown', keymap);
      press({ key: 'Enter', ctrlKey: true }, list() as HTMLElement);
      document.removeEventListener('keydown', keymap);
      expect(keymap).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(opened()).toEqual([
          { path: '/api/open-session', body: { link: LINK_B } },
        ]),
      );
      expect(location.pathname).toBe(`/inbox/${A}`);
    });

    it('does nothing for an Inbox with no session link, and offers none', async () => {
      serve.board = emptyHere();
      mount(`/inbox/${A}`);
      await focusList();
      expect(screen.queryByText(/Ctrl\+↩/)).toBeNull();
      press({ key: 'Enter', ctrlKey: true }, list() as HTMLElement);
      await settle();
      expect(opened()).toEqual([]);
      expect(serve.posts).toEqual([]);
      expect(location.pathname).toBe(`/inbox/${A}`);
    });
  });
});

describe('Ctrl+Space, o: the selected Inbox’s session', () => {
  beforeEach(() => {
    Object.assign(window, { pakeConfig: {} });
    serve.post = () => json({});
  });
  afterEach(() => {
    Reflect.deleteProperty(window, 'pakeConfig');
  });

  const LINK_A = 'claude://claude.ai/epitaxy/local_9f8e-7d6c';
  const opened = () =>
    serve.posts.filter((p) => p.path === '/api/open-session');
  const prefixO = (target: Element | Document = document) => {
    press({ key: ' ', code: 'Space', ctrlKey: true }, target);
    press({ key: 'o', code: 'KeyO' }, target);
  };

  it('opens it from a question', async () => {
    serve.board = board([
      { ...VIEW_A, metadata: { sessionLink: LINK_A } },
      VIEW_B,
    ]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    prefixO();
    await waitFor(() =>
      expect(opened()).toEqual([
        { path: '/api/open-session', body: { link: LINK_A } },
      ]),
    );
  });

  it('opens it from the empty state, the list holding the focus', async () => {
    serve.board = board([
      { ...empty(VIEW_A), metadata: { sessionLink: LINK_A } },
      { ...VIEW_B, metadata: { sessionLink: LINK_B } },
    ]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    (list() as HTMLElement).focus();
    prefixO(list() as HTMLElement);
    await waitFor(() =>
      expect(opened()).toEqual([
        { path: '/api/open-session', body: { link: LINK_A } },
      ]),
    );
  });

  it('opens nothing for a selected Inbox with no session link', async () => {
    serve.board = emptyHere();
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    prefixO();
    await settle();
    expect(opened()).toEqual([]);
  });
});

describe('clearing the last question', () => {
  const ONE = {
    ...VIEW_A,
    awaitingOperator: [asked(1, 'First', 2)],
    awaitingAgent: [],
  };
  const DONE = {
    ...ONE,
    awaitingOperator: [],
    awaitingAgent: [answered(1, 'First', 20, 'Yes')],
  };

  it('puts the focus on the list, its first line lit', async () => {
    serve.board = board([ONE, VIEW_B]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(items()).toEqual([`${A}/1`]));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    serve.post = () => json(DONE);
    serve.board = {
      ...board([DONE, VIEW_B]),
      inboxes: [summary(DONE), summary(VIEW_B)],
    };
    type('Yes');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(list()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(list()));
    expect(lit()?.textContent).toContain('quarry');
  });

  // Nothing waits on the operator in orchard; its answers are with the agent.
  const QUIET_A = { ...VIEW_A, awaitingOperator: [] };
  const toAgent = async () => {
    press({ key: '>', code: 'Period', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(list()).toBeNull());
  };

  it('puts the focus on the list when a queue switch lands on Your inbox', async () => {
    serve.board = board([QUIET_A, VIEW_B]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    await toAgent();
    press({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(list()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(list()));
    expect(lit()?.textContent).toContain('quarry');
  });

  it('puts the focus on the list on Ctrl+Space j', async () => {
    serve.board = board([QUIET_A, VIEW_B]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(list()).not.toBeNull());
    await toAgent();
    press({ key: ' ', code: 'Space', ctrlKey: true });
    press({ key: 'j', code: 'KeyJ' });
    await waitFor(() => expect(document.activeElement).toBe(list()));
  });

  it('puts the focus on the list when the inbox picker picks an empty Inbox', async () => {
    serve.board = board([VIEW_B, empty(VIEW_A)]);
    mount(`/inbox/${B}`);
    await waitFor(() => expect(items()).toEqual([`${B}/1`]));
    press({ key: ' ', code: 'Space', ctrlKey: true });
    press({ key: 'i', code: 'KeyI' });
    const field = await screen.findByTestId('inbox-picker-field');
    fireEvent.change(field, { target: { value: 'orchard' } });
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-testid="inbox-picker-row"][data-highlighted]')
          ?.getAttribute('data-key'),
      ).toBe(A),
    );
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    await waitFor(() => expect(list()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(list()));
  });

  it('takes no focus going to an Inbox that is already empty', async () => {
    serve.board = board([
      VIEW_B,
      empty(VIEW_A),
      { ...VIEW_B, inboxId: C, label: 'kiln' },
    ]);
    mount(`/inbox/${B}`);
    await waitFor(() => expect(items()).toEqual([`${B}/1`]));
    // The prefix, then 2: the sidebar's second Inbox, orchard.
    press({ key: ' ', code: 'Space', ctrlKey: true });
    press({ key: '2', code: 'Digit2' });
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    await waitFor(() => expect(list()).not.toBeNull());
    await settle();
    expect(document.activeElement).not.toBe(list());
  });
});
