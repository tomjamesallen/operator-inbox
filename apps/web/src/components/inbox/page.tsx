import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react';
import { commentSelectionWatchAtom } from '../../comments';
import { inboxVisibleRefreshAtom } from '../../inbox';
import {
  elsewhereClearWatchAtom,
  yourInboxLandingWatchAtom,
} from '../../inbox-elsewhere';
import {
  greyedLineAtom,
  inboxTabTitleAtom,
  railFitFeedAtom,
  railMeasureAtom,
} from '../../inbox-rail';
import { readerFeedAtom, readerLinkAtom } from '../../inbox-reader';
import { inboxReaderAtoms } from '../../inbox-reader-machine';
import { readerSwipeAtom } from '../../inbox-swipe';
import { keymapKeyAtom } from '../../keymap';
import { KeymapHelp, PendingKeys } from '../keymap-help';
import { QuestionSearch } from '../question-search';
import { InboxMetaCard } from './colophon';
import { InboxPicker } from './inbox-picker';
import { Masthead } from './masthead';
import { InboxReader } from './reader';
import { Rail } from './sidebar';

// The widths the sidebar's fit turns on are theme tokens, so CSS says them
// and this reads them off empty boxes in the question's font. A resize, or
// the reading font arriving and moving what `ch` is, measures again. Without a
// ResizeObserver nothing is measured, and the sidebar never pins.
const RailProbe = () => {
  const setMeasure = useAtomSet(railMeasureAtom);
  const watch = (box: HTMLDivElement | null) => {
    const [room, pushRoom, design] = box === null ? [] : [...box.children];
    if (
      room === undefined ||
      pushRoom === undefined ||
      design === undefined ||
      typeof ResizeObserver === 'undefined'
    )
      return;
    const read = () =>
      setMeasure({
        room: room.getBoundingClientRect().width,
        pushRoom: pushRoom.getBoundingClientRect().width,
        design: design.getBoundingClientRect().width,
        viewport: document.documentElement.clientWidth,
      });
    const observer = new ResizeObserver(read);
    observer.observe(room);
    observer.observe(pushRoom);
    observer.observe(design);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  };
  return (
    <div ref={watch} aria-hidden="true" className="invisible absolute h-0">
      <div className="w-rail-room" />
      <div className="w-rail-push-room" />
      <div className="w-rail" />
    </div>
  );
};

// A live region, so a screen reader hears a machine go grey. It is always on the
// page and filled when one does: a region that arrives already holding its text
// is often not announced.
const GreyedStatus = () => {
  const line = useAtomValue(greyedLineAtom);
  return (
    <output className="sr-only" data-testid="inbox-greyed">
      {line}
    </output>
  );
};

/**
 * The inbox page. It holds the machine: the actor dies with its last reader, so
 * this keeps it for as long as the page is up, and hands it every read of the
 * board and every change of fit.
 */
export const InboxPage = () => {
  useAtomMount(inboxReaderAtoms.actor);
  useAtomMount(readerFeedAtom);
  useAtomMount(readerLinkAtom);
  useAtomMount(railFitFeedAtom);
  useAtomMount(inboxTabTitleAtom);
  useAtomMount(inboxVisibleRefreshAtom);
  useAtomMount(keymapKeyAtom);
  useAtomMount(commentSelectionWatchAtom);
  useAtomMount(readerSwipeAtom);
  useAtomMount(elsewhereClearWatchAtom);
  useAtomMount(yourInboxLandingWatchAtom);
  return (
    <div className="flex h-dvh overflow-hidden bg-bg font-zen text-fg">
      <Masthead />
      <Rail />
      <InboxReader />
      <RailProbe />
      <GreyedStatus />
      <QuestionSearch />
      <InboxPicker />
      <InboxMetaCard />
      <KeymapHelp />
      <PendingKeys />
    </div>
  );
};
