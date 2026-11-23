import { useAtomSet } from '@effect/atom-react';
import type { FocusEvent, PointerEventHandler, ReactNode } from 'react';
import { boxFocusAskedAtom } from '../../inbox-reader';
import { focusedMacroCardAtom } from '../../macros';

// What every card under the answer box shares, whatever it carries: a stop in
// the one stack (`macro-cards.tsx`), its focus tracked by ref, Esc back to the
// text (after the card's own use of it), ⌘⌫ to remove it, and one border for
// focus and for a send held on it.

/**
 * A focus move inside the stack, or a field growing as the operator types,
 * keeps the whole card in sight, clear of the stack's faded edges. A card
 * taller than the stack keeps the field's foot in sight instead, where the
 * typing is: the stack scrolls once it is full.
 */
const reveal = (card: HTMLElement, target: HTMLElement): void => {
  const stack = card.closest<HTMLElement>('[data-macro-cards]');
  if (stack === null || card.offsetHeight <= stack.clientHeight) {
    card.scrollIntoView({ block: 'nearest' });
    return;
  }
  // The card's own scroll margin is the fade's width (`scroll-my-fade`).
  const fade =
    Number.parseFloat(getComputedStyle(card).scrollMarginBottom) || 0;
  const below =
    target.getBoundingClientRect().bottom -
    (stack.getBoundingClientRect().bottom - fade);
  if (below > 0) stack.scrollTop += below;
};

export const CardShell = ({
  cardRef,
  label,
  stop,
  waiting = false,
  tint = '',
  onEscape,
  remove,
  onPointerEnter,
  onPointerLeave,
  children,
  ...data
}: {
  readonly cardRef: string;
  readonly label: string;
  // A card with no field of its own is a stop itself, so ⌘⌫ can reach it.
  readonly stop: boolean;
  // A send is held on this card's empty fields.
  readonly waiting?: boolean;
  // A background for a card lit from elsewhere; the border stays the focus's.
  readonly tint?: string;
  // The card's own use of Esc, first; true when it took the key.
  readonly onEscape?: () => boolean;
  readonly remove: () => void;
  readonly onPointerEnter?: PointerEventHandler<HTMLElement>;
  readonly onPointerLeave?: PointerEventHandler<HTMLElement>;
  readonly children: ReactNode;
  readonly [data: `data-${string}`]: string | number | boolean | undefined;
}) => {
  const setFocused = useAtomSet(focusedMacroCardAtom);
  const bumpBoxFocus = useAtomSet(boxFocusAskedAtom);
  return (
    <section
      {...data}
      data-macro-card={cardRef}
      data-macro-held={waiting || undefined}
      aria-label={label}
      tabIndex={stop ? 0 : undefined}
      onFocus={(e: FocusEvent<HTMLElement>) => {
        // A card nested in this one (a comment's macro) is the focused one
        // while the focus is in it, so its "i" and its removal are its own.
        const inner =
          e.target instanceof Element &&
          e.target.closest('[data-macro-card]') !== e.currentTarget;
        if (!inner) setFocused(cardRef);
        if (e.target instanceof HTMLElement) reveal(e.currentTarget, e.target);
      }}
      // After the field has grown to its new line, on the next frame.
      onInput={(e) => {
        const card = e.currentTarget;
        const target = e.target;
        if (target instanceof HTMLElement)
          requestAnimationFrame(() => reveal(card, target));
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused((at) => (at === cardRef ? undefined : at));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (onEscape?.() !== true) bumpBoxFocus((n) => n + 1);
        } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) remove();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      {...(onPointerEnter === undefined ? {} : { onPointerEnter })}
      {...(onPointerLeave === undefined ? {} : { onPointerLeave })}
      className={`relative scroll-my-fade border px-s2 py-s1 font-zen text-12 outline-none ${waiting ? 'border-orange' : 'border-fg/12 focus-within:border-fg/30 focus-visible:border-fg/50'} ${tint}`}
    >
      {children}
    </section>
  );
};
