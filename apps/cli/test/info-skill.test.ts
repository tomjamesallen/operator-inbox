import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE,
  KEYBINDINGS_FILE,
  MACROS_FILE,
  METADATA_FILE,
  STATE_DIR_NAME,
} from '@operator-inbox/core';
import { SERVE_DEFAULT_PORT } from '@operator-inbox/core/api';
import { ConfigProvider, Effect } from 'effect';
import { Command } from 'effect/cli';
import { TestConsole } from 'effect/testing';
import { infoCommand, readInfo, renderInfo } from '../src/commands/info';
import { readSkill, skillCommand, skillPath } from '../src/commands/skill';
import { envProvider } from '../src/env-config';
import { webDistCandidates } from '../src/package-paths';

// `info` and `skill`, the two commands that only say where things are and
// what ships with the CLI. Every path is pointed into a fixed fake home
// through the environment, so nothing reads the real one.

const CONFIG = '/tmp/fake-home/config';
const STATE = '/tmp/fake-home/state';

const pointed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({ XDG_CONFIG_HOME: CONFIG, XDG_STATE_HOME: STATE }),
    ),
    Effect.provide(NodeServices.layer),
  );

const printed = Effect.map(TestConsole.logLines, (lines) =>
  lines.map(String).join('\n'),
);

describe('operator-inbox info', () => {
  it.effect('says where everything is', () =>
    Effect.gen(function* () {
      const info = yield* pointed(readInfo);
      expect(info).toMatchObject({
        configDir: path.join(CONFIG, CONFIG_DIR_NAME),
        configFile: path.join(CONFIG, CONFIG_DIR_NAME, CONFIG_FILE),
        metadataFile: path.join(CONFIG, CONFIG_DIR_NAME, METADATA_FILE),
        keybindingsFile: path.join(CONFIG, CONFIG_DIR_NAME, KEYBINDINGS_FILE),
        macrosFile: path.join(CONFIG, CONFIG_DIR_NAME, MACROS_FILE),
        stateDir: path.join(STATE, STATE_DIR_NAME),
        databasePath: path.join(STATE, STATE_DIR_NAME, 'inbox.sqlite'),
        databaseSource: 'default',
        port: SERVE_DEFAULT_PORT,
      });
      expect(
        webDistCandidates(path.join(import.meta.dirname, '..', 'src')),
      ).toContain(info.webDist);
    }),
  );

  it.effect('names an override of the database, and where it came from', () =>
    Effect.gen(function* () {
      const info = yield* readInfo.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          envProvider({
            XDG_CONFIG_HOME: CONFIG,
            XDG_STATE_HOME: STATE,
            OPERATOR_INBOX_DATABASE_PATH: '/backups/inbox.sqlite',
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      expect(info.databasePath).toBe('/backups/inbox.sqlite');
      expect(info.databaseSource).toBe('env');
    }),
  );

  // HOME through the ConfigProvider, never the process's own: with
  // XDG_STATE_HOME unset, the state is under the HOME the provider names, and
  // with no HOME either there is no answer rather than the real home's.
  it.effect('reads HOME from the environment it is given, and only there', () =>
    Effect.gen(function* () {
      const withEnv = (env: Record<string, string>) =>
        readInfo.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            envProvider(env),
          ),
          Effect.provide(NodeServices.layer),
        );
      const home = '/tmp/fake-home/home';
      const info = yield* withEnv({ XDG_CONFIG_HOME: CONFIG, HOME: home });
      expect(info.stateDir).toBe(
        path.join(home, '.local', 'state', STATE_DIR_NAME),
      );
      expect(info.databasePath).toBe(
        path.join(home, '.local', 'state', STATE_DIR_NAME, 'inbox.sqlite'),
      );
      const homeless = yield* Effect.flip(withEnv({ XDG_CONFIG_HOME: CONFIG }));
      expect(homeless.message).toContain('HOME is not set');
      expect(homeless.message).toContain('XDG_STATE_HOME');
    }),
  );

  it.effect('--json prints the same as one JSON object, in the same keys', () =>
    Effect.gen(function* () {
      yield* pointed(
        Command.runWith(infoCommand, { version: '0.0.0' })(['--json']),
      );
      const json = JSON.parse(yield* printed);
      expect(Object.keys(json)).toEqual([
        'version',
        'configDir',
        'configFile',
        'metadataFile',
        'keybindingsFile',
        'macrosFile',
        'stateDir',
        'databasePath',
        'databaseSource',
        'port',
        'webDist',
        'assetsDir',
      ]);
      expect(json).toEqual(yield* pointed(readInfo));
    }),
  );

  it.effect('without --json prints a key to a line', () =>
    Effect.gen(function* () {
      yield* pointed(Command.runWith(infoCommand, { version: '0.0.0' })([]));
      const info = yield* pointed(readInfo);
      expect(yield* printed).toBe(renderInfo(info));
      expect(renderInfo(info).split('\n')).toContain(
        `databasePath: ${info.databasePath}`,
      );
    }),
  );
});

describe('operator-inbox skill', () => {
  it('reads the skill from the package’s assets', () => {
    expect(skillPath()).toBe(
      path.join(import.meta.dirname, '..', 'assets', 'SKILL.md'),
    );
  });

  it.effect('prints the asset as it is', () =>
    Effect.gen(function* () {
      const asset = readFileSync(skillPath(), 'utf8');
      expect(yield* pointed(readSkill())).toBe(asset);
      yield* pointed(Command.runWith(skillCommand, { version: '0.0.0' })([]));
      expect(`${yield* printed}\n`).toBe(asset);
    }),
  );

  it.effect('says where it looked when the asset is missing', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        pointed(readSkill('/nowhere/operator-inbox/src')),
      );
      expect(failure.message).toContain(
        '/nowhere/operator-inbox/assets/SKILL.md',
      );
    }),
  );
});
