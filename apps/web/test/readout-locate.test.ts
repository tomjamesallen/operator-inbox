import type { ReadoutTimedSegment } from '@operator-inbox/core/api';
import { describe, expect, it } from 'vitest';
import { followBy } from '../src/readout/follow';
import {
  cursorAt,
  jumpFrom,
  locate,
  rangeOf,
  sentenceOf,
  wordAt,
} from '../src/readout/locate';
import { lookaheadOf } from '../src/readout/readout';
import { scriptOf } from '../src/readout/script';

// The cue locator: from a time in the audio to a segment and a word, and
// from a segment to its place on the page.

const timed: ReadonlyArray<ReadoutTimedSegment> = [
  {
    id: 'title',
    start: 0,
    end: 1.2,
    words: [
      { from: 0, to: 4, start: 0.05, end: 0.4 },
      { from: 5, to: 9, start: 0.45, end: 1.1 },
    ],
  },
  {
    id: 'p0u0',
    start: 1.7,
    end: 4,
    words: [
      { from: 0, to: 3, start: 1.75, end: 2 },
      { from: 4, to: 9, start: 2.1, end: 2.6 },
    ],
  },
  { id: 'p0u1', start: 4.3, end: 6, words: [] },
];

describe('the cursor', () => {
  it('finds the segment and the word being said', () => {
    expect(cursorAt(timed, 0)).toEqual({ seg: 0, word: -1 });
    expect(cursorAt(timed, 0.5)).toEqual({ seg: 0, word: 1 });
    // In the pause after a segment the cursor stays on it.
    expect(cursorAt(timed, 1.5)).toEqual({ seg: 0, word: 1 });
    // A word is led by 20 ms, so the underline is on it as it is heard.
    expect(cursorAt(timed, 2.085)).toEqual({ seg: 1, word: 1 });
    expect(cursorAt(timed, 99)).toEqual({ seg: 2, word: -1 });
    expect(cursorAt([], 3)).toEqual({ seg: 0, word: -1 });
  });

  it('jumps a paragraph, back to this one’s start when well into it', () => {
    expect(jumpFrom(timed, 2, 1)?.id).toBe('p0u1');
    expect(jumpFrom(timed, 5, 1)?.id).toBe('p0u1');
    expect(jumpFrom(timed, 3.5, -1)?.id).toBe('p0u0');
    expect(jumpFrom(timed, 2, -1)?.id).toBe('title');
    expect(jumpFrom(timed, 0.2, -1)?.id).toBe('title');
    expect(jumpFrom([], 0, 1)).toBeUndefined();
  });

  it('finds the sentence round a character, and the word a tap lands in', () => {
    const text = 'One thing. Then: two? Last';
    expect(sentenceOf(text, 2)).toEqual({ from: 0, to: 11 });
    expect(sentenceOf(text, 12)).toEqual({ from: 11, to: 17 });
    expect(sentenceOf(text, 24)).toEqual({ from: 22, to: 26 });
    expect(wordAt(timed[1]?.words ?? [], 5)?.start).toBe(2.1);
    expect(wordAt(timed[1]?.words ?? [], 50)?.start).toBe(2.1);
  });
});

describe('a segment on the page', () => {
  // An item as the page draws it: the title, then the body in its parts.
  const item = () => {
    const el = document.createElement('div');
    el.innerHTML = `<article><h1>Ship it?</h1><div data-readout-body><div data-question-body><p>Run <code>downloadNow()</code> first.</p><table><tbody><tr><td>x</td></tr></tbody></table></div></div></article>`;
    return el;
  };

  it('finds the title, a read unit and a described block', () => {
    const el = item();
    const html = el.querySelector('[data-question-body]')?.innerHTML ?? '';
    const script = scriptOf({ title: 'Ship it?', bodyHtml: html });
    const [title, para, table] = script.segments;
    expect(title && locate(el, title)?.el.tagName).toBe('H1');
    const p = para && locate(el, para);
    expect(p?.el.tagName).toBe('P');
    expect(table && locate(el, table)?.el.tagName).toBe('TABLE');
    expect(table && locate(el, table)?.unit).toBeUndefined();
    // The spoken "download now" covers the code's own text on the page.
    if (p?.unit === undefined || para === undefined) return;
    const from = para.text.indexOf('download');
    const range = rangeOf(p.unit, from, from + 'download now'.length);
    expect(range?.toString()).toBe('downloadNow()');
  });
});

describe('following the reading', () => {
  const zone = { top: 40, bottom: 640, margin: 150 };
  it('moves nothing inside the catch zone, and just enough at its edges', () => {
    expect(followBy(zone, 300, 320)).toBe(0);
    expect(followBy(zone, 500, 520)).toBe(30);
    expect(followBy(zone, 100, 120)).toBe(-90);
    // Taller than the zone: its top is held at the high edge.
    expect(followBy(zone, 400, 1400)).toBe(210);
  });
});

describe('the lookahead', () => {
  it('fits as many Questions as the lit one lasts, from one to three', () => {
    expect(lookaheadOf([], undefined, 1)).toBe(1);
    // Made in a tenth of real time: three, the most.
    expect(lookaheadOf([{ duration: 60, generationMs: 6_000 }], 60, 1)).toBe(3);
    // A slow voice: a minute to make a minute.
    expect(lookaheadOf([{ duration: 60, generationMs: 60_000 }], 60, 1)).toBe(
      1,
    );
    // Faster playback leaves less time to make the next.
    expect(lookaheadOf([{ duration: 60, generationMs: 25_000 }], 60, 1)).toBe(
      2,
    );
    expect(lookaheadOf([{ duration: 60, generationMs: 25_000 }], 60, 1.5)).toBe(
      1,
    );
    // A cached one says nothing about how long making takes.
    expect(lookaheadOf([{ duration: 60, generationMs: 0 }], 60, 1)).toBe(1);
  });
});
