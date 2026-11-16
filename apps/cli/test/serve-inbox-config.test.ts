import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE,
  METADATA_FILE,
} from '@operator-inbox/core';
import {
  BUILT_IN_METADATA_KEYS,
  DEFAULT_INBOX_METADATA,
  type InboxMetadataRules,
  withBuiltInKeys,
} from '@operator-inbox/core/api';
import { ConfigProvider, Effect, Result } from 'effect';
import { envProvider } from '../src/env-config';
import { readInboxConfig } from '../src/serve-inbox-config-api';

// `GET /api/inbox-config` answers from Local's metadata.json, read fresh on
// every request; a temp dir stands in for the operator's config home.
const readUnder = (xdg: string) =>
  readInboxConfig().pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({ XDG_CONFIG_HOME: xdg }),
    ),
    Effect.provide(NodeServices.layer),
  );

const write = (xdg: string, file: string, text: string) => {
  mkdirSync(path.join(xdg, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(path.join(xdg, CONFIG_DIR_NAME, file), text);
};

const xdgWith = (files: {
  readonly config?: string;
  readonly metadata?: string;
}): string => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-inbox-config-'));
  if (files.config !== undefined) write(xdg, CONFIG_FILE, files.config);
  if (files.metadata !== undefined) write(xdg, METADATA_FILE, files.metadata);
  return xdg;
};

const RULES = {
  extras: 'allow',
  keys: [
    {
      key: 'ticket',
      type: 'string',
      description: 'The ticket id',
      presence: 'expected',
    },
  ],
};

describe('serve’s inbox config', () => {
  it.effect('answers the default rules when there is no metadata.json', () =>
    Effect.gen(function* () {
      expect(yield* readUnder(xdgWith({}))).toEqual({
        metadata: DEFAULT_INBOX_METADATA,
      });
    }),
  );

  it.effect('answers the default rules when only config.json is there', () =>
    Effect.gen(function* () {
      const read = yield* readUnder(
        xdgWith({ config: '{"databasePath":"/state/inbox.sqlite"}' }),
      );
      expect(read.metadata).toEqual(DEFAULT_INBOX_METADATA);
    }),
  );

  it.effect('answers config.json’s chaseAfterMinutes when it is set', () =>
    Effect.gen(function* () {
      expect(
        (yield* readUnder(xdgWith({ config: '{"chaseAfterMinutes":10}' })))
          .chaseAfterMinutes,
      ).toBe(10);
      expect(
        'chaseAfterMinutes' in (yield* readUnder(xdgWith({ config: '{}' }))),
      ).toBe(false);
    }),
  );

  it.effect('keeps the rules when config.json does not load', () =>
    Effect.gen(function* () {
      const read = yield* readUnder(
        xdgWith({ config: '{"chaseAfterMinutes":0}' }),
      );
      expect(read).toEqual({ metadata: DEFAULT_INBOX_METADATA });
    }),
  );

  it.effect('answers the configured rules, as the file is now', () =>
    Effect.gen(function* () {
      const xdg = xdgWith({ metadata: JSON.stringify(RULES) });
      expect((yield* readUnder(xdg)).metadata).toEqual(
        withBuiltInKeys(RULES as InboxMetadataRules),
      );
      write(xdg, METADATA_FILE, JSON.stringify({ keys: [], extras: 'refuse' }));
      expect((yield* readUnder(xdg)).metadata).toEqual({
        keys: BUILT_IN_METADATA_KEYS,
        extras: 'refuse',
      });
    }),
  );

  it.effect('fails a metadata.json that is not JSON, with its sentence', () =>
    Effect.gen(function* () {
      const read = yield* Effect.result(readUnder(xdgWith({ metadata: '{' })));
      expect(Result.isFailure(read) && read.failure._tag).toBe(
        'InboxConfigUnreadable',
      );
      expect(Result.isFailure(read) && read.failure.message).toContain(
        'metadata.json',
      );
    }),
  );

  it.effect('fails rules that are not usable, with their sentence', () =>
    Effect.gen(function* () {
      const read = yield* Effect.result(
        readUnder(xdgWith({ metadata: '{"keys":3}' })),
      );
      expect(Result.isFailure(read) && read.failure._tag).toBe(
        'InboxConfigUnreadable',
      );
      expect(Result.isFailure(read) && read.failure.message).toContain('keys');
    }),
  );
});
