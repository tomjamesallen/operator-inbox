import { useAtomValue } from '@effect/atom-react';
import { useRef } from 'react';
import { askingAtom } from '../../inbox-reader';
import { ChaseToasts } from './chase';
import { AskPicker, AskPlace, Composer } from './composer';
import { Minimap } from './minimap';
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
  const header = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  return (
    <main
      data-inbox-reader
      className="relative h-full min-w-0 flex-1 bg-bg font-zen text-fg"
    >
      <QueueTabs header={header} />
      <div className="relative h-full">
        <QuestionFlow header={header} foot={foot} />
        {asking ? <Asking /> : <Minimap />}
        {/* `@container`: the chase toasts, inside it, place themselves by the
            column's width (`@chase-beside:`). */}
        <div ref={foot} className="@container absolute inset-x-0 bottom-0">
          <Composer />
          <ChaseToasts />
        </div>
      </div>
    </main>
  );
};
