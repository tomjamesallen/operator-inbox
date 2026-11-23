import {
  COMMENT_CONTEXT,
  type CommentAnchor,
  commentsInBodyOrder,
  type QuestionComment,
} from '@operator-inbox/core/api';
import { Atom } from 'effect/reactivity';
import {
  cardRefOf,
  focusedMacroCardAtom,
  type MacroCard,
  type MacroFocus,
  type MacroMenu,
  macrosToSend,
} from './macros';

// Comments on a Question's text: select a span of the body, press `c` (or the
// floating button, the context menu, ⌘⌥M), and a card for the comment joins
// the stack under the answer box, ahead of the macros. The span stays lit in
// the body, drawn as boxes behind the text from the Range's client rects, so
// the body's HTML is never touched (`comment-body.tsx`). `/` in a comment's
// field opens the answer box's macro menu, and each macro picked is a card
// nested under the field, acting on the comment's quote. Every comment with
// words or a macro rides on the answer (core's `comments.ts`).
//
// The drafts live in memory, by answer key: a reload starts afresh.

// --- the anchor ------------------------------------------------------------------

/** The attribute on the element around a Question's body that takes comments. */
export const COMMENTABLE = 'data-commentable';

// The rendered markdown parts of a body: each its own `RenderedBody`. A
// diagram or a drawing is not one, so it is never counted in `at.part`.
const partsOf = (wrapper: Element): ReadonlyArray<Element> => [
  ...wrapper.querySelectorAll('[data-question-body]'),
];

const offsetIn = (root: Node, node: Node, offset: number): number => {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
};

export interface Anchor {
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly at: CommentAnchor;
}

// Whether the stretch between two points holds no words.
const blank = (from: Node, fromOffset: number, to: Node, toOffset: number) => {
  const r = document.createRange();
  r.setStart(from, fromOffset);
  r.setEnd(to, toOffset);
  return r.toString().trim() === '';
};

// The one part a range's words lie in, and the range cut to that part. A
// triple-click selects a paragraph by ending the range at the start of
// whatever follows it: the next paragraph, or, after a part's last block,
// something outside the part (the next part, the highlights' layer). So an
// end outside the part is brought back to the part's end, and a start outside
// it to the part's start, as long as only white space is cut off. A span whose
// words reach into two parts lies in neither.
const cutToPart = (
  parts: ReadonlyArray<Element>,
  range: Range,
): { readonly part: number; readonly range: Range } | undefined => {
  for (const [part, root] of parts.entries()) {
    if (!range.intersectsNode(root)) continue;
    const cut = document.createRange();
    cut.selectNodeContents(root);
    if (root.contains(range.startContainer))
      cut.setStart(range.startContainer, range.startOffset);
    else if (!blank(range.startContainer, range.startOffset, root, 0)) continue;
    if (root.contains(range.endContainer))
      cut.setEnd(range.endContainer, range.endOffset);
    else if (
      !blank(root, root.childNodes.length, range.endContainer, range.endOffset)
    )
      continue;
    return { part, range: cut };
  }
  return undefined;
};

/**
 * A selection's anchor, when its words lie inside one rendered part of
 * `wrapper`. White space at either end of the span is left out, so a drag
 * that starts or ends between words quotes the words alone, and a
 * triple-clicked paragraph quotes the paragraph alone. A span across parts
 * (text, a diagram, text) is not one.
 */
export const anchorIn = (
  wrapper: Element,
  range: Range,
): Anchor | undefined => {
  if (range.collapsed) return undefined;
  const parts = partsOf(wrapper);
  const cut = cutToPart(parts, range);
  const root = cut === undefined ? undefined : parts[cut.part];
  if (cut === undefined || root === undefined) return undefined;
  const { part } = cut;
  const text = root.textContent ?? '';
  let start = offsetIn(root, cut.range.startContainer, cut.range.startOffset);
  let end = offsetIn(root, cut.range.endContainer, cut.range.endOffset);
  while (start < end && /\s/.test(text[start] ?? '')) start++;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
  if (end <= start) return undefined;
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - COMMENT_CONTEXT), start),
    suffix: text.slice(end, end + COMMENT_CONTEXT),
    at: { part, start, end },
  };
};

/**
 * The span drawn again as a Range in `wrapper`, if its part is there and still
 * holds the quote at that place: `at` is only a hint, and a body that changed
 * under it draws nothing rather than the wrong words.
 */
export const rangeIn = (
  wrapper: Element,
  anchor: Pick<Anchor, 'at' | 'quote'>,
): Range | undefined => {
  const { at } = anchor;
  const root = partsOf(wrapper)[at.part];
  if (root === undefined) return undefined;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0;
    if (!started && at.start < seen + len) {
      range.setStart(n, at.start - seen);
      started = true;
    }
    if (started && at.end <= seen + len) {
      range.setEnd(n, at.end - seen);
      return range.toString() === anchor.quote ? range : undefined;
    }
    seen += len;
  }
  return undefined;
};

// --- where the selection is --------------------------------------------------------

export interface Point {
  readonly top: number;
  readonly left: number;
}

export interface CommentSelection {
  // The answer key of the body the selection is in.
  readonly key: string;
  readonly anchor: Anchor;
  // The end of its last line, from the body's top left: where the floating
  // button goes.
  readonly end: Point | undefined;
}

const visibleRects = (range: Range): ReadonlyArray<DOMRect> =>
  [...range.getClientRects()].filter((r) => r.width > 0.5);

const wrapperOf = (node: Node): Element | undefined =>
  (node instanceof Element ? node : node.parentElement)?.closest(
    `[${COMMENTABLE}]`,
  ) ?? undefined;

/** The document's selection, when it lies in one commentable body. Reads the page. */
export const readCommentSelection = (): CommentSelection | undefined => {
  const sel = document.getSelection();
  if (sel === null || sel.rangeCount === 0) return undefined;
  const range = sel.getRangeAt(0);
  // The body is the one the range's start is in, or else its end's: a
  // triple-clicked last paragraph ends past its body, at whatever follows.
  const found = [range.startContainer, range.endContainer]
    .map(wrapperOf)
    .flatMap((wrapper) => {
      const anchor =
        wrapper === undefined ? undefined : anchorIn(wrapper, range);
      return wrapper === undefined || anchor === undefined
        ? []
        : [{ wrapper, anchor }];
    })[0];
  const key = found?.wrapper.getAttribute(COMMENTABLE);
  if (found === undefined || key == null) return undefined;
  const { wrapper, anchor } = found;
  // The button goes at the end of the quoted words, not of the white space
  // or the next block the selection reached into.
  const last = visibleRects(rangeIn(wrapper, anchor) ?? range).at(-1);
  const origin = wrapper.getBoundingClientRect();
  return {
    key,
    anchor,
    end:
      last === undefined
        ? undefined
        : { top: last.top - origin.top, left: last.right - origin.left },
  };
};

/** The selection inside a commentable body, as `selectionchange` last left it. */
export const commentSelectionAtom = Atom.make<CommentSelection | undefined>(
  undefined,
).pipe(Atom.keepAlive);

const sameSelection = (
  a: CommentSelection | undefined,
  b: CommentSelection | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.key === b.key &&
    a.anchor.at.part === b.anchor.at.part &&
    a.anchor.at.start === b.anchor.at.start &&
    a.anchor.at.end === b.anchor.at.end &&
    a.end?.top === b.end?.top &&
    a.end?.left === b.end?.left);

/**
 * The one listener on the selection, for every body on the page, whether its
 * answer box is open or not: a box that opens after the selection was made
 * still finds it. Mounted by the page; it dies with it.
 */
export const commentSelectionWatchAtom: Atom.Atom<void> = Atom.readable(
  (get) => {
    if (typeof document === 'undefined') return;
    const read = () => {
      const next = readCommentSelection();
      if (!sameSelection(get.once(commentSelectionAtom), next))
        get.set(commentSelectionAtom, next);
    };
    document.addEventListener('selectionchange', read);
    window.addEventListener('resize', read);
    get.addFinalizer(() => {
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('resize', read);
    });
  },
);

// --- the drafts --------------------------------------------------------------------

export interface CommentDraft extends Anchor {
  // Its card's number among this answer's, never reused while it is open.
  readonly id: number;
  readonly text: string;
  // The macros invoked on it, as the answer's own cards are (`macros.ts`).
  readonly macros: ReadonlyArray<MacroCard>;
}

/** One answer's comments, by its key, in the order made. Memory only. */
export const commentsAtom = Atom.family((_key: string) =>
  Atom.make<ReadonlyArray<CommentDraft>>([]).pipe(Atom.keepAlive),
);

/** The comments in body order: how they are numbered, stacked and sent. */
export const commentsInOrderAtom = Atom.family((key: string) =>
  Atom.make((get) => commentsInBodyOrder(get(commentsAtom(key)))),
);

// A comment is sent when it has words or a macro: a macro is a whole comment
// on its own, as it is a whole answer.
const isSent = (c: CommentDraft): boolean =>
  c.text.trim() !== '' || c.macros.length > 0;

/** What the answer carries: the comments with words or macros, in body order. */
export const commentsToSend = (
  drafts: ReadonlyArray<CommentDraft>,
): ReadonlyArray<QuestionComment> =>
  commentsInBodyOrder(drafts)
    .filter(isSent)
    .map(({ quote, prefix, suffix, at, text, macros }) => {
      const [first, ...rest] = macrosToSend(macros);
      return {
        quote,
        prefix,
        suffix,
        at,
        text: text.trim(),
        ...(first === undefined ? {} : { macros: [first, ...rest] }),
      };
    });

/** Whether any comment would be sent, so the answer may be comments alone. */
export const isCommented = (drafts: ReadonlyArray<CommentDraft>): boolean =>
  drafts.some(isSent);

// --- the cards ---------------------------------------------------------------------

/** A comment's card id in the stack: `c<n>`, so it never meets a macro card's number. */
export const commentCardId = (id: number): `c${number}` => `c${id}`;

/** A comment card's one stop: its field. */
export const commentStop = (id: number): MacroFocus => ({
  _tag: 'Field',
  card: commentCardId(id),
  index: 0,
});

export const commentCardRef = (key: string, id: number): string =>
  cardRefOf(key, commentCardId(id));

/** The comment a card ref names, its own or one of its macros', if it names one. */
export const commentOfCardRef = (
  ref: string | undefined,
): { readonly key: string; readonly id: number } | undefined => {
  const m = ref?.match(/^(.*)#c(\d+)(?:m\d+)?$/);
  return m?.[1] === undefined || m[2] === undefined
    ? undefined
    : { key: m[1], id: Number(m[2]) };
};

/** The comment whose card has the focus: being written or edited. */
export const editingCommentAtom = Atom.make((get) =>
  commentOfCardRef(get(focusedMacroCardAtom)),
);

/**
 * The comment whose field is to take the focus, until it has. A request, not
 * an event: a card drawn after it was made (its answer box opening, a menu
 * shutting) still finds it, and takes the focus as it is drawn.
 */
export const commentFocusAskedAtom = Atom.make<
  { readonly key: string; readonly id: number } | undefined
>(undefined).pipe(Atom.keepAlive);

/** Whether the comment `id` of answer `key` is asked for the focus. */
export const isCommentFocusAskedAtom = Atom.family((ref: string) =>
  Atom.make((get) => {
    const asked = get(commentFocusAskedAtom);
    return asked !== undefined && commentCardRef(asked.key, asked.id) === ref;
  }),
);

/**
 * A new comment on `anchor`, its card's field asked for the focus, and the
 * selection let go so the highlight shows in its place. The same span asked
 * for twice is the one comment.
 */
export const startCommentAtom = Atom.writable(
  () => undefined,
  (ctx, req: { readonly key: string; readonly anchor: Anchor }): void => {
    const comments = ctx.get(commentsAtom(req.key));
    const { at } = req.anchor;
    const same = comments.find(
      (c) =>
        c.at.part === at.part && c.at.start === at.start && c.at.end === at.end,
    );
    document.getSelection()?.removeAllRanges();
    ctx.set(commentSelectionAtom, undefined);
    const id =
      same?.id ?? comments.reduce((top, c) => Math.max(top, c.id), 0) + 1;
    if (same === undefined)
      ctx.set(commentsAtom(req.key), [
        ...comments,
        { id, ...req.anchor, text: '', macros: [] },
      ]);
    ctx.set(commentFocusAskedAtom, { key: req.key, id });
  },
);

/** Ask for a comment's field, to edit it. */
export const editCommentAtom = Atom.writable(
  () => undefined,
  (ctx, req: { readonly key: string; readonly id: number }): void =>
    ctx.set(commentFocusAskedAtom, req),
);

export const setCommentTextAtom = Atom.writable(
  () => undefined,
  (
    ctx,
    req: { readonly key: string; readonly id: number; readonly text: string },
  ): void =>
    ctx.set(
      commentsAtom(req.key),
      ctx
        .get(commentsAtom(req.key))
        .map((c) => (c.id === req.id ? { ...c, text: req.text } : c)),
    ),
);

/** Write comment `id`'s macro cards. */
export const setCommentMacrosAtom = Atom.writable(
  () => undefined,
  (
    ctx,
    req: {
      readonly key: string;
      readonly id: number;
      readonly macros: ReadonlyArray<MacroCard>;
    },
  ): void =>
    ctx.set(
      commentsAtom(req.key),
      ctx
        .get(commentsAtom(req.key))
        .map((c) => (c.id === req.id ? { ...c, macros: req.macros } : c)),
    ),
);

/**
 * The `/` menu of each comment's field, by its card ref (`commentCardRef`):
 * its own, so the answer box's menu (`macroMenuAtom`) stays the answer's.
 */
export const commentMacroMenuAtom = Atom.family((_ref: string) =>
  Atom.make<MacroMenu | undefined>(undefined),
);

export const removeCommentAtom = Atom.writable(
  () => undefined,
  (ctx, req: { readonly key: string; readonly id: number }): void => {
    ctx.set(
      commentsAtom(req.key),
      ctx.get(commentsAtom(req.key)).filter((c) => c.id !== req.id),
    );
    const lit = ctx.get(litCommentAtom);
    if (lit?.key === req.key && lit.id === req.id)
      ctx.set(litCommentAtom, undefined);
  },
);

// --- lighting one ------------------------------------------------------------------

/** The comment the pointer is on, in the body or on its card. */
export const litCommentAtom = Atom.make<
  { readonly key: string; readonly id: number } | undefined
>(undefined).pipe(Atom.keepAlive);

export const isLit = (
  lit: { readonly key: string; readonly id: number } | undefined,
  key: string,
  id: number,
): boolean => lit !== undefined && lit.key === key && lit.id === id;

// The pointer crossing from one line of a highlight to the next passes over
// the gap between them, so leaving waits a moment before it puts one out.
const LEAVE_MS = 160;
let leaving: ReturnType<typeof setTimeout> | undefined;

/** The pointer is on a comment, or has left one (`undefined`). */
export const hoverCommentAtom = Atom.writable(
  () => undefined,
  (
    ctx,
    to: { readonly key: string; readonly id: number } | undefined,
  ): void => {
    clearTimeout(leaving);
    if (to === undefined) {
      leaving = setTimeout(() => ctx.set(litCommentAtom, undefined), LEAVE_MS);
      return;
    }
    if (!isLit(ctx.get(litCommentAtom), to.key, to.id))
      ctx.set(litCommentAtom, to);
  },
);

// --- the drawn highlights ----------------------------------------------------------

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface Drawn {
  readonly id: number;
  readonly boxes: ReadonlyArray<Box>;
}

/** Each comment's span as boxes, from the body's top left. Reads the page. */
// The boxes between a range's ends and the body that scroll or clip
// sideways: a wide table's and a code block's. A line drawn inside one is cut
// to it, so a tint never shows past the box or over what it has scrolled away.
const sidewaysClips = (
  wrapper: Element,
  range: Range,
): ReadonlyArray<DOMRect> => {
  const view = wrapper.ownerDocument.defaultView;
  const clips = new Set<Element>();
  for (const end of [range.startContainer, range.endContainer]) {
    let a = end instanceof Element ? end : end.parentElement;
    for (; a !== null && a !== wrapper; a = a.parentElement)
      if (view?.getComputedStyle(a).overflowX !== 'visible') clips.add(a);
  }
  return [...clips].map((a) => a.getBoundingClientRect());
};

const clipAcross = (
  r: DOMRect,
  clips: ReadonlyArray<DOMRect>,
): { readonly left: number; readonly right: number } => {
  let left = r.left;
  let right = r.right;
  const middle = r.top + r.height / 2;
  for (const c of clips) {
    if (middle < c.top || middle > c.bottom) continue;
    left = Math.max(left, c.left);
    right = Math.min(right, c.right);
  }
  return { left, right };
};

export const drawComments = (
  wrapper: Element,
  comments: ReadonlyArray<Anchor & { readonly id: number }>,
): ReadonlyArray<Drawn> => {
  const origin = wrapper.getBoundingClientRect();
  return comments.flatMap((c) => {
    const range = rangeIn(wrapper, c);
    if (range === undefined) return [];
    const clips = sidewaysClips(wrapper, range);
    const boxes = visibleRects(range).flatMap((r) => {
      const { left, right } = clipAcross(r, clips);
      return right - left > 0.5
        ? [
            {
              top: r.top - origin.top,
              left: left - origin.left,
              width: right - left,
              height: r.height,
            },
          ]
        : [];
    });
    return boxes.length === 0 ? [] : [{ id: c.id, boxes }];
  });
};

/** The comment under a point, from the drawn boxes: the last drawn wins. */
export const commentAt = (
  drawn: ReadonlyArray<Drawn>,
  at: Point,
): number | undefined => {
  for (let i = drawn.length - 1; i >= 0; i--) {
    const d = drawn[i];
    if (
      d?.boxes.some(
        (b) =>
          at.left >= b.left &&
          at.left <= b.left + b.width &&
          at.top >= b.top &&
          at.top <= b.top + b.height,
      )
    )
      return d.id;
  }
  return undefined;
};

/**
 * A commentable body's element, by answer key, and a count bumped each time
 * its size changes (a diagram arriving, a resize): the highlights are drawn
 * again from it. Set by the body's ref.
 */
export const commentBodyAtom = Atom.family((_key: string) =>
  Atom.make<{ readonly el: Element | undefined; readonly n: number }>({
    el: undefined,
    n: 0,
  }),
);

/** What the context menu was opened on: a selection, a comment, or both. */
export interface CommentMenu {
  readonly key: string;
  readonly anchor: Anchor | undefined;
  readonly commentId: number | undefined;
  // What a picked item does once the menu has shut, so the focus it moves is
  // never fought over by a menu still holding it.
  readonly after?: 'comment' | 'edit';
}

export const commentMenuAtom = Atom.make<CommentMenu | undefined>(
  undefined,
).pipe(Atom.keepAlive);
