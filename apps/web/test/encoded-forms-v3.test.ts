import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AtomRegistry } from 'effect/reactivity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inboxRailWidthAtom } from '../src/inbox';

// Golden encodings for what the web app persists (see test/golden/v3/README.md).
// Every build must write and read the same bytes, so what a browser already
// holds stays readable. Never edit a golden to make a test pass.

const golden = (file: string): string =>
  readFileSync(join(import.meta.dirname, 'golden', 'v3', file), 'utf8');

// The exact localStorage key the sidebar's width lives under.
const RAIL_KEY = 'operator-inbox:inbox-rail-width';

// `Atom.kvs` reads and writes through an Effect runtime, so a step takes a
// turn of the event loop to reach localStorage.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('inboxRailWidthAtom (Atom.kvs over localStorage)', () => {
  let registry: AtomRegistry.AtomRegistry;
  let unmount: () => void;

  const open = async () => {
    registry = AtomRegistry.make();
    unmount = registry.mount(inboxRailWidthAtom);
    await settle();
  };

  const write = async (value: number | null) => {
    registry.set(inboxRailWidthAtom, value);
    await settle();
  };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    unmount();
    registry.dispose();
    localStorage.clear();
  });

  it('encodes a width as the golden bytes, under the exact key', async () => {
    await open();
    await write(176);
    expect(localStorage.getItem(RAIL_KEY)).toBe(golden('inbox-rail-width.txt'));
    expect(Object.keys(localStorage)).toEqual([RAIL_KEY]);
  });

  it('decodes the golden width back to the number', async () => {
    localStorage.setItem(RAIL_KEY, golden('inbox-rail-width.txt'));
    await open();
    expect(registry.get(inboxRailWidthAtom)).toBe(176);
    // Reading a decodable value leaves the stored bytes alone.
    expect(localStorage.getItem(RAIL_KEY)).toBe(golden('inbox-rail-width.txt'));
  });

  it('encodes null (the design’s width) as the golden bytes', async () => {
    await open();
    await write(176);
    await write(null);
    expect(localStorage.getItem(RAIL_KEY)).toBe(
      golden('inbox-rail-width-null.txt'),
    );
  });

  it('decodes the golden null back to null', async () => {
    localStorage.setItem(RAIL_KEY, golden('inbox-rail-width-null.txt'));
    await open();
    expect(registry.get(inboxRailWidthAtom)).toBeNull();
  });

  it('an absent key reads as the default, and the default is written back', async () => {
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
    await open();
    expect(registry.get(inboxRailWidthAtom)).toBeNull();
    // The default is written on first read: the key does not stay absent.
    expect(localStorage.getItem(RAIL_KEY)).toBe(
      golden('inbox-rail-width-null.txt'),
    );
    expect(Object.keys(localStorage)).toEqual([RAIL_KEY]);
  });

  it('a fractional width round-trips as JSON writes it', async () => {
    await open();
    await write(176.5);
    expect(localStorage.getItem(RAIL_KEY)).toBe('176.5');
    unmount();
    registry.dispose();
    await open();
    expect(registry.get(inboxRailWidthAtom)).toBe(176.5);
  });

  it.each([
    ['not JSON', 'garbage'],
    ['a JSON string, not a number', '"300"'],
  ])('an undecodable stored value (%s) reads as the default and is left in place', async (_label, stored) => {
    localStorage.setItem(RAIL_KEY, stored);
    await open();
    expect(registry.get(inboxRailWidthAtom)).toBeNull();
    expect(localStorage.getItem(RAIL_KEY)).toBe(stored);
  });
});
