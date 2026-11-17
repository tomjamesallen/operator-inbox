import type { InboxId } from '@operator-inbox/core/api';
import { cleanup, render } from '@testing-library/react';
import { Clock } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { nowMillis } from '../src/clock';
import { freshMark, MarkShape } from '../src/components/inbox/marks';
import { FRESH_MS } from '../src/inbox-queues';
import { TestRegistry } from './registry';

const halfwayMark = (spent: boolean) => ({
  key: 'inbox-a/1',
  inboxId: 'inbox-a' as InboxId,
  at: nowMillis(Clock.Clock.defaultValue()) - FRESH_MS / 2,
  ...(spent ? { spent: true as const } : {}),
});

const drawn = (spent: boolean) => {
  const { container } = render(
    <TestRegistry>
      <MarkShape mark={freshMark(halfwayMark(spent))} className="size-1" />
    </TestRegistry>,
  );
  const el = container.querySelector<HTMLElement>('[data-zen-fresh]');
  if (el === null) throw new Error('no mark');
  return el;
};

describe("a new question's dot", () => {
  afterEach(cleanup);

  it('picks up the slow fade where it had got to', () => {
    const el = drawn(false);
    expect(el.className).toContain('animate-fresh');
    expect(el.className).not.toContain('animate-fresh-out');
    expect(el.style.animationDelay).toMatch(/^-\d/);
  });

  it('fades fast once spent, from the strength it had reached', () => {
    const el = drawn(true);
    expect(el.className).toContain('animate-fresh-out');
    expect(Number(el.style.opacity)).toBeCloseTo(0.5, 1);
  });
});
