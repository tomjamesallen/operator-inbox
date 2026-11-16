import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { priorityCountAtom, priorityInfoAtom } from '../../inbox-priority';
import { attentionAtom, freshElsewhereAtom } from '../../inbox-rail';
import { railStateAtom, readerIntroAtom } from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { inParens, keyHintAtom } from '../../keymap';
import { freshMark, MarkShape } from './marks';
import { BurgerPriorityDot, priorityDotWords } from './priority';

// The burger and the wordmark, top left, sidebar open or shut.

// Each letter fades on its own a beat after its neighbour, and the width follows
// the fade, so the O never moves. Going out it runs right to left, and the width
// waits for it; coming in, left to right, after the width has started.
const LETTER_BEAT_MS = 35;
const LETTERS_IN_AFTER_MS = 200;

const Letters = ({
  open,
  letters,
}: {
  readonly open: boolean;
  readonly letters: string;
}) => (
  <span
    className={`grid transition-fold duration-500 ease-fold ${open ? 'grid-cols-open' : 'grid-cols-shut delay-300'}`}
  >
    <span className="min-w-0 overflow-x-clip whitespace-pre">
      {[...letters].map((letter, i) => (
        // A letter's beat is a runtime value Tailwind cannot express. Each
        // letter keeps a compositing layer of its own for good
        // (`will-change-transform`, which WebKit honours only on a box, so
        // `inline-block`): WebKit otherwise gives a letter a layer only while
        // its opacity runs, and redrawing it on and off that layer at the
        // wordmark's fractional offset nudged the row by about a pixel.
        <span
          key={i}
          style={{
            transitionDelay: `${
              open
                ? LETTERS_IN_AFTER_MS + i * LETTER_BEAT_MS
                : (letters.length - 1 - i) * LETTER_BEAT_MS
            }ms`,
          }}
          className={`inline-block transition-opacity duration-400 ease-fade will-change-transform ${open ? 'opacity-100' : 'opacity-0'}`}
        >
          {letter}
        </span>
      ))}
    </span>
  </span>
);

// "Operator inbox" in full, "Oi" in short, in the reading font. The dot in the O
// and the i's dot are the highlight's yellow; the i is dotless (U+0131) so its
// dot can be one.
const Wordmark = ({ open }: { readonly open: boolean }) => (
  <span
    role="img"
    aria-label="Operator Inbox"
    data-zen-brand={open ? 'long' : 'short'}
    className="flex items-baseline font-reading text-13 text-fg/60"
  >
    <span className="relative">
      O
      <span
        data-zen-brand-dot
        className="absolute top-1/2 left-1/2 -mt-logo-lift size-logo-dot -translate-1/2 rounded-full bg-yellow"
      />
    </span>
    <Letters open={open} letters="perator " />
    <span className="relative">
      ı
      <span
        data-zen-brand-tittle
        className="absolute top-1/2 left-1/2 -mt-logo-tittle -ml-logo-tittle-x size-logo-dot -translate-1/2 rounded-full bg-yellow"
      />
    </span>
    <Letters open={open} letters="nbox" />
  </span>
);

const ATTENTION = { red: 'bg-red', orange: 'bg-orange' } as const;

// A hover peeks and a click keeps. Shut, it carries what the sidebar would say:
// the top corner for a new question elsewhere, the foot for something wrong.
// On a phone, open or shut, its top left carries the priority Inbox's dot, in
// place of the flag the wider layout floats over the foot; its label says so
// at any width, since a screen reader has no breakpoint.
const Burger = () => {
  const rail = useAtomValue(railStateAtom);
  const attention = useAtomValue(attentionAtom);
  const newest = useAtomValue(freshElsewhereAtom).at(-1);
  const hint = useAtomValue(keyHintAtom('toggle_sidebar'));
  const send = useAtomSet(inboxReaderAtoms.send);
  const shut = rail === 'shut';
  const mark = newest === undefined ? undefined : freshMark(newest);
  const priority = priorityDotWords(
    useAtomValue(priorityCountAtom),
    useAtomValue(priorityInfoAtom)?.label,
  );
  return (
    <button
      type="button"
      aria-label={[
        'Sidebar',
        ...(attention === undefined ? [] : ['something needs attention']),
        ...(priority === undefined ? [] : [priority]),
      ].join(', ')}
      aria-expanded={!shut}
      aria-keyshortcuts={hint.aria}
      title={`Sidebar${inParens(hint.all)}`}
      data-rail-burger
      onMouseEnter={() => send({ type: 'RailHovered' })}
      onClick={() => send({ type: 'RailToggled' })}
      className={`pointer-events-auto relative cursor-pointer ${rail === 'docked' || rail === 'drawer' ? 'text-fg/60' : 'text-fg/25'} hover:text-fg`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3 fill-none stroke-current"
      >
        <path d="M1 3.5h14M1 8h14M1 12.5h14" />
      </svg>
      <BurgerPriorityDot />
      {shut && attention !== undefined && (
        <span
          data-zen-attention={attention}
          className={`absolute -right-0.5 bottom-0 size-1 rounded-full ${ATTENTION[attention]}`}
        />
      )}
      {shut && mark !== undefined && (
        <MarkShape
          key={mark.id}
          mark={mark}
          className="absolute top-0 -right-0.5 size-1 bg-hot"
        />
      )}
    </button>
  );
};

/** The row's left end: the same `h-header` the queues sit on. */
export const Masthead = () => {
  const intro = useAtomValue(readerIntroAtom);
  const shut = useAtomValue(railStateAtom) === 'shut';
  return (
    // Its own layer: under Safari the header's backdrop blur can take in what
    // sits over it.
    <div className="pointer-events-none fixed top-0 left-s4 z-30 flex h-header transform-gpu items-center gap-s2 compact:left-s3 compact:gap-s1 titlebar:left-traffic-lights titlebar:h-titlebar">
      <Burger />
      <Wordmark open={intro || !shut} />
    </div>
  );
};
