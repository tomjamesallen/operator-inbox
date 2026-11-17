import { Popover } from '@base-ui/react/popover';
import { useAtom, useAtomValue } from '@effect/atom-react';
import {
  type InboxMachineKey,
  LOCAL_MACHINE_KEY,
  type WidgetDto,
} from '@operator-inbox/core/api';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import {
  type Line,
  readWidgetOutput,
  toneFill,
  toneText,
  type WidgetOutput,
} from '../../widget-output';
import {
  ago,
  type DrawnWidget,
  type DrawnWidgetsMachine,
  drawnWidgetOf,
  machineWidgetsAtom,
  widgetAskFailureAtom,
  widgetKey,
  widgetRunAtom,
} from '../../widgets';
import { focusRing } from '../styles';

// The sidebar's widgets: one chip each, a box with a strip in its state's
// colour along its top, then its label and its state in a word, then
// `lines` rows of its output. A chip opens a popover with all of it, on
// hover, on a click, and on Space or Enter.

interface View {
  readonly machine: DrawnWidgetsMachine;
  readonly w: WidgetDto;
  readonly d: DrawnWidget;
  readonly out: WidgetOutput | undefined;
  // Why the last refresh asked from here failed, while no later one is taken.
  readonly askFailure: string | undefined;
}

const viewOf = (
  machine: DrawnWidgetsMachine,
  w: WidgetDto,
  askFailure: string | undefined,
): View => {
  const d = drawnWidgetOf(w, machine.now, machine.greyed);
  return {
    machine,
    w,
    d,
    out:
      d.shown === null ? undefined : readWidgetOutput(d.shown.stdout, w.format),
    askFailure,
  };
};

const failed = (v: View): boolean =>
  v.d.phase === 'error' || v.d.phase === 'failed';

const Spans = ({ line }: { readonly line: Line }) =>
  line.map((s, i) => (
    <span key={i} className={s.cls}>
      {s.text}
    </span>
  ));

/** The state's colour: its tone, red on a failure, grey with no tone. */
const fillOf = (v: View): string =>
  failed(v)
    ? 'bg-red'
    : v.out?.tone !== undefined
      ? toneFill[v.out.tone]
      : 'bg-fg/20';

const pulse = (v: View): string =>
  v.d.running ? 'motion-safe:animate-pulse' : '';

/** Output faded when it is no longer current. */
const faded = (v: View): string =>
  v.d.phase === 'stale' || v.d.phase === 'error' ? 'opacity-45' : '';

/** When it ran, how long it took, and when it runs next. */
const timingOf = (v: View): string => {
  const { w, d, machine } = v;
  const since = w.runningSince ?? machine.now;
  return [
    d.running
      ? `running for ${ago(machine.now - since)}`
      : d.ageMs === undefined
        ? 'no output yet'
        : `ran ${ago(d.ageMs)} ago`,
    w.lastRun === null ? '' : `in ${Math.round(w.lastRun.durationMs)}ms`,
    w.nextRunAt === null || d.running || machine.greyed
      ? ''
      : `next in ${ago(w.nextRunAt - machine.now)}`,
    w.refreshQueued && !machine.greyed ? 'a refresh is queued' : '',
  ]
    .filter((p) => p !== '')
    .join(', ');
};

// What a screen reader is told beyond the label and the output: what the
// strip and the border show by colour alone.
const spokenState = (v: View): string => {
  const tone =
    v.out?.tone === 'bad'
      ? 'problem'
      : v.out?.tone === 'warn'
        ? 'warning'
        : undefined;
  const phase = failed(v)
    ? `last run failed: ${v.d.failure ?? ''}`
    : v.d.phase === 'stale'
      ? `stale, ${ago(v.d.ageMs)} old`
      : v.d.running || v.d.phase === 'waiting'
        ? 'running'
        : undefined;
  return [tone, phase].filter((x) => x !== undefined).join(', ');
};

/** The chip's state in a word, on its first line, after the label. */
const stateWord = (
  v: View,
): { readonly text: string; readonly cls: string } => {
  if (failed(v)) return { text: 'failed', cls: 'text-red' };
  if (v.d.phase === 'stale')
    return { text: `stale · ${ago(v.d.ageMs)}`, cls: 'text-orange' };
  if (v.d.running || v.d.phase === 'waiting')
    return { text: 'running…', cls: 'text-fg/30' };
  return { text: ago(v.d.ageMs), cls: 'text-fg/30' };
};

/** What the popover says over the output: why it failed, why it is stale, why it reads oddly. */
const notesOf = (v: View): ReadonlyArray<string> => {
  const notes: Array<string> = [];
  if (v.machine.greyed)
    notes.push(
      `${v.machine.label} cannot be reached: this is its output at the last read.`,
    );
  if (v.askFailure !== undefined) notes.push(`Refresh failed: ${v.askFailure}`);
  if (v.d.failure !== undefined) {
    notes.push(`Last run failed: ${v.d.failure}`);
    const tail = v.w.lastRun?.stderrTail.trim() ?? '';
    if (tail !== '' && !v.d.failure.includes(tail)) notes.push(tail);
  }
  if (v.d.phase === 'stale' && !v.machine.greyed)
    notes.push(
      `Stale: the last output is ${ago(v.d.ageMs)} old, and a run every ${ago(v.w.intervalSeconds * 1000)} was due.`,
    );
  if (v.out?.note !== undefined) notes.push(v.out.note);
  if (v.d.shown?.truncated === true) notes.push('The output was cut short.');
  return notes;
};

const Refresh = ({ v }: { readonly v: View }) => {
  const { machine, w } = v;
  const [run, ask] = useAtom(widgetRunAtom(widgetKey(machine.key, w.id)));
  const spinning = v.d.running || run.waiting;
  const askFailed =
    v.askFailure === undefined ? '' : ` — the last ask failed: ${v.askFailure}`;
  const title = machine.greyed
    ? `${machine.label} cannot be reached, so ${w.label} cannot run`
    : `Refresh ${w.label} (${timingOf(v)})${askFailed}`;
  return (
    <button
      type="button"
      aria-label={`Refresh ${w.label}`}
      title={title}
      disabled={machine.greyed}
      data-widget-refresh
      onClick={(e) => {
        e.stopPropagation();
        ask(
          machine.key === LOCAL_MACHINE_KEY
            ? { id: w.id }
            : { machine: machine.key, id: w.id },
        );
      }}
      // Always laid out: only its colour comes and goes, so showing it moves
      // nothing.
      className={`flex shrink-0 cursor-pointer items-center p-0.5 disabled:cursor-default ${focusRing} ${
        spinning
          ? 'text-fg/60'
          : 'text-fg/0 group-hover/widget:text-fg/40 hover:text-fg/80 focus-visible:text-fg/60'
      }`}
    >
      <RefreshCw
        aria-hidden="true"
        className={`size-3 ${spinning ? 'motion-safe:animate-spin' : ''}`}
      />
    </button>
  );
};

/**
 * The chip's output: exactly `lines` rows, the first in its tone and the rest
 * muted; on a failure, what failed. Padded with blank rows, so a shorter
 * output never moves what is below.
 */
const Output = ({ v }: { readonly v: View }) => {
  const rows: Array<ReactNode> = [];
  if (v.d.failure !== undefined)
    rows.push(<span className="text-red/80">{v.d.failure}</span>);
  else if (v.out === undefined)
    rows.push(<span className="text-fg/30">…</span>);
  else {
    const { tone } = v.out;
    for (const [i, line] of v.out.lines.slice(0, v.w.lines).entries())
      rows.push(
        <span
          className={
            i === 0 && tone !== undefined ? toneText[tone] : 'text-fg/70'
          }
        >
          <Spans line={line} />
        </span>,
      );
  }
  while (rows.length < v.w.lines) rows.push(' ');
  return rows.map((row, i) => (
    <span
      key={i}
      data-widget-row
      className={`block min-w-0 overflow-hidden font-app text-ellipsis whitespace-pre ${faded(v)}`}
    >
      {row}
    </span>
  ));
};

const Chip = ({
  machine,
  w,
}: {
  readonly machine: DrawnWidgetsMachine;
  readonly w: WidgetDto;
}) => {
  const askFailure = useAtomValue(
    widgetAskFailureAtom(widgetKey(machine.key, w.id)),
  );
  const v = viewOf(machine, w, askFailure);
  // The escape hatch: Base UI takes an element to focus when a key opens the
  // popover, so its text is read and Tab reaches its refresh.
  const popup = useRef<HTMLDivElement>(null);
  const spoken = spokenState(v);
  const state = stateWord(v);
  const notes = notesOf(v);
  return (
    <Popover.Root>
      {/* A button may not hold a button, so the border is on the box, and
          the refresh sits over the trigger's top right corner. */}
      <div
        data-widget={w.id}
        data-widget-phase={v.d.phase}
        data-widget-greyed={machine.greyed || undefined}
        className={`group/widget relative w-full min-w-0 overflow-hidden rounded-sm border hover:bg-fg/5 ${
          failed(v)
            ? 'border-red/40'
            : v.d.phase === 'stale'
              ? 'border-dashed border-fg/20'
              : 'border-fg/10'
        } ${machine.greyed ? 'not-focus-visible:not-has-focus-visible:opacity-50' : ''}`}
      >
        <span
          aria-hidden="true"
          data-widget-strip
          className={`absolute inset-x-0 top-0 h-0.5 ${fillOf(v)} ${pulse(v)}`}
        />
        <Popover.Trigger
          openOnHover
          delay={250}
          closeDelay={150}
          data-widget-chip
          className={`flex w-full min-w-0 cursor-pointer flex-col px-s1 pt-1 pb-0.5 text-left ${focusRing}`}
        >
          <span className="flex min-w-0 items-center gap-s1 pr-s4">
            <span className="shrink truncate text-10 tracking-label text-fg/45 uppercase">
              {w.label}
            </span>
            {spoken !== '' && <span className="sr-only">{spoken}</span>}
            <span
              data-widget-state
              className={`ml-auto shrink-0 font-app whitespace-pre ${state.cls}`}
            >
              {state.text}
            </span>
          </span>
          <Output v={v} />
        </Popover.Trigger>
        <span className="absolute top-0.5 right-0.5">
          <Refresh v={v} />
        </span>
        {/* Always in the page, so what comes into it is heard. */}
        <output aria-live="polite" data-widget-announce className="sr-only">
          {askFailure === undefined
            ? ''
            : `Refresh ${w.label} failed: ${askFailure}`}
        </output>
      </div>
      <Popover.Portal>
        <Popover.Positioner
          side="right"
          align="start"
          sideOffset={8}
          className="z-40"
        >
          <Popover.Popup
            ref={popup}
            aria-label={`${w.label} widget`}
            data-widget-popup={w.id}
            // Opened by a key, focus moves into it; by the pointer, it stays.
            initialFocus={(type) =>
              type === 'keyboard' ? popup.current : false
            }
            className="max-w-96 min-w-56 rounded-md border border-fg/10 bg-bg p-s2 text-11 shadow-lg outline-none"
          >
            <div className="flex items-center gap-s1 pb-s1">
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${fillOf(v)} ${pulse(v)}`}
              />
              <span className="flex-1 truncate text-10 tracking-label text-fg/60 uppercase">
                {w.label}
              </span>
              <Refresh v={v} />
            </div>
            {v.out !== undefined && v.out.lines.length > 0 && (
              <div
                data-widget-lines
                className={`max-h-widget-lines overflow-auto scrollbar-none ${faded(v)}`}
              >
                {v.out.lines.map((line, i) => (
                  <div
                    key={i}
                    className={`font-app whitespace-pre ${i === 0 && v.out?.tone !== undefined ? toneText[v.out.tone] : 'text-fg/80'}`}
                  >
                    {line.length === 0 ? ' ' : <Spans line={line} />}
                  </div>
                ))}
              </div>
            )}
            {notes.length > 0 && (
              <div data-widget-note className="pt-s1 text-10">
                {notes.map((n) => (
                  <p key={n} className={failed(v) ? 'text-red' : 'text-orange'}>
                    {n}
                  </p>
                ))}
              </div>
            )}
            <p data-widget-timing className="pt-s1 text-10 text-fg/35">
              {timingOf(v)}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

/**
 * One machine's widgets, and one quiet line when its `widgets.json` has
 * problems. Nothing for a machine with neither, an older serve's among them.
 */
export const MachineWidgets = ({
  machine: key,
}: {
  readonly machine: InboxMachineKey;
}) => {
  const machine = useAtomValue(machineWidgetsAtom(key));
  if (
    machine === undefined ||
    (machine.widgets.length === 0 && machine.problems.length === 0)
  )
    return null;
  const { problems } = machine;
  const count = `${problems.length} problem${problems.length === 1 ? '' : 's'}`;
  return (
    <section
      aria-label={`${machine.label} widgets`}
      data-widgets={machine.key}
      className="flex flex-col gap-s1 px-s2 pb-s2"
    >
      {machine.widgets.map((w) => (
        <Chip key={w.id} machine={machine} w={w} />
      ))}
      {problems.length > 0 && (
        <p
          data-widgets-problems
          title={problems.join('\n')}
          className="truncate text-10 text-red"
        >
          widgets.json: {count}
          <span className="sr-only">: {problems.join('; ')}</span>
        </p>
      )}
    </section>
  );
};
