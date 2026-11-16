import { useAtomValue } from '@effect/atom-react';
import { useState } from 'react';
import { clockAtom, nowMillis } from '../../clock';
import { FRESH_MS, type FreshMark } from '../../inbox-queues';

// A question's dots: yellow for the agent's highlight, blue for the question a
// link names, pink for a new one, which fades on its own, or fast once its
// question stops waiting.

export interface Mark {
  readonly id: string;
  readonly dot: string;
  readonly fresh?: FreshMark;
}

export const HIGHLIGHT: Mark = { id: 'highlight', dot: 'bg-yellow' };
export const SELECTED: Mark = { id: 'selected', dot: 'bg-blue' };
export const freshMark = (fresh: FreshMark): Mark => ({
  // Its own id once spent, so the fast fade mounts and reads where the slow one
  // had got to.
  id: `${fresh.key}:${fresh.at}${fresh.spent ? ':spent' : ''}`,
  dot: 'bg-hot',
  fresh,
});

// Mounted partway through, as when it moves from the burger to a sidebar row, a
// new question's mark picks up the fade where it had got to: a runtime offset
// Tailwind cannot express. It is read once, at mount: a later read would push
// the running animation on again. That one-time read is why this is a hook. A
// spent mark starts from the strength it had reached, a runtime value too.
export const MarkShape = ({
  mark,
  className,
}: {
  readonly mark: Mark;
  readonly className: string;
}) => {
  const { fresh } = mark;
  const spent = fresh?.spent === true;
  const clock = useAtomValue(clockAtom);
  const [delay] = useState(() =>
    fresh === undefined ? undefined : fresh.at - nowMillis(clock),
  );
  return (
    <span
      data-zen-fresh={fresh === undefined ? undefined : ''}
      data-zen-mark={fresh === undefined ? mark.id : 'fresh'}
      style={
        delay === undefined
          ? undefined
          : spent
            ? { opacity: Math.max(0, 1 + delay / FRESH_MS) }
            : { animationDelay: `${delay}ms` }
      }
      className={`rounded-full ${fresh === undefined ? '' : spent ? 'animate-fresh-out' : 'animate-fresh'} ${className}`}
    />
  );
};

// Marks in one place stack, yellow then blue then pink: the first is the dot,
// and each after it a solid band outside the last, drawn outermost first so the
// dot sits on top.
const RINGS = ['size-mark-1', 'size-mark-2'] as const;

export const MarkStack = ({
  marks,
  className = 'relative',
}: {
  readonly marks: ReadonlyArray<Mark>;
  readonly className?: string;
}) => {
  const [core, ...rest] = marks;
  if (core === undefined) return null;
  return (
    <span
      data-zen-stack={marks.length}
      className={`flex size-1.5 shrink-0 ${className}`}
    >
      {rest
        .slice(0, RINGS.length)
        .map((m, i) => (
          <MarkShape
            key={m.id}
            mark={m}
            className={`pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 ${RINGS[i]} ${m.dot}`}
          />
        ))
        .reverse()}
      <MarkShape
        key={core.id}
        mark={core}
        className={`relative size-1.5 ${core.dot}`}
      />
    </span>
  );
};
