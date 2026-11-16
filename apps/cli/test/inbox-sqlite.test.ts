import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  decideAnswer,
  INBOX_DATABASE_PATH_VAR,
  InboxEvent,
  InboxId,
  inboxState,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import {
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
} from 'effect';
import { SqlClient } from 'effect/sql';
import {
  dispatchAnswers,
  dispatchAsk,
  dispatchDone,
  dispatchOpen,
} from '../src/commands/inbox';
import { installEffect } from '../src/commands/install';
import { envProvider } from '../src/env-config';
import {
  addMetadataColumn,
  connectInboxLog,
  decideAndAppend,
  InboxLog,
  inboxLogLive,
  makeInboxLogLazy,
} from '../src/inbox-store';

// The live inbox log on a real SQLite file, reached the
// way the CLI reaches it: the path from `OPERATOR_INBOX_DATABASE_PATH`, the
// layer `inboxLogLive`. It makes its own folder, `install` runs twice,
// and what one layer writes a second, separate layer on the same file reads.
// The lazy log over a file that cannot be opened answers one line with the
// file and the driver's reason, and recovers once it can. Many
// processes at once are `inbox-sqlite.processes.test.ts`.

const ID = InboxId.make('01INBOXSQL1TE0000000000000');
const SESSION = { sessionId: SessionId.make('sqlite-a'), cwd: '/w/x' };

/** A config provider pointing the inbox at `file`, and config.json at `base`. */
const pointedAt = (base: string, file: string) =>
  ConfigProvider.layer(
    envProvider(
      {
        [INBOX_DATABASE_PATH_VAR]: file,
        XDG_CONFIG_HOME: path.join(base, 'config'),
      },
      { fallBackToEnv: true },
    ),
  );

const live = (base: string, file: string) =>
  inboxLogLive.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(pointedAt(base, file)),
  );

const answer = (n: number, response: string) =>
  decideAndAppend(ID, (state) =>
    Result.map(
      decideAnswer(state, {
        inboxId: ID,
        number: QuestionNumber.make(n),
        response,
      }),
      (event) => ({ events: [event], result: undefined }),
    ),
  );

describe('the inbox log on a SQLite file', () => {
  it.live(
    'install twice, then open, ask, answer and read back through a second layer',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        // A folder that does not exist yet, two levels down: it is made.
        const file = path.join(base, 'state', 'operator-inbox', 'inbox.sqlite');

        // What `install` runs, twice: it is idempotent.
        yield* installEffect.pipe(Effect.provide(pointedAt(base, file)));
        yield* installEffect.pipe(Effect.provide(pointedAt(base, file)));
        expect(yield* fs.exists(file)).toBe(true);

        yield* Effect.gen(function* () {
          yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.some('SQLite round trip'),
            freshId: ID,
            cwd: '/w/x',
          });
          expect(
            yield* dispatchAsk({ inboxId: ID, title: 'Which?', body: '- a' }),
          ).toBe('#1');
          yield* answer(1, 'a');
        }).pipe(Effect.provide(live(base, file)));

        // A separate layer: a new client on the same file, as another process
        // would open it.
        const answers = yield* dispatchAnswers({
          inboxId: ID,
          json: false,
        }).pipe(Effect.provide(live(base, file)));
        expect(answers).toContain('a');
        yield* dispatchDone({ inboxId: ID, numbers: [1] }).pipe(
          Effect.provide(live(base, file)),
        );
        const { events } = yield* Effect.flatMap(InboxLog, (log) =>
          log.read(ID),
        ).pipe(Effect.provide(live(base, file)));
        expect(events.map((e) => e._tag)).toEqual([
          'InboxOpened',
          'QuestionAsked',
          'QuestionAnswered',
          'AnswerProcessed',
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    'a file that cannot be OPENED: every call says so with the file and the reason, then the same layer recovers',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        // The folder exists, but a DIRECTORY sits at the file's name: the
        // driver cannot open it.
        const file = path.join(base, 'state', 'inbox.sqlite');
        yield* fs.makeDirectory(file, { recursive: true });

        const log = Context.get(
          yield* Layer.build(makeInboxLogLazy(live(base, file))),
          InboxLog,
        );
        for (let call = 0; call < 3; call++) {
          const failure = yield* Effect.flip(log.read(ID));
          const prefix = `inbox could not open its event log at ${file} (set by ${INBOX_DATABASE_PATH_VAR}): `;
          expect(failure.message.startsWith(prefix)).toBe(true);
          // SQLite's own words follow, not kairos's wrapper or an empty tail.
          expect(failure.message.slice(prefix.length)).toBe(
            'unable to open database file',
          );
          expect(failure.message.split('\n')).toHaveLength(1);
        }

        // The cause is removed; the same layer, with no restart, now opens.
        yield* fs.remove(file, { recursive: true });
        expect((yield* log.read(ID)).events).toEqual([]);
        expect(yield* fs.exists(file)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "a folder that cannot be MADE: install says so with the file and the system's reason",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        // A FILE where the folder should be.
        const blocker = path.join(base, 'state');
        yield* fs.writeFileString(blocker, 'not a folder');
        const file = path.join(blocker, 'inbox.sqlite');

        const failure = yield* Effect.flip(
          installEffect.pipe(Effect.provide(pointedAt(base, file))),
        );
        expect(failure.message).toContain(
          `could not create the folder for its event log at ${file}`,
        );
        expect(failure.message).toMatch(/: .+$/);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// --- an inbox file in the v3 shape --------------------------------------------------

// kairos-es's events table has a `metadata` column that a v3-shape file lacks,
// and its `ensureSchema` never alters a table, so the store adds the column
// itself to a file without it (`addMetadataColumn` in `inbox-store.ts`). The
// v3-shape file is planted from the v3 goldens: the exact DDL and every row.

const GOLDEN = path.join(import.meta.dirname, 'golden', 'v3');
const MAIN_TABLE = 'operator_inbox';
const GOLDEN_A = InboxId.make('01GOLDENINBOXA000000000000');
const GOLDEN_B = InboxId.make('01GOLDENINBOXB000000000000');

const GoldenRows = Schema.Struct({
  [MAIN_TABLE]: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      type: Schema.String,
      data: Schema.String,
      tags: Schema.String,
      uuid: Schema.String,
      occurred_at: Schema.String,
    }),
  ),
});
const goldenRows = Schema.decodeUnknownSync(Schema.fromJsonString(GoldenRows))(
  readFileSync(path.join(GOLDEN, 'inbox-log-rows.json'), { encoding: 'utf8' }),
)[MAIN_TABLE];
const goldenEvents = goldenRows.map((r) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(InboxEvent))(r.data),
);

/** The old-shape file: the v3 DDL, then every v3 row (the trigger fans out the tags). */
const plantV3File = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(
      readFileSync(path.join(GOLDEN, 'inbox-log-ddl.sql'), {
        encoding: 'utf8',
      }),
    );
    const insert = db.prepare(
      `INSERT INTO "${MAIN_TABLE}" (id, type, data, tags, uuid, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of goldenRows)
      insert.run(
        r.id,
        r.type,
        Buffer.from(r.data, 'utf8'),
        r.tags,
        r.uuid,
        r.occurred_at,
      );
  } finally {
    db.close();
  }
};

const ColumnRows = Schema.Array(Schema.Struct({ name: Schema.String }));
const MetadataRows = Schema.Array(Schema.Struct({ metadata: Schema.String }));
const SchemaVersion = Schema.Array(
  Schema.Struct({ schema_version: Schema.Number }),
);
const TableSql = Schema.Array(Schema.Struct({ sql: Schema.String }));

/** What the file looks like from outside the store, read with a plain client. */
const inspect = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    const columns = Schema.decodeUnknownSync(ColumnRows)(
      db.prepare(`PRAGMA table_info("${MAIN_TABLE}")`).all(),
    ).map((c) => c.name);
    return {
      columns,
      // Absent until the column is there.
      metadata: columns.includes('metadata')
        ? Schema.decodeUnknownSync(MetadataRows)(
            db
              .prepare(`SELECT metadata FROM "${MAIN_TABLE}" ORDER BY id`)
              .all(),
          ).map((r) => r.metadata)
        : undefined,
      schemaVersion:
        Schema.decodeUnknownSync(SchemaVersion)(
          db.prepare('PRAGMA schema_version').all(),
        )[0]?.schema_version ?? -1,
      tableSql:
        Schema.decodeUnknownSync(TableSql)(
          db
            .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
            .all(MAIN_TABLE),
        )[0]?.sql ?? '',
    };
  } finally {
    db.close();
  }
};

describe('an inbox file in the v3 shape', () => {
  it.live(
    'gains the metadata column on open, reads every event back, takes an append, and a second open changes nothing',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'inbox.sqlite');
        plantV3File(file);
        const before = inspect(file);
        expect(before.columns).toEqual([
          'id',
          'type',
          'data',
          'tags',
          'uuid',
          'occurred_at',
        ]);

        const open = connectInboxLog({ source: 'env', path: file });

        // First open: migrated, every event read back, one appended.
        const first = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          const a = yield* log.read(GOLDEN_A);
          const b = yield* log.read(GOLDEN_B);
          const asked = yield* dispatchAsk({
            inboxId: GOLDEN_B,
            title: 'After the migration',
            body: 'appended after the migration',
          });
          return { a, b, asked };
        }).pipe(Effect.provide(open), Effect.scoped);

        const inA = goldenEvents.filter(
          (e) =>
            e.inboxId === GOLDEN_A ||
            (e._tag === 'QuestionMoved' && e.toInboxId === GOLDEN_A),
        );
        const inB = goldenEvents.filter(
          (e) =>
            e.inboxId === GOLDEN_B ||
            (e._tag === 'QuestionMoved' && e.toInboxId === GOLDEN_B),
        );
        expect(first.a.events).toEqual(inA);
        expect(first.b.events).toEqual(inB);
        expect(first.a.head).toBe(BigInt(goldenRows.length));
        const stateA = inboxState(first.a.events);
        expect(stateA.label).toBe('Golden inbox A renamed');
        expect(stateA.metadata).toEqual({ stage: 'build' });
        expect(stateA.pinned).toBe(false);
        expect(stateA.pinnedGroups).toEqual([]);
        expect(
          stateA.questions.map((q) => [q.number, q.state, q.withdrawn]),
        ).toEqual([
          [1, 'processed', false],
          [2, 'moved', false],
          [3, 'processed', true],
        ]);
        const stateB = inboxState(first.b.events);
        expect(stateB.label).toBe('Golden inbox B');
        expect(stateB.archived).toBe(false);
        expect(stateB.questions.map((q) => [q.number, q.title])).toEqual([
          [1, 'Second question, edited'],
        ]);
        expect(first.asked).toBe('#2');

        const migrated = inspect(file);
        expect(migrated.columns).toEqual([...before.columns, 'metadata']);
        // The old rows take the column's default; the new row writes `{}`.
        expect(migrated.metadata).toEqual(
          Array.from({ length: goldenRows.length + 1 }, () => '{}'),
        );

        // Second open: no ALTER, no schema change, and everything still reads.
        const second = yield* Effect.flatMap(InboxLog, (log) =>
          log.read(GOLDEN_B),
        ).pipe(Effect.provide(open), Effect.scoped);
        expect(second.events).toEqual([
          ...inB,
          expect.objectContaining({
            _tag: 'QuestionAsked',
            inboxId: GOLDEN_B,
            number: 2,
            title: 'After the migration',
          }),
        ]);
        const reopened = inspect(file);
        expect(reopened.schemaVersion).toBe(migrated.schemaVersion);
        expect(reopened.tableSql).toBe(migrated.tableSql);
        expect(reopened.columns).toEqual(migrated.columns);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// --- the migration itself, over a recording client ------------------------------------

/**
 * Run `addMetadataColumn` once against `file` on a client of its own, and
 * return every statement it EXECUTED, in order (recorded as each one starts,
 * so a statement that fails is listed too). `afterFirstRead` runs once, just
 * after the first statement returns: the moment a racing process would act.
 */
const migrateRecording = (
  file: string,
  afterFirstRead: Effect.Effect<void, unknown> = Effect.void,
) =>
  Effect.gen(function* () {
    const { clientLayer, SqliteClient } = yield* Effect.promise(
      () => import('@kairos-es/store-sqlite'),
    );
    const statements: Array<string> = [];
    yield* Effect.gen(function* () {
      const client = yield* SqliteClient;
      const recording = new Proxy(client, {
        get: (target, key, receiver) =>
          key === 'unsafe'
            ? (statement: string) =>
                Effect.andThen(
                  Effect.sync(() => statements.push(statement)),
                  target.unsafe(statement),
                ).pipe(
                  Effect.tap(() =>
                    statements.length === 1 ? afterFirstRead : Effect.void,
                  ),
                )
            : Reflect.get(target, key, receiver),
      });
      yield* addMetadataColumn.pipe(
        Effect.provideService(SqlClient.SqlClient, recording),
      );
    }).pipe(Effect.provide(clientLayer({ filename: file })), Effect.scoped);
    return statements;
  });

const isAlter = (statement: string) => statement.startsWith('ALTER TABLE');

describe('the metadata column migration', () => {
  it.live(
    'runs the ALTER on an old file once, and a second open only reads',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'inbox.sqlite');
        plantV3File(file);

        // The probe can see an ALTER: the first open on the old file runs one.
        const first = yield* migrateRecording(file);
        expect(first.filter(isAlter)).toHaveLength(1);
        expect(inspect(file).columns).toContain('metadata');

        // The second open finds the column and stops at the read. Without the
        // check it would run the ALTER, fail on the duplicate column and pass
        // through the race fallback, which is why the statements are counted.
        const second = yield* migrateRecording(file);
        expect(second).toHaveLength(1);
        expect(second.filter(isAlter)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live('a fresh file (no table yet) is a read and nothing else', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped();
      const statements = yield* migrateRecording(
        path.join(base, 'inbox.sqlite'),
      );
      expect(statements).toHaveLength(1);
      expect(statements.filter(isAlter)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    'two opens racing on one old file both succeed: the loser’s ALTER fails and its re-read finds the column',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'inbox.sqlite');
        plantV3File(file);

        // The loser reads the columns (no metadata); the winner, on its own
        // connection, then migrates the file before the loser's ALTER runs.
        let winner: ReadonlyArray<string> = [];
        const loser = yield* migrateRecording(
          file,
          Effect.map(migrateRecording(file), (s) => {
            winner = s;
          }),
        );
        expect(winner.filter(isAlter)).toHaveLength(1);
        // Read, the ALTER that lost, and the re-read that found the column.
        expect(loser).toHaveLength(3);
        expect(isAlter(loser[1] ?? '')).toBe(true);
        expect(loser[2]).toBe(loser[0]);
        const after = inspect(file);
        expect(after.columns.filter((c) => c === 'metadata')).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
