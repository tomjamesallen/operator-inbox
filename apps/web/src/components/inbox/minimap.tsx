import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { questionRef } from '@operator-inbox/core/api';
import { useCallback } from 'react';
import { drawnBoardAtom } from '../../inbox';
import {
  activeQueueAtom,
  freshMarksAtom,
  headOf,
  heldKeyAtom,
  litKeyAtom,
  type ReaderItem,
  readerIntroAtom,
  scrubbingAtom,
  shownQueuesAtom,
} from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import {
  SCRUB_IDLE,
  type ScrubInput,
  type ScrubRow,
  scrubKeyAt,
  scrubStep,
} from '../../inbox-scrub';
import { introFade } from './composer';
import { freshMark, MarkStack } from './marks';
import { useMarks } from './question-item';

const Row = ({
  item,
  on,
  greyed,
  held,
  scrubbing,
}: {
  readonly item: ReaderItem;
  readonly on: boolean;
  readonly greyed: boolean;
  readonly held: boolean;
  readonly scrubbing: boolean;
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
      data-zen-minimap-row={item.key}
      className="group relative flex max-h-s3 min-h-0 flex-1 cursor-pointer items-center justify-end gap-s1 pr-s2"
    >
      <MarkStack
        marks={[...marks, ...(fresh === undefined ? [] : [freshMark(fresh)])]}
      />
      <span
        className={`h-px shrink-0 transition-all duration-300 ${width} ${tone}`}
      />
      {scrubbing ? (
        on && (
          // Beside the finger, clear of the thumb, so the reader can tell
          // where they will land.
          <span
            data-zen-scrub-label
            className="absolute top-1/2 right-full mr-s4 flex max-w-scrub-label -translate-y-1/2 items-baseline gap-s2 border border-fg/13 bg-bg px-s2 py-s1 text-13 whitespace-nowrap text-fg shadow-sm"
          >
            <span className="shrink-0 text-fg/50">
              {questionRef(item.inboxCode, item.question.number)}
            </span>
            <span className="truncate">{title}</span>
          </span>
        )
      ) : (
        <span className="absolute top-1/2 right-full hidden max-w-subtitle -translate-y-1/2 truncate bg-bg px-s1 text-11 text-fg/70 group-hover:block">
          {title}
        </span>
      )}
    </button>
  );
};

const rowsOf = (nav: HTMLElement): ReadonlyArray<ScrubRow> =>
  [...nav.querySelectorAll<HTMLElement>('[data-zen-minimap-row]')].map((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { key: el.dataset.zenMinimapRow ?? '', top, bottom };
  });

// A finger dragged down the minimap scrubs the list (`inbox-scrub.ts`). The
// listeners live as long as the minimap, and what they hold is the gesture's
// own bookkeeping: whether the scrub is on, and which question it is over, is
// the machine's. The question under the finger is looked up once a frame,
// however many moves the frame brings.
const useScrub = () => {
  const send = useAtomSet(inboxReaderAtoms.send);
  return useCallback(
    (nav: HTMLElement | null) => {
      if (nav === null) return;
      let gesture = SCRUB_IDLE;
      let y: number | undefined;
      let over: string | undefined;
      let frame: number | undefined;
      const scrubTo = () => {
        frame = undefined;
        if (y === undefined) return;
        const key = scrubKeyAt(rowsOf(nav), y);
        if (key === undefined || key === over) return;
        over = key;
        send({ type: 'ScrubbedTo', key });
      };
      const flush = () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        scrubTo();
      };
      const feed = (e: PointerEvent, input: ScrubInput) => {
        const step = scrubStep(gesture, input);
        gesture = step.next;
        if (step.began) {
          over = undefined;
          // Throws for a pointer the browser has already let go of: the scrub
          // runs on without the capture, and the pointer's cancel ends it.
          try {
            nav.setPointerCapture(e.pointerId);
          } catch {}
        }
        if (step.at !== undefined) {
          y = step.at;
          // The first is at once, so the label shows as the drag starts.
          if (step.began) scrubTo();
          else frame ??= requestAnimationFrame(scrubTo);
        }
        if (step.ended) {
          flush();
          y = undefined;
          send({ type: 'ScrubEnded' });
        }
      };
      const onDown = (e: PointerEvent) =>
        feed(e, {
          type: 'down',
          pointer: e.pointerId,
          y: e.clientY,
          scrubs: e.pointerType !== 'mouse' && e.isPrimary,
        });
      const onMove = (e: PointerEvent) =>
        feed(e, { type: 'move', pointer: e.pointerId, y: e.clientY });
      const onUp = (e: PointerEvent) =>
        feed(e, { type: 'up', pointer: e.pointerId, y: e.clientY });
      const onCancel = (e: PointerEvent) =>
        feed(e, { type: 'cancel', pointer: e.pointerId });
      // The row a finger pressed holds it until the scrub takes it, and that
      // row's loss bubbles up here: only the minimap's own loss is an end.
      const onLost = (e: PointerEvent) => {
        if (e.target === nav) onCancel(e);
      };
      nav.addEventListener('pointerdown', onDown);
      nav.addEventListener('pointermove', onMove);
      nav.addEventListener('pointerup', onUp);
      nav.addEventListener('pointercancel', onCancel);
      nav.addEventListener('lostpointercapture', onLost);
      return () => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (gesture._tag === 'Scrubbing') send({ type: 'ScrubEnded' });
        nav.removeEventListener('pointerdown', onDown);
        nav.removeEventListener('pointermove', onMove);
        nav.removeEventListener('pointerup', onUp);
        nav.removeEventListener('pointercancel', onCancel);
        nav.removeEventListener('lostpointercapture', onLost);
      };
    },
    [send],
  );
};

// One row per question, down the right edge. The rows share the height, and
// shrink when a queue holds more than the window fits. On a touch screen it is
// wider than it draws, for a thumb, and takes the touch for itself
// (`touch-none`), so a drag down it scrubs rather than scrolls the page.
export const Minimap = () => {
  const queue = useAtomValue(activeQueueAtom);
  const items = useAtomValue(shownQueuesAtom)[queue];
  const lit = useAtomValue(litKeyAtom);
  const held = useAtomValue(heldKeyAtom);
  const board = useAtomValue(drawnBoardAtom);
  const intro = useAtomValue(readerIntroAtom);
  const scrubbing = useAtomValue(scrubbingAtom);
  const scrub = useScrub();
  return (
    <nav
      ref={scrub}
      aria-label="Questions"
      data-zen-minimap
      data-zen-scrubbing={scrubbing || undefined}
      inert={intro}
      className={`absolute inset-y-20 right-0 z-10 flex w-s5 touch-none flex-col justify-center select-none pointer-coarse:w-8 ${introFade(intro)}`}
    >
      {items.map((item) => (
        <Row
          key={item.key}
          item={item}
          on={item.key === lit}
          greyed={board?.greyed.has(item.machine) === true}
          held={item.key === held}
          scrubbing={scrubbing}
        />
      ))}
    </nav>
  );
};
