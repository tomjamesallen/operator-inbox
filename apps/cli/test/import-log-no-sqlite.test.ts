import { writeFileSync } from 'node:fs';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { vi } from 'vitest';
import { InputError } from '../src/errors';
import { importLog } from '../src/import-log';

// A Node without node:sqlite: the import fails with its one-line refusal, not
// a defect. Its own file, since the mock replaces node:sqlite for the file.

vi.mock('node:sqlite', () => {
  throw new Error('No such built-in module: node:sqlite');
});

describe('import-log without node:sqlite', () => {
  it.effect('fails with one line naming node:sqlite', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped();
      const from = path.join(base, 'source.sqlite');
      writeFileSync(from, '');
      const error = yield* Effect.flip(
        importLog({
          from,
          fromPrefix: 'legacy_inbox',
          dryRun: true,
          target: { source: 'env', path: path.join(base, 'inbox.sqlite') },
        }),
      );
      expect(error).toBeInstanceOf(InputError);
      expect(error.message).toMatch(
        /^import-log: could not load node:sqlite, which Node 22\.16 or later provides: /,
      );
      expect(error.message).not.toContain('\n');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
