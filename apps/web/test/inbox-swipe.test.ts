import { describe, expect, it } from 'vitest';
import {
  SWIPE_TOUCH_PX,
  SWIPE_WHEEL_PX,
  touchSwipeOf,
  WHEEL_AT_REST,
  type WheelGesture,
  wheelSwipeStep,
} from '../src/inbox-swipe';

const run = (samples: ReadonlyArray<[number, number, number]>) => {
  let gesture: WheelGesture = WHEEL_AT_REST;
  const steps: Array<1 | -1> = [];
  for (const [dx, dy, at] of samples) {
    const { next, by } = wheelSwipeStep(gesture, dx, dy, at);
    gesture = next;
    if (by !== undefined) steps.push(by);
  }
  return steps;
};

describe('a swipe on a trackpad', () => {
  it('steps once the fingers have gone far enough, by their direction', () => {
    expect(run([[SWIPE_WHEEL_PX, 0, 0]])).toEqual([1]);
    expect(run([[-SWIPE_WHEEL_PX, 0, 0]])).toEqual([-1]);
    expect(run([[SWIPE_WHEEL_PX - 1, 0, 0]])).toEqual([]);
  });

  it('steps once for a whole gesture, the momentum after it included', () => {
    const tail = Array.from(
      { length: 40 },
      (_, i) => [50, 0, i * 16] as [number, number, number],
    );
    expect(run(tail)).toEqual([1]);
  });

  it('steps again after the wheel has rested', () => {
    expect(
      run([
        [SWIPE_WHEEL_PX, 0, 0],
        [SWIPE_WHEEL_PX, 0, 1000],
      ]),
    ).toEqual([1, 1]);
  });

  it('leaves a gesture that is mostly vertical to the scroll', () => {
    expect(
      run([
        [70, 80, 0],
        [70, 80, 16],
      ]),
    ).toEqual([]);
  });
});

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
