import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { type KeyboardEvent, useCallback } from 'react';
import { openInboxSessionAtom, relAge } from '../../inbox';
import { chaseNowAtom } from '../../inbox-chase';
import {
  type ElsewhereLine,
  type ElsewhereRow,
  elsewhereFocusAskedAtom,
  elsewhereLinesAtom,
  needsAttention,
  pickElsewhereAtom,
  setElsewhereCursorAtom,
  stepElsewhereAtom,
} from '../../inbox-elsewhere';
import { freshMark, MarkStack } from './marks';

// The empty state while other Inboxes have something: the owl, awake, sat on a
// box listing them. Which Inboxes, in what order, and what a line does are
// `inbox-elsewhere.ts`. The list is a listbox the ask's picker's way: the
// focus stays on the list, `aria-activedescendant` names the line lit, the
// arrows move it, Enter picks it, and a hover lights it.

const LIST_ID = 'elsewhere-list';
const HINT_ID = 'elsewhere-keys';
const lineId = (key: string) => `elsewhere-${key}`;

/**
 * The empty state's owl (`SnoozingOwl`'s drawing), awake: its eyes open, a
 * little lidded, a blink every few seconds and a shake now and then. Its body
 * runs on below its base, behind the box it sits on, so the box's top edge is
 * what cuts it off and no line of the owl crosses the box. With reduced motion
 * it sits still, eyes open.
 */
export const AwakeOwl = () => (
  <svg
    viewBox="0 15 120 57"
    aria-hidden="true"
    data-zen-owl="awake"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="relative -mb-2 w-36 overflow-visible fill-none stroke-fg"
  >
    <g className="origin-owl animate-owl-shake motion-reduce:animate-none">
      {/* One fade for the lot, so a line crossing another does not darken. */}
      <g className="opacity-45">
        <path d="M35 72V66C33 54 33 44 37 37L34 28 47 32Q60 28 73 32L86 28 83 37C87 44 87 54 85 66V72" />
        <path
          d="M60 48A11.5 11.5 0 1 0 49 60M60 48A11.5 11.5 0 1 1 71 60"
          className="stroke-fg/45"
        />
        <path
          d="M42 47Q48.5 52 55 47M65 47Q71.5 52 78 47"
          data-owl-lid
          className="animate-owl-blink-lid opacity-0 motion-reduce:hidden"
        />
      </g>
      <g
        data-owl-eyes
        className="origin-center animate-owl-blink fill-fg stroke-none opacity-80 transform-fill motion-reduce:animate-none"
      >
        <circle cx="48.5" cy="48" r="3.25" />
        <circle cx="71.5" cy="48" r="3.25" />
      </g>
      <path
        d="M56 52Q60 50.5 64 52L60 59Z"
        className="fill-yellow stroke-none"
      />
    </g>
  </svg>
);

const waited = (ms: number) => relAge(ms / 86_400_000);

const titleOf = (row: ElsewhereRow, nowMs: number): string =>
  [
    row.label,
    row.lastAt === undefined
      ? undefined
      : `Last activity ${waited(Math.max(0, nowMs - row.lastAt))} ago`,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

// The line lit is drawn so only while the list holds the focus, as a menu's
// highlighted item is; a hover lights a line either way.
const LINE =
  'flex w-full cursor-pointer items-center gap-s2 px-s3 py-s1 text-left hover:bg-fg/5 group-focus/list:data-lit:bg-fg/8';

const InboxLine = ({
  line,
  lit,
}: {
  readonly line: Extract<ElsewhereLine, { _tag: 'Inbox' }>;
  readonly lit: boolean;
}) => {
  const pick = useAtomSet(pickElsewhereAtom);
  const setCursor = useAtomSet(setElsewhereCursorAtom);
  const now = useAtomValue(chaseNowAtom);
  const { row } = line;
  return (
    <button
      type="button"
      id={lineId(line.key)}
      role="option"
      aria-selected={lit}
      tabIndex={-1}
      data-lit={lit || undefined}
      data-elsewhere={row.inboxId}
      title={titleOf(row, now)}
      // A press keeps the focus where it is, on the list.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(line)}
      onMouseEnter={() => setCursor(line.key)}
      className={`${LINE} text-fg/70 hover:text-fg group-focus/list:data-lit:text-fg`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{row.label}</span>
        {row.session !== undefined && (
          <span className="truncate text-10 text-fg/40" data-elsewhere-session>
            {row.session}
          </span>
        )}
      </span>
      {needsAttention(row) && (
        <span
          data-attention
          title={`${row.stuck === 1 ? '1 question' : `${row.stuck} questions`} with the agent for ${waited(row.stuckForMs)}`}
          className="shrink-0 rounded-full border border-orange/40 px-1.5 text-10 text-orange"
        >
          needs attention
        </span>
      )}
      <span className="w-4 shrink-0 text-right text-11 tabular-nums text-fg/50">
        {row.count === 0 ? '' : row.count}
      </span>
      {row.fresh === undefined ? (
        <span className="size-1.5 shrink-0" />
      ) : (
        <MarkStack marks={[freshMark(row.fresh)]} />
      )}
    </button>
  );
};

const AllLine = ({
  line,
  lit,
}: {
  readonly line: Extract<ElsewhereLine, { _tag: 'All' }>;
  readonly lit: boolean;
}) => {
  const pick = useAtomSet(pickElsewhereAtom);
  const setCursor = useAtomSet(setElsewhereCursorAtom);
  return (
    <button
      type="button"
      id={lineId(line.key)}
      role="option"
      aria-selected={lit}
      tabIndex={-1}
      data-lit={lit || undefined}
      data-elsewhere-all
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(line)}
      onMouseEnter={() => setCursor(line.key)}
      className={`${LINE} mt-s1 border-t border-fg/10 pt-s2 text-11 text-fg/45 hover:text-fg group-focus/list:data-lit:text-fg`}
    >
      Show all inbox items
    </button>
  );
};

// What the lit line's keys do, said under the box while the list holds the
// focus. Ctrl+Enter is there only for a session this machine can open.
const hintOf = (line: ElsewhereLine | undefined): string => {
  if (line?._tag !== 'Inbox') return '↩ show all';
  return line.row.target?._tag === 'Here'
    ? '↩ open · Ctrl+↩ session'
    : '↩ open';
};

// Nothing holds the focus, or the box at the foot does, which an answer that
// empties the Inbox has just taken away. Anywhere else the operator put it.
const focusIsFree = (): boolean => {
  const at = document.activeElement;
  return (
    at === null ||
    at === document.body ||
    (at instanceof HTMLElement && at.dataset.zenBox !== undefined)
  );
};

/** The other Inboxes with something for the operator, under the awake owl. */
export const Elsewhere = () => {
  const { lines, cursor } = useAtomValue(elsewhereLinesAtom);
  const step = useAtomSet(stepElsewhereAtom);
  const pick = useAtomSet(pickElsewhereAtom);
  const openSession = useAtomSet(openInboxSessionAtom);
  const asked = useAtomValue(elsewhereFocusAskedAtom);
  const setAsked = useAtomSet(elsewhereFocusAskedAtom);
  // A new callback when the focus is asked for, so a list already drawn
  // takes it too.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null || asked === false) return;
      setAsked(false);
      if (asked === 'moved' || focusIsFree()) el.focus({ preventScroll: true });
    },
    [asked, setAsked],
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.shiftKey) return;
    const chord = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && chord) {
      // The lit line's session; the keymap's open_session keeps to the
      // selected Inbox's.
      if (cursor?._tag === 'Inbox') openSession(cursor.row.inboxId);
    } else if (chord) return;
    else if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home') step('first');
    else if (e.key === 'End') step('last');
    else if (e.key === 'Enter' && cursor !== undefined) pick(cursor);
    else return;
    // The list's keys, not the keymap's: Ctrl+Enter there sends an answer.
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      data-zen-elsewhere
      className="group/elsewhere flex flex-col items-center text-center"
    >
      <h1 className="sr-only">Nothing waiting on you here</h1>
      <AwakeOwl />
      {/* After the owl and positioned, so it paints over the owl's base. */}
      <div className="relative w-full max-w-sm rounded-xl border border-fg/25 bg-bg py-s1 text-left font-zen text-12 group-focus-within/elsewhere:border-fg/40">
        <div
          ref={attach}
          id={LIST_ID}
          role="listbox"
          tabIndex={0}
          aria-label="Other inboxes with something for you"
          aria-activedescendant={
            cursor === undefined ? undefined : lineId(cursor.key)
          }
          aria-describedby={HINT_ID}
          aria-keyshortcuts="Enter Control+Enter"
          onKeyDown={onKeyDown}
          className="group/list outline-none"
        >
          {lines.map((line) =>
            line._tag === 'Inbox' ? (
              <InboxLine
                key={line.key}
                line={line}
                lit={line.key === cursor?.key}
              />
            ) : (
              <AllLine
                key={line.key}
                line={line}
                lit={line.key === cursor?.key}
              />
            ),
          )}
        </div>
      </div>
      <p
        id={HINT_ID}
        data-elsewhere-keys
        className="invisible mt-s2 text-10 text-fg/35 group-focus-within/elsewhere:visible"
      >
        {hintOf(cursor)}
      </p>
    </div>
  );
};
