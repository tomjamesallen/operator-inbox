import { describe, expect, it } from 'vitest';
import {
  SCRUB_IDLE,
  SCRUB_START_PX,
  type ScrubGesture,
  type ScrubInput,
  type ScrubStep,
  scrubKeyAt,
  scrubStep,
} from '../src/inbox-scrub';

// The minimap's scrub, apart from the DOM: which question a finger is over,
// and when a press turns into a scrub. All names are invented.

describe('the question under the finger', () => {
  // Three rows, 10px each, from 100 down to 130.
  const rows = ['a', 'b', 'c'].map((key, i) => ({
    key,
    top: 100 + i * 10,
    bottom: 110 + i * 10,
  }));

  it('is the row the finger is on', () => {
    expect(scrubKeyAt(rows, 100)).toBe('a');
    expect(scrubKeyAt(rows, 109.9)).toBe('a');
    expect(scrubKeyAt(rows, 110)).toBe('b');
    expect(scrubKeyAt(rows, 125)).toBe('c');
  });

  it('holds the first above the minimap and the last below it', () => {
    expect(scrubKeyAt(rows, 0)).toBe('a');
    expect(scrubKeyAt(rows, 130)).toBe('c');
    expect(scrubKeyAt(rows, 900)).toBe('c');
  });

  it('is nothing when there are no rows', () =>
    expect(scrubKeyAt([], 100)).toBeUndefined());

  it('follows rows of any height', () => {
    const uneven = [
      { key: 'a', top: 0, bottom: 4 },
      { key: 'b', top: 4, bottom: 40 },
      { key: 'c', top: 40, bottom: 44 },
    ];
    expect(scrubKeyAt(uneven, 30)).toBe('b');
    expect(scrubKeyAt(uneven, 41)).toBe('c');
  });
});

describe('the gesture', () => {
  const run = (
    inputs: ReadonlyArray<ScrubInput>,
    from: ScrubGesture = SCRUB_IDLE,
  ): ReadonlyArray<ScrubStep> => {
    let gesture = from;
    return inputs.map((input) => {
      const step = scrubStep(gesture, input);
      gesture = step.next;
      return step;
    });
  };
  const down = (y: number, pointer = 1, scrubs = true): ScrubInput => ({
    type: 'down',
    pointer,
    y,
    scrubs,
  });
  const move = (y: number, pointer = 1): ScrubInput => ({
    type: 'move',
    pointer,
    y,
  });
  const up = (y: number, pointer = 1): ScrubInput => ({
    type: 'up',
    pointer,
    y,
  });

  it('leaves a tap to the click: no scrub, nothing to bring up', () => {
    const steps = run([down(200), move(202), up(202)]);
    expect(steps.some((s) => s.began || s.ended)).toBe(false);
    expect(steps.every((s) => s.at === undefined)).toBe(true);
    expect(steps.at(-1)?.next).toEqual(SCRUB_IDLE);
  });

  it('turns a press into a scrub once the finger has moved far enough', () => {
    const [, short, far] = run([
      down(200),
      move(200 + SCRUB_START_PX - 1),
      move(200 + SCRUB_START_PX),
    ]);
    expect(short?.began).toBeUndefined();
    expect(far).toMatchObject({
      began: true,
      at: 200 + SCRUB_START_PX,
      next: { _tag: 'Scrubbing', pointer: 1 },
    });
  });

  it('counts a drag upwards the same', () =>
    expect(run([down(200), move(190)])[1]?.began).toBe(true));

  it('follows the finger every move once scrubbing', () => {
    const steps = run([down(200), move(210), move(230), move(215)]);
    expect(steps.map((s) => s.at)).toEqual([undefined, 210, 230, 215]);
    expect(steps.filter((s) => s.began)).toHaveLength(1);
  });

  it('ends where the finger lifts', () =>
    expect(run([down(200), move(220), up(240)])[2]).toEqual({
      next: SCRUB_IDLE,
      at: 240,
      ended: true,
    }));

  it('ends with no last move when the browser takes the pointer back', () =>
    expect(
      run([down(200), move(220), { type: 'cancel', pointer: 1 }])[2],
    ).toEqual({ next: SCRUB_IDLE, ended: true }));

  it('ends nothing when a press is cancelled before it moved', () =>
    expect(run([down(200), { type: 'cancel', pointer: 1 }])[1]).toEqual({
      next: SCRUB_IDLE,
    }));

  it('never starts from a mouse', () => {
    const steps = run([down(200, 1, false), move(260), up(260)]);
    expect(steps.some((s) => s.began || s.ended || s.at !== undefined)).toBe(
      false,
    );
  });

  it('keeps to its own finger when a second one comes down', () => {
    const steps = run([
      down(200, 1),
      move(220, 1),
      down(300, 2),
      move(320, 2),
      up(320, 2),
      move(230, 1),
    ]);
    expect(steps[2]?.next).toEqual({ _tag: 'Scrubbing', pointer: 1 });
    expect(steps[3]?.at).toBeUndefined();
    expect(steps[4]?.ended).toBeUndefined();
    expect(steps[5]?.at).toBe(230);
  });
});
