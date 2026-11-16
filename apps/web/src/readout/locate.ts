import type {
  ReadoutTimedSegment,
  ReadoutWord,
} from '@operator-inbox/core/api';
import { type ReadUnit, type Segment, spokenOf, unitsOf } from './script';

// From a time in a Question's audio to a place on the page, and back. The
// body's HTML is never touched: a place is a Range over the body's own text
// nodes, drawn as boxes from its client rects, as the comment highlights are.

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Where the cursor is: the segment, and the word in it (-1 between words). */
export interface Cursor {
  readonly seg: number;
  readonly word: number;
}

// A word's timing starts a hair late against what is heard; leading it by
// 20 ms puts the underline on the word as it is said.
const WORD_LEAD = 0.02;

/** The segment and word being said at `t` seconds into the audio. */
export const cursorAt = (
  segments: ReadonlyArray<ReadoutTimedSegment>,
  t: number,
): Cursor => {
  let seg = 0;
  segments.forEach((s, i) => {
    if (s.start <= t + 0.001) seg = i;
  });
  let word = -1;
  (segments[seg]?.words ?? []).forEach((w, i) => {
    if (w.start <= t + WORD_LEAD) word = i;
  });
  return { seg, word };
};

/**
 * Where a jump of one paragraph goes from `t`: the start of the next segment
 * (`by` 1), or of the one before (`by` -1), except that back goes to the
 * start of this one when it is more than `grace` seconds in, as a player's
 * back button does. Undefined with no segments.
 */
export const jumpFrom = (
  segments: ReadonlyArray<ReadoutTimedSegment>,
  t: number,
  by: 1 | -1,
  grace = 1.5,
): ReadoutTimedSegment | undefined => {
  if (segments.length === 0) return undefined;
  const { seg } = cursorAt(segments, t);
  const into = t - (segments[seg]?.start ?? 0);
  const to = by === -1 && into > grace ? seg : seg + by;
  return segments[Math.max(0, Math.min(segments.length - 1, to))];
};

/** The sentence holding character `at`, as offsets into `text`. */
export const sentenceOf = (
  text: string,
  at: number,
): { readonly from: number; readonly to: number } => {
  const ends = [...text.matchAll(/[.!?:;]["'”’)\]]*(\s|$)/g)].map(
    (m) => (m.index ?? 0) + m[0].length,
  );
  let from = 0;
  for (const end of ends) {
    if (end > at) return { from, to: end };
    from = end;
  }
  return { from, to: text.length };
};

// --- finding a segment's element --------------------------------------------------

// The item's body is marked `data-readout-body`; its first child is the
// rendered body: one html block, itself the part, or a list of parts.
const partsOf = (itemEl: Element): ReadonlyArray<Element> => {
  const body = itemEl.querySelector('[data-readout-body]')?.firstElementChild;
  if (body === null || body === undefined) return [];
  return body.hasAttribute('data-question-body') ? [body] : [...body.children];
};

const htmlOf = (part: Element) =>
  part.hasAttribute('data-question-body')
    ? part
    : (part.querySelector('[data-question-body]') ?? undefined);

const textNodes = (el: Element): Text[] => {
  const out: Text[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode())
    out.push(n as Text);
  return out;
};

export interface Located {
  readonly el: Element;
  // Set for the title and for a read unit: the text nodes it owns.
  readonly unit?: ReadUnit;
}

/** The element a segment was made from, in the item drawn at `itemEl`. */
export const locate = (itemEl: Element, seg: Segment): Located | undefined => {
  if (seg.kind === 'title') {
    const h1 = itemEl.querySelector('article h1');
    if (h1 === null) return undefined;
    return { el: h1, unit: { kind: 'read', el: h1, nodes: textNodes(h1) } };
  }
  const part = partsOf(itemEl)[seg.part ?? -1];
  if (part === undefined) return undefined;
  if (seg.unit === undefined) return { el: part };
  const html = htmlOf(part);
  const unit = html === undefined ? undefined : unitsOf(html)[seg.unit];
  if (unit === undefined) return undefined;
  return unit.kind === 'read' ? { el: unit.el, unit } : { el: unit.el };
};

// --- ranges and boxes ---------------------------------------------------------------

/** A Range over characters `from`–`to` of a read unit's spoken text. */
export const rangeOf = (
  unit: ReadUnit,
  from: number,
  to: number,
): Range | undefined => {
  const { at } = spokenOf(unit.nodes);
  const a = at[from];
  const b = at[Math.min(to, at.length) - 1];
  if (a === undefined || b === undefined) return undefined;
  const r = unit.el.ownerDocument.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], Math.min(b[1] + 1, b[0].data.length));
  return r;
};

/** The client boxes of a Range or an element, relative to `origin`. */
export const boxesOf = (
  thing: Range | Element,
  origin: Element,
): ReadonlyArray<Box> => {
  const o = origin.getBoundingClientRect();
  // An element's one box; a Range's one per line it wraps over.
  const rects =
    thing instanceof Element
      ? [thing.getBoundingClientRect()]
      : [...thing.getClientRects()];
  return rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      top: r.top - o.top,
      left: r.left - o.left,
      width: r.width,
      height: r.height,
    }));
};

/**
 * A block's box as drawn, not as laid out: a wide diagram spills past its
 * part's box into the margin, so the box is the union of the element's and
 * of what it draws (an svg, an image, a canvas, a table, a code block), each
 * cut to any scrolling or clipping box between it and the element, so a part
 * scrolled away never widens it. The element's own box is cut across, to any
 * such box between it and the origin, so a table wider than the box it
 * scrolls in is drawn as wide as what shows.
 */
export const drawnBoxOf = (
  el: Element,
  origin: Element,
): ReadonlyArray<Box> => {
  let { left, top, right, bottom } = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  for (let a = el.parentElement; a !== null && a !== origin; ) {
    const cs = view?.getComputedStyle(a);
    if (cs === undefined) break;
    if (cs.overflowX !== 'visible') {
      const c = a.getBoundingClientRect();
      left = Math.max(left, c.left);
      right = Math.min(right, c.right);
    }
    a = a.parentElement;
  }
  for (const d of el.querySelectorAll('svg, img, canvas, table, pre')) {
    const b = d.getBoundingClientRect();
    let r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    for (let a = d.parentElement; a !== null && a !== el; a = a.parentElement) {
      const cs = view?.getComputedStyle(a);
      if (cs === undefined) break;
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const c = a.getBoundingClientRect();
      r = {
        left: Math.max(r.left, c.left),
        top: Math.max(r.top, c.top),
        right: Math.min(r.right, c.right),
        bottom: Math.min(r.bottom, c.bottom),
      };
    }
    if (r.right <= r.left || r.bottom <= r.top) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (right <= left || bottom <= top) return [];
  const o = origin.getBoundingClientRect();
  return [
    {
      top: top - o.top,
      left: left - o.left,
      width: right - left,
      height: bottom - top,
    },
  ];
};

// --- from a tap to a time ------------------------------------------------------------

const caretAt = (doc: Document, x: number, y: number) => {
  const d = doc as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const pos = d.caretPositionFromPoint?.(x, y);
  if (pos !== null && pos !== undefined)
    return { node: pos.offsetNode, offset: pos.offset };
  const r = doc.caretRangeFromPoint?.(x, y);
  return r === null || r === undefined
    ? undefined
    : { node: r.startContainer, offset: r.startOffset };
};

/** The word of a read unit holding character `char`, or its last. */
export const wordAt = (
  words: ReadonlyArray<ReadoutWord>,
  char: number,
): ReadoutWord | undefined =>
  words.find((w) => w.to > char) ?? words[words.length - 1];

/**
 * Where a tap at `x`, `y` on `target` in the item at `itemEl` seeks to: a
 * described block's description from anywhere on the block, or the word
 * under the tap. Undefined off the script.
 */
export const seekTargetAt = (
  itemEl: Element,
  segments: ReadonlyArray<Segment>,
  timed: ReadonlyArray<ReadoutTimedSegment>,
  target: Element,
  x: number,
  y: number,
): number | undefined => {
  const located = segments.map((s) => locate(itemEl, s));
  for (let i = 0; i < segments.length; i++) {
    const l = located[i];
    const t = timed[i];
    if (
      segments[i]?.kind === 'described' &&
      l !== undefined &&
      t !== undefined &&
      l.el.contains(target)
    )
      return t.start;
  }
  const caret = caretAt(itemEl.ownerDocument, x, y);
  if (caret === undefined) return undefined;
  for (let i = 0; i < segments.length; i++) {
    const unit = located[i]?.unit;
    const t = timed[i];
    if (unit === undefined || t === undefined) continue;
    if (!unit.nodes.includes(caret.node as Text)) continue;
    const { at, text } = spokenOf(unit.nodes);
    const idx = at.findIndex(([n, o]) => n === caret.node && o >= caret.offset);
    const word = wordAt(t.words, idx < 0 ? text.length - 1 : idx);
    return word?.start ?? t.start;
  }
  return undefined;
};
