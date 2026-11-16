import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clockAtom } from '../src/clock';
import { MISMATCH_MESSAGE } from '../src/failure';
import { installRowContextMenu } from '../src/pake-row-menu';
import { json } from './fixture';
import {
  A,
  answered,
  aside,
  asked,
  B,
  BOARD,
  BOARD_WITH_ARCHIVED,
  board,
  C,
  items,
  LOCAL,
  M,
  MACHINE_BOARD,
  MACHINES,
  mount,
  mounted,
  nav,
  openRail,
  press,
  queueTab,
  rail,
  railShut,
  reread,
  rowMenu,
  serve,
  stubClipboard,
  summary,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  VIEW_C,
  type WireView,
} from './inbox-page-harness';

// What the sidebar lists and what its rows do, on the real page: the Inboxes,
// their groups and pins, the search, the machine sections and the width. How it
// opens is `inbox-rail.test.tsx`.

useInboxPage();

const inGroup = <Q extends { metadata: Record<string, unknown> }>(
  q: Q,
  group: string,
): Q => ({ ...q, metadata: { ...q.metadata, group } });

// A row's words and its count, which sits beside the link.
const rowText = (a: Element): string =>
  a.closest('[data-greyed-faded]')?.textContent ?? '';

const order = (): string[] =>
  [
    ...nav().querySelectorAll<HTMLElement>(
      '[data-rail-inbox]:not([data-rail-inbox=""]), [data-rail-group]',
    ),
  ].map((a) =>
    a.dataset.railGroup === undefined
      ? (a.dataset.railInbox ?? '')
      : `  ${a.dataset.railGroup || 'Default'}`,
  );

const pickRow = async (name: string, shiftKey = false): Promise<void> => {
  await openRail();
  fireEvent.click(rail().getByText(name), { shiftKey });
  // A pick in the sidebar leaves it out: still there to pick again.
  await openRail();
};

const openMenu = async (label: string) => {
  await openRail();
  return rowMenu(rail().getByText(label));
};

describe('the list', () => {
  it('lists All with the total, then every inbox in the server’s order', async () => {
    await mounted();
    await openRail();
    const rows = rail().getAllByRole('link');
    expect(rows.map(rowText)).toEqual(['All3', 'orchard2', 'quarry1']);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual([
      '/inbox',
      `/inbox/${A}`,
      `/inbox/${B}`,
    ]);
    expect(rows[1]?.getAttribute('aria-current')).toBe('page');
  });

  it('selecting an inbox shows its questions and puts it in the path', async () => {
    await mounted();
    await pickRow('quarry');
    await waitFor(() => expect(items()).toEqual([`${B}/1`]));
    expect(location.pathname).toBe(`/inbox/${B}`);
  });

  it('puts archived inboxes in a collapsed Archived section that opens', async () => {
    serve.board = BOARD_WITH_ARCHIVED;
    await mounted();
    await openRail();
    const toggle = rail().getByRole('button', { name: /Archived \(1\)/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(rail().queryByText('kiln')).toBeNull();
    // The All count is the server's, which leaves the archived inbox out.
    expect(rowText(rail().getAllByRole('link')[0] as Element)).toBe('All3');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute('aria-expanded')).toBe('true'),
    );
    // Selecting it shows its own view.
    fireEvent.click(await rail().findByText('kiln'));
    await waitFor(() => expect(items()).toEqual([`${C}/1`]));
  });

  it('archives an inbox from its row’s ⋯, and unarchives it', async () => {
    let archived = false;
    serve.post = () => {
      archived = !archived;
      serve.board = archived
        ? board([{ ...VIEW_A, archived: true }, VIEW_B])
        : BOARD;
      return json({ ...VIEW_A, archived });
    };
    await mounted();
    fireEvent.click(
      within(await openMenu('orchard')).getByRole('menuitem', {
        name: /Archive/,
      }),
    );
    const fold = await rail().findByRole('button', { name: /Archived \(1\)/ });
    fireEvent.click(fold);
    fireEvent.click(
      within(await openMenu('orchard')).getByRole('menuitem', {
        name: /Unarchive/,
      }),
    );
    await waitFor(() =>
      expect(rail().queryByRole('button', { name: /Archived/ })).toBeNull(),
    );
    expect(serve.posts).toEqual([
      { path: `/api/inbox/${A}/archive`, body: { archived: true } },
      { path: `/api/inbox/${A}/archive`, body: { archived: false } },
    ]);
  });

  // An archive's failure goes once a board shows
  // the Inbox as it asked, and is worded by what it asked.
  it('drops an archive’s failure once a board shows the Inbox archived', async () => {
    serve.post = () =>
      json({ _tag: 'ArchiveRefused', message: 'not now' }, 409);
    await mounted();
    fireEvent.click(
      within(await openMenu('orchard')).getByRole('menuitem', {
        name: /Archive/,
      }),
    );
    expect((await rail().findByRole('alert')).textContent).toBe(
      'Not archived: not now.',
    );
    await reread(board([{ ...VIEW_A, archived: true }, VIEW_B]));
    await waitFor(() => expect(rail().queryAllByRole('alert')).toEqual([]));
  });

  // Worded by what the archive asked for, so
  // bringing an archived Inbox back that fails says "Not unarchived".
  it('says an unarchive that was refused was not unarchived', async () => {
    serve.board = board([{ ...VIEW_A, archived: true }, VIEW_B]);
    serve.post = () =>
      json({ _tag: 'ArchiveRefused', message: 'not now' }, 409);
    await mounted();
    await openRail();
    fireEvent.click(rail().getByRole('button', { name: /Archived \(1\)/ }));
    await rail().findByText('orchard');
    fireEvent.click(
      within(await openMenu('orchard')).getByRole('menuitem', {
        name: /Unarchive/,
      }),
    );
    expect((await rail().findByRole('alert')).textContent).toBe(
      'Not unarchived: not now.',
    );
  });

  it('tells, on hover over an Inbox’s row, when it was last seen', async () => {
    const clock = Effect.runSync(TestClock.make().pipe(Effect.scoped));
    await Effect.runPromise(
      clock.setTime(Date.parse('2026-10-09T15:00:00.000Z')),
    );
    mount(`/inbox/${A}`, [[clockAtom, clock]]);
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    await openRail();
    expect(
      document.querySelector(`[data-rail-inbox="${A}"]`)?.getAttribute('title'),
    ).toBe(`orchard · ${A}\nLast seen 3h ago`);
  });

  it('shows an Inbox’s code in its row’s tooltip', async () => {
    serve.board = board([{ ...VIEW_A, code: 'toe' }, VIEW_B]);
    mount(`/inbox/${A}`);
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    await openRail();
    expect(
      document
        .querySelector(`[data-rail-inbox="${A}"]`)
        ?.getAttribute('title')
        ?.split('\n')[0],
    ).toBe(`orchard · toe · ${A}`);
    // An Inbox with no code yet shows none.
    expect(
      document
        .querySelector(`[data-rail-inbox="${B}"]`)
        ?.getAttribute('title')
        ?.split('\n')[0],
    ).toBe(`quarry · ${B}`);
  });

  it('marks the inbox and group holding a highlighted question', async () => {
    const store = {
      ...asked(1, 'First', 2),
      highlight: { seq: 30 },
      metadata: { group: 'store' },
    };
    const ui = { ...asked(3, 'Third', 9), metadata: { group: 'ui' } };
    serve.board = board([{ ...VIEW_A, awaitingOperator: [store, ui] }, VIEW_B]);
    // From another Inbox, orchard's groups are collapsed: its own row is lit.
    await mounted(`/inbox/${B}`);
    await openRail();
    expect(
      [...nav().querySelectorAll<HTMLElement>('[data-highlighted]')].map(
        (e) => e.dataset.railGroup ?? e.dataset.railInbox,
      ),
    ).toEqual([A]);
    await pickRow('orchard');
    await openRail();
    const marked = [
      ...nav().querySelectorAll<HTMLElement>('[data-highlighted]'),
    ];
    expect(
      marked.map((e) => e.dataset.railGroup ?? e.dataset.railInbox),
    ).toEqual([A, 'store']);
    for (const e of marked)
      expect(
        e.querySelector('[data-zen-mark="highlight"]')?.className,
      ).toContain('bg-yellow');
    expect(
      nav()
        .querySelector('[data-rail-group="ui"]')
        ?.hasAttribute('data-highlighted'),
    ).toBe(false);
  });
});

describe('the sidebar on a phone', () => {
  // Nothing is measured here, so it never fits: the phone's case, a drawer.
  it('starts shut, so the page opens on the question', async () => {
    await mounted();
    expect(aside()).toBeNull();
    expect(document.querySelector('[data-rail-veil]')).toBeNull();
  });

  it('shuts on its veil and on Esc', async () => {
    await mounted();
    await openRail();
    fireEvent.click(
      document.querySelector('[data-rail-veil]') as HTMLButtonElement,
    );
    await railShut();
    await openRail();
    press({ key: 'Escape' });
    await railShut();
  });
});

describe('groups', () => {
  // orchard: #1 and #6 in "store", #3 in "ui", the rest ungrouped.
  const GROUPED = board([
    {
      ...VIEW_A,
      awaitingOperator: [
        inGroup(asked(1, 'First', 2), 'store'),
        inGroup(asked(3, 'Third', 9), 'ui'),
      ],
      awaitingAgent: [
        inGroup(answered(6, 'Sixth', 11, 'Six.'), 'store'),
        answered(2, 'Second', 12, 'Yes.'),
      ],
    },
    VIEW_B,
  ]);

  const groupRows = (): string[] =>
    [...nav().querySelectorAll<HTMLElement>('[data-rail-group]')].map(
      (a) => `${a.dataset.railGroup}:${rowText(a)}`,
    );

  const withAgent = () => queueTab(/With the agent/).textContent;

  it('shows an inbox as one row while none of its questions has a group', async () => {
    await mounted();
    await openRail();
    expect(groupRows()).toEqual([]);
  });

  it('nests Default first under its inbox, then the groups A–Z, each with its waiting count', async () => {
    serve.board = GROUPED;
    await mounted();
    await openRail();
    expect(groupRows()).toEqual([':Default', 'store:store1', 'ui:ui1']);
    // Only orchard has groups; quarry stays one row.
    expect(rail().queryByRole('list', { name: 'Groups in quarry' })).toBeNull();
  });

  it('shows one group on a click, and the whole inbox from its own row', async () => {
    serve.board = GROUPED;
    await mounted();
    await pickRow('store');
    await waitFor(() => expect(items()).toEqual([`${A}/1`]));
    expect(withAgent()).toContain('1');
    expect(location.pathname).toBe(`/inbox/${A}`);
    expect(location.hash).toBe('#group=store');
    await pickRow('Default');
    await waitFor(() => expect(items()).toEqual([]));
    expect(withAgent()).toContain('1');
    await pickRow('orchard');
    await waitFor(() => expect(items()).toHaveLength(2));
    expect(withAgent()).toContain('2');
    expect(location.hash).toBe('');
  });

  it('adds and removes a group with shift-click', async () => {
    serve.board = GROUPED;
    await mounted();
    await pickRow('ui');
    await waitFor(() => expect(items()).toEqual([`${A}/3`]));
    await pickRow('store', true);
    await waitFor(() => expect(items()).toEqual([`${A}/1`, `${A}/3`]));
    await openRail();
    const on = [...nav().querySelectorAll('[data-rail-group][aria-current]')];
    expect(on.map(rowText)).toEqual(['store1', 'ui1']);
    await pickRow('ui', true);
    await waitFor(() => expect(items()).toEqual([`${A}/1`]));
  });

  it('adds and removes a focused group with Space, as shift-click does', async () => {
    serve.board = GROUPED;
    await mounted();
    await openRail();
    const row = (name: string) => {
      const a = rail().getByText(name).closest('a');
      if (a === null) throw new Error(`no ${name} row`);
      return a;
    };
    press({ key: ' ', code: 'Space' }, row('ui'));
    await waitFor(() => expect(items()).toEqual([`${A}/3`]));
    press({ key: ' ', code: 'Space' }, row('store'));
    await waitFor(() => expect(items()).toEqual([`${A}/1`, `${A}/3`]));
    press({ key: ' ', code: 'Space' }, row('ui'));
    await waitFor(() => expect(items()).toEqual([`${A}/1`]));
  });

  it('names a grouped question’s group over it, and none for Default', async () => {
    serve.board = GROUPED;
    await mounted();
    const groups = () =>
      [...document.querySelectorAll<HTMLElement>('[data-zen-item]')].map(
        (i) =>
          `${i.dataset.zenItem}:${i.querySelector('[data-zen-group]')?.textContent ?? '-'}`,
      );
    expect(groups()).toEqual([`${A}/1:store`, `${A}/3:ui`]);
    fireEvent.click(queueTab(/With the agent/));
    await waitFor(() => expect(groups()).toEqual([`${A}/2:-`, `${A}/6:store`]));
    // The eyebrow shows the group, so the colophon does not repeat it.
    expect(document.querySelector('[data-zen-meta-key="group"]')).toBeNull();
  });

  it('shows the whole inbox when the hash names a group it does not have', async () => {
    serve.board = GROUPED;
    await mounted(`/inbox/${A}#group=gone`);
    expect(items()).toHaveLength(2);
  });
});

describe('only the selected inbox lists its groups', () => {
  // orchard has "store" and "ui"; quarry has "dig".
  const TWO_GROUPED = board([
    {
      ...VIEW_A,
      pinnedGroups: ['ui'],
      awaitingOperator: [
        inGroup(asked(1, 'First', 2), 'store'),
        inGroup(asked(3, 'Third', 9), 'ui'),
      ],
    },
    {
      ...VIEW_B,
      awaitingOperator: [inGroup(asked(1, 'Quarry one', 7), 'dig')],
    },
  ]);

  it('lists no group in All, and only the picked inbox’s once one is picked', async () => {
    serve.board = TWO_GROUPED;
    await mounted('/inbox');
    await openRail();
    expect(order()).toEqual([A, B]);
    await pickRow('quarry');
    await openRail();
    expect(order()).toEqual([A, B, '  Default', '  dig']);
    await pickRow('orchard');
    await openRail();
    expect(order()).toEqual([A, '  Default', '  ui', '  store', B]);
  });

  it('expands an inbox the search reaches into, picked or not', async () => {
    serve.board = TWO_GROUPED;
    await mounted(`/inbox/${A}`);
    await openRail();
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search inboxes and groups' }),
      { target: { value: 'dig' } },
    );
    await waitFor(() => expect(order()).toEqual([B, '  dig']));
    // A name match lists all its groups, as it did.
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search inboxes and groups' }),
      { target: { value: 'quarry' } },
    );
    await waitFor(() => expect(order()).toEqual([B, '  Default', '  dig']));
  });

  it('lists an unpicked inbox’s pinned groups under the pinned filter', async () => {
    serve.board = TWO_GROUPED;
    await mounted(`/inbox/${B}`);
    await openRail();
    fireEvent.click(screen.getByRole('button', { name: 'Show only pinned' }));
    await waitFor(() => expect(order()).toEqual([A, '  ui']));
  });

  it('moves along the picked inbox’s groups with Tab, and Space picks one', async () => {
    serve.board = TWO_GROUPED;
    await mounted(`/inbox/${B}`);
    await openRail();
    // quarry's rows are the only group rows on the page, in its order.
    const links = [
      ...nav().querySelectorAll<HTMLElement>('[data-rail-group]'),
    ].map((a) => a.dataset.railGroup);
    expect(links).toEqual(['', 'dig']);
    const dig = nav().querySelector<HTMLElement>('[data-rail-group="dig"]');
    if (dig === null) throw new Error('no dig row');
    press({ key: ' ', code: 'Space' }, dig);
    await waitFor(() => expect(location.hash).toBe('#group=dig'));
    expect(location.pathname).toBe(`/inbox/${B}`);
  });
});

describe('archived groups', () => {
  // orchard: #1 in "store", #3 in "ui", #6 (with the agent) in "store";
  // "store" is archived.
  const ARCHIVED_GROUP = {
    ...VIEW_A,
    archivedGroups: ['store'],
    awaitingOperator: [
      inGroup(asked(1, 'First', 2), 'store'),
      inGroup(asked(3, 'Third', 9), 'ui'),
    ],
    awaitingAgent: [
      inGroup(answered(6, 'Sixth', 11, 'Six.'), 'store'),
      answered(2, 'Second', 12, 'Yes.'),
    ],
  };
  const LIVE_GROUP = {
    ...ARCHIVED_GROUP,
    archivedGroups: [] as ReadonlyArray<string>,
  };
  // As serve counts: an archived group's waiting question is out of the
  // row's count and All's.
  const counted = (views: ReadonlyArray<WireView>) => {
    const b = board(views);
    return {
      ...b,
      inboxes: b.inboxes.map((i) =>
        i.inboxId === A
          ? { ...i, awaitingOperator: i.awaitingOperator - 1 }
          : i,
      ),
      totalAwaitingOperator: b.totalAwaitingOperator - 1,
    };
  };
  const ARCHIVED = counted([ARCHIVED_GROUP, VIEW_B]);

  const fold = () =>
    rail().getByRole('button', { name: /Archived groups \(1\)/ });
  const groupRows = (): string[] =>
    [...nav().querySelectorAll<HTMLElement>('[data-rail-group]')].map(
      (a) => a.dataset.railGroup || 'Default',
    );

  it('folds an archived group away under its inbox, shut', async () => {
    serve.board = ARCHIVED;
    await mounted(`/inbox/${A}`);
    await openRail();
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(groupRows()).toEqual(['Default', 'ui']);
    fireEvent.click(fold());
    await waitFor(() =>
      expect(groupRows()).toEqual(['Default', 'ui', 'store']),
    );
    expect(
      rail().getByRole('list', { name: 'Archived groups in orchard' }),
    ).toBeTruthy();
    // The inbox's row counts only what is not put away; All too.
    expect(rowText(rail().getByText('orchard'))).toBe('orchard1');
    expect(rowText(rail().getAllByRole('link')[0] as Element)).toBe('All2');
  });

  it('leaves its questions out of All and the inbox’s own view, and shows them when picked', async () => {
    serve.board = ARCHIVED;
    await mounted('/inbox');
    expect(items()).toEqual([`${B}/1`, `${A}/3`]);
    await pickRow('orchard');
    await waitFor(() => expect(items()).toEqual([`${A}/3`]));
    expect(queueTab(/With the agent/).textContent).toContain('1');
    await openRail();
    fireEvent.click(fold());
    await pickRow('store');
    await waitFor(() => expect(items()).toEqual([`${A}/1`]));
    expect(location.hash).toBe('#group=store');
    // Picked, its fold stays open, so the picked row is on show.
    await openRail();
    expect(fold().getAttribute('aria-expanded')).toBe('true');
  });

  it('archives a group from its row’s menu, and unarchives it from the fold', async () => {
    let archived = false;
    serve.board = board([LIVE_GROUP, VIEW_B]);
    serve.post = () => {
      archived = !archived;
      serve.board = archived ? ARCHIVED : board([LIVE_GROUP, VIEW_B]);
      return json(archived ? ARCHIVED_GROUP : LIVE_GROUP);
    };
    await mounted(`/inbox/${A}`);
    await openRail();
    const row = (group: string) => {
      const el = nav().querySelector(`[data-rail-group="${group}"]`);
      if (el === null) throw new Error(`no ${group} row`);
      return el;
    };
    const menu = await rowMenu(row('store'));
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Archive the group store' }),
    );
    await waitFor(() => expect(groupRows()).toEqual(['Default', 'ui']));
    fireEvent.click(fold());
    await waitFor(() =>
      expect(row('store').hasAttribute('data-group-archived')).toBe(true),
    );
    const again = await rowMenu(row('store'));
    // An archived group's menu only brings it back: its pin waits.
    expect(within(again).queryByRole('menuitem', { name: /Pin/ })).toBeNull();
    fireEvent.click(
      within(again).getByRole('menuitem', {
        name: 'Unarchive the group store',
      }),
    );
    await waitFor(() =>
      expect(
        rail().queryByRole('button', { name: /Archived groups/ }),
      ).toBeNull(),
    );
    expect(serve.posts).toEqual([
      {
        path: `/api/inbox/${A}/archive-group`,
        body: { group: 'store', archived: true },
      },
      {
        path: `/api/inbox/${A}/archive-group`,
        body: { group: 'store', archived: false },
      },
    ]);
  });

  it('says a refused archive was not made, under the group’s row', async () => {
    serve.board = board([LIVE_GROUP, VIEW_B]);
    serve.post = () =>
      json(
        {
          _tag: 'ArchiveRefused',
          message: 'no question in this inbox is in group "store"',
        },
        409,
      );
    await mounted(`/inbox/${A}`);
    await openRail();
    const row = nav().querySelector('[data-rail-group="store"]');
    if (row === null) throw new Error('no store row');
    fireEvent.click(
      within(await rowMenu(row)).getByRole('menuitem', {
        name: 'Archive the group store',
      }),
    );
    await waitFor(() =>
      expect(
        nav().querySelector('[data-group-archive-outcome="store"]')
          ?.textContent,
      ).toContain('Not archived'),
    );
  });

  it('opens the fold to show a search match there', async () => {
    serve.board = ARCHIVED;
    await mounted(`/inbox/${B}`);
    await openRail();
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search inboxes and groups' }),
      { target: { value: 'stor' } },
    );
    await waitFor(() => expect(order()).toEqual([A, '  store']));
    expect(fold().getAttribute('aria-expanded')).toBe('true');
  });

  it('never shows under the pinned filter, its pin waiting', async () => {
    const pinned = { ...ARCHIVED_GROUP, pinnedGroups: ['store', 'ui'] };
    serve.board = counted([pinned, VIEW_B]);
    await mounted(`/inbox/${B}`);
    await openRail();
    fireEvent.click(screen.getByRole('button', { name: 'Show only pinned' }));
    await waitFor(() => expect(order()).toEqual([A, '  ui']));
  });

  it('archives the one group in force with the archive key', async () => {
    serve.board = board([LIVE_GROUP, VIEW_B]);
    serve.post = () => json(ARCHIVED_GROUP);
    await mounted(`/inbox/${A}#group=store`);
    press({ key: ' ', code: 'Space', ctrlKey: true });
    press({ key: '&', shiftKey: true });
    await waitFor(() =>
      expect(serve.posts).toEqual([
        {
          path: `/api/inbox/${A}/archive-group`,
          body: { group: 'store', archived: true },
        },
      ]),
    );
  });
});

describe('the search', () => {
  // orchard has groups "store" and "ui" (and Default); quarry has none; kiln
  // is archived.
  const SEARCHED = {
    ...BOARD_WITH_ARCHIVED,
    views: [
      {
        ...VIEW_A,
        awaitingOperator: [
          inGroup(asked(1, 'First', 2), 'store'),
          inGroup(asked(3, 'Third', 9), 'ui'),
        ],
      },
      VIEW_B,
      VIEW_C,
    ],
  };

  const search = (text: string): HTMLInputElement => {
    const field = screen.getByRole('searchbox', {
      name: 'Search inboxes and groups',
    }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: text } });
    return field;
  };

  const open = async () => {
    serve.board = SEARCHED;
    await mounted();
    await openRail();
  };

  it('keeps an inbox whose name matches, with all its groups', async () => {
    await open();
    search('orch');
    await waitFor(() =>
      expect(order()).toEqual([A, '  Default', '  store', '  ui']),
    );
  });

  it('keeps an inbox for a matching group, showing only that group, and never matches Default', async () => {
    await open();
    search('stor');
    await waitFor(() => expect(order()).toEqual([A, '  store']));
    // "dult" matches "Default" by its letters, and nothing else here.
    search('dult');
    await waitFor(() =>
      expect(nav().querySelector('[data-sidebar-no-match]')).not.toBeNull(),
    );
  });

  it('marks the best matches, names and groups alike', async () => {
    await open();
    // "or" matches orchard's name and its group "store": both are marked.
    search('or');
    await waitFor(() =>
      expect(
        [...nav().querySelectorAll<HTMLElement>('[data-search-top]')].map(
          (e) => e.dataset.railGroup ?? e.dataset.railInbox,
        ),
      ).toEqual([A, 'store']),
    );
    // The selected row keeps the selection's look; the other is tinted.
    const tinted = (selector: string) =>
      nav()
        .querySelector(selector)
        ?.closest('[data-greyed-faded]')
        ?.classList.contains('bg-fg/5');
    expect(tinted('[data-rail-group="store"]')).toBe(true);
    expect(tinted(`[data-rail-inbox="${A}"]`)).toBe(false);
  });

  it('opens the Archived section to show a match there', async () => {
    await open();
    expect(rail().queryByText('kiln')).toBeNull();
    search('kln');
    await waitFor(() => expect(order()).toEqual([C]));
  });

  it('opens the first match on Enter, its group with it', async () => {
    await open();
    const field = search('ui');
    await waitFor(() => expect(order()).toEqual([A, '  ui']));
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#group=ui'));
    expect(location.pathname).toBe(`/inbox/${A}`);
  });
});

describe('pins', () => {
  // quarry pinned; in orchard, the group "ui" pinned.
  const PINNED = {
    ...BOARD,
    inboxes: BOARD.inboxes.map((i) => ({ ...i, pinned: i.inboxId === B })),
    views: [
      {
        ...VIEW_A,
        pinnedGroups: ['ui'],
        awaitingOperator: [
          inGroup(asked(1, 'First', 2), 'store'),
          inGroup(asked(3, 'Third', 9), 'ui'),
        ],
      },
      VIEW_B,
    ],
  };
  const ALL_PINNED = {
    ...PINNED,
    inboxes: PINNED.inboxes.map((i) => ({ ...i, pinned: true })),
  };

  const open = async (path?: string) => {
    serve.board = PINNED;
    await mounted(path);
    await openRail();
  };
  // The row of an Inbox, or of one of its groups.
  const rowLink = (inboxId: string, group?: string): Element => {
    const el = nav().querySelector(
      group === undefined
        ? `[data-rail-inbox="${inboxId}"]`
        : `[data-inbox="${inboxId}"][data-rail-group="${group}"]`,
    );
    if (el === null) throw new Error(`no row ${inboxId} ${group ?? ''}`);
    return el;
  };
  // Pins or unpins from the row's menu, by the item's name.
  const pinVia = async (row: Element, name: string) => {
    const menu = await rowMenu(row);
    fireEvent.click(within(menu).getByRole('menuitem', { name }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  };
  const markedPinned = (row: Element): boolean =>
    row.closest('[data-greyed-faded]')?.querySelector('[data-pinned-mark]') !=
    null;
  const onlyPinned = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Show only pinned' }));
  // The scope as the breadcrumbs mark it: every crumb underlined, once each.
  const scope = () => {
    const marked = [
      ...new Set(
        [...document.querySelectorAll('[data-crumb-scope]')].map(
          (c) => c.textContent,
        ),
      ),
    ];
    return marked.length === 0 ? undefined : marked.join(' › ');
  };

  it('puts a pinned inbox first, and a pinned group first after Default', async () => {
    await open();
    expect(order()).toEqual([B, A, '  Default', '  ui', '  store']);
  });

  it('marks a pinned row, and pins from the row’s menu, which Default has none of', async () => {
    await open();
    expect(markedPinned(rowLink(B))).toBe(true);
    expect(markedPinned(rowLink(A))).toBe(false);
    expect(markedPinned(rowLink(A, 'ui'))).toBe(true);
    expect(nav().querySelectorAll('[data-pinned-mark]')).toHaveLength(2);
    // Nothing on a row pins: that is in the menu. A pinned row's pin unpins.
    expect(rail().queryByRole('button', { name: /^Pin/ })).toBeNull();
    const menu = await rowMenu(rowLink(B));
    expect(
      within(menu).getByRole('menuitem', { name: 'Unpin the inbox quarry' }),
    ).toBeTruthy();
    expect(rowLink(A, '').closest('[data-row-menu-area]')).toBeNull();
  });

  it('unpins an inbox, or a group, from the pin on its row, without picking the row', async () => {
    serve.post = () => json(PINNED.views[0]);
    await open(`/inbox/${A}`);
    fireEvent.click(rail().getByRole('button', { name: 'Unpin quarry' }));
    await waitFor(() =>
      expect(serve.posts).toEqual([
        { path: `/api/inbox/${B}/pin`, body: { pinned: false } },
      ]),
    );
    // The row was not picked: the page stays on orchard.
    expect(location.pathname).toBe(`/inbox/${A}`);
    fireEvent.click(rail().getByRole('button', { name: 'Unpin the group ui' }));
    await waitFor(() =>
      expect(serve.posts).toEqual([
        { path: `/api/inbox/${B}/pin`, body: { pinned: false } },
        { path: `/api/inbox/${A}/pin`, body: { pinned: false, group: 'ui' } },
      ]),
    );
    expect(location.hash).not.toContain('group=ui');
  });

  it('filters to what is pinned, by the search box’s rules', async () => {
    // orchard is not pinned but its group "ui" is; quarry is pinned.
    await open();
    const filter = screen.getByRole('button', { name: 'Show only pinned' });
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(order()).toEqual([B, A, '  ui']));
    // With text too: both must allow a row.
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search inboxes and groups' }),
      { target: { value: 'orch' } },
    );
    await waitFor(() => expect(order()).toEqual([A, '  ui']));
    fireEvent.click(filter);
    await waitFor(() =>
      expect(order()).toEqual([A, '  Default', '  ui', '  store']),
    );
  });

  // An archived Inbox never shows under pinned.
  describe('an archived inbox', () => {
    const LATER = {
      ...VIEW_C,
      inboxId: 'inbox-l',
      label: 'loft',
      pinnedGroups: ['later'],
      awaitingOperator: [inGroup(asked(1, 'Loft one', 21), 'later')],
    };
    // kiln is archived and pinned; loft is archived with a pinned group.
    const ARCHIVED_PINS = board([VIEW_A, VIEW_B, VIEW_C, LATER]);
    const withPins = {
      ...ARCHIVED_PINS,
      inboxes: ARCHIVED_PINS.inboxes.map((i) => ({
        ...i,
        pinned: i.inboxId === B || i.inboxId === C,
      })),
    };
    const fold = () => document.querySelector('[data-archived-section]');

    it('stays out of the pinned view, its pin or its group’s', async () => {
      serve.board = withPins;
      await mounted();
      await openRail();
      onlyPinned();
      await waitFor(() => expect(order()).toEqual([B]));
      expect(fold()).toBeNull();
      // Nor does a search bring it back while the filter is on.
      fireEvent.change(
        screen.getByRole('searchbox', { name: 'Search inboxes and groups' }),
        { target: { value: 'kiln' } },
      );
      await waitFor(() => expect(order()).toEqual([]));
    });

    it('stays in its fold with the filter off, its pin still on', async () => {
      serve.board = withPins;
      await mounted();
      await openRail();
      expect(order()).toEqual([B, A]);
      fireEvent.click(screen.getByRole('button', { name: /Archived \(2\)/ }));
      await waitFor(() => expect(markedPinned(rowLink(C))).toBe(true));
    });

    it('shows nothing in the pinned view of its own page', async () => {
      serve.board = withPins;
      mount(`/inbox/${C}`);
      await screen.findAllByText('Kiln one');
      await openRail();
      onlyPinned();
      await screen.findByText('Nothing waiting on you.');
      await waitFor(() => expect(scope()).toBe('kiln'));
    });

    it('names no group of its own in the pinned view', async () => {
      serve.board = withPins;
      mount('/inbox/inbox-l');
      await screen.findAllByText('Loft one');
      await openRail();
      onlyPinned();
      await waitFor(() => expect(scope()).toBe('loft'));
    });

    it('comes back pinned when unarchived, nothing written', async () => {
      serve.board = withPins;
      await mounted();
      await openRail();
      onlyPinned();
      await waitFor(() => expect(order()).toEqual([B]));
      await reread({
        ...withPins,
        inboxes: withPins.inboxes.map((i) =>
          i.inboxId === C ? { ...i, archived: false } : i,
        ),
        views: withPins.views.map((v) =>
          v.inboxId === C ? { ...v, archived: false } : v,
        ),
      });
      await waitFor(() => expect(order()).toEqual([B, C]));
      expect(serve.posts).toEqual([]);
    });
  });

  it('keeps every count in one right-aligned column, pinned or not', async () => {
    await open();
    const counts = [...nav().querySelectorAll('a')].map(
      (a) => a.closest('[data-greyed-faded]')?.lastElementChild,
    );
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) {
      expect(c?.classList.contains('w-4')).toBe(true);
      expect(c?.classList.contains('text-right')).toBe(true);
    }
  });

  it('narrows the questions to pinned inboxes and pinned groups', async () => {
    // quarry is pinned: all of it. orchard is not: only its "ui" group.
    await open('/inbox');
    expect(items()).toEqual([`${A}/1`, `${B}/1`, `${A}/3`]);
    expect(scope()).toBeUndefined();
    onlyPinned();
    await waitFor(() => expect(items()).toEqual([`${B}/1`, `${A}/3`]));
    // Nothing is selected, so no crumb is marked.
    expect(scope()).toBeUndefined();
  });

  it('says which inbox and groups the page shows', async () => {
    await open(`/inbox/${A}#group=ui&group=store`);
    expect(scope()).toBe('orchard › store › ui');
    onlyPinned();
    // Only "ui" is pinned in orchard, so only it is marked now.
    await waitFor(() => expect(scope()).toBe('orchard › ui'));
    await waitFor(() => expect(items()).toEqual([`${A}/3`]));
  });

  it('names the pinned groups an unpinned inbox narrows to', async () => {
    await open(`/inbox/${A}`);
    expect(scope()).toBe('orchard');
    onlyPinned();
    await waitFor(() => expect(scope()).toBe('orchard › ui'));
  });

  it('adds nothing to the name of a pinned inbox, which shows whole', async () => {
    await open(`/inbox/${B}`);
    onlyPinned();
    await waitFor(() => expect(scope()).toBe('quarry'));
  });

  it('pins a group with a click', async () => {
    serve.post = () => json(PINNED.views[0]);
    await open();
    await pinVia(rowLink(A, 'store'), 'Pin the group store');
    await waitFor(() =>
      expect(serve.posts).toEqual([
        { path: `/api/inbox/${A}/pin`, body: { pinned: true, group: 'store' } },
      ]),
    );
  });

  // A pin or an unpin that fails says so, under its row.
  it('says a refused pin or unpin was not made, under its row', async () => {
    serve.post = () =>
      json({ _tag: 'PinRefused', message: 'it changes nothing' }, 409);
    await open();
    await pinVia(rowLink(A, 'store'), 'Pin the group store');
    await pinVia(rowLink(B), 'Unpin the inbox quarry');
    await waitFor(() =>
      expect(
        rail()
          .getAllByRole('alert')
          .map((a) => a.textContent),
      ).toEqual([
        'Not unpinned: it changes nothing.',
        'Not pinned: it changes nothing.',
      ]),
    );
  });

  // A pin's failure is worded by what it asked for,
  // and goes once a board shows that, whoever made it, and stays gone.
  it('drops a pin’s failure once a board shows what it asked for, and never rewords it', async () => {
    serve.post = () =>
      json({ _tag: 'PinRefused', message: 'it changes nothing' }, 409);
    await open();
    await pinVia(rowLink(A), 'Pin the inbox orchard');
    expect((await rail().findByRole('alert')).textContent).toBe(
      'Not pinned: it changes nothing.',
    );
    // Another writer pins orchard: the failure says nothing true any more.
    await reread(ALL_PINNED);
    await waitFor(() => expect(markedPinned(rowLink(A))).toBe(true));
    expect(rail().queryAllByRole('alert')).toEqual([]);
    // Unpinned again: the old failure does not come back as "Not unpinned".
    await reread(PINNED);
    await waitFor(() => expect(markedPinned(rowLink(A))).toBe(false));
    expect(rail().queryAllByRole('alert')).toEqual([]);
  });

  // A retry after a failure the board settled says nothing of
  // that failure while it is in flight, and is worded by its own attempt when
  // it ends.
  it('says nothing of a pin’s last failure while its retry is in flight', async () => {
    let reply: (r: Response) => void = () => undefined;
    serve.post = () =>
      serve.posts.length === 1
        ? json({}, 504)
        : new Promise<Response>((resolve) => {
            reply = resolve;
          });
    await open();
    await pinVia(rowLink(A), 'Pin the inbox orchard');
    expect((await rail().findByRole('alert')).textContent).toBe(
      'Pin unconfirmed: it may have been made.',
    );
    // It was made: the next board shows orchard pinned.
    await reread(ALL_PINNED);
    await waitFor(() => expect(markedPinned(rowLink(A))).toBe(true));
    await waitFor(() => expect(rail().queryAllByRole('alert')).toEqual([]));
    await pinVia(rowLink(A), 'Unpin the inbox orchard');
    await waitFor(() => expect(serve.posts).toHaveLength(2));
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(rail().queryAllByRole('alert')).toEqual([]);
    reply(json({ _tag: 'PinRefused', message: 'it changes nothing' }, 409));
    expect((await rail().findByRole('alert')).textContent).toBe(
      'Not unpinned: it changes nothing.',
    );
  });

  // A reply the page cannot read leaves a write unconfirmed. A
  // view of a shape this page does not know stands for it here; a declared
  // error status's undecodable body is covered under node
  // (failure-node.test.ts).
  it('says a pin answered with a reply this page cannot read is unconfirmed, and asks for a reload', async () => {
    serve.post = () => json({ inboxId: A, shape: 'from a newer serve' });
    await open();
    await pinVia(rowLink(A, 'store'), 'Pin the group store');
    const alert = await rail().findByRole('alert');
    expect(alert.textContent).toBe(`Unconfirmed: ${MISMATCH_MESSAGE}`);
    expect(alert.textContent).not.toMatch(/^Not /);
  });
});

describe('the machine sections', () => {
  const sectionOf = (label: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(
      `[data-machine-section="${label}"]`,
    );
    if (el === null) throw new Error(`no section ${label}`);
    return el;
  };
  const triggerOf = (label: string): HTMLElement =>
    within(sectionOf(label)).getAllByRole('button')[0] as HTMLElement;
  const inboxesIn = (label: string): string[] =>
    [
      ...sectionOf(label).querySelectorAll<HTMLElement>(
        '[data-rail-inbox]:not([data-rail-inbox=""])',
      ),
    ].map((a) => a.dataset.railInbox ?? '');
  const kept = () =>
    JSON.parse(
      localStorage.getItem('operator-inbox:inbox-machine-sections-open') ??
        '{}',
    );

  const open = async (shape: unknown = MACHINE_BOARD) => {
    serve.board = shape;
    await mounted();
    await openRail();
  };

  // The sidebar draws no machine heading: no status dot, no machine label.
  const expectNoMachineHeading = (): void => {
    expect(nav().querySelector('[data-machine-dot]')).toBeNull();
    expect(rail().queryByText('Local')).toBeNull();
  };

  it('draws All, then each machine in the board’s order, Local first', async () => {
    await open();
    // All first, with the board's own total.
    expect(rowText(rail().getAllByRole('link')[0] as Element)).toBe('All4');
    const sections = [
      ...nav().querySelectorAll<HTMLElement>('[data-machine-section]'),
    ];
    expect(sections.map((x) => x.dataset.machineSection)).toEqual([
      'Local',
      'laptop',
      'desktop',
      'old',
    ]);
    expect(sections.map((x) => x.dataset.machineKey)).toEqual([
      'local',
      '3010',
      '3011',
      '3012',
    ]);
    expect(sections.map((x) => x.dataset.machineStatus)).toEqual([
      'local',
      'reachable',
      'unreachable',
      'incompatible',
    ]);
    // The port for other machines only, in the title.
    expect(
      sections.map((x) => within(x).getAllByRole('button')[0]?.title),
    ).toEqual([
      'Local: this machine',
      'laptop: 127.0.0.1:3010, reachable',
      'desktop: 127.0.0.1:3011, unreachable',
      'old: 127.0.0.1:3012, incompatible',
    ]);
    // Each dot in its status's colour.
    expect(
      sections.map(
        (x) =>
          [...(x.querySelector('[data-machine-dot]')?.classList ?? [])].find(
            (c) => c.startsWith('bg-'),
          ) ?? '',
      ),
    ).toEqual(['bg-green', 'bg-green', 'bg-red', 'bg-orange']);
    // Two Inboxes named orchard stay apart, each in its own machine's section,
    // and each links by its own id.
    expect(inboxesIn('Local')).toEqual([A]);
    expect(inboxesIn('laptop')).toEqual([M]);
    expect(
      sectionOf('laptop')
        .querySelector(`[data-rail-inbox="${M}"]`)
        ?.getAttribute('href'),
    ).toBe(`/inbox/${M}`);
    // Local's archived Inbox sits in Local's own Archived fold.
    expect(
      within(sectionOf('Local')).getByRole('button', {
        name: /Archived \(1\)/,
      }),
    ).toBeTruthy();
    expect(
      sectionOf('laptop').querySelector('[data-archived-section]'),
    ).toBeNull();
  });

  it('keys sections by machine, so a machine labelled as another keeps its own', async () => {
    // Two sections with one label: each keeps its own Inboxes and fold.
    const TWIN = { key: '3020', label: 'laptop' };
    const VIEW_T: WireView = { ...VIEW_B, inboxId: 'inbox-t', machine: TWIN };
    await open({
      ...MACHINE_BOARD,
      inboxes: [...MACHINE_BOARD.inboxes, summary(VIEW_T)],
      views: [...MACHINE_BOARD.views, VIEW_T],
      machines: [
        ...MACHINES.slice(0, 2),
        { status: 'reachable', ...TWIN, port: 3020, awaitingOperator: 1 },
      ],
    });
    const twins = [
      ...nav().querySelectorAll<HTMLElement>('[data-machine-section="laptop"]'),
    ];
    expect(twins.map((x) => x.dataset.machineKey)).toEqual(['3010', '3020']);
    const [first, second] = twins;
    if (first === undefined || second === undefined) throw new Error('none');
    fireEvent.click(within(second).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(kept()).toEqual({ '3020': false }));
    expect(
      within(first).getAllByRole('button')[0]?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('starts every section open but an unreachable one, and remembers a fold by key', async () => {
    await open();
    expect(
      ['Local', 'laptop', 'desktop', 'old'].map((l) =>
        triggerOf(l).getAttribute('aria-expanded'),
      ),
    ).toEqual(['true', 'true', 'false', 'true']);
    // Folding laptop hides its Inboxes and is kept in this browser by key.
    fireEvent.click(triggerOf('laptop'));
    await waitFor(() => expect(inboxesIn('laptop')).toEqual([]));
    await waitFor(() => expect(kept()).toEqual({ '3010': false }));
  });

  it('opens folded where this browser remembers it folded', async () => {
    localStorage.setItem(
      'operator-inbox:inbox-machine-sections-open',
      JSON.stringify({ '3010': false, '3011': true }),
    );
    await open();
    await waitFor(() =>
      expect(triggerOf('laptop').getAttribute('aria-expanded')).toBe('false'),
    );
    expect(triggerOf('desktop').getAttribute('aria-expanded')).toBe('true');
    expect(inboxesIn('laptop')).toEqual([]);
  });

  it('shows an unreachable machine’s tunnel command, with a copy button, once opened', async () => {
    await open();
    const writeText = stubClipboard();
    const hint = () =>
      sectionOf('desktop').querySelector('[data-machine-hint]');
    expect(hint()).toBeNull();
    fireEvent.click(triggerOf('desktop'));
    const tunnel = await waitFor(() => {
      const el = hint();
      if (el === null) throw new Error('no tunnel line');
      return el as HTMLElement;
    });
    expect(tunnel.querySelector('code')?.textContent).toBe(
      'operator-inbox tunnel desktop',
    );
    fireEvent.click(
      within(tunnel).getByRole('button', {
        name: 'Copy the command that opens the tunnel to desktop',
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('operator-inbox tunnel desktop'),
    );
    // An incompatible machine shows what Local's serve said, and core's advice
    // for it, the sentence doctor gives too.
    const old = sectionOf('old').querySelector('[data-machine-hint]');
    expect(old?.textContent).toBe(
      'its board did not decode: expected an array at inboxes. old runs an operator-inbox whose inbox contract this one cannot read: pull and `pnpm build` there, then restart its serve.',
    );
    expect(old?.querySelector('code')).toBeNull();
  });

  it('copies a tunnel command a shell reads as one word', async () => {
    await open({
      ...MACHINE_BOARD,
      machines: [
        LOCAL,
        { ...MACHINES[2], label: "operator's mac", key: '3011' },
      ],
    });
    const writeText = stubClipboard();
    fireEvent.click(triggerOf("operator's mac"));
    fireEvent.click(
      await within(sectionOf("operator's mac")).findByRole('button', {
        name: "Copy the command that opens the tunnel to operator's mac",
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "operator-inbox tunnel 'operator'\\''s mac'",
      ),
    );
  });

  it('opens a folded machine’s section to show a search match there', async () => {
    localStorage.setItem(
      'operator-inbox:inbox-machine-sections-open',
      JSON.stringify({ '3010': false }),
    );
    await open();
    await waitFor(() => expect(inboxesIn('laptop')).toEqual([]));
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search inboxes and groups' }),
      { target: { value: 'orchard' } },
    );
    await waitFor(() => expect(inboxesIn('laptop')).toEqual([M]));
    expect(inboxesIn('Local')).toEqual([A]);
  });

  it.each([
    ['no machines list', BOARD],
    ['Local alone', { ...BOARD, machines: [LOCAL] }],
    // A serve may send `machines: []` when it has no Inbox machines, and a newer page must still draw Local.
    ['an empty machines list', { ...BOARD, machines: [] }],
  ])('draws the single list, with no heading, on a board with %s', async (_, shape) => {
    await open(shape);
    expectNoMachineHeading();
    expect(rail().getAllByRole('link').map(rowText)).toEqual([
      'All3',
      'orchard2',
      'quarry1',
    ]);
  });
});

describe('the width', () => {
  const parts = async () => {
    await mounted();
    await openRail();
    const handle = screen.getByRole('separator', {
      name: 'Drag to resize the inbox sidebar',
    });
    const rail = aside() as HTMLElement;
    // The test DOM lays nothing out.
    Object.defineProperty(rail, 'offsetWidth', { value: 300 });
    return { handle, rail };
  };

  it('starts at the design’s width, and the arrow keys resize it', async () => {
    const { handle, rail } = await parts();
    expect(rail.classList.contains('w-rail')).toBe(true);
    expect(rail.style.width).toBe('');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(rail.style.width).toBe('316px'));
    expect(rail.classList.contains('w-rail')).toBe(false);
    expect(handle.getAttribute('aria-valuenow')).toBe('316');
    await waitFor(() =>
      expect(localStorage.getItem('operator-inbox:inbox-rail-width')).toBe(
        '316',
      ),
    );
  });

  it('goes back to the design’s width on a double-click or Enter', async () => {
    const { handle, rail } = await parts();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(rail.style.width).toBe('316px'));
    fireEvent.doubleClick(handle);
    await waitFor(() => expect(rail.classList.contains('w-rail')).toBe(true));
    expect(rail.style.width).toBe('');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(rail.style.width).toBe('316px'));
    fireEvent.keyDown(handle, { key: 'Enter' });
    await waitFor(() => expect(rail.classList.contains('w-rail')).toBe(true));
  });

  it('opens at the width this browser remembers, and has no handle shut', async () => {
    localStorage.setItem('operator-inbox:inbox-rail-width', '300');
    await mounted();
    expect(screen.queryByRole('separator', { name: /resize/ })).toBeNull();
    await openRail();
    await waitFor(() => expect(aside()?.style.width).toBe('300px'));
  });
});

// A muted Inbox stays in the sidebar, greyed with its count; its groups fold
// away and its questions leave All, but picking it still shows them.
describe('muting', () => {
  const GROUPED_MUTED = board([
    {
      ...VIEW_A,
      muted: true,
      awaitingOperator: [
        inGroup(asked(1, 'First', 2), 'store'),
        asked(3, 'Third', 9),
      ],
    },
    VIEW_B,
  ]);

  const rowOf = (inboxId: string): HTMLElement =>
    nav()
      .querySelector(`[data-rail-inbox="${inboxId}"]`)
      ?.closest('[data-greyed-faded]') as HTMLElement;

  it('mutes an inbox from its row’s ⋯, and unmutes it', async () => {
    let muted = false;
    serve.post = () => {
      muted = !muted;
      serve.board = board([{ ...VIEW_A, muted }, VIEW_B]);
      return json({ ...VIEW_A, muted });
    };
    await mounted();
    fireEvent.click(
      within(await openMenu('orchard')).getByRole('menuitem', {
        name: 'Mute',
      }),
    );
    await waitFor(() => expect(rowOf(A).dataset.muted).toBe('true'));
    fireEvent.click(
      within(await openMenu('orchard')).getByRole('menuitem', {
        name: 'Unmute',
      }),
    );
    await waitFor(() => expect(rowOf(A).dataset.muted).toBeUndefined());
    expect(serve.posts).toEqual([
      { path: `/api/inbox/${A}/mute`, body: { muted: true } },
      { path: `/api/inbox/${A}/mute`, body: { muted: false } },
    ]);
  });

  it('greys a muted inbox, keeps its count, and hides its groups', async () => {
    serve.board = GROUPED_MUTED;
    await mounted();
    await openRail();
    expect(rowOf(A).dataset.muted).toBe('true');
    expect(rowText(rail().getByText('orchard'))).toBe('orchard2');
    expect(nav().querySelectorAll('[data-rail-group]')).toHaveLength(0);
    // All leaves the muted inbox's questions out of its count.
    expect(rowText(rail().getAllByRole('link')[0] as Element)).toBe('All1');
  });

  it('sorts a muted inbox to the bottom, even when pinned', async () => {
    const pinned = board([{ ...VIEW_A, muted: true }, VIEW_B]);
    serve.board = {
      ...pinned,
      inboxes: pinned.inboxes.map((i) =>
        i.inboxId === A ? { ...i, pinned: true } : i,
      ),
    };
    await mounted(`/inbox/${B}`);
    await openRail();
    expect(order()).toEqual([B, A]);
  });

  it('leaves a muted inbox’s questions out of All, and shows them when picked', async () => {
    serve.board = GROUPED_MUTED;
    await mounted(`/inbox/${B}`);
    await pickRow('All');
    await waitFor(() => expect(items()).toEqual([`${B}/1`]));
    await pickRow('orchard');
    await waitFor(() => expect(items()).toEqual([`${A}/1`, `${A}/3`]));
  });
});

// On a touch screen, by the device and not the width, the rows' menu is a ⋯
// over the box, beside `<>`, and `<>` and the session icon fold into it. jsdom draws no media query, so the classes stand for it.
describe('the menu over the box', () => {
  const button = () =>
    document.querySelector<HTMLElement>('[data-zen-inbox-menu]');

  it('is there on a touch screen only, by the device', async () => {
    await mounted();
    const b = button();
    expect(b?.getAttribute('aria-label')).toBe('More for orchard');
    expect(b?.classList.contains('hidden')).toBe(true);
    expect(b?.classList.contains('pointer-coarse:flex')).toBe(true);
    expect(
      [...(b?.classList ?? [])].some((c) => c.startsWith('compact:')),
    ).toBe(false);
    const meta = screen.getByRole('button', { name: 'Metadata' });
    expect(meta.closest('.pointer-coarse\\:hidden')).not.toBeNull();
  });

  it('holds the row menu’s lines, with Metadata for the lit question', async () => {
    let muted = false;
    serve.post = () => {
      muted = !muted;
      serve.board = board([{ ...VIEW_A, muted }, VIEW_B]);
      return json({ ...VIEW_A, muted });
    };
    await mounted();
    fireEvent.click(button() as HTMLElement);
    const menu = await screen.findByRole('menu');
    const lines = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    const words = ['Metadata', 'Rename', 'Pin', 'Archive', 'Mute'];
    expect(lines.map((l) => words.find((w) => l.startsWith(w)))).toEqual([
      'Metadata',
      'Rename',
      'Pin',
      'Archive',
      'Mute',
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mute' }));
    await waitFor(() =>
      expect(serve.posts).toEqual([
        { path: `/api/inbox/${A}/mute`, body: { muted: true } },
      ]),
    );
  });
});

// A right-click in the desktop app's window.
// Pake's injected script listens on the document, capturing, and takes any
// right-click inside a link for its own menu (pake-cli 3.17.5,
// `src-tauri/src/inject/event.js`). Copied here as it does it.
describe('a right-click in the desktop app’s window', () => {
  const pakeLinkMenu = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest('a') == null) return;
    event.preventDefault();
    event.stopPropagation();
  };
  let uninstall: () => void = () => undefined;

  beforeEach(() => {
    Object.assign(window, { pakeConfig: {} });
    document.addEventListener('contextmenu', pakeLinkMenu, true);
  });
  afterEach(() => {
    uninstall();
    uninstall = () => undefined;
    document.removeEventListener('contextmenu', pakeLinkMenu, true);
    Reflect.deleteProperty(window, 'pakeConfig');
  });

  const rightClickLink = async () => {
    await openRail();
    const link = rail().getByText('orchard').closest('a') as HTMLElement;
    fireEvent.contextMenu(link, { clientX: 10, clientY: 10 });
  };

  it('opens the row’s menu on its link, past Pake’s link menu', async () => {
    uninstall = installRowContextMenu();
    await mounted();
    await rightClickLink();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Mute' })).toBeTruthy();
  });

  it('never opens without the redirect: Pake takes the click', async () => {
    await mounted();
    await rightClickLink();
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
