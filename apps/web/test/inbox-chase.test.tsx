import { fireEvent, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { clockAtom } from '../src/clock';
import { chasesOf, isStale } from '../src/inbox-chase';
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
// time is marked with a Chase link beside it, and a warning button counts the
// Inboxes holding one and opens the inbox picker.

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

describe('the Inboxes to chase', () => {
  it('lists each Inbox with its stale questions', () => {
    expect(
      chasesOf(drawn([linkedA, VIEW_B]), at('11:20'), FIVE).map((c) => [
        c.inboxId,
        c.numbers,
      ]),
    ).toEqual([[A, [2, 6]]]);
  });

  it('leaves out an Inbox muted or archived', () => {
    expect(
      chasesOf(
        drawn([
          { ...VIEW_A, muted: true },
          { ...VIEW_A, inboxId: B, archived: true },
        ]),
        at('11:20'),
        FIVE,
      ),
    ).toEqual([]);
  });
});

const card = (key: string) =>
  document.querySelector<HTMLElement>(`[data-zen-item="${key}"]`);

const chaseButton = () =>
  document.querySelector<HTMLElement>('[data-chase-button]');

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

  it('shows the button with the count, and it opens and shuts the picker', async () => {
    serve.board = board([linkedA, VIEW_B]);
    mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:25')]]);
    await waitFor(() => expect(chaseButton()).not.toBeNull());
    // In the reader's foot, beside or above the answer box, in its stack of
    // alerts.
    expect(
      chaseButton()
        ?.closest('[data-foot-alerts]')
        ?.parentElement?.contains(document.querySelector('[data-zen-answer]')),
    ).toBe(true);
    expect(
      chaseButton()?.querySelector('[data-chase-count]')?.textContent,
    ).toBe('1');
    expect(chaseButton()?.getAttribute('aria-label')).toBe(
      '1 Inbox probably needs chasing — open the inbox picker',
    );
    fireEvent.click(chaseButton() as HTMLElement);
    const picker = await waitFor(() => {
      const el = document.querySelector('[data-testid="inbox-picker"]');
      if (el === null) throw new Error('no picker');
      return el;
    });
    // The Inbox to chase comes first.
    expect(
      picker
        .querySelector('[data-testid="inbox-picker-row"]')
        ?.getAttribute('data-key'),
    ).toBe(A);
    fireEvent.keyDown(
      picker.querySelector('[data-testid="inbox-picker-field"]') as HTMLElement,
      { key: 'Escape' },
    );
    await waitFor(() =>
      expect(document.querySelector('[data-testid="inbox-picker"]')).toBeNull(),
    );
    // Nothing folds it away while there is something to chase.
    await settle();
    expect(chaseButton()).not.toBeNull();
  });

  it('takes the threshold from config.json’s chaseAfterMinutes', async () => {
    serve.config = {
      metadata: { extras: 'allow', keys: [] },
      chaseAfterMinutes: 2,
    };
    // Two minutes after #2's answer, three after #6's.
    mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:14')]]);
    await waitFor(() => expect(chaseButton()).not.toBeNull());
  });

  it('shows no button before five minutes', async () => {
    mount(`/inbox/${B}`, [[clockAtom, await clockAt('11:14')]]);
    await waitFor(() => expect(items().length).toBeGreaterThan(0));
    await settle();
    expect(chaseButton()).toBeNull();
  });
});
