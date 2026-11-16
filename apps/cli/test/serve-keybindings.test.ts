import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { CONFIG_DIR_NAME, KEYBINDINGS_FILE } from '@operator-inbox/core';
import { ConfigProvider, Effect, Result } from 'effect';
import { envProvider } from '../src/env-config';
import { readKeybindingsFile } from '../src/serve-keybindings-api';

// The keybindings file is read from $XDG_CONFIG_HOME/operator-inbox/, fresh
// each time; a temp dir stands in for the operator's config home.
const readUnder = (xdg: string) =>
  readKeybindingsFile().pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({ XDG_CONFIG_HOME: xdg }),
    ),
    Effect.provide(NodeServices.layer),
  );

describe('serve’s keybindings file', () => {
  it.effect('answers no file with its path and no text', () =>
    Effect.gen(function* () {
      const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-keys-'));
      const read = yield* readUnder(xdg);
      expect(read).toEqual({
        path: path.join(xdg, CONFIG_DIR_NAME, KEYBINDINGS_FILE),
        text: null,
      });
    }),
  );

  it.effect('answers the file’s text as it is now', () =>
    Effect.gen(function* () {
      const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-keys-'));
      mkdirSync(path.join(xdg, CONFIG_DIR_NAME));
      const file = path.join(xdg, CONFIG_DIR_NAME, KEYBINDINGS_FILE);
      writeFileSync(file, 'prefix = ctrl+a\n');
      expect((yield* readUnder(xdg)).text).toBe('prefix = ctrl+a\n');
      writeFileSync(file, 'keybind = clear\n');
      expect((yield* readUnder(xdg)).text).toBe('keybind = clear\n');
    }),
  );

  it.effect('fails a file that is there and cannot be read', () =>
    Effect.gen(function* () {
      const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-keys-'));
      mkdirSync(path.join(xdg, CONFIG_DIR_NAME, KEYBINDINGS_FILE), {
        recursive: true,
      });
      const read = yield* Effect.result(readUnder(xdg));
      expect(Result.isFailure(read) && read.failure._tag).toBe(
        'KeybindingsUnreadable',
      );
    }),
  );
});
