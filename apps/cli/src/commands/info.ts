import path from 'node:path';
import {
  configDir,
  configPath,
  keybindingsPath,
  loadXdgConfigHome,
  metadataPath,
  stateDir,
} from '@operator-inbox/core';
import { SERVE_DEFAULT_PORT } from '@operator-inbox/core/api';
import { Config, Console, Effect, Option } from 'effect';
import { Command, Flag } from 'effect/cli';
import { InputError } from '../errors';
import { readHome } from '../home-dir';
import { resolveInboxDatabaseEdge } from '../inbox-database';
import { assetsDirOf, locateWebDist, moduleDir } from '../package-paths';
import { VERSION } from '../version';

// `operator-inbox info`: where this install keeps everything, so a person or a
// job (a backup that copies the store) can ask rather than guess. Reads only:
// it makes no folder and opens no file.

export interface Info {
  readonly version: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly metadataFile: string;
  readonly keybindingsFile: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly databaseSource: 'env' | 'config' | 'default';
  readonly port: number;
  readonly webDist: string;
  readonly assetsDir: string;
}

export const readInfo = Effect.gen(function* () {
  const xdgConfigHome = yield* loadXdgConfigHome.pipe(
    Effect.mapError((e) => new InputError({ message: e.message })),
  );
  const xdgStateHome = yield* Config.String('XDG_STATE_HOME').pipe(
    Effect.orElseSucceed(() => ''),
  );
  const database = yield* resolveInboxDatabaseEdge;
  const home = yield* readHome;
  const state = stateDir({
    xdgStateHome,
    home: Option.getOrElse(home, () => ''),
  });
  // Under the home folder unless XDG_STATE_HOME is set; with neither, there
  // is no absolute answer to give.
  if (!path.isAbsolute(state)) {
    return yield* new InputError({
      message:
        'HOME is not set, so the state folder cannot be found; set XDG_STATE_HOME',
    });
  }
  return {
    version: VERSION,
    configDir: configDir(xdgConfigHome),
    configFile: configPath(xdgConfigHome),
    metadataFile: metadataPath(xdgConfigHome),
    keybindingsFile: keybindingsPath(xdgConfigHome),
    stateDir: state,
    databasePath: database.path,
    databaseSource: database.source,
    port: SERVE_DEFAULT_PORT,
    webDist: yield* locateWebDist(),
    assetsDir: assetsDirOf(moduleDir),
  } satisfies Info;
});

/** The text form: one `key: value` line per field, in the JSON's order. */
export const renderInfo = (info: Info): string =>
  Object.entries(info)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

export const infoCommand = Command.make(
  'info',
  {
    json: Flag.Boolean('json').pipe(
      Flag.withDescription('Print the same as one JSON object'),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Effect.flatMap(readInfo, (info) =>
      Console.log(json ? JSON.stringify(info, null, 2) : renderInfo(info)),
    ),
).pipe(
  Command.withDescription(
    'Print where this install keeps its config, its state and the inbox database, its port and its web build',
  ),
);
