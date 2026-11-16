import type { InboxId } from '@operator-inbox/core/api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DrawnBoard } from '../src/inbox';
import { elsewhereRowsOf } from '../src/inbox-elsewhere';
import { pickerInboxesOf } from '../src/inbox-picker';
import {
  homeKeyOf,
  type PriorityInfo,
  type PriorityTrip,
  priorityCountOf,
  priorityInfoOf,
  pullAfterAnswer,
  tripStepOf,
} from '../src/inbox-priority';
import {
  A,
  asked,
  B,
  board,
  box,
  C,
  litKey,
  mounted,
  openRail,
  openRowMenu,
  prefix,
  reread,
  serve,
  settle,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  VIEW_C,
  type WireView,
} from './inbox-page-harness';

// The priority Inbox: one Inbox the operator marks, which pulls them back to
// it after each answer elsewhere. The interjection's card after every answer,
// the boomerang's round trip (a reload mid-trip, and the priority Inbox
// emptied by other means), the ambient count, and the order the lists of
// Inboxes take. All names are invented.

useInboxPage();

const id = (s: string) => s as InboxId;

/** `board(views)` with `priority` on the rows named. */
const marked = (
  views: ReadonlyArray<WireView>,
  priority: ReadonlyArray<string>,
) => {
  const b = board(views);
  return {
    ...b,
    inboxes: b.inboxes.map((i) =>
      priority.includes(i.inboxId) ? { ...i, priority: true } : i,
    ),
  };
};

const drawn = (b: object): DrawnBoard =>
  ({ ...b, greyed: new Set() }) as unknown as DrawnBoard;

const NONE: ReadonlySet<string> = new Set();

// B, quarry, is the priority Inbox: one Question waiting. A, orchard, has two.
const PRIORITY_B = marked([VIEW_A, VIEW_B], [B]);

const info = (over: Partial<PriorityInfo> = {}): PriorityInfo => ({
  inboxId: id(B),
  label: 'quarry',
  waiting: [asked(1, 'Quarry one', 7)] as never,
  pulls: true,
  ...over,
});

describe('what the priority Inbox holds', () => {
  it('is the row the board marks, its waiting oldest first, less answers on their way', () => {
    const b = marked(
      [
        VIEW_A,
        {
          ...VIEW_B,
          awaitingOperator: [asked(4, 'Later', 30), asked(2, 'Earlier', 8)],
        },
      ],
      [B],
    );
    const got = priorityInfoOf(drawn(b), new Set([`${B}/2`]));
    expect(got?.inboxId).toBe(B);
    expect(got?.waiting.map((q) => q.number)).toEqual([4]);
    expect(priorityInfoOf(drawn(board([VIEW_A, VIEW_B])), NONE)).toBe(
      undefined,
    );
  });

  it('does not pull while archived or muted, and keeps its mark', () => {
    const b = marked([VIEW_A, { ...VIEW_B, muted: true }], [B]);
    expect(priorityInfoOf(drawn(b), NONE)?.pulls).toBe(false);
    const c = marked([VIEW_A, VIEW_C], [C]);
    expect(priorityInfoOf(drawn(c), NONE)?.pulls).toBe(false);
  });
});

describe('the step boundary', () => {
  const at = (
    answeredIn: string,
    selected: string | undefined,
    over: Partial<PriorityInfo> = {},
    pull: 'interjection' | 'boomerang' = 'interjection',
  ) =>
    pullAfterAnswer({
      priority: info(over),
      answeredIn: id(answeredIn),
      selected: selected === undefined ? undefined : id(selected),
      pull,
    });

  it('interjects after every answer elsewhere, in an Inbox or in All', () => {
    expect(at(A, A)).toBe('interject');
    expect(at(A, undefined)).toBe('interject');
    expect(at(A, A, {}, 'boomerang')).toBe('boomerang');
  });

  it('stays when nothing waits there, it does not pull, or the answer was its own', () => {
    expect(at(A, A, { waiting: [] })).toBe('stay');
    expect(at(A, A, { pulls: false })).toBe('stay');
    expect(at(B, undefined)).toBe('stay');
    expect(at(B, B)).toBe('stay');
  });
});

describe('the ambient count', () => {
  it('counts what waits there while the operator is elsewhere, All included', () => {
    expect(priorityCountOf(info(), id(A))).toBe(1);
    expect(priorityCountOf(info(), undefined)).toBe(1);
  });

  it('is nothing in the priority Inbox itself, or while it does not pull', () => {
    expect(priorityCountOf(info(), id(B))).toBe(0);
    expect(priorityCountOf(info({ pulls: false }), id(A))).toBe(0);
    expect(priorityCountOf(undefined, id(A))).toBe(0);
  });
});

describe('the boomerang’s trip', () => {
  const trip: PriorityTrip = {
    priority: id(B),
    from: { inboxId: id(A), label: 'orchard', groups: [], key: `${A}/3` },
  };
  const step = (
    over: Partial<Parameters<typeof tripStepOf>[0]> = {},
  ): ReturnType<typeof tripStepOf> =>
    tripStepOf({
      trip,
      priority: info(),
      selected: id(B),
      boardRead: true,
      ...over,
    });

  it('keeps while the priority Inbox has something, and before the first board', () => {
    expect(step()).toBe('keep');
    expect(step({ priority: undefined, boardRead: false })).toBe('keep');
  });

  it('comes home once nothing waits there, whatever emptied it', () => {
    expect(step({ priority: info({ waiting: [] }) })).toBe('home');
  });

  it('ends on a pick elsewhere, or once the Inbox is no longer the priority one', () => {
    expect(step({ selected: id(A) })).toBe('end');
    expect(step({ selected: undefined })).toBe('end');
    expect(step({ priority: undefined })).toBe('end');
    expect(step({ priority: info({ inboxId: id(C) }) })).toBe('end');
    expect(step({ priority: info({ pulls: false }) })).toBe('end');
  });

  it('lands home on the Question it left for, or the oldest still waiting there', () => {
    const b = drawn(PRIORITY_B);
    expect(homeKeyOf(b, trip, NONE)).toBe(`${A}/3`);
    // Answered meanwhile: the oldest still waiting in orchard.
    expect(homeKeyOf(b, trip, new Set([`${A}/3`]))).toBe(`${A}/1`);
    // From All: the oldest in any Inbox All shows.
    expect(
      homeKeyOf(
        b,
        { ...trip, from: { ...trip.from, inboxId: null, key: null } },
        NONE,
      ),
    ).toBe(`${A}/1`);
  });
});

describe('the order of the lists of Inboxes', () => {
  // A needs attention (an answer stale with the agent), B is the priority
  // Inbox, C waits.
  const views = [VIEW_A, VIEW_B, { ...VIEW_C, archived: false, label: 'kiln' }];
  const now = Date.parse('2026-10-09T12:00:00.000Z');
  const FIVE = 5 * 60_000;

  it('the picker: priority, then needs attention, then the rest as before', () => {
    const rows = pickerInboxesOf(drawn(marked(views, [B])), now, FIVE, []);
    expect(rows.map((r) => r.key)).toEqual([B, A, C]);
    // Unmarked, the order is as it was.
    expect(
      pickerInboxesOf(drawn(board(views)), now, FIVE, []).map((r) => r.key),
    ).toEqual([A, B, C]);
  });

  it('the picker puts the priority Inbox on top though nothing waits there', () => {
    const quiet = [VIEW_A, { ...VIEW_B, awaitingOperator: [] }];
    const rows = pickerInboxesOf(drawn(marked(quiet, [B])), now, FIVE, []);
    expect(rows[0]?.key).toBe(B);
  });

  it('the empty state’s list leads with the priority Inbox', () => {
    const rows = elsewhereRowsOf(
      drawn(marked(views, [B])),
      undefined,
      now,
      FIVE,
      [],
    );
    expect(rows.map((r) => [r.inboxId, r.priority])).toEqual([
      [B, true],
      [A, false],
      [C, false],
    ]);
  });
});

// --- on the page ---------------------------------------------------------------------

const card = () => document.querySelector('[data-priority-card]');
const pill = () => document.querySelector('[data-priority-trip]');
const answer = async (text: string) => {
  type(text);
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  await settle();
};
const boomerang = () => {
  serve.config = { ...(serve.config as object), priorityPull: 'boomerang' };
};

describe('marking it', () => {
  it('marks an Inbox from its row’s menu, and the flag follows the board', async () => {
    await mounted(`/inbox/${A}`);
    await openRail();
    const menu = await openRowMenu('quarry');
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: /Mark as priority/ }),
    );
    await waitFor(() =>
      expect(serve.posts).toContainEqual({
        path: `/api/inbox/${B}/priority`,
        body: { priority: true },
      }),
    );
    await reread(PRIORITY_B);
    await openRail();
    expect(document.querySelectorAll('nav [data-priority-flag]')).toHaveLength(
      1,
    );
    // On another Inbox, the item replaces it.
    const other = await openRowMenu('orchard');
    expect(
      within(other).getByRole('menuitem', { name: /Make priority instead/ }),
    ).toBeTruthy();
  });

  it('marks the Inbox in hand by key', async () => {
    await mounted(`/inbox/${A}`);
    prefix();
    fireEvent.keyDown(document, { key: '!', code: 'Digit1', shiftKey: true });
    await waitFor(() =>
      expect(serve.posts).toContainEqual({
        path: `/api/inbox/${A}/priority`,
        body: { priority: true },
      }),
    );
  });
});

describe('the interjection', () => {
  it('shows the card after every answer elsewhere; Esc carries on only until the next', async () => {
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${A}`);
    expect(card()).toBeNull();
    await answer('One.');
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()?.textContent).toContain('quarry has a question waiting');
    expect(card()?.textContent).toContain('Quarry one');
    // The card takes the focus, so ↩ reaches Go there; Esc carries on.
    expect(document.activeElement?.hasAttribute('data-priority-card-go')).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await waitFor(() => expect(card()).toBeNull());
    expect(location.pathname).toBe(`/inbox/${A}`);
    await answer('Three.');
    await waitFor(() => expect(card()).not.toBeNull());
    fireEvent.click(
      document.querySelector('[data-priority-card-go]') as Element,
    );
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${B}`));
    expect(card()).toBeNull();
  });

  it('shows no card while the priority Inbox is muted', async () => {
    serve.board = marked([VIEW_A, { ...VIEW_B, muted: true }], [B]);
    await mounted(`/inbox/${A}`);
    await answer('One.');
    expect(card()).toBeNull();
  });
});

describe('the boomerang', () => {
  it('goes there after an answer, survives a reload, and comes home when it empties by other means', async () => {
    boomerang();
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${A}`);
    await answer('One.');
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${B}`));
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(pill()?.textContent).toContain('1 priority left, then back to');
    expect(pill()?.textContent).toContain('orchard');
    expect(sessionStorage.getItem('operator-inbox:priority-trip')).toContain(
      `${A}/3`,
    );
    // A reload of the tab, mid-trip: the way home is kept.
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    await mounted(`/inbox/${B}`);
    await waitFor(() => expect(pill()).not.toBeNull());
    // The priority Inbox empties without an answer here (another tab).
    await reread(marked([VIEW_A, { ...VIEW_B, awaitingOperator: [] }], [B]));
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    expect(pill()).toBeNull();
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    expect(sessionStorage.getItem('operator-inbox:priority-trip')).toBe('null');
  });

  it('comes home on the last priority answer, and Back now comes home early', async () => {
    boomerang();
    serve.board = marked(
      [
        VIEW_A,
        {
          ...VIEW_B,
          awaitingOperator: [asked(1, 'Quarry one', 7), asked(2, 'Two', 8)],
        },
      ],
      [B],
    );
    await mounted(`/inbox/${A}`);
    await answer('One.');
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(pill()?.textContent).toContain('2 priority left');
    await answer('Quarry.');
    await waitFor(() =>
      expect(pill()?.textContent).toContain('1 priority left'),
    );
    fireEvent.click(document.querySelector('[data-priority-back]') as Element);
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    expect(pill()).toBeNull();
  });

  it('ends the trip when the operator picks another Inbox', async () => {
    boomerang();
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${A}`);
    await answer('One.');
    await waitFor(() => expect(pill()).not.toBeNull());
    prefix();
    fireEvent.keyDown(document, { key: 'i' });
    const field = await screen.findByTestId('inbox-picker-field');
    fireEvent.change(field, { target: { value: 'orchard' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    await settle();
    expect(pill()).toBeNull();
    expect(sessionStorage.getItem('operator-inbox:priority-trip')).toBe('null');
  });
});

describe('the ambient indicator', () => {
  const button = () => document.querySelector('[data-priority-button]');
  const dot = () => document.querySelector('[data-burger-priority]');
  const burger = () => document.querySelector('[data-rail-burger]');
  const picker = () => document.querySelector('[data-testid="inbox-picker"]');

  it('counts what waits there while the operator is elsewhere, and opens the inbox picker', async () => {
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${A}`);
    await waitFor(() => expect(button()).not.toBeNull());
    expect(button()?.querySelector('[data-priority-count]')?.textContent).toBe(
      '1',
    );
    expect(button()?.closest('[data-foot-alerts]')).not.toBeNull();
    expect(button()?.getAttribute('aria-label')).toBe(
      'quarry has a question waiting — open the inbox picker',
    );
    fireEvent.click(button() as Element);
    const opened = await waitFor(() => {
      const el = picker();
      if (el === null) throw new Error('no picker');
      return el;
    });
    // Its own list is gone: the picker, with the priority Inbox first.
    expect(document.querySelector('[data-priority-list]')).toBeNull();
    expect(
      opened
        .querySelector('[data-testid="inbox-picker-row"]')
        ?.getAttribute('data-key'),
    ).toBe(B);
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    // A second click shuts it, as the chase button's does.
    fireEvent.click(button() as Element);
    await waitFor(() => expect(picker()).toBeNull());
  });

  // On a phone the flag gives way to a dot on the burger; the breakpoint is
  // CSS's (`compact:`), so this reads the classes that ask for it.
  it('is a dot on the burger on a phone, under the same condition', async () => {
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${A}`);
    await waitFor(() => expect(dot()).not.toBeNull());
    expect(button()?.className).toContain('compact:hidden');
    expect(dot()?.className).toContain('hidden');
    expect(dot()?.className).toContain('compact:block');
    expect(dot()?.className).toContain('bg-priority');
    expect(burger()?.contains(dot())).toBe(true);
    expect(burger()?.getAttribute('aria-label')).toBe(
      'Sidebar, priority: quarry has a question waiting',
    );
  });

  it('puts no dot on the burger in the priority Inbox itself', async () => {
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${B}`);
    await settle();
    expect(dot()).toBeNull();
    expect(burger()?.getAttribute('aria-label')).toBe('Sidebar');
  });

  it('is not there in the priority Inbox itself', async () => {
    serve.board = PRIORITY_B;
    await mounted(`/inbox/${B}`);
    await settle();
    expect(button()).toBeNull();
  });
});
