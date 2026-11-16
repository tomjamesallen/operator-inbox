import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import {
  CircleAlert,
  Headphones,
  LoaderCircle,
  Pause,
  Play,
} from 'lucide-react';
import { keyHintAtom } from '../../keymap';
import {
  listenOnAtom,
  litReadyAtom,
  litScriptAtom,
  playerStateAtom,
  playPauseAtom,
  RATES,
  type Readiness,
  readinessAtom,
  readoutMakingAtom,
  readoutRateAtom,
  readoutTimeAtom,
  readoutUnavailableAtom,
  seekAtom,
  setRateAtom,
  toggleListenAtom,
} from '../../readout/readout';
import { focusRing } from '../styles';
import { Tip } from './icon';

// Listen mode's control, on the left of the line over the answer box: one
// split button. Off, a quiet headphones toggle and nothing else; on, it turns
// yellow, play and pause slide out of it to the right, and the progress bar
// and the speeds fade in after it. Turning it on or off moves nothing else on
// the line. On a phone the buttons are a finger's size, and the bar has a
// strip of its own under them, kept whether listen mode is on or off.

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// What the bar says instead while the lit Question's audio is not made.
const waitingText = (r: Readiness | undefined): string | undefined => {
  switch (r?._tag) {
    case undefined:
    case 'Asking':
      return 'asking for the audio…';
    case 'Queued':
      return 'queued…';
    case 'Generating':
      return 'making the audio…';
    case 'Failed':
    case 'Unreachable':
      return r.message;
    case 'Ready':
      return undefined;
  }
};

/** The bar: one stretch per segment, sized by its share of the audio, filling as it is read; a tap seeks. */
const SegmentBar = () => {
  const lit = useAtomValue(litReadyAtom);
  const time = useAtomValue(readoutTimeAtom);
  const seek = useAtomSet(seekAtom);
  if (lit === undefined) return null;
  return (
    <span
      data-readout-bar
      className="flex h-3 min-w-0 flex-1 items-center gap-px compact:absolute compact:inset-x-0 compact:bottom-0 compact:h-5"
    >
      {lit.ready.segments.map((s, i) => {
        const done =
          time >= s.end
            ? 1
            : time <= s.start
              ? 0
              : (time - s.start) / (s.end - s.start);
        const described = lit.script.segments[i]?.kind === 'described';
        return (
          <button
            key={s.id}
            type="button"
            tabIndex={-1}
            aria-label={`Play from ${lit.script.segments[i]?.text.slice(0, 40) ?? s.id}`}
            title={lit.script.segments[i]?.text}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const f = (e.clientX - box.left) / Math.max(1, box.width);
              seek(s.start + f * (s.end - s.start));
            }}
            // A segment's share of the bar is its share of the audio: a
            // runtime number no utility can hold.
            style={{ flexGrow: Math.max(0.01, s.end - s.start) }}
            // The full height, a finger's target on a phone; the line stays
            // thin inside it.
            className="flex h-full cursor-pointer items-center"
          >
            <span
              className={`relative h-1 w-full overflow-hidden rounded-full ${described ? 'bg-yellow/25' : 'bg-fg/15'}`}
            >
              <span
                style={{ width: `${done * 100}%` }}
                className="absolute inset-y-0 left-0 bg-yellow"
              />
            </span>
          </button>
        );
      })}
    </span>
  );
};

/** The time left, in real seconds at the speed chosen; a phone shows only the bar. */
const TimeLeft = () => {
  const lit = useAtomValue(litReadyAtom);
  const time = useAtomValue(readoutTimeAtom);
  const rate = useAtomValue(readoutRateAtom);
  if (lit === undefined) return null;
  return (
    <span className="shrink-0 tabular-nums compact:hidden">
      {clock(Math.max(0, lit.ready.duration - time) / rate)}
    </span>
  );
};

/** The speeds, one pressed; the keys step through them. */
const Speeds = () => {
  const rate = useAtomValue(readoutRateAtom);
  const setRate = useAtomSet(setRateAtom);
  const slower = useAtomValue(keyHintAtom('slower_readout'));
  const faster = useAtomValue(keyHintAtom('faster_readout'));
  const keys = [slower.first, faster.first]
    .filter((k) => k !== undefined)
    .join(' / ');
  return (
    <span className="flex shrink-0 compact:hidden">
      <Tip label="Reading speed" keys={keys === '' ? undefined : keys}>
        <ToggleGroup
          aria-label="Reading speed"
          data-readout-speed
          value={[String(rate)]}
          onValueChange={(v) => {
            const next = RATES.find((r) => String(r) === v[0]);
            if (next !== undefined) setRate(next);
          }}
          className="flex items-center"
        >
          {RATES.map((r) => (
            <Toggle
              key={r}
              value={String(r)}
              onMouseDown={(e) => e.preventDefault()}
              className={`cursor-pointer rounded-sm px-1 text-10 tabular-nums text-fg/40 hover:text-fg data-pressed:bg-yellow/15 data-pressed:text-yellow ${focusRing}`}
            >
              {`${r}×`}
            </Toggle>
          ))}
        </ToggleGroup>
      </Tip>
    </span>
  );
};

/** A phone's speed: one chip, each tap the next speed round. */
const RateChip = () => {
  const rate = useAtomValue(readoutRateAtom);
  const setRate = useAtomSet(setRateAtom);
  const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
  return (
    <button
      type="button"
      aria-label={`Reading speed ${rate}×, tap for ${next}×`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setRate(next)}
      className={`hidden shrink-0 cursor-pointer rounded-sm compact:flex compact:size-8 compact:items-center compact:justify-center compact:text-12 tabular-nums ${rate === 1 ? 'text-fg/40' : 'bg-yellow/15 text-yellow'} ${focusRing}`}
    >
      {`${rate}×`}
    </button>
  );
};

const PlayGlyph = ({
  state,
  readiness,
}: {
  readonly state: string;
  readonly readiness: Readiness | undefined;
}) => {
  const icon = 'size-2.5 compact:size-3.5';
  if (state === 'playing')
    return (
      <Pause
        aria-hidden="true"
        strokeWidth={2.5}
        className={`${icon} fill-current`}
      />
    );
  if (readiness?._tag === 'Failed' || readiness?._tag === 'Unreachable')
    return (
      <CircleAlert aria-hidden="true" strokeWidth={2.5} className={icon} />
    );
  if (state === 'waiting' || readiness?._tag !== 'Ready')
    return (
      <LoaderCircle
        aria-hidden="true"
        strokeWidth={2.5}
        className={`${icon} ${state === 'waiting' ? 'animate-spin' : ''}`}
      />
    );
  return (
    <Play
      aria-hidden="true"
      strokeWidth={2.5}
      className={`${icon} fill-current`}
    />
  );
};

export const ListenControl = () => {
  const on = useAtomValue(listenOnAtom);
  const lit = useAtomValue(litScriptAtom);
  const readiness = useAtomValue(readinessAtom(lit?.script.key ?? ''));
  const unavailable = useAtomValue(readoutUnavailableAtom);
  const making = useAtomValue(readoutMakingAtom);
  const state = useAtomValue(playerStateAtom);
  const toggle = useAtomSet(toggleListenAtom);
  const playPause = useAtomSet(playPauseAtom);
  const toggleHint = useAtomValue(keyHintAtom('toggle_listen'));
  const playHint = useAtomValue(keyHintAtom('play_readout'));
  const playing = state === 'playing';
  const waiting = on ? waitingText(readiness) : undefined;
  const why = unavailable ?? waiting;
  return (
    <span
      data-readout-control
      className="mr-s2 flex min-w-0 flex-1 items-center gap-s2"
    >
      <span
        className={`flex h-4 shrink-0 items-center overflow-hidden rounded-sm transition-colors duration-200 compact:h-8 ${on ? 'bg-yellow/15 text-yellow' : 'text-fg/30'}`}
      >
        <Tip
          label={on ? 'Turn listen mode off' : 'Turn listen mode on'}
          keys={toggleHint.first}
        >
          <Toggle
            pressed={on}
            onPressedChange={() => toggle(undefined)}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Listen mode"
            aria-keyshortcuts={toggleHint.aria}
            data-readout-toggle
            className={`relative flex size-4 cursor-pointer items-center justify-center compact:size-8 ${on ? 'hover:bg-yellow/25' : 'hover:text-fg/70'} ${focusRing}`}
          >
            <Headphones
              aria-hidden="true"
              strokeWidth={2}
              className="size-3 compact:size-4"
            />
            {on && making && (
              <span className="absolute top-0.5 right-0.5 size-1 animate-pulse rounded-full bg-yellow" />
            )}
          </Toggle>
        </Tip>
        {/* Slides out of the headphones: its width opens from nothing. */}
        <span
          className={`flex h-full items-center overflow-hidden transition-all duration-200 ease-out ${on ? 'max-w-4 opacity-100 compact:max-w-8' : 'max-w-0 opacity-0'}`}
        >
          <Tip
            label={playing ? 'Pause' : 'Listen to this question'}
            keys={playHint.first}
          >
            <button
              type="button"
              tabIndex={on ? 0 : -1}
              disabled={lit === undefined}
              data-readout-play={state}
              aria-label={playing ? 'Pause' : 'Listen to this question'}
              aria-keyshortcuts={playHint.aria}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => playPause(undefined)}
              className={`flex size-4 shrink-0 cursor-pointer items-center justify-center border-l border-yellow/25 hover:bg-yellow/25 compact:size-8 ${focusRing}`}
            >
              <PlayGlyph state={state} readiness={readiness} />
            </button>
          </Tip>
        </span>
      </span>
      {/* Then the bar and the speeds, fading in after it: a fade, not a
          slide, since a transform would hold a phone's bar to this span. */}
      <span
        aria-hidden={!on}
        className={`flex min-w-0 flex-1 items-center gap-s2 transition-opacity duration-300 ease-out ${on ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        {on &&
          (why !== undefined ? (
            <span
              data-readout-status
              className={`min-w-0 truncate ${unavailable !== undefined || readiness?._tag === 'Failed' || readiness?._tag === 'Unreachable' ? 'text-orange' : ''}`}
              title={why}
            >
              {why}
            </span>
          ) : (
            <>
              <SegmentBar />
              <TimeLeft />
              <Speeds />
              <RateChip />
            </>
          ))}
      </span>
    </span>
  );
};
