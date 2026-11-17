import { Menu } from '@base-ui/react/menu';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { InboxId } from '@operator-inbox/core/api';
import { Flag } from 'lucide-react';
import {
  drawnBoardAtom,
  priorityInboxOf,
  selectedInboxAtom,
} from '../../inbox';
import {
  inboxPickerOpenAtom,
  setInboxPickerOpenAtom,
} from '../../inbox-picker';
import {
  carryOnAtom,
  goToPriorityAtom,
  interjectionAtom,
  priorityBackAtom,
  priorityCountAtom,
  priorityInfoAtom,
  priorityTripAtom,
  priorityWriteAtom,
  togglePriorityAtom,
} from '../../inbox-priority';
import { keyHintAtom } from '../../keymap';
import { focusRing } from '../styles';

// The priority Inbox, drawn: its flag in the sidebar and the lists of
// other Inboxes, the row menu's item that marks it, the count that stacks
// with the chase button (a dot on the burger on a phone), the interjection
// card and the boomerang's pill. What
// pulls and when is `inbox-priority.ts`. Each control shows at most one key
// hint, outside any underline, and nothing that could be read as a key.

const HINT = 'text-fg/40 touch-only:hidden';

const hintOf = (keys: string | undefined) =>
  keys === undefined ? null : <span className={HINT}>{keys}</span>;

/**
 * The flag after an Inbox's name, or after its pin, on the priority Inbox
 * only. Filled, and pulsing where motion is welcome, while it has Questions
 * waiting and the operator is elsewhere: the quiet cue that a pull is coming.
 * Hollow and faint while it is archived or muted, when it does not pull.
 */
export const PriorityFlag = ({ inboxId }: { readonly inboxId: InboxId }) => {
  const board = useAtomValue(drawnBoardAtom);
  const info = useAtomValue(priorityInfoAtom);
  const selected = useAtomValue(selectedInboxAtom);
  const row = board?.inboxes.find((i) => i.inboxId === inboxId);
  if (row?.priority !== true) return null;
  const theOne = info?.inboxId === inboxId;
  const suspended = !theOne || info?.pulls !== true;
  const n = theOne ? (info?.waiting.length ?? 0) : 0;
  const pulling = !suspended && n > 0 && selected !== inboxId;
  const words = suspended
    ? `Priority inbox, ${row.archived ? 'archived' : row.muted === true ? 'muted' : 'on another machine'}: it does not pull`
    : pulling
      ? `Priority inbox: ${n} waiting on you`
      : 'Priority inbox';
  return (
    <span
      role="img"
      aria-label={words}
      title={words}
      data-priority-flag={
        suspended ? 'suspended' : pulling ? 'pulling' : 'quiet'
      }
      className={`flex shrink-0 items-center ${suspended ? 'text-priority/45' : 'text-priority'} ${pulling ? 'motion-safe:animate-pulse' : ''}`}
    >
      <Flag
        aria-hidden
        className="size-3"
        strokeWidth={2}
        fill={pulling ? 'currentColor' : 'none'}
      />
    </span>
  );
};

/**
 * The row menu's item: Mark as priority; on the priority Inbox, Unmark
 * priority; on any other while one is marked, Make priority instead, its title
 * naming the one it replaces.
 */
export const PriorityItem = ({
  inboxId,
  className,
}: {
  readonly inboxId: InboxId;
  readonly className: string;
}) => {
  const board = useAtomValue(drawnBoardAtom);
  const toggle = useAtomSet(togglePriorityAtom);
  const writing = useAtomValue(priorityWriteAtom).waiting;
  const keys = useAtomValue(keyHintAtom('toggle_priority'));
  const marked =
    board?.inboxes.find((i) => i.inboxId === inboxId)?.priority === true;
  const holder = priorityInboxOf(board);
  const other =
    !marked && holder !== undefined && holder.inboxId !== inboxId
      ? holder.label
      : undefined;
  return (
    <Menu.Item
      className={className}
      disabled={writing}
      data-priority-item
      onClick={() => toggle(inboxId)}
      title={other === undefined ? undefined : `Replaces ${other}`}
    >
      <span className="flex items-center gap-s1">
        <Flag aria-hidden className="size-3 text-priority" strokeWidth={2} />
        {marked
          ? 'Unmark priority'
          : other === undefined
            ? 'Mark as priority'
            : 'Make priority instead'}
      </span>
      <span className="text-fg/30 touch-only:hidden">{keys.first}</span>
    </Menu.Item>
  );
};

const countLabel = (n: number, label: string) =>
  `${label} has ${n === 1 ? 'a question' : `${n} questions`} waiting`;

/**
 * The ambient indicator: a round flag in the priority colour with the count,
 * stacked over the chase button and working as it does. It is there only
 * while the operator is elsewhere and the priority Inbox has Questions
 * waiting. A click opens the inbox picker, which lists the priority Inbox
 * first, and a second shuts it. Not on a phone: there the burger carries a
 * dot instead (`BurgerPriorityDot`), and nothing floats over the Question.
 */
export const PriorityButton = () => {
  const count = useAtomValue(priorityCountAtom);
  const info = useAtomValue(priorityInfoAtom);
  const open = useAtomValue(inboxPickerOpenAtom);
  const setOpen = useAtomSet(setInboxPickerOpenAtom);
  if (count === 0 || info === undefined) return null;
  const words = countLabel(count, info.label);
  return (
    <button
      type="button"
      aria-label={`${words} — open the inbox picker`}
      title={words}
      aria-expanded={open}
      data-priority-button
      onClick={() => setOpen(!open)}
      className="relative flex size-6 cursor-pointer items-center justify-center rounded-full border border-priority/40 bg-rail text-priority shadow-sm transition-colors hover:bg-priority/10 compact:hidden motion-reduce:transition-none"
    >
      <Flag aria-hidden className="size-3.5" />
      <span
        aria-hidden
        data-priority-count
        className="absolute -top-1 -right-1 flex min-w-3 items-center justify-center rounded-full bg-priority px-0.5 font-zen text-9 leading-card text-rail tabular-nums"
      >
        {count}
      </span>
    </button>
  );
};

/**
 * The burger's priority words, on a phone, while the ambient indicator would
 * show: what the burger's dot means, for its label. Undefined when there is
 * no dot.
 */
export const priorityDotWords = (
  count: number,
  label: string | undefined,
): string | undefined =>
  count === 0 || label === undefined
    ? undefined
    : `priority: ${countLabel(count, label)}`;

/**
 * The ambient indicator on a phone: a dot in the priority colour on the
 * burger, top left, under the same condition as the flag. The burger's own
 * label says what it means (`priorityDotWords`).
 */
export const BurgerPriorityDot = () => {
  const count = useAtomValue(priorityCountAtom);
  const info = useAtomValue(priorityInfoAtom);
  if (priorityDotWords(count, info?.label) === undefined) return null;
  return (
    <span
      aria-hidden
      data-burger-priority
      className="absolute top-0 -left-0.5 hidden size-1 rounded-full bg-priority compact:block"
    />
  );
};

const CARD_BUTTON = `flex cursor-pointer items-center gap-s2 border px-s3 py-s1 text-12 ${focusRing}`;

/**
 * The interjection: after an answer elsewhere while the priority Inbox has
 * Questions waiting, a card in the place of the next Question, over the list
 * and the answer box. Its Go there takes the focus, so ↩ goes there; Esc
 * carries on here, until the next answer. Questions arriving while it is up
 * are counted on it.
 */
export const PriorityCard = () => {
  const info = useAtomValue(interjectionAtom);
  const go = useAtomSet(goToPriorityAtom);
  const carryOn = useAtomSet(carryOnAtom);
  if (info === undefined) return null;
  const n = info.waiting.length;
  return (
    // The card owns ↩ and Esc while it has the focus, as a widget does: the
    // keymap's listener is on the document, so they stop here.
    <section
      aria-label="Priority inbox"
      data-priority-card
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        carryOn();
      }}
      className="absolute inset-0 z-30 flex items-center justify-center bg-bg px-s5 pt-header"
    >
      <div className="w-full max-w-measure border-l-2 border-priority py-s2 pl-s4">
        <div className="flex items-center gap-s1 font-zen text-11 text-priority">
          <Flag aria-hidden className="size-3" fill="currentColor" />
          <span className="font-medium tracking-label uppercase">
            Priority inbox
          </span>
        </div>
        <h1 className="mt-s2 font-reading text-18 font-medium text-fg">
          {countLabel(n, info.label)}
        </h1>
        <ul className="mt-s3 flex flex-col gap-s1 font-reading text-14 leading-snug text-fg/70">
          {info.waiting.slice(0, 3).map((q) => (
            <li key={q.number} className="line-clamp-2">
              <span className="font-zen text-11 text-fg/35">#{q.number} </span>
              {q.title}
            </li>
          ))}
          {n > 3 && <li className="text-fg/40">and {n - 3} more</li>}
        </ul>
        <div className="mt-s4 flex flex-wrap gap-s2 font-zen">
          <button
            type="button"
            // biome-ignore lint/a11y/noAutofocus: the card stands in for the next Question, so ↩ must reach it at once.
            autoFocus
            data-priority-card-go
            onClick={() => go({})}
            className={`${CARD_BUTTON} border-priority/50 text-priority hover:bg-priority/10`}
          >
            Go there {hintOf('↩')}
          </button>
          <button
            type="button"
            data-priority-card-carry-on
            onClick={() => carryOn()}
            className={`${CARD_BUTTON} border-fg/20 text-fg/70 hover:text-fg`}
          >
            Carry on here {hintOf('Esc')}
          </button>
        </div>
      </div>
    </section>
  );
};

/**
 * The boomerang's pill, under the header while a trip is out: how many
 * priority Questions are left before the way home, where home is, and Back
 * now, which goes there early.
 */
export const PriorityTripPill = () => {
  const trip = useAtomValue(priorityTripAtom);
  const info = useAtomValue(priorityInfoAtom);
  const back = useAtomSet(priorityBackAtom);
  const keys = useAtomValue(keyHintAtom('priority_back')).first;
  if (trip === null || info === undefined || info.inboxId !== trip.priority)
    return null;
  const left = info.waiting.length;
  return (
    <div
      data-priority-trip
      className="pointer-events-none absolute inset-x-0 top-header z-20 flex justify-center px-s4 pt-s1"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-s2 rounded-full border border-priority/40 bg-bg px-s3 py-0.5 font-zen text-11 shadow-sm">
        <Flag
          aria-hidden
          className="size-3 shrink-0 text-priority"
          fill="currentColor"
        />
        {/* Wraps rather than truncates: on a phone the way home is the
            part that matters, and an ellipsis would hide it. */}
        <span
          className="min-w-0 text-balance text-fg/70"
          data-priority-trip-left
        >
          {left} priority left, then back to{' '}
          <span className="whitespace-nowrap text-fg">{trip.from.label}</span>
        </span>
        <button
          type="button"
          data-priority-back
          onClick={() => back()}
          className={`group/back flex shrink-0 cursor-pointer items-center gap-s1 text-priority ${focusRing}`}
        >
          <span className="group-hover/back:underline">Back now</span>
          {hintOf(keys)}
        </button>
      </div>
    </div>
  );
};
