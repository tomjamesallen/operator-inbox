import path from 'node:path';
import {
  describeInboxDatabase,
  INBOX_DATABASE_PATH_VAR,
  loadConfig,
  type ResolvedInboxDatabase,
  resolveInboxDatabase,
} from '@operator-inbox/core';
import { Config, Effect, FileSystem, Option } from 'effect';
import { InputError } from './errors';
import { readHome } from './home-dir';

// The inbox's SQLite file at the CLI edge: where it is, and its folder. The decision — precedence, the refusal of a path that is not
// absolute, a blank or relative `XDG_STATE_HOME` counting as unset — is pure,
// in `@operator-inbox/core`'s `inbox-database.ts`; this module only reads the env,
// config.json and the home folder, and makes the folder. Opening the file is
// `connectInboxLog`'s, in `inbox-store.ts`, and nowhere else.

/** The store's table prefix — one store, its own tables. */
export const STORE_CONFIG = { tablePrefix: 'operator_inbox' };

/**
 * The file in use and where it came from. A config.json that does not load,
 * or an override that is not absolute, is one line naming the cause.
 */
export const resolveInboxDatabaseEdge: Effect.Effect<
  ResolvedInboxDatabase,
  InputError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  // Blank counts as unset in core, so a missing variable reads as ''.
  const env = yield* Config.String(INBOX_DATABASE_PATH_VAR).pipe(
    Effect.orElseSucceed(() => ''),
  );
  const xdgStateHome = yield* Config.String('XDG_STATE_HOME').pipe(
    Effect.orElseSucceed(() => ''),
  );
  const { config } = yield* loadConfig().pipe(
    Effect.mapError(
      (e) =>
        new InputError({
          message:
            'message' in e && typeof e.message === 'string'
              ? `inbox: ${e.message}`
              : 'inbox: could not read config.json',
        }),
    ),
  );
  const home = yield* readHome;
  const resolved = yield* Effect.mapError(
    Effect.fromResult(
      resolveInboxDatabase({
        env,
        configPath: config.databasePath,
        xdgStateHome,
        home: Option.getOrElse(home, () => ''),
      }),
    ),
    (message) => new InputError({ message }),
  );
  // The default path is under the home folder unless XDG_STATE_HOME is set;
  // with neither, it would be relative to wherever this runs.
  if (!path.isAbsolute(resolved.path)) {
    return yield* new InputError({
      message: `inbox: HOME is not set, so the default store cannot be found; set XDG_STATE_HOME or ${INBOX_DATABASE_PATH_VAR}`,
    });
  }
  return resolved;
});

/**
 * Is the inbox's file there yet? Only looks: it never opens the file or makes
 * its folder, so a caller that runs in every session (inbox mode's hooks) can
 * tell a machine or session that never used the inbox without creating the
 * file. False when the path does not resolve or cannot be checked.
 */
export const inboxDatabaseExists: Effect.Effect<
  boolean,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const resolved = yield* resolveInboxDatabaseEdge;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(resolved.path);
}).pipe(Effect.orElseSucceed(() => false));

/** Make the file's folder if it is missing. Idempotent. */
export const ensureInboxFolder = (resolved: ResolvedInboxDatabase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(resolved.path), { recursive: true });
  }).pipe(
    Effect.mapError(
      (e) =>
        new InputError({
          message: `inbox could not create the folder for its event log at ${describeInboxDatabase(resolved)}: ${e.message}`,
        }),
    ),
  );
