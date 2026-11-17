import {
  decodeWidgetsFile,
  loadXdgConfigHome,
  WIDGET_PROBLEM_IGNORED,
  type WidgetConfig,
  widgetsPath,
} from '@operator-inbox/core';
import { Console, Effect, FileSystem, Result } from 'effect';
import { Command, Flag } from 'effect/cli';
import { InputError } from '../errors';

// `operator-inbox widgets`: the widgets the sidebar shows, read from
// `widgets.json` as serve reads it, so the operator can check a file before
// serve runs it. It runs nothing. A file that does not decode fails the
// command with the same sentence serve gives; no file is no widgets, and not
// a failure. An entry with a problem is dropped and the rest still run, as in
// serve, so each problem is printed with what it costs.

export interface WidgetsReport {
  readonly path: string;
  readonly exists: boolean;
  /** The file's `path` entries, in front of serve's `PATH` for every widget. */
  readonly searchPath: ReadonlyArray<string>;
  readonly widgets: ReadonlyArray<WidgetConfig>;
  readonly problems: ReadonlyArray<string>;
}

export const readWidgets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const p = widgetsPath(
    yield* loadXdgConfigHome.pipe(
      Effect.mapError((e) => new InputError({ message: e.message })),
    ),
  );
  const cannotRead = (cause: unknown) =>
    new InputError({
      message: `could not read ${p}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  const exists = yield* fs.exists(p).pipe(Effect.mapError(cannotRead));
  if (!exists)
    return {
      path: p,
      exists: false,
      searchPath: [],
      widgets: [],
      problems: [],
    } satisfies WidgetsReport;
  const text = yield* fs.readFileString(p).pipe(Effect.mapError(cannotRead));
  const decoded = decodeWidgetsFile(text, p);
  if (Result.isFailure(decoded))
    return yield* new InputError({ message: decoded.failure });
  return {
    path: p,
    exists: true,
    searchPath: decoded.success.path,
    widgets: decoded.success.widgets,
    problems: decoded.success.problems,
  } satisfies WidgetsReport;
});

/** A problem as the command prints it: what it costs, then the problem. */
export const problemLine = (problem: string): string =>
  problem.endsWith(WIDGET_PROBLEM_IGNORED)
    ? `  ignored  ${problem.slice(0, -WIDGET_PROBLEM_IGNORED.length)}`
    : `  dropped  ${problem}`;

const plural = (n: number, one: string): string =>
  `${n} ${one}${n === 1 ? '' : 's'}`;

/** How a widget runs, in a few words. */
export const widgetLine = (w: WidgetConfig): string =>
  [
    `every ${w.intervalSeconds}s`,
    `timeout ${w.timeoutSeconds}s`,
    w.format,
    plural(w.lines, 'line'),
    ...(w.text === undefined ? [] : ['templated']),
  ].join(', ');

// What a file to start from looks like, said where there is none.
const STARTER = '{ "widgets": [ { "label": "Load", "command": "uptime" } ] }';

export const renderWidgets = (report: WidgetsReport): string => {
  if (!report.exists)
    return `no widgets: there is no ${report.path}. To start one, write ${STARTER} there`;
  const width = Math.max(0, ...report.widgets.map((w) => w.id.length));
  const runs = report.widgets.length;
  const problems = report.problems.length;
  return [
    report.path,
    ...(report.searchPath.length === 0
      ? []
      : [`path, in front of serve's PATH: ${report.searchPath.join(':')}`]),
    ...report.widgets.flatMap((w) => [
      `${w.id.padEnd(width)}  ${w.label} — ${widgetLine(w)}`,
      `${' '.repeat(width)}  runs: ${w.command}`,
    ]),
    ...(problems === 0
      ? []
      : ['problems:', ...report.problems.map(problemLine)]),
    runs === 0 && problems === 0
      ? 'no widgets in the file'
      : `${plural(runs, 'widget')} will run${problems === 0 ? '' : `, ${plural(problems, 'problem')}`}`,
  ].join('\n');
};

export const widgetsCommand = Command.make(
  'widgets',
  {
    json: Flag.Boolean('json').pipe(
      Flag.withDescription(
        'Print the file’s path, its widgets and its problems as JSON',
      ),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Effect.flatMap(readWidgets, (report) =>
      Console.log(
        json
          ? JSON.stringify(
              {
                path: report.path,
                searchPath: report.searchPath,
                widgets: report.widgets,
                problems: report.problems,
              },
              null,
              2,
            )
          : renderWidgets(report),
      ),
    ),
).pipe(
  Command.withDescription(
    "Print the widgets the sidebar shows (~/.config/operator-inbox/widgets.json) and check the file: each widget's id, label, interval, timeout, format and lines, its command, and each problem, with whether it drops the widget or is ignored. Runs nothing. A file that does not decode exits non-zero, saying why",
  ),
);
