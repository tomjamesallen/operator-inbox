import { Tabs } from '@base-ui/react/tabs';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { Archive, Bot, Inbox, type LucideIcon } from 'lucide-react';
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
import { HeaderGlass } from './scope-crumb';

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

// Each queue's tab is an icon; its title is the tab's name and its tooltip.
// Lucide's bot draws its head 16 units wide where the tray and the box run
// 20, so at one size it reads small beside them. It gets a box a step larger,
// and a stroke scaled down by the same ratio (14/16), so all three draw the
// same line weight.
const QUEUE_ICONS: Readonly<
  Record<
    QueueName,
    {
      readonly Icon: LucideIcon;
      readonly size: string;
      readonly stroke: number;
    }
  >
> = {
  inbox: { Icon: Inbox, size: 'size-3.5', stroke: 2 },
  agent: { Icon: Bot, size: 'size-4', stroke: 1.75 },
  processed: { Icon: Archive, size: 'size-3.5', stroke: 2 },
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
  const inboxHint = useAtomValue(keyHintAtom('focus_inbox_column'));
  const shown = !intro && !raised;
  return (
    // On a phone the row is fixed, opaque and unblurred. Safari on iOS colours
    // the status bar from a full-width fixed bar at the top edge, but only one
    // with a solid background and no backdrop filter; without one it lays its
    // own soft fade over the top of the page, washing out this row and the line
    // under it. Wider screens keep the frosted row over the reader.
    // In the desktop window the header is the title strip: its empty space,
    // and the row's, moves the window (`data-tauri-drag-region`, which only an
    // element itself answers to, never its children). The row is the strip's
    // height, so the icons line up with the traffic lights and the burger.
    <div
      ref={header}
      data-zen-header
      data-tauri-drag-region
      className="absolute inset-x-0 top-0 z-10 h-header text-11 compact:fixed compact:bg-bg"
    >
      {/* The frosted glass is a layer of its own, so it can grow down to
          hold a stuck breadcrumb. */}
      <HeaderGlass />
      <div
        inert={!shown}
        data-zen-queues={shown ? 'shown' : 'hidden'}
        data-tauri-drag-region
        className={`relative flex h-full items-center titlebar:h-titlebar justify-center transition-opacity ease-fade compact:justify-end compact:pr-s2 ${shown ? 'opacity-100 delay-800 duration-500' : 'opacity-0 duration-200'}`}
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
            data-tauri-drag-region
            className="flex items-center gap-s4 compact:gap-s2"
          >
            {QUEUE_NAMES.map((q) => {
              const on = q === queue && !asking;
              const count = queues[q].length;
              const glyph = QUEUE_ICONS[q];
              return (
                <Tip
                  key={q}
                  label={QUEUE_TITLES[q]}
                  keys={q === 'inbox' ? inboxHint.first : undefined}
                >
                  <Tabs.Tab
                    value={q}
                    aria-label={
                      q !== 'processed' && count > 0
                        ? `${QUEUE_TITLES[q]}, ${count}`
                        : QUEUE_TITLES[q]
                    }
                    aria-keyshortcuts={
                      q === 'inbox' ? inboxHint.aria : undefined
                    }
                    className={`group relative flex cursor-pointer items-center ${on ? 'text-fg/70' : 'text-fg/25 hover:text-fg/60'}`}
                  >
                    <glyph.Icon
                      aria-hidden="true"
                      strokeWidth={glyph.stroke}
                      className={glyph.size}
                    />
                    {/* An eyebrow, out of the flow so a count changing moves no
                        tab. Nothing to clear: an empty queue shows none. In the
                        desktop window's strip it sits 2px lower, clear of the
                        window's top edge. */}
                    {q !== 'processed' && count > 0 && (
                      <span
                        data-zen-count
                        aria-hidden="true"
                        className={`absolute bottom-full left-full -mb-1 text-9 titlebar:-mb-1.5 leading-none font-medium tabular-nums ${on ? 'text-fg/70' : 'text-fg/35 group-hover:text-fg/60'}`}
                      >
                        {count}
                      </span>
                    )}
                  </Tabs.Tab>
                </Tip>
              );
            })}
          </Tabs.List>
        </Tabs.Root>
        <AskButton />
      </div>
    </div>
  );
};
