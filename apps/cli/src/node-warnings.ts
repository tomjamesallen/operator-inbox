// Node marks `node:sqlite` experimental, so loading it prints
// `ExperimentalWarning: SQLite is an experimental feature …` on stderr. The
// inbox store's driver is `node:sqlite`, so every inbox command and `serve`'s
// first inbox read would print it. Hide that one warning and no other: every
// other warning, experimental or not, still prints in Node's own format.
//
// Remove this module, and its call in `index.ts`, when Node marks
// `node:sqlite` stable.

/** The warning's type, read the ways `process.emitWarning` accepts it. */
const warningType = (
  warning: string | Error,
  rest: ReadonlyArray<unknown>,
): string => {
  const [second] = rest;
  if (typeof second === 'string') return second;
  if (
    typeof second === 'object' &&
    second !== null &&
    'type' in second &&
    typeof second.type === 'string'
  )
    return second.type;
  return typeof warning === 'string' ? 'Warning' : warning.name;
};

/** Whether a `process.emitWarning` call is node:sqlite's experimental warning. */
export const isNodeSqliteWarning = (
  warning: string | Error,
  rest: ReadonlyArray<unknown>,
): boolean =>
  warningType(warning, rest) === 'ExperimentalWarning' &&
  (typeof warning === 'string' ? warning : warning.message).startsWith(
    'SQLite',
  );

/**
 * Drop node:sqlite's experimental warning before Node prints it, and pass
 * every other warning on unchanged. Node's own modules raise the warning
 * through `process.emitWarning`, so wrapping that one function is enough.
 */
export const hideNodeSqliteWarning = (proc: NodeJS.Process): void => {
  const emit = proc.emitWarning;
  proc.emitWarning = (warning: string | Error, ...rest: Array<unknown>) => {
    if (isNodeSqliteWarning(warning, rest)) return;
    Reflect.apply(emit, proc, [warning, ...rest]);
  };
};
