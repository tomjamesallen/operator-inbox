import { AtomRegistry } from 'effect/reactivity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  owlStirringAtom,
  STIR_GAP_MAX_MS,
  STIR_GAP_MIN_MS,
  STIR_MS,
} from '../src/owl-stir';

const fakeNow = () => vi.getMockedSystemTime()?.getTime() ?? 0;

describe('the owl stirring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sleeps until the shortest gap has passed', () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(owlStirringAtom);
    vi.advanceTimersByTime(STIR_GAP_MIN_MS - 1);
    expect(registry.get(owlStirringAtom)).toBe(false);
    unmount();
  });

  it('stirs for one stir, then settles', () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(owlStirringAtom);
    const changes: Array<[number, boolean]> = [];
    const started = fakeNow();
    registry.subscribe(owlStirringAtom, (on) =>
      changes.push([fakeNow() - started, on]),
    );
    vi.advanceTimersByTime(STIR_GAP_MAX_MS + STIR_MS);
    const [first, second] = changes;
    expect(first?.[1]).toBe(true);
    expect(second?.[1]).toBe(false);
    expect((second?.[0] ?? 0) - (first?.[0] ?? 0)).toBe(STIR_MS);
    unmount();
  });

  it('keeps every gap between starts in range', () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(owlStirringAtom);
    const starts: Array<number> = [];
    const started = fakeNow();
    registry.subscribe(owlStirringAtom, (on) => {
      if (on) starts.push(fakeNow() - started);
    });
    vi.advanceTimersByTime(50 * STIR_GAP_MAX_MS);
    expect(starts.length).toBeGreaterThanOrEqual(49);
    const gaps = starts.map((at, i) => at - (starts[i - 1] ?? 0));
    expect(new Set(gaps).size).toBeGreaterThan(1);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(STIR_GAP_MIN_MS);
      expect(gap).toBeLessThanOrEqual(STIR_GAP_MAX_MS);
    }
    unmount();
  });

  it('stops its timers when the owl leaves the page', async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(owlStirringAtom);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
