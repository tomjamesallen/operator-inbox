import { Tabs } from '@base-ui/react/tabs';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { RefObject } from 'react';
import { QUEUE_NAMES, QUEUE_TITLES, type QueueName } from '../../inbox-queues';
import {
  activeQueueAtom,
  askingAtom,
  railRaisedAtom,
  readerIntroAtom,
  shownQueuesAtom,
  toggleAskAtom,
} from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { keyHintAtom } from '../../keymap';
import { Icon, Tip } from './icon';

const AskButton = () => {
  const toggle = useAtomSet(toggleAskAtom);
  const hint = useAtomValue(keyHintAtom('ask_agent'));
  return (
    // On a phone the row has no room beside the wordmark: it sits in the gutter.
    <span className="absolute top-1/2 right-s5 flex -translate-y-1/2 compact:top-full compact:right-s2 compact:translate-y-0">
      <Tip label="Ask the agent" keys={hint.first}>
        <button
          type="button"
          aria-label="Ask the agent"
          aria-keyshortcuts={hint.aria}
          onClick={() => toggle()}
          className="flex cursor-pointer items-center text-fg/30 hover:text-fg"
        >
          <Icon d="M12 5v14M5 12h14" />
        </button>
      </Tip>
    </span>
  );
};

// The three queues, on the row the burger and the wordmark share. They go at
// once as the sidebar lies over the row, and come back only once the wordmark
// has shut.
export const QueueTabs = ({
  header,
}: {
  readonly header: RefObject<HTMLDivElement | null>;
}) => {
  const queue = useAtomValue(activeQueueAtom);
  const queues = useAtomValue(shownQueuesAtom);
  const asking = useAtomValue(askingAtom);
  const intro = useAtomValue(readerIntroAtom);
  const raised = useAtomValue(railRaisedAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  const shown = !intro && !raised;
  return (
    <div
      ref={header}
      data-zen-header
      className="absolute inset-x-0 top-0 z-10 h-header bg-bg/70 text-11 backdrop-blur-md"
    >
      <div
        inert={!shown}
        data-zen-queues={shown ? 'shown' : 'hidden'}
        className={`relative flex h-full items-center justify-center transition-opacity ease-fade compact:justify-end compact:pr-s2 ${shown ? 'opacity-100 delay-800 duration-500' : 'opacity-0 duration-200'}`}
      >
        {/* Asking, no queue is on. The page below is the panel of whichever is. */}
        <Tabs.Root
          value={asking ? null : queue}
          onValueChange={(next: QueueName) =>
            send({ type: 'QueueChosen', queue: next })
          }
        >
          <Tabs.List
            aria-label="Queues"
            className="flex items-center gap-s4 compact:gap-s2"
          >
            {QUEUE_NAMES.map((q) => {
              const on = q === queue && !asking;
              const count = queues[q].length;
              return (
                <Tabs.Tab
                  key={q}
                  value={q}
                  className={`group relative flex cursor-pointer items-center whitespace-nowrap ${on ? 'text-fg/70' : 'text-fg/25 hover:text-fg/60'}`}
                >
                  {q === 'agent' ? (
                    <>
                      <span className="compact:hidden">{QUEUE_TITLES[q]}</span>
                      <span className="hidden compact:inline">Agent</span>
                    </>
                  ) : (
                    QUEUE_TITLES[q]
                  )}
                  {/* An eyebrow, out of the flow so a count changing moves no
                      tab. Nothing to clear: an empty queue shows none. */}
                  {q !== 'processed' && count > 0 && (
                    <span
                      data-zen-count
                      className={`absolute bottom-full left-full -mb-1 text-9 leading-none font-medium tabular-nums ${on ? 'text-fg/70' : 'text-fg/35 group-hover:text-fg/60'}`}
                    >
                      {count}
                    </span>
                  )}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </Tabs.Root>
        <AskButton />
      </div>
    </div>
  );
};
