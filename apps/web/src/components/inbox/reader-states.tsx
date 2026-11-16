import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/reactivity';
import type { ReactNode } from 'react';
import { failureText, fetchSentence } from '../../failure';
import {
  copyMarkAtom,
  copyQuestionAtom,
  drawnBoardAtom,
  inboxBoardAtom,
  inboxesSeenAtom,
  isUnreadMachine,
  type MissingInbox,
  machineHintOf,
  missingInboxOf,
  selectedInboxAtom,
} from '../../inbox';
import { elsewhereShownAtom } from '../../inbox-elsewhere';
import { activeQueueAtom } from '../../inbox-reader';
import { inboxClashHeading, inboxClashNotice } from '../../machine-notices';
import { owlStirringAtom } from '../../owl-stir';
import { Elsewhere } from './elsewhere';
import { ICON_COPY, ICON_DONE, ICON_FAILED, Icon } from './icon';

// What stands in the question's place when there is no question: the first
// load, a board that could not be read, an Inbox that is not on the board, and
// an empty queue. Each says why, never "nothing waiting" when it cannot know.
// An empty Inbox, or group of one, while somewhere else has something lists
// those places instead (`Elsewhere`).

const namesOf = (machines: ReadonlyArray<{ readonly label: string }>) =>
  machines.map((m) => m.label).join(' and ');

const head = 'font-reading text-18 leading-card font-medium text-fg';
const line = 'mt-s2 font-reading text-14 leading-prose text-fg/70';

const CopyLine = ({
  text,
  name,
}: {
  readonly text: string;
  readonly name: string;
}) => {
  const mark = useAtomValue(copyMarkAtom(text));
  const copy = useAtomSet(copyQuestionAtom(text));
  return (
    <span className="flex items-center gap-s1">
      <code className="min-w-0 flex-1 truncate font-mono text-11 text-fg/70">
        {text}
      </code>
      <button
        type="button"
        aria-label={name}
        title={name}
        data-mark={mark}
        onClick={() => copy(text)}
        className={`flex shrink-0 cursor-pointer items-center ${mark === 'ok' ? 'text-green' : mark === 'bad' ? 'text-red' : 'text-fg/30 hover:text-fg'}`}
      >
        <Icon
          d={
            mark === 'ok' ? ICON_DONE : mark === 'bad' ? ICON_FAILED : ICON_COPY
          }
        />
      </button>
    </span>
  );
};

export const MachineHint = ({
  machine,
}: {
  readonly machine: Parameters<typeof machineHintOf>[0];
}) => {
  const hint = machineHintOf(machine);
  if (hint === undefined) return null;
  return hint._tag === 'Tunnel' ? (
    <div className="text-11">
      <p className="text-fg/60">Not reachable. Open the tunnel:</p>
      <CopyLine
        text={hint.command}
        name={`Copy the command that opens the tunnel to ${machine.label}`}
      />
    </div>
  ) : (
    <p className="text-11 wrap-break-word text-fg/60">{hint.text}</p>
  );
};

const Absent = ({
  missing,
  name,
}: {
  readonly missing: MissingInbox;
  readonly name: string;
}) => {
  switch (missing._tag) {
    case 'Missing':
      return <h1 className={head}>No inbox here.</h1>;
    case 'Unknown':
      return (
        <>
          <h1 className={head}>
            This inbox is not on any machine that answered.
          </h1>
          <p className={line}>
            {namesOf(missing.machines)} cannot be reached, so it may be there.
          </p>
        </>
      );
    case 'Unreached':
      return (
        <>
          <h1 className={head}>
            {name} is on {missing.machine.label}, which cannot be reached.
          </h1>
          <div className="mt-s3 max-w-measure font-zen">
            <MachineHint machine={missing.machine} />
          </div>
        </>
      );
    case 'Clashed':
      return (
        <>
          <h1 className={head}>{inboxClashHeading(missing.clash)}.</h1>
          <p className={`${line} first-letter:uppercase`}>
            {inboxClashNotice(missing.clash)}.
          </p>
          <p className={line}>
            {missing.clash.claims
              .map((c) => `${c.machine.label} calls it “${c.label}”`)
              .join('; ')}
            . Nothing is shown or sent until one of them stops claiming it.
          </p>
        </>
      );
  }
};

const EMPTY =
  'No inboxes yet. An agent session opens one with operator-inbox open.';

// One Z, where a rising one starts: just off the owl's ear.
const Z = 'M93 38h6l-6 7h6';

// An owl asleep in the in-tray: with nothing waiting, nothing needs it awake.
// It breathes, Zs drift off it, and now and then it stirs. It does so under
// reduced motion too: its motion is slight and slow, and the operator wants it.
const SnoozingOwl = () => {
  const stirring = useAtomValue(owlStirringAtom);
  // The lines and the beak each need these, as the beak stays out of the fade.
  const tip = `origin-owl ${stirring ? 'animate-owl-tip' : ''}`;
  const breath = 'origin-owl animate-owl-breathe';
  return (
    <svg
      viewBox="0 15 120 88"
      aria-hidden="true"
      data-zen-owl
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-36 overflow-visible fill-none stroke-fg"
    >
      <clipPath id="owl-above-rim">
        <rect width="120" height="66" />
      </clipPath>
      {/* One fade for the lot, so a line crossing another does not darken. */}
      <g className="opacity-45">
        {/* Still, so the rim stays put while the owl tips behind it. */}
        <g clipPath="url(#owl-above-rim)">
          <g className={tip}>
            <g className={breath}>
              <path d="M35 66C33 54 33 44 37 37L34 28 47 32Q60 28 73 32L86 28 83 37C87 44 87 54 85 66" />
              <path
                d="M60 48A11.5 11.5 0 1 0 49 60M60 48A11.5 11.5 0 1 1 71 60"
                className="stroke-fg/45"
              />
              <path
                d="M42 47Q48.5 52 55 47M65 47Q71.5 52 78 47"
                className={stirring ? 'animate-owl-stir-lid' : undefined}
              />
              <g
                className={`origin-center fill-fg stroke-none transform-fill ${stirring ? 'animate-owl-stir-eye' : 'scale-y-0'}`}
              >
                <circle cx="48.5" cy="48" r="3.25" />
                <circle cx="71.5" cy="48" r="3.25" />
              </g>
            </g>
          </g>
        </g>
        <path d="M12 66H108L99 96a4 4 0 0 1-4 3H25a4 4 0 0 1-4-3Z" />
      </g>
      <g className={tip}>
        <g className={breath}>
          <path
            d="M56 52Q60 50.5 64 52L60 59Z"
            className="fill-yellow stroke-none"
          />
        </g>
      </g>
      <g className="stroke-yellow/80">
        <path
          d={Z}
          className="origin-center animate-owl-z-1 opacity-0 transform-fill"
        />
        <path
          d={Z}
          className="origin-center animate-owl-z-2 opacity-0 transform-fill"
        />
        <path
          d={Z}
          className="origin-center animate-owl-z-3 opacity-0 transform-fill"
        />
      </g>
    </svg>
  );
};

const Asleep = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex flex-col items-center gap-s3 text-center">
    <SnoozingOwl />
    <div>{children}</div>
  </div>
);

/** The question's place, while a queue has no question to put there. */
export const NoQuestion = () => {
  const result = useAtomValue(inboxBoardAtom);
  const board = useAtomValue(drawnBoardAtom);
  const selected = useAtomValue(selectedInboxAtom);
  const seen = useAtomValue(inboxesSeenAtom);
  const queue = useAtomValue(activeQueueAtom);
  const elsewhere = useAtomValue(elsewhereShownAtom);
  if (board === undefined)
    return AsyncResult.isFailure(result) ? (
      <p
        className="font-reading text-14 leading-prose text-red"
        role="alert"
        data-zen-failure
      >
        {fetchSentence(failureText(result.cause))}
      </p>
    ) : (
      // The first load is the wordmark alone: this is for a screen reader.
      <output className="sr-only">Loading…</output>
    );
  if (
    selected !== undefined &&
    !board.views.some((v) => v.inboxId === selected)
  )
    return (
      <Absent
        missing={missingInboxOf(board, selected, seen)}
        name={seen.get(selected)?.label ?? 'This inbox'}
      />
    );
  if (elsewhere) return <Elsewhere />;
  const unread = (board.machines ?? []).filter(
    (m) => isUnreadMachine(m) && !board.greyed.has(m.key),
  );
  if (board.views.length === 0 && unread.length === 0)
    return (
      <Asleep>
        <h1 className="font-reading text-18 text-fg/40">{EMPTY}</h1>
      </Asleep>
    );
  return (
    <Asleep>
      <h1 className="font-reading text-18 font-medium text-fg/40">
        {queue === 'inbox' ? 'Nothing waiting on you.' : 'Nothing here.'}
      </h1>
      {selected === undefined && unread.length > 0 && (
        <p className="mt-s2 font-reading text-14 leading-prose text-fg/55">
          {namesOf(unread)} cannot be reached, so there may be more there.
        </p>
      )}
    </Asleep>
  );
};
