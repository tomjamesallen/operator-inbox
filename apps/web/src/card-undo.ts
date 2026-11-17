import {
  InboxId,
  type InboxOperatorQuestionDto,
} from '@operator-inbox/core/api';
import { Atom } from 'effect/reactivity';
import {
  type CommentDraft,
  commentFocusAskedAtom,
  commentsAtom,
  removeCommentAtom,
} from './comments';
import { askDraftAtom, responseDraftAtom } from './inbox';
import {
  ASK_CARDS_PREFIX,
  askMacroFocusAtom,
  type MacroCard,
  macroCardsAtom,
} from './macros';

// Undo for a card removed from an answer: a comment's or a macro's, by its ×,
// ⌘⌫ or the body's context menu. Each removal keeps the card whole (its text,
// its slot values, a comment's anchor) and its place in the stack, on a short
// stack per answer, so undoing restores it exactly, its highlight with it, and
// puts the focus back in it. A comment never written that Esc lets go is not a
// removal: nothing was lost.
//
// ⌘Z follows the order things happened in, newest first, across the whole
// answer box: the box's text, the comments and the macro cards are one
// timeline. Each removal keeps the answer as it left it, and while the answer
// is still just that, the removal is the newest thing done to it, so ⌘Z brings
// the card back, whatever typing the focused field holds from before it. Once
// the answer differs (a word typed, a field filled, a card added) the newest
// thing is that edit, and ⌘Z is the browser's own undo. Unwinding the edit
// (the field's own ⌘Z, back to the text as the removal left it) makes the
// removal the newest again, and the next ⌘Z brings it back. The browser never
// says whether a field has undo history, so this compares the answer instead.
// The notice over the box can bring its removal back while it shows, edited
// since or not.
//
// Memory only, as the comments are: a reload, or a send, starts afresh.

type QuestionNumber = InboxOperatorQuestionDto['number'];

/** How many removals one answer keeps to undo. */
export const UNDO_DEPTH = 10;

export type RemovedCard =
  | {
      readonly _tag: 'Comment';
      readonly comment: CommentDraft;
      // Its place in the order the comments were made.
      readonly at: number;
    }
  | {
      readonly _tag: 'Macro';
      readonly card: MacroCard;
      // Its place among the macro cards.
      readonly at: number;
      readonly inboxId: InboxId;
      // The answer's question; an ask's cards name none.
      readonly number?: QuestionNumber;
    };

export interface CardRemoval {
  // Counts up across the page, so a notice can tell a new removal from one
  // it has shown.
  readonly seq: number;
  readonly removed: RemovedCard;
  // The answer as the removal left it (`answerStateOf`).
  readonly after: string;
}

type Read = <A>(atom: Atom.Atom<A>) => A;

// Everything an edit can change, in one comparable string. Small: one answer's
// text, comments and cards, or one ask's text and cards (`askCardsKeyOf`).
const answerStateOf = (read: Read, key: string): string => {
  const asking = askOfKey(key);
  return JSON.stringify([
    asking === undefined
      ? read(responseDraftAtom(key))
      : read(askDraftAtom(asking)),
    read(commentsAtom(key)),
    read(macroCardsAtom(key)),
  ]);
};

// The Inbox an ask's key is for; an answer's key is for none.
const askOfKey = (key: string): InboxId | undefined =>
  key.startsWith(ASK_CARDS_PREFIX)
    ? InboxId.make(key.slice(ASK_CARDS_PREFIX.length))
    : undefined;

/** One answer's removals, the latest last. Memory only. */
export const cardRemovalsAtom = Atom.family((_key: string) =>
  Atom.make<ReadonlyArray<CardRemoval>>([]).pipe(Atom.keepAlive),
);

const removalSeqAtom = Atom.make(0).pipe(Atom.keepAlive);

/** The newest removal, edited since or not: the notice's. */
export const latestRemovalAtom = Atom.family((key: string) =>
  Atom.make((get): CardRemoval | undefined =>
    get(cardRemovalsAtom(key)).at(-1),
  ),
);

/** The removal ⌘Z would restore now: the newest, while nothing is done since. */
export const undoableRemovalAtom = Atom.family((key: string) =>
  Atom.make((get): CardRemoval | undefined => {
    const top = get(cardRemovalsAtom(key)).at(-1);
    return top !== undefined && top.after === answerStateOf((a) => get(a), key)
      ? top
      : undefined;
  }),
);

export type CardToRemove =
  | { readonly _tag: 'Comment'; readonly id: number }
  | {
      readonly _tag: 'Macro';
      readonly id: number;
      readonly inboxId: InboxId;
      readonly number?: QuestionNumber;
    };

/** Remove a card from answer `key`, keeping it to undo. */
export const removeCardAtom = Atom.writable(
  () => undefined,
  (ctx, req: { readonly key: string; readonly card: CardToRemove }): void => {
    const { key, card } = req;
    let removed: RemovedCard;
    if (card._tag === 'Comment') {
      const comments = ctx.get(commentsAtom(key));
      const at = comments.findIndex((c) => c.id === card.id);
      const comment = comments[at];
      if (comment === undefined) return;
      ctx.set(removeCommentAtom, { key, id: card.id });
      removed = { _tag: 'Comment', comment, at };
    } else {
      const cards = ctx.get(macroCardsAtom(key));
      const at = cards.findIndex((c) => c.id === card.id);
      const found = cards[at];
      if (found === undefined) return;
      const questioned =
        card.number === undefined ? {} : { number: card.number };
      ctx.set(macroCardsAtom(key), {
        inboxId: card.inboxId,
        ...questioned,
        cards: cards.filter((c) => c.id !== card.id),
      });
      removed = {
        _tag: 'Macro',
        card: found,
        at,
        inboxId: card.inboxId,
        ...questioned,
      };
    }
    const seq = ctx.get(removalSeqAtom) + 1;
    ctx.set(removalSeqAtom, seq);
    ctx.set(
      cardRemovalsAtom(key),
      [
        ...ctx.get(cardRemovalsAtom(key)),
        { seq, removed, after: answerStateOf((a) => ctx.get(a), key) },
      ].slice(-UNDO_DEPTH),
    );
  },
);

// A card added since keeps its number: the one restored takes the next free.
const freeId = (taken: ReadonlyArray<{ readonly id: number }>, id: number) =>
  taken.some((c) => c.id === id)
    ? taken.reduce((top, c) => Math.max(top, c.id), 0) + 1
    : id;

const insertedAt = <A>(list: ReadonlyArray<A>, at: number, item: A) => [
  ...list.slice(0, at),
  item,
  ...list.slice(at),
];

/**
 * Restore answer `key`'s newest removal, if nothing has been done since, or
 * the removal `seq` (the notice's), edited since or not: focus and all.
 */
export const undoCardRemovalAtom = Atom.writable(
  () => undefined,
  (
    ctx,
    req: { readonly key: string; readonly seq?: number | undefined },
  ): void => {
    const { key } = req;
    const removals = ctx.get(cardRemovalsAtom(key));
    const top =
      req.seq === undefined
        ? ctx.get(undoableRemovalAtom(key))
        : removals.find((r) => r.seq === req.seq);
    if (top === undefined) return;
    ctx.set(
      cardRemovalsAtom(key),
      removals.filter((r) => r.seq !== top.seq),
    );
    const { removed } = top;
    if (removed._tag === 'Comment') {
      const comments = ctx.get(commentsAtom(key));
      const id = freeId(comments, removed.comment.id);
      ctx.set(
        commentsAtom(key),
        insertedAt(comments, removed.at, { ...removed.comment, id }),
      );
      ctx.set(commentFocusAskedAtom, { key, id });
      return;
    }
    const cards = ctx.get(macroCardsAtom(key));
    const id = freeId(cards, removed.card.id);
    ctx.set(macroCardsAtom(key), {
      inboxId: removed.inboxId,
      ...(removed.number === undefined ? {} : { number: removed.number }),
      cards: insertedAt(cards, removed.at, { ...removed.card, id }),
    });
    ctx.set(askMacroFocusAtom, {
      key,
      to:
        removed.card.macro.params.length > 0
          ? { _tag: 'Field', card: id, index: 0 }
          : { _tag: 'Card', card: id },
    });
  },
);

/** What the notice says of a removal. */
export const removalLabel = (removal: CardRemoval): string =>
  removal.removed._tag === 'Comment' ? 'Comment removed' : 'Macro removed';
