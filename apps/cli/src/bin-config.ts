import { Config } from 'effect';

// A binary the CLI runs, overridable through `name` so a test can stand a stub
// in for it. Unset or empty (`export OPERATOR_INBOX_SSH_BIN=`, which the env
// provider keeps as '') is `fallback`, found on PATH: there is no binary
// called ''.
export const binConfig = (
  name: string,
  fallback: string,
): Config.Config<string> =>
  Config.String(name).pipe(
    Config.withDefault(fallback),
    Config.map((bin) => (bin === '' ? fallback : bin)),
  );
