import { fireEvent, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { clockAtom } from '../src/clock';
import { chaseLine, chaseToastsOf, isStale } from '../src/inbox-chase';
import {
  A,
  answered,
  B,
  board,
  items,
  mount,
  onQueue,
  serve,
  settle,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Chasing a question that sits with the agent: past five minutes its card's
// time is marked with a Chase link beside it, and its Inbox raises a toast
// that stays until dismissed.

useInboxPage();

// The default threshold, which the harness holds off.
beforeEach(() => {
  serve.config = { metadata: { extras: 'allow', keys: [] } };
});

const LINK_A = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';

// VIEW_A's two answers landed at 11:11 (#6) and 11:12 (#2).
const at = (time: string) => Date.parse(`2026-10-09T${time}:00.000Z`);

const clockAt = async (time: string) => {
  const clock = Effect.runSync(TestClock.make().pipe(Effect.scoped));
  await Effect.runPromise(clock.setTime(at(time)));
  return clock;
};

const FIVE = 5 * 60_000;

const linkedA = { ...VIEW_A, metadata: { sessionLink: LINK_A } };

const drawn = (views: ReadonlyArray<object>) =>
  // The pure functions read only `views` and `machines`.
  board(views as never) as never;

describe('which questions are stale', () => {
  const q = answered(6, 'Sixth', 11, 'Six.') as never;

  it('turns stale at five minutes with the agent, not before', () => {
    expect(isStale(q, at('11:15') + 59_000, FIVE)).toBe(false);
    expect(isStale(q, at('11:16'), FIVE)).toBe(true);
  });

  it('never calls a question with no stamp stale', () => {
    const {
      answeredAt: _a,
      askedAt: _b,
      ...bare
    } = answered(6, 'Sixth', 11, 'Six.');
    expect(isStale(bare as never, at('23:59'), FIVE)).toBe(false);
  });
});

describe('the toasts', () => {
  it('raises one per Inbox, naming each stale question', () => {
    const toasts = chaseToastsOf(
      drawn([linkedA, VIEW_B]),
      at('11:20'),
      FIVE,
      new Set(),
    );
    expect(toasts.map((t) => [t.inboxId, t.numbers])).toEqual([[A, [2, 6]]]);
    expect(toasts[0]?.target).toEqual({ _tag: 'Here', link: LINK_A });
    expect(chaseLine(toasts[0] as never)).toBe(
      '2 questions (#2, #6) in orchard have sat with the agent for 9m.',
    );
  });

  it('names each question by its code once its Inbox has one', () => {
    const coded = { ...VIEW_A, code: 'or-chd' };
    expect(
      chaseLine(
        chaseToastsOf(drawn([coded]), at('11:20'), FIVE, new Set())[0] as never,
      ),
    ).toBe(
      '2 questions (or-chd#2, or-chd#6) in orchard have sat with the agent for 9m.',
    );
    expect(
      chaseLine(
        chaseToastsOf(
          drawn([coded]),
          at('11:20'),
          FIVE,
          new Set([`${A}/2`]),
        )[0] as never,
      ),
    ).toBe('or-chd#6 in orchard has sat with the agent for 9m.');
  });

  it('leaves out a dismissed question, and an Inbox muted or archived', () => {
    expect(
      chaseToastsOf(drawn([VIEW_A]), at('11:20'), FIVE, new Set([`${A}/2`]))[0]
        ?.numbers,
    ).toEqual([6]);
    expect(
      chaseToastsOf(
        drawn([
          { ...VIEW_A, muted: true },
          { ...VIEW_A, inboxId: B, archived: true },
        ]),
        at('11:20'),
        FIVE,
        new Set(),
      ),
    ).toEqual([]);
  });
});

const card = (key: string) =>
  document.querySelector<HTMLElement>(`[data-zen-item="${key}"]`);

const toast = () =>
  document.querySelector<HTMLElement>(`[data-chase-toast="${A}"]`);

describe('on the page', () => {
  it('marks a stale answer’s time and puts Chase beside it', async () => {
    serve.board = board([linkedA, VIEW_B]);
    mount(`/inbox/${A}`, [[clockAtom, await clockAt('11:21')]]);
    await onQueue(/With the agent/);
    await waitFor(() => expect(items()).toEqual([`${A}/2`, `${A}/6`]));
    // #6 has waited five minutes; #2, answered a minute later, has not.
    const six = card(`${A}/6`);
    expect(
      six?.querySelector('[data-zen-when]')?.hasAttribute('data-stale'),
    ).toBe(true);
    expect(
      six?.querySelector('[data-chase="here"]')?.getAttribute('href'),
    ).toBe(LINK_A);
    const two = card(`${A}/2`);
    expect(
      two?.querySelector('[data-zen-when]')?.hasAttribute('data-stale'),
    ).toBe(false);
    expect(two?.querySelector('[data-chase]')).toBeNull();
  });

  it('marks it with no Chase when the Inbox has no session link', async () => {
    mount(`/inbox/${A}`, [[clockAtom, await clockAt('11:25')]]);
    await onQueue(/With the agent/);
    await waitFor(() => expect(card(`${A}/6`)).not.toBeNull());
    expect(
      card(`${A}/6`)
        ?.querySelector('[data-zen-when]')
        ?.hasAttribute('data-stale'),
    ).toBe(true);
    expect(card(`${A}/6`)?.querySelector('[data-chase]')).toBeNull();
  });

  it('raises a toast with the session, which stays dismissed', async () => {
    serve.board = board([linkedA, VIEW_B]);
    const view = mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:25')]]);
    await waitFor(() => expect(toast()).not.toBeNull());
    // In the reader's foot, beside or above the answer box, never over it.
    expect(
      toast()
        ?.closest('[data-chase-toasts]')
        ?.parentElement?.contains(document.querySelector('[data-zen-answer]')),
    ).toBe(true);
    expect(toast()?.textContent).toContain('#2, #6');
    expect(
      toast()?.querySelector('[data-chase="here"]')?.getAttribute('href'),
    ).toBe(LINK_A);
    fireEvent.click(
      toast()?.querySelector('[aria-label="Dismiss"]') as HTMLElement,
    );
    await waitFor(() => expect(toast()).toBeNull());
    expect(
      JSON.parse(localStorage.getItem('operator-inbox:chase-dismissed') ?? ''),
    ).toEqual([`${A}/2`, `${A}/6`]);
    // A reload keeps it dismissed.
    view.unmount();
    mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:25')]]);
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    await settle();
    expect(toast()).toBeNull();
  });

  it('takes the threshold from config.json’s chaseAfterMinutes', async () => {
    serve.config = {
      metadata: { extras: 'allow', keys: [] },
      chaseAfterMinutes: 2,
    };
    // Two minutes after #2's answer, three after #6's.
    mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:14')]]);
    await waitFor(() => expect(toast()?.textContent).toContain('#2, #6'));
  });

  it('raises none before five minutes', async () => {
    mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:14')]]);
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    await settle();
    expect(toast()).toBeNull();
  });
});
