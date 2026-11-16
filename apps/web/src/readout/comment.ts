import type { ReadoutTimedSegment } from '@operator-inbox/core/api';
import { type Anchor, anchorIn, COMMENTABLE } from '../comments';
import { cursorAt, locate, rangeOf } from './locate';
import { type Script, spokenOf } from './script';

// A comment on the paragraph being read: the segment under the cursor,
// whole, as if the operator had selected it. A table or a code block is
// quoted by its own text; a diagram or a drawing has none to quote, so it
// gives nothing. Only a Question in Your inbox has a commentable body.

export const readingAnchor = (
  doc: Document,
  key: string,
  script: Script,
  timed: ReadonlyArray<ReadoutTimedSegment>,
  t: number,
): Anchor | undefined => {
  const wrapper = doc.querySelector(`[${COMMENTABLE}="${CSS.escape(key)}"]`);
  const item = doc.querySelector(`[data-zen-item="${CSS.escape(key)}"]`);
  if (wrapper === null || item === null) return undefined;
  const seg = script.segments[cursorAt(timed, t).seg];
  if (seg === undefined) return undefined;
  const located = locate(item, seg);
  if (located === undefined) return undefined;
  let range: Range | undefined;
  if (located.unit !== undefined)
    range = rangeOf(located.unit, 0, spokenOf(located.unit.nodes).text.length);
  else {
    range = doc.createRange();
    range.selectNodeContents(located.el);
  }
  return range === undefined ? undefined : anchorIn(wrapper, range);
};
