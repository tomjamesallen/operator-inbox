import { useAtomSet } from '@effect/atom-react';
import type { FocusEvent, PointerEventHandler, ReactNode } from 'react';
import { boxFocusAskedAtom } from '../../inbox-reader';
import { focusedMacroCardAtom } from '../../macros';

// What every card under the answer box shares, whatever it carries: a stop in
// the one stack (`macro-cards.tsx`), its focus tracked by ref, Esc back to the
// text (after the card's own use of it), ⌘⌫ to remove it, and one border for
// focus and for a send held on it.

/**
 * A focus move inside the stack keeps the card in sight, or, for a card taller
 * than the stack, the field itself: the stack scrolls once it is full.
 */
const reveal = (card: HTMLElement, target: HTMLElement): void => {
  const stack = card.closest<HTMLElement>('[data-macro-cards]');
  const fits = stack === null || card.offsetHeight <= stack.clientHeight;
  (fits ? card : target).scrollIntoView({ block: 'nearest' });
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
        setFocused(cardRef);
        if (e.target instanceof HTMLElement) reveal(e.currentTarget, e.target);
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
