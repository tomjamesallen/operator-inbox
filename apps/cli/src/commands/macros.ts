import {
  decodeMacrosFile,
  loadXdgConfigHome,
  type MacroConfig,
  type MacroParam,
  macrosPath,
} from '@operator-inbox/core';
import { Console, Effect, FileSystem, Result } from 'effect';
import { Command, Flag } from 'effect/cli';
import { InputError } from '../errors';

// `operator-inbox macros`: the macros the answer box offers, read from
// `macros.json` as the page reads it, so the operator can check a file before
// the page does. A file that does not decode fails the command with the same
// sentence the page shows; no file is no macros, and not a failure.

export interface MacrosReport {
  readonly path: string;
  readonly exists: boolean;
  readonly macros: ReadonlyArray<MacroConfig>;
}

export const readMacros = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const p = macrosPath(
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
    return { path: p, exists: false, macros: [] } satisfies MacrosReport;
  const text = yield* fs.readFileString(p).pipe(Effect.mapError(cannotRead));
  const decoded = decodeMacrosFile(text, p);
  if (Result.isFailure(decoded))
    return yield* new InputError({ message: decoded.failure });
  return {
    path: p,
    exists: true,
    macros: decoded.success.macros,
  } satisfies MacrosReport;
});

const optional = (p: MacroParam): string =>
  p.required === false ? ', optional' : '';

/** What a parameter takes, in a few words. */
export const paramLine = (p: MacroParam): string => {
  switch (p.type) {
    case 'enum':
      return `${p.multiple === true ? 'any of' : 'one of'}: ${p.options.join(', ')}${optional(p)}`;
    case 'text':
      return `text${p.placeholder === undefined ? '' : ` (${p.placeholder})`}${optional(p)}`;
    case 'number': {
      const range =
        p.min !== undefined && p.max !== undefined
          ? ` ${p.min} to ${p.max}`
          : p.min !== undefined
            ? ` from ${p.min}`
            : p.max !== undefined
              ? ` up to ${p.max}`
              : '';
      const fallback = p.default === undefined ? '' : `, default ${p.default}`;
      return `number${range}${fallback}${optional(p)}`;
    }
  }
};

export const renderMacros = (report: MacrosReport): string => {
  if (!report.exists)
    return `no macros: there is no ${report.path}, so / in the answer box simply types`;
  if (report.macros.length === 0) return `no macros in ${report.path}`;
  const width = Math.max(
    0,
    ...report.macros.flatMap((m) => m.params.map((p) => p.name.length)),
  );
  return [
    ...report.macros.flatMap((m) => [
      `/${m.name}${m.description === '' ? '' : ` — ${m.description}`}`,
      `  tells the agent: ${m.instruction.trim().split('\n').join('\n    ')}`,
      ...(m.params.length === 0
        ? ['  (no parameters)']
        : m.params.map((p) => `  ${p.name.padEnd(width)}  ${paramLine(p)}`)),
    ]),
    `${report.macros.length} macro${report.macros.length === 1 ? '' : 's'} in ${report.path}`,
  ].join('\n');
};

export const macrosCommand = Command.make(
  'macros',
  {
    json: Flag.Boolean('json').pipe(
      Flag.withDescription('Print the file’s path and its macros as JSON'),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Effect.flatMap(readMacros, (report) =>
      Console.log(
        json
          ? JSON.stringify(
              { path: report.path, macros: report.macros },
              null,
              2,
            )
          : renderMacros(report),
      ),
    ),
).pipe(
  Command.withDescription(
    "Print the macros the answer box offers (~/.config/operator-inbox/macros.json) and check the file: each macro's name, description, the instruction the agent is given, and its parameters. A file that does not decode exits non-zero, saying why",
  ),
);
