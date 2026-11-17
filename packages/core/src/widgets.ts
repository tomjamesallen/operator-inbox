import { Result, Schema } from 'effect';
import {
  formatSchemaIssues,
  joinSchemaIssuePath,
  type SchemaIssueItem,
} from './schema-issues';
import {
  checkTemplate,
  WIDGET_TONES,
  type WidgetToneRule,
} from './widget-template';

// Widgets: small commands the operator configures in `widgets.json`, which
// serve runs on a timer and the sidebar shows the output of. A widget is a
// label, a shell command, how often it runs and how its output is read: as
// text, or as JSON, either the envelope the page reads or the command's own
// JSON mapped through templates (`widget-template.ts`).
//
// Each entry is checked on its own: a bad one is dropped with a problem naming
// it (`widgets.2.intervalSeconds — at least 5`) and the rest still run. Only a
// file that is not JSON, or not `{ "widgets": [ … ] }`, fails as a whole.
//
// BROWSER-SAFE: `api/index.ts` re-exports it for the page's types, so it may
// import only `effect` and core's own pure modules.

/** The file's name, beside `macros.json` in the config folder. */
export const WIDGETS_FILE = 'widgets.json';

/** The fewest seconds between one run's end and the next one's start. */
export const WIDGET_MIN_INTERVAL_SECONDS = 5;
export const WIDGET_DEFAULT_INTERVAL_SECONDS = 60;
/** A run's timeout unless set: this, or the interval when that is shorter. */
export const WIDGET_DEFAULT_TIMEOUT_SECONDS = 10;
export const WIDGET_MIN_TIMEOUT_SECONDS = 1;
/** How many lines of output a chip may show. */
export const WIDGET_MAX_LINES = 4;
/**
 * How a problem that costs nothing ends: its key is ignored and the widget
 * kept. Every other problem drops the entry it names.
 */
export const WIDGET_PROBLEM_IGNORED = ': ignored';

// --- the config -----------------------------------------------------------------

const nonBlank = Schema.makeFilter(
  (s: string) => s.trim() !== '' || 'a non-empty string',
);

// A widget's id names its cached run on disk (`widgets/<id>.json`) and is what
// the page sends to refresh it, so it is kept to what is safe in a file name
// on a case-insensitive disk.
export const WidgetId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
    message:
      'lower-case letters, digits, - and _, from a letter or digit, at most 64',
  }),
);
export type WidgetId = typeof WidgetId.Type;

export const WidgetFormat = Schema.Literals(['text', 'json']);
export type WidgetFormat = typeof WidgetFormat.Type;

export const WidgetToneSchema = Schema.Literals(WIDGET_TONES);

const ToneMap = Schema.Record(Schema.String, WidgetToneSchema);
const tonePath = Schema.String.check(nonBlank);
const ToneMapRule = Schema.Struct({ from: tonePath, map: ToneMap });
const ToneAboveRule = Schema.Struct({ from: tonePath, above: ToneMap });
export const WidgetToneRuleSchema = Schema.Union([ToneMapRule, ToneAboveRule]);

const seconds = (minimum: number) =>
  Schema.Finite.check(
    Schema.makeFilter((n: number) => n >= minimum || `at least ${minimum}`),
  );

// One entry as the file holds it. Every key but `label` and `command` has a
// default (`WidgetConfig`).
export const WidgetEntry = Schema.Struct({
  id: Schema.optionalKey(WidgetId),
  label: Schema.String.check(nonBlank),
  command: Schema.String.check(nonBlank),
  intervalSeconds: Schema.optionalKey(seconds(WIDGET_MIN_INTERVAL_SECONDS)),
  timeoutSeconds: Schema.optionalKey(seconds(WIDGET_MIN_TIMEOUT_SECONDS)),
  format: Schema.optionalKey(WidgetFormat),
  lines: Schema.optionalKey(
    Schema.Number.check(
      Schema.makeFilter(
        (n: number) =>
          (Number.isInteger(n) && n >= 1 && n <= WIDGET_MAX_LINES) ||
          `a whole number from 1 to ${WIDGET_MAX_LINES}`,
      ),
    ),
  ),
  text: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  tone: Schema.optionalKey(WidgetToneRuleSchema),
});
export type WidgetEntry = typeof WidgetEntry.Type;

// The file as a whole. `path` goes in front of serve's `PATH` for every
// widget, so a tool installed outside it needs no full path in each command.
export const WidgetsFile = Schema.Struct({
  path: Schema.optionalKey(Schema.Array(Schema.String.check(nonBlank))),
  widgets: Schema.Array(WidgetEntry),
});
export type WidgetsFile = typeof WidgetsFile.Type;

/** A widget as serve runs it: an entry with every default filled in. */
export interface WidgetConfig {
  readonly id: WidgetId;
  readonly label: string;
  readonly command: string;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly format: WidgetFormat;
  readonly lines: number;
  // A `json` widget's templates: with `text` set, the command prints its own
  // JSON and serve maps it to the envelope's text, detail and tone.
  readonly text?: string;
  readonly detail?: string;
  readonly tone?: WidgetToneRule;
}

/** What a file gives: the widgets that can run, and why any others cannot. */
export interface DecodedWidgets {
  readonly path: ReadonlyArray<string>;
  readonly widgets: ReadonlyArray<WidgetConfig>;
  readonly problems: ReadonlyArray<string>;
}

/** A widget's id when it sets none: its label, lower-cased and dashed. */
export const widgetIdOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');

// The file's shape with each entry left unread, so one bad entry costs that
// entry alone.
const FileShape = Schema.Struct({
  path: WidgetsFile.fields.path,
  widgets: Schema.Array(Schema.Unknown),
});

// An entry with its tone left unread too: a union's issues name both of its
// branches, so the tone is read apart, by the branch its keys choose.
const EntryShape = Schema.Struct({
  ...WidgetEntry.fields,
  tone: Schema.optionalKey(Schema.Unknown),
});

const options = { errors: 'all', reportInput: true } as const;
const decodeShape = Schema.decodeUnknownResult(FileShape, options);
const decodeEntry = Schema.decodeUnknownResult(EntryShape, options);
const decodeToneMap = Schema.decodeUnknownResult(ToneMapRule, options);
const decodeToneAbove = Schema.decodeUnknownResult(ToneAboveRule, options);

// `key — what was wrong`, the form every problem is in.
const problem = (at: ReadonlyArray<PropertyKey>, message: string): string =>
  `${joinSchemaIssuePath(at)} — ${message}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// What an entry's shape cannot say: templates on a text widget, a tone or a
// detail with no text, a template that does not parse, a threshold that is not
// a number, a label that makes no id.
const entryProblems = (
  at: ReadonlyArray<PropertyKey>,
  entry: WidgetEntry,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const templated = (['text', 'detail', 'tone'] as const).filter(
    (k) => entry[k] !== undefined,
  );
  if ((entry.format ?? 'text') === 'text')
    for (const k of templated)
      problems.push(problem([...at, k], 'only a json widget takes it'));
  else if (entry.text === undefined)
    for (const k of templated)
      problems.push(problem([...at, k], 'needs a text template beside it'));
  for (const k of ['text', 'detail'] as const) {
    const template = entry[k];
    if (template === undefined) continue;
    const checked = checkTemplate(template);
    if (Result.isFailure(checked))
      problems.push(problem([...at, k], checked.failure.message));
  }
  if (entry.tone !== undefined && 'above' in entry.tone)
    for (const threshold of Object.keys(entry.tone.above))
      if (threshold.trim() === '' || !Number.isFinite(Number(threshold)))
        problems.push(
          problem(
            [...at, 'tone', 'above'],
            `${JSON.stringify(threshold)} is not a number`,
          ),
        );
  if (entry.id === undefined && widgetIdOf(entry.label) === '')
    problems.push(
      problem(
        [...at, 'label'],
        'has no letter or digit to make an id from: set id',
      ),
    );
  return problems;
};

// An entry's tone, by the branch its keys choose: `map` or `above`, one of
// the two. Absent is none.
const readTone = (
  raw: unknown,
): Result.Result<
  WidgetToneRule | undefined,
  ReadonlyArray<SchemaIssueItem>
> => {
  if (raw === undefined) return Result.succeed(undefined);
  const branches = isRecord(raw)
    ? (['map', 'above'] as const).filter((k) => Object.hasOwn(raw, k))
    : [];
  const [branch] = branches;
  if (branch === undefined || branches.length > 1)
    return Result.fail([
      {
        path: [],
        message: 'expected { "from", "map" } or { "from", "above" }',
      },
    ]);
  const decoded: Result.Result<WidgetToneRule, Schema.SchemaError> =
    branch === 'map' ? decodeToneMap(raw) : decodeToneAbove(raw);
  return Result.isFailure(decoded)
    ? Result.fail(formatSchemaIssues(decoded.failure.issue))
    : Result.succeed(decoded.success);
};

const resolve = (entry: WidgetEntry): WidgetConfig => {
  const intervalSeconds =
    entry.intervalSeconds ?? WIDGET_DEFAULT_INTERVAL_SECONDS;
  return {
    id: entry.id ?? widgetIdOf(entry.label),
    label: entry.label,
    command: entry.command,
    intervalSeconds,
    timeoutSeconds:
      entry.timeoutSeconds ??
      Math.min(WIDGET_DEFAULT_TIMEOUT_SECONDS, intervalSeconds),
    format: entry.format ?? 'text',
    lines: entry.lines ?? 1,
    ...(entry.text === undefined ? {} : { text: entry.text }),
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    ...(entry.tone === undefined ? {} : { tone: entry.tone }),
  };
};

/**
 * The widgets a `widgets.json` holds, each with its defaults filled in, and a
 * problem for each entry that cannot run, which is dropped; or the one
 * sentence saying why the file cannot be read at all: not JSON, or not the
 * file's shape. Pure over the file's text, so serve and the CLI read it alike
 * and a test needs no filesystem.
 */
export const decodeWidgetsFile = (
  text: string,
  filePath: string,
): Result.Result<DecodedWidgets, string> => {
  const at = `${WIDGETS_FILE} at ${filePath}`;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return Result.fail(`${at} is not valid JSON: ${reason}`);
  }
  const shape = decodeShape(json);
  if (Result.isFailure(shape))
    return Result.fail(
      `${at}: ${formatSchemaIssues(shape.failure.issue)
        .map((i) =>
          i.path.length > 0 ? problem(i.path, i.message) : i.message,
        )
        .join('; ')}`,
    );
  const widgets: Array<WidgetConfig> = [];
  const problems: Array<string> = [];
  const seen = new Set<string>();
  shape.success.widgets.forEach((raw, i) => {
    const entryAt = ['widgets', i] as const;
    if (!isRecord(raw)) {
      problems.push(problem(entryAt, 'expected an object'));
      return;
    }
    // A key no widget takes is said, but costs nothing: a misspelt
    // `interval` would otherwise leave the default in force unremarked.
    for (const key of Object.keys(raw))
      if (!Object.hasOwn(WidgetEntry.fields, key))
        problems.push(
          problem(
            [...entryAt, key],
            `not a widget key${WIDGET_PROBLEM_IGNORED}`,
          ),
        );
    const issues: Array<SchemaIssueItem> = [];
    const decoded = decodeEntry(raw);
    if (Result.isFailure(decoded))
      issues.push(...formatSchemaIssues(decoded.failure.issue));
    const tone = readTone(raw.tone);
    if (Result.isFailure(tone))
      issues.push(
        ...tone.failure.map((i) => ({ ...i, path: ['tone', ...i.path] })),
      );
    if (Result.isFailure(decoded) || Result.isFailure(tone)) {
      for (const issue of issues)
        problems.push(problem([...entryAt, ...issue.path], issue.message));
      return;
    }
    const { tone: _unread, ...rest } = decoded.success;
    const entry: WidgetEntry =
      tone.success === undefined ? rest : { ...rest, tone: tone.success };
    const own = entryProblems(entryAt, entry);
    if (own.length > 0) {
      problems.push(...own);
      return;
    }
    const widget = resolve(entry);
    if (seen.has(widget.id)) {
      problems.push(
        problem(
          entry.id === undefined ? entryAt : [...entryAt, 'id'],
          `the id ${widget.id} is used twice`,
        ),
      );
      return;
    }
    seen.add(widget.id);
    widgets.push(widget);
  });
  return Result.succeed({
    path: shape.success.path ?? [],
    widgets,
    problems,
  });
};
