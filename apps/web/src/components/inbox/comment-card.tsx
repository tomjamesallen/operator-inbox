import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { useCallback } from 'react';
import {
  type CommentDraft,
  commentCardRef,
  commentFocusAskedAtom,
  hoverCommentAtom,
  isCommentFocusAskedAtom,
  isLit,
  litCommentAtom,
  removeCommentAtom,
  setCommentTextAtom,
} from '../../comments';
import { askMacroFocusAtom, focusedMacroCardAtom } from '../../macros';
import { CardShell } from './card-shell';

// A comment's card in the stack under the answer box, beside the macros' and
// on the same shell: its number, the quote and ×, and one field, the comment.
// ↩ in the field goes back to the answer's text (⇧↩ is a new line); Esc does
// too, and takes a comment never written with it. Hovering the card lights
// its highlight in the body, and the highlight lights the card.

/** A quote cut to a line. */
const shortQuote = (quote: string, max = 90): string =>
  quote.length > max ? `${quote.slice(0, max - 1)}…` : quote;

export const CommentCard = ({
  itemKey,
  comment,
  number,
  remove,
}: {
  readonly itemKey: string;
  readonly comment: CommentDraft;
  // Its place among the Question's comments, in body order.
  readonly number: number;
  // Removes it, and moves the focus on as the stack does.
  readonly remove: () => void;
}) => {
  const ref = commentCardRef(itemKey, comment.id);
  const focused = useAtomValue(focusedMacroCardAtom) === ref;
  const lit = isLit(useAtomValue(litCommentAtom), itemKey, comment.id);
  const asked = useAtomValue(isCommentFocusAskedAtom(ref));
  const setAsked = useAtomSet(commentFocusAskedAtom);
  const askFocus = useAtomSet(askMacroFocusAtom);
  const setText = useAtomSet(setCommentTextAtom);
  const drop = useAtomSet(removeCommentAtom);
  const hover = useAtomSet(hoverCommentAtom);
  // The field takes the focus when it is asked for: as the card is drawn, or
  // later, for an edit. A new callback when `asked` turns true is what makes
  // React call it again.
  const field = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (el === null || !asked) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
      setAsked(undefined);
    },
    [asked, setAsked],
  );
  return (
    <CardShell
      cardRef={ref}
      label={`Comment ${number}`}
      stop={false}
      remove={remove}
      data-comment-card={comment.id}
      tint={focused || lit ? 'bg-yellow/8' : ''}
      onEscape={() => {
        // A comment never written goes; the text takes the focus either way.
        if (comment.text.trim() === '') drop({ key: itemKey, id: comment.id });
        return false;
      }}
      onPointerEnter={() => hover({ key: itemKey, id: comment.id })}
      onPointerLeave={() => hover(undefined)}
    >
      <header className="flex items-baseline gap-s2">
        <span className="shrink-0 font-medium text-yellow">❝ {number}</span>
        <span className="min-w-0 flex-1 truncate text-fg/40 italic">
          “{shortQuote(comment.quote)}”
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Remove comment ${number}`}
          title="Remove (⌘⌫)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={remove}
          className="cursor-pointer text-fg/30 hover:text-fg"
        >
          ×
        </button>
      </header>
      {/* Label and control share a first row of `h-field`, as a macro's do. */}
      <div className="mt-s1 flex items-start gap-s2">
        <span className="flex h-field w-20 shrink-0 items-center text-fg/40">
          comment
        </span>
        <div className="min-w-0 flex-1">
          <textarea
            ref={field}
            data-macro-stop={`${ref}:0`}
            data-comment-field={comment.id}
            aria-label={`Comment ${number}`}
            rows={1}
            value={comment.text}
            placeholder="what about it"
            onChange={(e) =>
              setText({ key: itemKey, id: comment.id, text: e.target.value })
            }
            onKeyDown={(e) => {
              if (
                e.key !== 'Enter' ||
                e.shiftKey ||
                e.metaKey ||
                e.ctrlKey ||
                e.altKey
              )
                return;
              e.preventDefault();
              askFocus({ key: itemKey, to: { _tag: 'Text' } });
            }}
            className="field-sizing-content block w-full resize-none border-b border-fg/20 bg-transparent py-field-pad font-reading text-13 leading-card text-fg outline-none placeholder:text-fg/25 focus:border-fg/60 pointer-coarse:text-field"
          />
        </div>
      </div>
    </CardShell>
  );
};
