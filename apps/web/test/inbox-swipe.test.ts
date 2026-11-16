import { describe, expect, it } from 'vitest';
import { SWIPE_TOUCH_PX, touchSwipeOf } from '../src/inbox-swipe';

describe('a swipe with a finger', () => {
  it('steps by the way the finger pushes the page', () => {
    expect(touchSwipeOf(-SWIPE_TOUCH_PX, 0)).toBe(1);
    expect(touchSwipeOf(SWIPE_TOUCH_PX, 0)).toBe(-1);
  });

  it('ignores a short drag and a mostly vertical one', () => {
    expect(touchSwipeOf(SWIPE_TOUCH_PX - 1, 0)).toBeUndefined();
    expect(touchSwipeOf(SWIPE_TOUCH_PX, SWIPE_TOUCH_PX)).toBeUndefined();
  });
});
