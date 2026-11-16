import { useAtomValue } from '@effect/atom-react';
import { type CSSProperties, useRef } from 'react';
import { railOverAtom } from '../../inbox-rail';
import { askingAtom, wideBlocksAtom } from '../../inbox-reader';
import { ChaseButton, FootAlerts } from './chase';
import { AskPicker, AskPlace, Composer } from './composer';
import { Minimap } from './minimap';
import { PriorityButton, PriorityCard, PriorityTripPill } from './priority';
import { QuestionFlow } from './question-flow';
import { QueueTabs } from './queue-tabs';

const Asking = () => (
  <div className="absolute inset-x-0 top-0 px-s5 pt-30">
    <div className="mx-auto max-w-measure">
      <AskPlace />
      <h1 className="mt-s2 font-reading text-18 font-medium text-fg">
        Ask the agent
      </h1>
      <AskPicker />
    </div>
  </div>
);

/** The reader: the queues, one question at a time, and the box at the foot. */
export const InboxReader = () => {
  const asking = useAtomValue(askingAtom);
  const railOver = useAtomValue(railOverAtom);
  const wideBlocks = useAtomValue(wideBlocksAtom);
  const header = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  return (
    // `isolate`: the reader is one layer of the page, so nothing inside it
    // (the stuck breadcrumb, the header's glass, the chase button) can rise
    // above the sidebar or the masthead, whatever its own `z-` says. A
    // sidebar pinned over it says how far it reaches (`--rail-over`), so a
    // wide picture keeps clear of it: a dragged width is a runtime value
    // Tailwind cannot express. `data-wide-blocks` is config.json's
    // `wideBlocks`: whether a wide table or picture grows both ways or right
    // only, which the stylesheet and the figures' variants read.
    <main
      data-inbox-reader
      data-wide-blocks={wideBlocks}
      style={
        railOver === undefined
          ? undefined
          : ({ '--rail-over': railOver } as CSSProperties)
      }
      className="relative isolate h-full min-w-0 flex-1 bg-bg font-zen text-fg"
    >
      <QueueTabs header={header} />
      <div className="relative h-full">
        <QuestionFlow header={header} foot={foot} />
        {asking ? <Asking /> : <Minimap />}
        {/* `@container`: the chase button, inside it, places itself by the
            column's width (`@chase-beside:`). `z-2`: over the read-aloud
            band (`z-1` in the list, `readout-layer.tsx`), so a line read
            under the foot is hidden by it as its text is. Not `isolate` on
            the list instead: its stuck breadcrumb must still rise over the
            header. Under the minimap's `z-10`, as before. */}
        <div ref={foot} className="@container absolute inset-x-0 bottom-0 z-2">
          <Composer />
          <FootAlerts>
            <PriorityButton />
            <ChaseButton />
          </FootAlerts>
        </div>
        {/* Over the list and the box: the interjection card; under the
            header: the boomerang's pill. */}
        <PriorityCard />
        <PriorityTripPill />
      </div>
    </main>
  );
};
