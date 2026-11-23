import { Schema } from 'effect';
import { MacrosInvoked } from './macros';

// The operator's comments on a Question's text: a span of the rendered body,
// quoted, and what they say about it, and the macros they invoked on it. They
// ride on the answer, as macros do.
//
// `quote`, `prefix` and `suffix` are the anchor of record (a W3C Web Annotation
// TextQuoteSelector): what the agent reads, and what still finds the span in a
// body rendered by a later version of the renderer. The quote is of the
// rendered text, not the markdown, so `**Column order.**` is quoted as
// `Column order.`. `at` (a TextPositionSelector) is only a hint for drawing the
// highlight again: the index of the rendered markdown part of the body (a
// diagram or drawing part is not counted) and the character offsets in that
// part's text. A reader checks it against `quote` before trusting it.
//
// BROWSER-SAFE: the local app's contract imports this module.

export const CommentAnchor = Schema.Struct({
  part: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CommentAnchor = typeof CommentAnchor.Type;

export const QuestionComment = Schema.Struct({
  // The selected text, as rendered.
  quote: Schema.String,
  // Up to `COMMENT_CONTEXT` characters before and after it, in the same part.
  prefix: Schema.String,
  suffix: Schema.String,
  at: CommentAnchor,
  // What the operator says about it: '' when its macros say it all.
  text: Schema.String,
  // The macros the operator invoked on the quoted text, in the order they
  // stacked them, each with its instruction copied in at send time, as an
  // answer's are (`macros.ts`). Left out for none, so a comment written
  // before comments took macros decodes as it was.
  macros: Schema.optionalKey(MacrosInvoked),
});
export type QuestionComment = typeof QuestionComment.Type;

// The comments of one answer, in the order their spans sit in the body.
export const QuestionComments = Schema.NonEmptyArray(QuestionComment);
export type QuestionComments = typeof QuestionComments.Type;

/** How much text each side of a quote is kept, to find it again. */
export const COMMENT_CONTEXT = 32;

/** The most comments one answer may carry. */
export const MAX_COMMENTS_PER_ANSWER = 50;

/** Why a comment cannot be sent, or `undefined` when it can. */
export const commentProblem = (c: QuestionComment): string | undefined => {
  if (c.quote.trim() === '') return 'a comment quotes no text';
  // A macro is a whole comment on its own, as it is a whole answer.
  if (c.text.trim() === '' && (c.macros ?? []).length === 0)
    return `the comment on “${c.quote}” is empty`;
  if (c.at.end < c.at.start)
    return `the comment on “${c.quote}” ends before it starts`;
  return undefined;
};

/** The comments in the order their spans sit in the body. */
export const commentsInBodyOrder = <C extends { readonly at: CommentAnchor }>(
  comments: ReadonlyArray<C>,
): ReadonlyArray<C> =>
  [...comments].sort(
    (a, b) =>
      a.at.part - b.at.part || a.at.start - b.at.start || a.at.end - b.at.end,
  );
