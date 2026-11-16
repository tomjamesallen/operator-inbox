import { Result, Schema } from 'effect';
import { schemaIssueLines } from './schema-issues';

// Macros: slash commands the operator configures in `macros.json`, each with an
// instruction for the agent and typed parameters. The operator invokes them in
// the answer box; the answer then carries, for each one, its name, its
// instruction as the config held it, and its arguments, enough for the agent to
// act on it without asking what it means.
//
// BROWSER-SAFE: the page parses the file with this module (`api/index.ts`
// re-exports it), so it may import only `effect` and core's own pure modules.

/** The file's name, beside `metadata.json` in the config folder. */
export const MACROS_FILE = 'macros.json';

// --- the config -----------------------------------------------------------------

// A macro's name, without its slash: what follows `/` in the box.
export const MacroName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/, {
    message: 'a macro name is lower-case letters, digits and -, from a letter',
  }),
);

const ParamName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]*$/, {
    message:
      'a parameter name is lower-case letters, digits and _, from a letter',
  }),
);

// Every parameter is required unless it says `required: false`.
const common = {
  name: ParamName,
  required: Schema.optionalKey(Schema.Boolean),
};

// One of a closed list, or with `multiple`, any number of them.
export const MacroEnumParam = Schema.Struct({
  ...common,
  type: Schema.Literal('enum'),
  options: Schema.NonEmptyArray(Schema.String),
  multiple: Schema.optionalKey(Schema.Boolean),
});
export type MacroEnumParam = typeof MacroEnumParam.Type;

export const MacroTextParam = Schema.Struct({
  ...common,
  type: Schema.Literal('text'),
  placeholder: Schema.optionalKey(Schema.String),
});
export type MacroTextParam = typeof MacroTextParam.Type;

export const MacroNumberParam = Schema.Struct({
  ...common,
  type: Schema.Literal('number'),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  default: Schema.optionalKey(Schema.Finite),
});
export type MacroNumberParam = typeof MacroNumberParam.Type;

// Parameters are leaves: no nesting, no objects, no lists of objects.
export const MacroParam = Schema.Union([
  MacroEnumParam,
  MacroTextParam,
  MacroNumberParam,
]);
export type MacroParam = typeof MacroParam.Type;

// `description` is the operator's line (the menu, the card's header);
// `instruction` is what the agent is told, copied into the answer.
export const MacroConfig = Schema.Struct({
  name: MacroName,
  description: Schema.String,
  instruction: Schema.String.check(Schema.isNonEmpty()),
  params: Schema.Array(MacroParam),
});
export type MacroConfig = typeof MacroConfig.Type;

export const MacrosFile = Schema.Struct({
  macros: Schema.Array(MacroConfig),
});
export type MacrosFile = typeof MacrosFile.Type;

/** What a file holds that its shape cannot say: names twice, ranges upside down. */
export const macrosFileProblems = (file: MacrosFile): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  file.macros.forEach((m, i) => {
    const at = `macros.${i}`;
    if (seen.has(m.name))
      problems.push(`${at}.name — /${m.name} is named twice`);
    seen.add(m.name);
    const params = new Set<string>();
    m.params.forEach((p, j) => {
      const pat = `${at}.params.${j}`;
      if (params.has(p.name))
        problems.push(`${pat}.name — /${m.name} has two parameters ${p.name}`);
      params.add(p.name);
      if (p.type === 'enum' && new Set(p.options).size !== p.options.length)
        problems.push(`${pat}.options — an option is listed twice`);
      if (p.type === 'number') {
        if (p.min !== undefined && p.max !== undefined && p.min > p.max)
          problems.push(`${pat} — min is more than max`);
        if (
          p.default !== undefined &&
          ((p.min !== undefined && p.default < p.min) ||
            (p.max !== undefined && p.default > p.max))
        )
          problems.push(`${pat}.default — outside min and max`);
      }
    });
  });
  return problems;
};

const decodeFile = Schema.decodeUnknownResult(MacrosFile, {
  errors: 'all',
  reportInput: true,
});

/**
 * The macros a `macros.json` holds, or the one sentence saying why they cannot
 * be used: not JSON, not the file's shape, or names that clash. Pure over the
 * file's text, so the page and the CLI read it alike and a test needs no
 * filesystem.
 */
export const decodeMacrosFile = (
  text: string,
  filePath: string,
): Result.Result<MacrosFile, string> => {
  const at = `${MACROS_FILE} at ${filePath}`;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return Result.fail(`${at} is not valid JSON: ${reason}`);
  }
  const decoded = decodeFile(json);
  if (Result.isFailure(decoded))
    return Result.fail(
      `${at}: ${schemaIssueLines(decoded.failure.issue).join('; ')}`,
    );
  const problems = macrosFileProblems(decoded.success);
  return problems.length === 0
    ? Result.succeed(decoded.success)
    : Result.fail(`${at}: ${problems.join('; ')}`);
};

// --- what an answer carries -------------------------------------------------------

// One argument as sent: text, a number, the options a many-of chose, or `null`
// for a parameter left empty, so the agent never needs the config to tell "not
// given" from "not a parameter".
export const MacroArg = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Array(Schema.String),
  Schema.Null,
]);
export type MacroArg = typeof MacroArg.Type;

// A macro as an answer carries it. The instruction is copied in rather than
// looked up later, so the log still says what the agent was told after the
// config changes, and an answer read on another machine needs no config.
export const MacroInvoked = Schema.Struct({
  macro: MacroName,
  instruction: Schema.String,
  args: Schema.Record(Schema.String, MacroArg),
});
export type MacroInvoked = typeof MacroInvoked.Type;

// The macros of one answer, in the order the operator stacked them.
export const MacrosInvoked = Schema.NonEmptyArray(MacroInvoked);
export type MacrosInvoked = typeof MacrosInvoked.Type;

// --- drafts -----------------------------------------------------------------------

/** A parameter's value while the operator fills it in; absent is empty. */
export type MacroDraftValue = string | number | ReadonlyArray<string>;

export const isMacroParamRequired = (p: MacroParam): boolean =>
  p.required !== false;

export const isMacroValueFilled = (v: MacroDraftValue | undefined): boolean =>
  v !== undefined &&
  (typeof v === 'string'
    ? v.trim() !== ''
    : typeof v === 'number'
      ? Number.isFinite(v)
      : v.length > 0);

/** The required parameters still empty, in the macro's order. */
export const missingMacroParams = (
  macro: MacroConfig,
  args: Readonly<Record<string, MacroDraftValue>>,
): ReadonlyArray<MacroParam> =>
  macro.params.filter(
    (p) => isMacroParamRequired(p) && !isMacroValueFilled(args[p.name]),
  );

/** A new invocation's arguments: each number's default, nothing else. */
export const initialMacroArgs = (
  macro: MacroConfig,
): Readonly<Record<string, MacroDraftValue>> =>
  Object.fromEntries(
    macro.params.flatMap((p) =>
      p.type === 'number' && p.default !== undefined
        ? [[p.name, p.default]]
        : [],
    ),
  );

const argOf = (p: MacroParam, v: MacroDraftValue | undefined): MacroArg => {
  if (v === undefined || !isMacroValueFilled(v)) return null;
  if (p.type === 'text') return typeof v === 'string' ? v.trim() : null;
  if (p.type === 'number') return typeof v === 'number' ? v : null;
  if (p.multiple === true) {
    const chosen = Array.isArray(v)
      ? p.options.filter((o) => v.includes(o))
      : [];
    return chosen.length === 0 ? null : chosen;
  }
  return typeof v === 'string' && p.options.includes(v) ? v : null;
};

/**
 * A draft as the answer carries it: every parameter in `args`, an empty one
 * as `null`, text trimmed, and a value the parameter cannot take (an option
 * the list no longer has) as `null` too.
 */
export const macroInvokedOf = (
  macro: MacroConfig,
  args: Readonly<Record<string, MacroDraftValue>>,
): MacroInvoked => ({
  macro: macro.name,
  instruction: macro.instruction,
  args: Object.fromEntries(
    macro.params.map((p) => [p.name, argOf(p, args[p.name])]),
  ),
});
