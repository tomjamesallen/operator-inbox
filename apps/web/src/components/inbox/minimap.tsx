import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { drawnBoardAtom } from '../../inbox';
import {
  activeQueueAtom,
  freshMarksAtom,
  headOf,
  heldKeyAtom,
  litKeyAtom,
  type ReaderItem,
  readerIntroAtom,
  shownQueuesAtom,
} from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { introFade } from './composer';
import { freshMark, MarkStack } from './marks';
import { useMarks } from './question-item';

const Row = ({
  item,
  on,
  greyed,
  held,
}: {
  readonly item: ReaderItem;
  readonly on: boolean;
  readonly greyed: boolean;
  readonly held: boolean;
}) => {
  const send = useAtomSet(inboxReaderAtoms.send);
  const marks = useMarks(item);
  const fresh = useAtomValue(freshMarksAtom).find((f) => f.key === item.key);
  const { title } = headOf(item);
  const width = on ? 'w-s3' : 'w-s1';
  const tone = held
    ? 'bg-red'
    : greyed
      ? 'bg-orange'
      : on
        ? 'bg-fg'
        : 'bg-fg/30 group-hover:bg-fg/70';
  return (
    <button
      type="button"
      onClick={() => send({ type: 'MovedTo', key: item.key })}
      aria-label={title}
      aria-current={on || undefined}
      className="group relative flex max-h-s3 min-h-0 flex-1 cursor-pointer items-center justify-end gap-s1 pr-s2"
    >
      <MarkStack
        marks={[...marks, ...(fresh === undefined ? [] : [freshMark(fresh)])]}
      />
      <span
        className={`h-px shrink-0 transition-all duration-300 ${width} ${tone}`}
      />
      <span className="absolute top-1/2 right-full hidden max-w-subtitle -translate-y-1/2 truncate bg-bg px-s1 text-11 text-fg/70 group-hover:block">
        {title}
      </span>
    </button>
  );
};

// One row per question, down the right edge. The rows share the height, and
// shrink when a queue holds more than the window fits.
export const Minimap = () => {
  const queue = useAtomValue(activeQueueAtom);
  const items = useAtomValue(shownQueuesAtom)[queue];
  const lit = useAtomValue(litKeyAtom);
  const held = useAtomValue(heldKeyAtom);
  const board = useAtomValue(drawnBoardAtom);
  const intro = useAtomValue(readerIntroAtom);
  return (
    <nav
      aria-label="Questions"
      data-zen-minimap
      inert={intro}
      className={`absolute inset-y-20 right-0 z-10 flex w-s5 flex-col justify-center ${introFade(intro)}`}
    >
      {items.map((item) => (
        <Row
          key={item.key}
          item={item}
          on={item.key === lit}
          greyed={board?.greyed.has(item.machine) === true}
          held={item.key === held}
        />
      ))}
    </nav>
  );
};
