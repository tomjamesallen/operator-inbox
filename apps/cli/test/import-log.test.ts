import {
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  PlatformError,
  Schema,
} from 'effect';
import { Command } from 'effect/cli';
import { TestConsole } from 'effect/testing';
import { importLogCommand } from '../src/commands/import-log';
import { envProvider } from '../src/env-config';
import { importLog, readLog } from '../src/import-log';
import { sha256Hex } from '../src/inbox-blobs';
import { connectInboxLog, InboxLog } from '../src/inbox-store';

// `import-log`: another kairos-es inbox log, under its own table prefix, copied
// into this app's store. The source is built from the v3 goldens
// (`test/golden/v3/`) under the neutral prefix `legacy_inbox`, so the copy is
// checked against rows whose bytes are pinned. Every file lives in a temporary
// folder made per test; the real state folder is never opened.

const GOLDEN = path.join(import.meta.dirname, 'golden', 'v3');
const golden = (name: string) =>
  readFileSync(path.join(GOLDEN, name), { encoding: 'utf8' });

const PREFIX = 'legacy_inbox';

const GoldenRow = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  data: Schema.String,
  tags: Schema.String,
  uuid: Schema.String,
  occurred_at: Schema.String,
});
type GoldenRow = typeof GoldenRow.Type;
const goldenRows = (): ReadonlyArray<GoldenRow> =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({ operator_inbox: Schema.Array(GoldenRow) }),
    ),
  )(golden('inbox-log-rows.json')).operator_inbox;

/** The golden DDL under another prefix, optionally with the metadata column. */
const legacyDdl = (withMetadata: boolean) => {
  const ddl = golden('inbox-log-ddl.sql').replaceAll('operator_inbox', PREFIX);
  return withMetadata
    ? ddl.replace(
        'occurred_at TEXT NOT NULL\n     );',
        "occurred_at TEXT NOT NULL,\n       metadata TEXT NOT NULL DEFAULT '{}'\n     );",
      )
    : ddl;
};

interface Planted {
  readonly rows?: ReadonlyArray<GoldenRow>;
  readonly withMetadata?: boolean;
  readonly metadataOf?: (id: number) => string;
  /** Raw SQL run after the rows, to plant a fault. */
  readonly after?: string;
}

/** A source log built with plain SQL: the golden DDL and rows, no store. */
const plantSource = (file: string, planted: Planted = {}) => {
  const withMetadata = planted.withMetadata ?? false;
  const db = new DatabaseSync(file);
  try {
    db.exec(legacyDdl(withMetadata));
    const insert = db.prepare(
      withMetadata
        ? `INSERT INTO "${PREFIX}" (id, type, data, tags, uuid, occurred_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO "${PREFIX}" (id, type, data, tags, uuid, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of planted.rows ?? goldenRows()) {
      const values = [
        r.id,
        r.type,
        Buffer.from(r.data, 'utf8'),
        r.tags,
        r.uuid,
        r.occurred_at,
      ] as const;
      if (withMetadata)
        insert.run(...values, planted.metadataOf?.(r.id) ?? '{}');
      else insert.run(...values);
    }
    if (planted.after !== undefined) db.exec(planted.after);
  } finally {
    db.close();
  }
};

const StoredRow = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  data: Schema.Uint8Array,
  tags: Schema.String,
  uuid: Schema.String,
  occurred_at: Schema.String,
  metadata: Schema.String,
});
const StoredTag = Schema.Struct({ tag: Schema.String, main_id: Schema.Number });

/** Every row of a log's tables, read with plain SQL. */
const readTables = (file: string, prefix: string, metadata = 'metadata') => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      events: Schema.decodeUnknownSync(Schema.Array(StoredRow))(
        db
          .prepare(
            `SELECT id, type, data, tags, uuid, occurred_at, ${metadata} FROM "${prefix}" ORDER BY id`,
          )
          .all(),
      ),
      tags: Schema.decodeUnknownSync(Schema.Array(StoredTag))(
        db
          .prepare(
            `SELECT tag, main_id FROM "${prefix}_tags" ORDER BY main_id, tag`,
          )
          .all(),
      ),
    };
  } finally {
    db.close();
  }
};

/** A source, a target path in its own folder, and the importer pointed at them. */
const setUp = (planted?: Planted) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped();
    const from = path.join(base, 'source', 'inbox.sqlite');
    const targetDir = path.join(base, 'state', 'operator-inbox');
    const target = path.join(targetDir, 'inbox.sqlite');
    yield* fs.makeDirectory(path.dirname(from), { recursive: true });
    yield* fs.makeDirectory(targetDir, { recursive: true });
    plantSource(from, planted);
    const run = (
      dryRun: boolean,
      options: { readonly from?: string; readonly fromPrefix?: string } = {},
    ) =>
      importLog({
        from: options.from ?? from,
        fromPrefix: options.fromPrefix ?? PREFIX,
        dryRun,
        target: { source: 'env', path: target },
      });
    return { base, from, target, targetDir, run };
  });

const listDir = (dir: string) => readdirSync(dir).sort();

describe('import-log', () => {
  it.effect(
    'copies the golden log byte for byte, and the app folds the copy as it folds the source',
    () =>
      Effect.gen(function* () {
        const { from, target, targetDir, run } = yield* setUp();
        const source = readTables(from, PREFIX, `'{}' AS metadata`);
        const summary = yield* run(false);
        expect(summary).toEqual({
          events: 23,
          inboxes: 2,
          questions: 4,
          olderForms: 0,
          blobs: 0,
        });
        // The store file alone: the temporary copy and its sidecars are gone.
        expect(listDir(targetDir)).toEqual(['inbox.sqlite']);
        const copied = readTables(target, 'operator_inbox');
        expect(copied.events).toHaveLength(source.events.length);
        copied.events.forEach((row, i) => {
          const expected = source.events[i];
          expect(row).toEqual(expected);
          expect(
            Buffer.from(row.data).equals(Buffer.from(expected?.data ?? [])),
          ).toBe(true);
        });
        expect(copied.tags).toEqual(source.tags);
        // And the copy opens through the store and reads back.
        const listed = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          return yield* log.listAll();
        }).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: target })),
          Effect.scoped,
        );
        expect(listed.map((l) => l.state.questions.length)).toEqual([3, 1]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('keeps the metadata column as the source holds it', () =>
    Effect.gen(function* () {
      const { from, target, run } = yield* setUp({
        withMetadata: true,
        metadataOf: (id) => (id === 2 ? '{"origin":"legacy"}' : '{}'),
      });
      yield* run(false);
      const copied = readTables(target, 'operator_inbox');
      expect(copied.events.map((r) => r.metadata)).toEqual(
        readTables(from, PREFIX).events.map((r) => r.metadata),
      );
      expect(copied.events[1]?.metadata).toBe('{"origin":"legacy"}');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'keeps a withdrawal from before `reason` existed as stored, and counts it',
    () =>
      Effect.gen(function* () {
        const rows = goldenRows().map((r) =>
          r.type === 'QuestionWithdrawn'
            ? {
                ...r,
                data: r.data.replace(',"reason":"no longer relevant"', ''),
              }
            : r,
        );
        expect(rows).not.toEqual(goldenRows());
        const { target, run } = yield* setUp({ rows });
        const summary = yield* run(false);
        expect(summary.olderForms).toBe(1);
        const withdrawal = readTables(target, 'operator_inbox').events.find(
          (r) => r.type === 'QuestionWithdrawn',
        );
        expect(Buffer.from(withdrawal?.data ?? []).toString('utf8')).toBe(
          '{"_tag":"QuestionWithdrawn","inboxId":"01GOLDENINBOXA000000000000","number":3}',
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly planted: Planted;
    readonly message: string;
  }> = [
    {
      name: 'a payload that does not decode',
      planted: {
        rows: goldenRows().map((r) =>
          r.id === 5
            ? { ...r, data: '{"_tag":"QuestionAsked","inboxId":1}' }
            : r,
        ),
      },
      message: 'event 5 (QuestionAsked) does not decode',
    },
    {
      name: 'a payload whose bytes are not the form the app writes',
      planted: {
        rows: goldenRows().map((r) =>
          r.id === 2 ? { ...r, data: r.data.replace('","', '", "') } : r,
        ),
      },
      message: 'event 2 (InboxOpened) re-encodes to different bytes',
    },
    {
      name: 'a type column that is not its payload',
      planted: {
        rows: goldenRows().map((r) =>
          r.id === 3 ? { ...r, type: 'QuestionEdited' } : r,
        ),
      },
      message:
        'event 3 is stored as QuestionEdited but its payload is QuestionAsked',
    },
    {
      name: 'a tag row missing from the source',
      planted: {
        after: `DELETE FROM "${PREFIX}_tags" WHERE main_id = 1 AND tag = 'session:golden-session-a'`,
      },
      message: 'tag rows',
    },
  ];

  for (const refusal of refusals)
    it.effect(
      `refuses ${refusal.name}, naming it, and leaves no store and no temporary file`,
      () =>
        Effect.gen(function* () {
          const { targetDir, run } = yield* setUp(refusal.planted);
          const error = yield* Effect.flip(run(false));
          expect(error.message).toContain(refusal.message);
          expect(listDir(targetDir)).toEqual([]);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

  it.effect(
    'reads a WAL source through its -wal file, events only the -wal holds included',
    () =>
      Effect.gen(function* () {
        const all = goldenRows();
        const { from, target, run } = yield* setUp({ rows: all.slice(0, 20) });
        // A writer that holds the file open in WAL mode with the last events
        // in its -wal alone, as a source still in use would be.
        const writer = new DatabaseSync(from);
        yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
        writer.exec('PRAGMA journal_mode = WAL');
        writer.exec('PRAGMA wal_autocheckpoint = 0');
        const insert = writer.prepare(
          `INSERT INTO "${PREFIX}" (id, type, data, tags, uuid, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const r of all.slice(20))
          insert.run(
            r.id,
            r.type,
            Buffer.from(r.data, 'utf8'),
            r.tags,
            r.uuid,
            r.occurred_at,
          );
        expect(statSync(`${from}-wal`).size).toBeGreaterThan(0);
        const summary = yield* run(false);
        expect(summary.events).toBe(23);
        expect(readTables(target, 'operator_inbox').events).toHaveLength(23);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'reads events, tags and the sequence from one snapshot, even with an append between the reads',
    () =>
      Effect.gen(function* () {
        const all = goldenRows();
        const { from } = yield* setUp({ rows: all.slice(0, 20) });
        const writer = new DatabaseSync(from);
        yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
        writer.exec('PRAGMA journal_mode = WAL');
        const reader = new DatabaseSync(from, { readOnly: true });
        yield* Effect.addFinalizer(() => Effect.sync(() => reader.close()));
        const append = (r: GoldenRow) =>
          writer
            .prepare(
              `INSERT INTO "${PREFIX}" (id, type, data, tags, uuid, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              r.id,
              r.type,
              Buffer.from(r.data, 'utf8'),
              r.tags,
              r.uuid,
              r.occurred_at,
            );
        // Another connection appends just before the tags are read, and again
        // just before the sequence is.
        const pending = [...all.slice(20)];
        const appending = new Proxy(reader, {
          get(target, key) {
            if (key === 'prepare')
              return (sql: string) => {
                if (
                  sql.startsWith('SELECT tag, main_id') ||
                  sql.startsWith('SELECT seq')
                ) {
                  const next = pending.shift();
                  if (next !== undefined) append(next);
                }
                return target.prepare(sql);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const rows = yield* readLog(appending, PREFIX, from);
        expect(pending).toHaveLength(1);
        expect(rows.events).toHaveLength(20);
        expect(Math.max(...rows.tags.map((t) => t.main_id))).toBe(20);
        expect(rows.sequence).toEqual({ seq: 20, kind: 'integer' });
        expect(reader.isTransaction).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'keeps a sequence that ran ahead of the highest id, as an integer',
    () =>
      Effect.gen(function* () {
        const { target, run } = yield* setUp({
          after: `UPDATE sqlite_sequence SET seq = 40 WHERE name = '${PREFIX}'`,
        });
        yield* run(false);
        const db = new DatabaseSync(target, { readOnly: true });
        try {
          expect(
            db
              .prepare(
                "SELECT seq, typeof(seq) AS kind FROM sqlite_sequence WHERE name = 'operator_inbox'",
              )
              .get(),
          ).toEqual({ seq: 40, kind: 'integer' });
        } finally {
          db.close();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'refuses a source with a -journal beside it, saying how to recover it',
    () =>
      Effect.gen(function* () {
        const { from, targetDir, run } = yield* setUp();
        writeFileSync(`${from}-journal`, '');
        const error = yield* Effect.flip(run(true));
        expect(error.message).toContain(`${from}-journal exists`);
        expect(error.message).toContain(`open ${from} once with sqlite3`);
        expect(listDir(targetDir)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'refuses to start beside a leftover temporary copy, naming it, and leaves it alone',
    () =>
      Effect.gen(function* () {
        const { targetDir, run } = yield* setUp();
        const leftover = path.join(
          targetDir,
          'inbox.sqlite.import-0a1b2c3d4e5f',
        );
        writeFileSync(leftover, 'left');
        for (const dryRun of [true, false]) {
          const error = yield* Effect.flip(run(dryRun));
          expect(error.message).toContain(
            `${leftover} is left from an import that did not finish`,
          );
          expect(error.message).toContain('only when no import is running');
        }
        expect(listDir(targetDir)).toEqual([
          'inbox.sqlite.import-0a1b2c3d4e5f',
        ]);
        expect(readFileSync(leftover, 'utf8')).toBe('left');
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'refuses a relative --from and a --from-prefix that is not a bare name',
    () =>
      Effect.gen(function* () {
        const { targetDir, run } = yield* setUp();
        expect(
          (yield* Effect.flip(run(false, { from: 'source/inbox.sqlite' })))
            .message,
        ).toContain(
          '--from must be an absolute path (it is source/inbox.sqlite)',
        );
        for (const fromPrefix of ['legacy-inbox', 'x"; DROP TABLE y; --', ''])
          expect(
            (yield* Effect.flip(run(false, { fromPrefix }))).message,
          ).toContain('--from-prefix must be a bare table name');
        expect(listDir(targetDir)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  /**
   * The node file system, with every `link` and `remove` recorded and
   * `onLink` run before the link. With `leaveSidecars`, the temporary copy's
   * check for a `-wal` first leaves an empty `-wal` and `-shm` beside it, as
   * SQLite does when its WAL is kept past the last close. With
   * `failTempRemove`, the removal of the temporary name straight after the
   * link fails (the cleanup on exit, which forces, still works).
   */
  const watchedFileSystem = (
    onLink: (to: string) => void,
    leaveSidecars = false,
    failTempRemove = false,
  ) => {
    const calls: Array<{
      readonly op: string;
      readonly path: string;
      readonly sidecars?: ReadonlyArray<string>;
    }> = [];
    const layer = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        link: (from: string, to: string) =>
          Effect.suspend(() => {
            calls.push({
              op: 'link',
              path: from,
              sidecars: ['-wal', '-shm', '-journal'].filter((s) =>
                existsSync(`${from}${s}`),
              ),
            });
            onLink(to);
            return fs.link(from, to);
          }),
        remove: (p: string, options?: Parameters<typeof fs.remove>[1]) =>
          Effect.suspend(() => {
            calls.push({ op: 'remove', path: p });
            if (
              failTempRemove &&
              options?.force !== true &&
              /\.import-[0-9a-f]+$/.test(p)
            )
              return Effect.fail(
                PlatformError.systemError({
                  _tag: 'PermissionDenied',
                  module: 'FileSystem',
                  method: 'remove',
                  pathOrDescriptor: p,
                }),
              );
            return fs.remove(p, options);
          }),
        stat: (p: string) =>
          Effect.suspend(() => {
            if (leaveSidecars && /\.import-[0-9a-f]+-wal$/.test(p)) {
              writeFileSync(p, '');
              writeFileSync(`${p.slice(0, -'-wal'.length)}-shm`, '');
            }
            return fs.stat(p);
          }),
      })),
    ).pipe(Layer.provide(NodeServices.layer));
    return { calls, layer: Layer.merge(NodeServices.layer, layer) };
  };

  it.effect(
    'moves the copy as its main file alone, and removes its temporary name straight after the link',
    () => {
      const watched = watchedFileSystem(() => {}, true);
      return Effect.gen(function* () {
        const { targetDir, run } = yield* setUp();
        yield* run(false);
        expect(listDir(targetDir)).toEqual(['inbox.sqlite']);
        const at = watched.calls.findIndex((c) => c.op === 'link');
        const link = watched.calls[at];
        expect(link?.sidecars).toEqual([]);
        expect(watched.calls[at + 1]).toEqual({
          op: 'remove',
          path: link?.path,
        });
      }).pipe(Effect.provide(watched.layer));
    },
  );

  it.effect(
    'refuses to move the copy onto a store that appeared while it ran, and leaves that store alone',
    () => {
      const watched = watchedFileSystem((to) => writeFileSync(to, 'appeared'));
      return Effect.gen(function* () {
        const { target, targetDir, run } = yield* setUp();
        const error = yield* Effect.flip(run(false));
        expect(error.message).toContain('could not move the verified copy to');
        expect(readFileSync(target, 'utf8')).toBe('appeared');
        expect(listDir(targetDir)).toEqual(['inbox.sqlite']);
      }).pipe(Effect.provide(watched.layer));
    },
  );

  it.effect(
    'when the temporary name cannot be removed after the link, says to check it is gone',
    () => {
      const watched = watchedFileSystem(() => {}, false, true);
      return Effect.gen(function* () {
        const { target, targetDir, run } = yield* setUp();
        const error = yield* Effect.flip(run(false));
        expect(error.message).toContain(`the store is in place at ${target}`);
        expect(error.message).toMatch(
          /could not remove \S+\.import-[0-9a-f]+, a second name for it; check it is gone/,
        );
        expect(error.message).not.toContain('delete it');
        // The cleanup on exit removed it after all.
        expect(listDir(targetDir)).toEqual(['inbox.sqlite']);
      }).pipe(Effect.provide(watched.layer));
    },
  );

  it.effect(
    'names a leftover beside a store that exists as a possible second name for it, before the store itself',
    () =>
      Effect.gen(function* () {
        const { target, targetDir, run } = yield* setUp();
        writeFileSync(target, 'live');
        // An import killed between the link and the removal of its temp name.
        const leftover = path.join(
          targetDir,
          'inbox.sqlite.import-0a1b2c3d4e5f',
        );
        linkSync(target, leftover);
        // And the copy's own sidecars, which are never the store's file.
        writeFileSync(`${leftover}-shm`, '');
        writeFileSync(`${leftover}-wal`, '');
        for (const dryRun of [true, false]) {
          const error = yield* Effect.flip(run(dryRun));
          expect(error.message).toContain(
            `${leftover} is left from an import that did not finish, and the store ${target} exists, so it may be a second name for the live store`,
          );
          expect(error.message).toContain(
            'remove it only when no import is running and after checking it is not the store',
          );
          expect(error.message).toContain('`ls -i`');
          expect(error.message).toContain(
            `. ${leftover}-shm, ${leftover}-wal are only sidecars of the copy, never the store's file, and safe to delete once the copy is dealt with`,
          );
          expect(error.message).not.toContain(`${leftover}-wal is left`);
          expect(error.message).not.toContain('already exists');
        }
        expect(listDir(targetDir)).toEqual([
          'inbox.sqlite',
          'inbox.sqlite.import-0a1b2c3d4e5f',
          'inbox.sqlite.import-0a1b2c3d4e5f-shm',
          'inbox.sqlite.import-0a1b2c3d4e5f-wal',
        ]);
        expect(readFileSync(target, 'utf8')).toBe('live');
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'copies the blob table with the events, each blob its own hash',
    () =>
      Effect.gen(function* () {
        const doc = Buffer.from('<p>a chart</p>', 'utf8');
        const sha = sha256Hex(doc);
        const { target, run } = yield* setUp({
          after: `CREATE TABLE "${PREFIX}_blobs" (sha TEXT PRIMARY KEY, kind TEXT NOT NULL, bytes INTEGER NOT NULL, doc BLOB NOT NULL); INSERT INTO "${PREFIX}_blobs" VALUES ('${sha}', 'html', ${doc.byteLength}, X'${doc.toString('hex')}');`,
        });
        const summary = yield* run(false);
        expect(summary.blobs).toBe(1);
        const kept = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          return yield* log.readBlobs([sha]);
        }).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: target })),
          Effect.scoped,
        );
        expect(Buffer.from(kept.get(sha)?.doc ?? []).equals(doc)).toBe(true);
        expect(kept.get(sha)?.kind).toBe('html');
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'refuses a blob whose bytes are not its hash, and writes nothing',
    () =>
      Effect.gen(function* () {
        const { targetDir, run } = yield* setUp({
          after: `CREATE TABLE "${PREFIX}_blobs" (sha TEXT PRIMARY KEY, kind TEXT NOT NULL, bytes INTEGER NOT NULL, doc BLOB NOT NULL); INSERT INTO "${PREFIX}_blobs" VALUES ('${'0'.repeat(64)}', 'html', 2, X'6869');`,
        });
        const error = yield* Effect.flip(run(false));
        expect(error.message).toContain('is not the SHA-256');
        expect(listDir(targetDir)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('refuses a store that already exists, and leaves it alone', () =>
    Effect.gen(function* () {
      const { target, run } = yield* setUp();
      writeFileSync(target, '');
      const error = yield* Effect.flip(run(false));
      expect(error.message).toContain('already exists');
      expect(readFileSync(target)).toHaveLength(0);
      // A dry run says the same: it would not succeed for real.
      expect((yield* Effect.flip(run(true))).message).toContain(
        'already exists',
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('refuses --from naming the store itself', () =>
    Effect.gen(function* () {
      const { target, targetDir, run } = yield* setUp();
      const error = yield* Effect.flip(
        run(false, {
          from: path.join(targetDir, '..', 'operator-inbox', 'inbox.sqlite'),
        }),
      );
      // The same file under another name, before it even exists.
      expect(error.message).toContain("this app's own store");
      expect(listDir(targetDir)).toEqual([]);
      writeFileSync(target, '');
      const same = yield* Effect.flip(run(false, { from: target }));
      expect(same.message).toContain("this app's own store");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('refuses a source without the prefixed tables', () =>
    Effect.gen(function* () {
      const { from, target, targetDir } = yield* setUp();
      const error = yield* Effect.flip(
        importLog({
          from,
          fromPrefix: 'other_inbox',
          dryRun: false,
          target: { source: 'env', path: target },
        }),
      );
      expect(error.message).toContain('has no event table "other_inbox"');
      expect(listDir(targetDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('a dry run checks the source and writes nothing', () =>
    Effect.gen(function* () {
      const { from, targetDir, run } = yield* setUp();
      const before = readFileSync(from);
      expect(yield* run(true)).toEqual({
        events: 23,
        inboxes: 2,
        questions: 4,
        olderForms: 0,
        blobs: 0,
      });
      expect(listDir(targetDir)).toEqual([]);
      expect(readFileSync(from).equals(before)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'the command resolves the store the usual way and prints one summary',
    () =>
      Effect.gen(function* () {
        const { base, from, target, targetDir } = yield* setUp();
        const command = Command.runWith(importLogCommand, { version: '0.0.0' });
        const pointed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(
            effect,
            ConfigProvider.ConfigProvider,
            envProvider({
              XDG_CONFIG_HOME: path.join(base, 'config'),
              XDG_STATE_HOME: path.join(base, 'state'),
              OPERATOR_INBOX_DATABASE_PATH: target,
            }),
          );
        yield* pointed(
          command(['--from', from, '--from-prefix', PREFIX, '--dry-run']),
        );
        expect(listDir(targetDir)).toEqual([]);
        yield* pointed(command(['--from', from, '--from-prefix', PREFIX]));
        const lines = (yield* TestConsole.logLines).map(String);
        expect(lines).toEqual([
          `import-log: dry run: ${from} (prefix ${PREFIX}) holds 23 events, 2 Inboxes, 4 Questions; verified; nothing written`,
          `import-log: copied 23 events, 2 Inboxes, 4 Questions from ${from} (prefix ${PREFIX}) into ${target} (set by OPERATOR_INBOX_DATABASE_PATH); verified`,
        ]);
        expect(listDir(targetDir)).toEqual(['inbox.sqlite']);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
