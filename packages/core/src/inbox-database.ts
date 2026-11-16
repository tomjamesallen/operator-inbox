import path from 'node:path';
import { Result } from 'effect';

// Where the inbox event log's SQLite file lives. Pure:
// the env read and the config read happen at the CLI edge
// (`apps/cli/src/inbox-database.ts`); this module only holds the names and
// decides.
//
// The default needs no operator setup: the file and its folder are made on
// first use. A path holds no secret, so every message may print it.

/** The file's name under `$XDG_STATE_HOME/operator-inbox/`. */
export const INBOX_DATABASE_FILE = 'inbox.sqlite';

/** The env var that overrides the default path. */
export const INBOX_DATABASE_PATH_VAR = 'OPERATOR_INBOX_DATABASE_PATH';

/** The `config.json` key that overrides the default, below the env var. */
export const INBOX_DATABASE_PATH_CONFIG_KEY = 'databasePath';

/** Where the path in use came from. */
export type InboxDatabaseSource = 'env' | 'config' | 'default';

export interface ResolvedInboxDatabase {
  readonly source: InboxDatabaseSource;
  /** Absolute. */
  readonly path: string;
}

/**
 * The state base: `$XDG_STATE_HOME`, or `<home>/.local/state`. A blank or
 * relative `XDG_STATE_HOME` counts as unset, as the XDG spec says, so the base
 * is always absolute. Every state path the app uses is built on this.
 */
export const stateHome = (inputs: {
  readonly xdgStateHome: string | undefined;
  readonly home: string;
}): string => {
  const state = inputs.xdgStateHome?.trim();
  return state !== undefined && path.isAbsolute(state)
    ? state
    : path.join(inputs.home, '.local', 'state');
};

/** The directory the app's state lives in, under the state base. */
export const STATE_DIR_NAME = 'operator-inbox';

/** The app's state directory: `<state base>/operator-inbox`. */
export const stateDir = (inputs: {
  readonly xdgStateHome: string | undefined;
  readonly home: string;
}): string => path.join(stateHome(inputs), STATE_DIR_NAME);

/** The default file: `<state base>/operator-inbox/inbox.sqlite`. */
export const defaultInboxDatabasePath = (inputs: {
  readonly xdgStateHome: string | undefined;
  readonly home: string;
}): string => path.join(stateDir(inputs), INBOX_DATABASE_FILE);

const describeSource = (source: Exclude<InboxDatabaseSource, 'default'>) =>
  source === 'env'
    ? INBOX_DATABASE_PATH_VAR
    : `config.json's ${INBOX_DATABASE_PATH_CONFIG_KEY}`;

/**
 * Precedence: the env var, then `config.json`'s `databasePath`, then the
 * default. An empty value at either rung counts as unset, so an `export
 * OPERATOR_INBOX_DATABASE_PATH=` left behind does not shadow the default.
 *
 * An override must be absolute. "Relative to what?" has one answer for a
 * session's CLI and another for the serve launch agent, and `~` is expanded by
 * a shell, not by the app — so either is refused with the line that says why,
 * rather than read as a different file than the operator meant.
 */
export const resolveInboxDatabase = (inputs: {
  readonly env: string | undefined;
  readonly configPath: string | undefined;
  readonly xdgStateHome: string | undefined;
  readonly home: string;
}): Result.Result<ResolvedInboxDatabase, string> => {
  const pick = (
    source: Exclude<InboxDatabaseSource, 'default'>,
    value: string,
  ): Result.Result<ResolvedInboxDatabase, string> =>
    path.isAbsolute(value)
      ? Result.succeed({ source, path: value })
      : Result.fail(
          `inbox: ${describeSource(source)} must be an absolute path (it is ${JSON.stringify(value)})`,
        );
  const env = inputs.env?.trim();
  if (env !== undefined && env.length > 0) return pick('env', env);
  const config = inputs.configPath?.trim();
  if (config !== undefined && config.length > 0) return pick('config', config);
  return Result.succeed({
    source: 'default',
    path: defaultInboxDatabasePath(inputs),
  });
};

/** The file in use, and where an override came from. */
export const describeInboxDatabase = (resolved: ResolvedInboxDatabase) =>
  resolved.source === 'default'
    ? resolved.path
    : `${resolved.path} (set by ${describeSource(resolved.source)})`;
