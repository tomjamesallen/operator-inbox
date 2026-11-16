import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  type InboxEvent,
  InboxId,
  InboxWatcherRecord,
  QuestionNumber,
  QuestionRevision,
  SessionId,
} from '@operator-inbox/core';
import {
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Random,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { envProvider } from '../src/env-config';
import { connectInboxLog, InboxLog } from '../src/inbox-store';
import { watcherAlive } from '../src/inbox-watch';

// The CLI's encoded forms in the v3 encoding, pinned byte for byte against
// golden files under `test/golden/v3/`, so a dependency upgrade proves it
// writes the same bytes and still reads files already on disk. A clean
// type-check cannot see these changes. Each form is ENCODED from a fixed value
// through the production writer and compared with the golden's exact bytes,
// then the golden is DECODED through the production reader and compared with
// the value. See the README beside the goldens before touching one.
//
// Every file lives in a temporary folder made per test. The real state folder
// is never opened: `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and the inbox database
// path all point into the temporary folder.

const GOLDEN = path.join(import.meta.dirname, 'golden', 'v3');
const golden = (name: string) =>
  readFileSync(path.join(GOLDEN, name), { encoding: 'utf8' });

/** Config pointing every state path this file touches into `base`. */
const pointedAt = (base: string) =>
  ConfigProvider.layer(
    envProvider({
      XDG_STATE_HOME: path.join(base, 'state'),
      XDG_CONFIG_HOME: path.join(base, 'config'),
      OPERATOR_INBOX_DATABASE_PATH: path.join(
        base,
        'state',
        'operator-inbox',
        'inbox.sqlite',
      ),
    }),
  );

// A pid no process can hold on macOS (pid_max 99998) or Linux (at most 2^22),
// so a record naming it always reads as a dead session or a gone watcher.
const DEAD_PID = 4194305;

// --- the inbox event log -----------------------------------------------------------

const INBOX_A = InboxId.make('01GOLDENINBOXA000000000000');
const INBOX_B = InboxId.make('01GOLDENINBOXB000000000000');
const SESSION_A = SessionId.make('golden-session-a');
const SESSION_B = SessionId.make('golden-session-b');
const n = QuestionNumber.make;

// One of every `InboxEvent` variant, in an order the fold accepts, across two
// Inboxes. `INBOX_B`'s open carries none of the optional keys, so the golden
// pins that an absent key stays absent in the payload.
const EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'InboxOpened',
    inboxId: INBOX_A,
    label: 'Golden inbox A',
    sessionId: SESSION_A,
    cwd: '/tmp/golden/a',
    metadata: { team: 'golden-team' },
  },
  { _tag: 'InboxOpened', inboxId: INBOX_B, label: 'Golden inbox B' },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: n(1),
    title: 'First question',
    body: '- option one\n- option two',
    metadata: { group: 'alpha' },
  },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: n(2),
    title: 'Second question',
    body: 'Unicode survives: café, naïve, “quotes”.',
  },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: n(3),
    title: 'Third question',
    body: 'To be withdrawn',
  },
  {
    _tag: 'QuestionEdited',
    inboxId: INBOX_A,
    number: n(2),
    title: 'Second question, edited',
    body: 'Edited body',
  },
  {
    _tag: 'QuestionHighlighted',
    inboxId: INBOX_A,
    number: n(2),
    note: 'look here',
  },
  {
    _tag: 'QuestionHighlightDismissed',
    inboxId: INBOX_A,
    number: n(2),
    by: 'operator',
  },
  { _tag: 'QuestionHighlighted', inboxId: INBOX_A, number: n(1) },
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: n(1),
    response: 'option one',
  },
  { _tag: 'AnswerProcessed', inboxId: INBOX_A, number: n(1) },
  {
    _tag: 'QuestionWithdrawn',
    inboxId: INBOX_A,
    number: n(3),
    reason: 'no longer relevant',
  },
  {
    _tag: 'QuestionMetadataChanged',
    inboxId: INBOX_A,
    number: n(1),
    set: { kind: 'decision' },
    unset: ['group'],
  },
  {
    _tag: 'InboxMetadataChanged',
    inboxId: INBOX_A,
    set: { stage: 'build' },
    unset: ['team'],
  },
  {
    _tag: 'InboxRenamed',
    inboxId: INBOX_A,
    label: 'Golden inbox A renamed',
    previousLabel: 'Golden inbox A',
  },
  { _tag: 'InboxAdopted', inboxId: INBOX_A, sessionId: SESSION_B },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: n(2),
    toInboxId: INBOX_B,
    toNumber: n(1),
    question: {
      title: 'Second question, edited',
      body: 'Edited body',
      revision: QuestionRevision.make(2),
      metadata: {},
      state: 'awaiting-operator',
      withdrawn: false,
      askedStamp: { seq: 4, at: '2026-10-16T09:04:00.000Z' },
    },
  },
  { _tag: 'InboxPinned', inboxId: INBOX_A },
  { _tag: 'GroupPinned', inboxId: INBOX_A, group: 'alpha' },
  { _tag: 'GroupUnpinned', inboxId: INBOX_A, group: 'alpha' },
  { _tag: 'InboxUnpinned', inboxId: INBOX_A },
  { _tag: 'InboxArchived', inboxId: INBOX_B },
  { _tag: 'InboxUnarchived', inboxId: INBOX_B },
];

// The store's two tables, as `STORE_CONFIG`'s prefix names them.
const MAIN_TABLE = 'operator_inbox';
const TAG_TABLE = 'operator_inbox_tags';

// A golden row of the event table. `data` is the BLOB as the UTF-8 text it
// holds (the event's JSON).
const MainRow = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  data: Schema.String,
  tags: Schema.String,
  uuid: Schema.String,
  occurred_at: Schema.String,
});
const TagRow = Schema.Struct({ tag: Schema.String, main_id: Schema.Number });
const Rows = Schema.Struct({
  [MAIN_TABLE]: Schema.Array(MainRow),
  [TAG_TABLE]: Schema.Array(TagRow),
});
type Rows = typeof Rows.Type;
const decodeGoldenRows = () =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Rows))(
    golden('inbox-log-rows.json'),
  );

// What node:sqlite hands back for a row, decoded rather than cast.
const decodeSqlRows = <A>(schema: Schema.Decoder<A>, rows: unknown) =>
  Schema.decodeUnknownSync(Schema.Array(schema))(rows);
const StoredSql = Schema.Struct({ sql: Schema.String });
const StoredMainRow = Schema.Struct({
  ...MainRow.fields,
  data: Schema.Uint8Array,
});
const TableColumn = Schema.Struct({ name: Schema.String });
const StoredMetadata = Schema.Struct({ metadata: Schema.String });

// The clock starts here and moves one minute before each append, so every
// row's `occurred_at` is fixed.
const START = DateTime.makeUnsafe('2026-10-16T09:00:00.000Z');

/**
 * Append `EVENTS` one append each through the production `InboxLog` over a
 * SQLite file, with the clock under `TestClock` and `Random` seeded, so the
 * ids the store makes are fixed too.
 */
const writeEvents = (file: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(START));
    const log = yield* InboxLog;
    for (const event of EVENTS) {
      yield* TestClock.adjust(Duration.minutes(1));
      const { head } = yield* log.readPair(INBOX_A, INBOX_B);
      yield* log.append([event], { after: head });
    }
  }).pipe(
    Random.withSeed('operator-inbox-golden-v3'),
    Effect.provide(connectInboxLog({ source: 'env', path: file })),
    Effect.scoped,
  );

/** The store's own objects, as `sqlite_master` records them, in creation order. */
const readDdl = (file: string): string => {
  const db = new DatabaseSync(file);
  try {
    const rows = decodeSqlRows(
      StoredSql,
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
        )
        .all(),
    );
    return rows.map((r) => `${r.sql};\n`).join('\n');
  } finally {
    db.close();
  }
};

/** Every row of both tables, every column, in order. */
const readRows = (file: string): Rows => {
  const db = new DatabaseSync(file);
  try {
    const main = decodeSqlRows(
      StoredMainRow,
      db
        .prepare(
          `SELECT id, type, data, tags, uuid, occurred_at FROM "${MAIN_TABLE}" ORDER BY id`,
        )
        .all(),
    );
    const tags = decodeSqlRows(
      TagRow,
      db
        .prepare(
          `SELECT tag, main_id FROM "${TAG_TABLE}" ORDER BY main_id, tag`,
        )
        .all(),
    );
    return {
      [MAIN_TABLE]: main.map((r) => ({
        id: r.id,
        type: r.type,
        data: Buffer.from(r.data).toString('utf8'),
        tags: r.tags,
        uuid: r.uuid,
        occurred_at: r.occurred_at,
      })),
      [TAG_TABLE]: tags.map((r) => ({ tag: r.tag, main_id: r.main_id })),
    };
  } finally {
    db.close();
  }
};

// The event table's columns as the golden DDL declares them.
const GOLDEN_COLUMNS = ['id', 'type', 'data', 'tags', 'uuid', 'occurred_at'];

/** The event table's column names, in declaration order. */
const readColumns = (file: string): ReadonlyArray<string> => {
  const db = new DatabaseSync(file);
  try {
    return decodeSqlRows(
      TableColumn,
      db.prepare(`PRAGMA table_info("${MAIN_TABLE}")`).all(),
    ).map((c) => c.name);
  } finally {
    db.close();
  }
};

/** The `metadata` column of every event row, in order. */
const readMetadataColumn = (file: string): ReadonlyArray<string> => {
  const db = new DatabaseSync(file);
  try {
    return decodeSqlRows(
      StoredMetadata,
      db.prepare(`SELECT metadata FROM "${MAIN_TABLE}" ORDER BY id`).all(),
    ).map((r) => r.metadata);
  } finally {
    db.close();
  }
};

/** An old-shape file built from the golden DDL and rows, with no store involved. */
const plantOldShape = (file: string, ddl: string, rows: Rows) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(ddl);
    const insert = db.prepare(
      `INSERT INTO "${MAIN_TABLE}" (id, type, data, tags, uuid, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows[MAIN_TABLE])
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

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// What `listAll` folds the golden log to: both Inboxes, every question's
// state, stamps and highlight.
const EXPECTED_LIST: unknown = [
  {
    inboxId: '01GOLDENINBOXA000000000000',
    state: {
      opened: true,
      label: 'Golden inbox A renamed',
      metadata: {
        stage: 'build',
      },
      archived: false,
      pinned: false,
      pinnedGroups: [],
      archivedGroups: [],
      muted: false,
      priority: false,
      questions: [
        {
          number: 1,
          title: 'First question',
          body: '- option one\n- option two',
          revision: 1,
          metadata: {
            kind: 'decision',
          },
          state: 'processed',
          withdrawn: false,
          askedStamp: {
            seq: 3,
            at: '2026-10-16T09:03:00.000Z',
          },
          highlight: {
            stamp: {
              seq: 9,
              at: '2026-10-16T09:09:00.000Z',
            },
          },
          response: 'option one',
          answeredStamp: {
            seq: 10,
            at: '2026-10-16T09:10:00.000Z',
          },
          processedOrder: 1,
          processedStamp: {
            seq: 11,
            at: '2026-10-16T09:11:00.000Z',
          },
        },
        {
          number: 2,
          title: 'Second question, edited',
          body: 'Edited body',
          revision: 2,
          metadata: {},
          state: 'moved',
          withdrawn: false,
          askedStamp: {
            seq: 4,
            at: '2026-10-16T09:04:00.000Z',
          },
          movedTo: {
            inboxId: '01GOLDENINBOXB000000000000',
            number: 1,
          },
        },
        {
          number: 3,
          title: 'Third question',
          body: 'To be withdrawn',
          revision: 1,
          metadata: {},
          state: 'processed',
          withdrawn: true,
          askedStamp: {
            seq: 5,
            at: '2026-10-16T09:05:00.000Z',
          },
          reason: 'no longer relevant',
          processedOrder: 2,
          processedStamp: {
            seq: 12,
            at: '2026-10-16T09:12:00.000Z',
          },
        },
      ],
      processedCount: 2,
      inboxId: '01GOLDENINBOXA000000000000',
    },
    lastActivity: {
      seq: 21,
      at: '2026-10-16T09:21:00.000Z',
    },
  },
  {
    inboxId: '01GOLDENINBOXB000000000000',
    state: {
      opened: true,
      label: 'Golden inbox B',
      metadata: {},
      archived: false,
      pinned: false,
      pinnedGroups: [],
      archivedGroups: [],
      muted: false,
      priority: false,
      questions: [
        {
          number: 1,
          title: 'Second question, edited',
          body: 'Edited body',
          revision: 2,
          metadata: {},
          state: 'awaiting-operator',
          withdrawn: false,
          askedStamp: {
            seq: 4,
            at: '2026-10-16T09:04:00.000Z',
          },
        },
      ],
      processedCount: 0,
      inboxId: '01GOLDENINBOXB000000000000',
    },
    lastActivity: {
      seq: 23,
      at: '2026-10-16T09:23:00.000Z',
    },
  },
];

describe('the inbox event log, as kairos-es writes it in the v3 encoding', () => {
  it.effect(
    'this build writes the golden DDL plus two deliberate changes: a metadata column and the blob table',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'inbox.sqlite');
        yield* writeEvents(file);
        // kairos-es adds `metadata TEXT NOT NULL DEFAULT '{}'` as the event
        // table's last column, and the inbox store adds the same column to a
        // v3-shape file that lacks it. That is a decided change with its
        // migration, so the DDL is the golden's with exactly that column added
        // and nothing else moved.
        const goldenDdl = golden('inbox-log-ddl.sql');
        const withMetadata = goldenDdl.replace(
          'occurred_at TEXT NOT NULL\n     );',
          "occurred_at TEXT NOT NULL,\n       metadata TEXT NOT NULL DEFAULT '{}'\n     );",
        );
        expect(withMetadata).not.toBe(goldenDdl);
        // The app's own blob table (`inbox-blobs.ts`), made after the event
        // tables on every open, is the second: a new table, so a file
        // written before it gains it on its next open and nothing else moves.
        const withBlobs = `${withMetadata}\nCREATE TABLE "operator_inbox_blobs" (sha TEXT PRIMARY KEY, kind TEXT NOT NULL, bytes INTEGER NOT NULL, doc BLOB NOT NULL);\n`;
        expect(readDdl(file)).toBe(withBlobs);
        expect(readColumns(file)).toEqual([...GOLDEN_COLUMNS, 'metadata']);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'writing the fixed events on this build yields the golden rows',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'inbox.sqlite');
        yield* writeEvents(file);
        const written = readRows(file);
        const expected = decodeGoldenRows();
        // `uuid` is the one column normalised: the store draws it from
        // Effect's `Random`, seeded here, and a seeded generator's sequence
        // is not part of the encoded form (another Effect major may draw
        // differently). Its SHAPE is pinned; the golden keeps v3's values.
        // Every other column — id, type, the payload bytes, tags and
        // occurred_at — must match exactly.
        for (const row of written[MAIN_TABLE])
          expect(row.uuid).toMatch(UUID_V4);
        const withoutUuid = (rows: Rows) =>
          rows[MAIN_TABLE].map(({ uuid: _uuid, ...rest }) => rest);
        expect(withoutUuid(written)).toEqual(withoutUuid(expected));
        expect(written[TAG_TABLE]).toEqual(expected[TAG_TABLE]);
        // And the payload bytes as bytes, not only as text.
        written[MAIN_TABLE].forEach((row, i) => {
          expect(Buffer.from(row.data, 'utf8')).toEqual(
            Buffer.from(expected[MAIN_TABLE][i]?.data ?? '', 'utf8'),
          );
        });
        // kairos-es 1.0.0-alpha.4's metadata column: every append writes an
        // empty bag, so the payload bytes above are all an event carries.
        expect(readMetadataColumn(file)).toEqual(EVENTS.map(() => '{}'));
        // Absent stays absent: `INBOX_B`'s open carries no optional key.
        expect(written[MAIN_TABLE][1]?.data).toBe(
          '{"_tag":"InboxOpened","inboxId":"01GOLDENINBOXB000000000000","label":"Golden inbox B"}',
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    'an old-shape file built from the goldens reads back every event and folds to the expected state',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'old-shape.sqlite');
        const rows = decodeGoldenRows();
        plantOldShape(file, golden('inbox-log-ddl.sql'), rows);
        // The fan-out trigger in the golden DDL rebuilt the tag rows.
        expect(readRows(file)).toEqual(rows);

        const { a, b, all, bySession } = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          return {
            a: yield* log.read(INBOX_A),
            b: yield* log.read(INBOX_B),
            all: yield* log.listAll(),
            bySession: yield* log.findBySession(SESSION_B),
          };
        }).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: file })),
          Effect.scoped,
        );

        const inA = (e: InboxEvent) =>
          e.inboxId === INBOX_A ||
          (e._tag === 'QuestionMoved' && e.toInboxId === INBOX_A);
        const inB = (e: InboxEvent) =>
          e.inboxId === INBOX_B ||
          (e._tag === 'QuestionMoved' && e.toInboxId === INBOX_B);
        expect(a.events).toEqual(EVENTS.filter(inA));
        expect(b.events).toEqual(EVENTS.filter(inB));
        expect(a.head).toBe(BigInt(EVENTS.length));
        expect(bySession).toEqual(Option.some(INBOX_A));
        expect(all).toEqual(EXPECTED_LIST);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe('a withdrawal and its defaulted reason, through the store', () => {
  const B_TAGS = '["inbox:01GOLDENINBOXB000000000000"]';

  it.effect(
    'a withdrawal logged before `reason` existed decodes with the empty default',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'old-withdrawal.sqlite');
        plantOldShape(file, golden('inbox-log-ddl.sql'), {
          [MAIN_TABLE]: [
            {
              id: 1,
              type: 'QuestionWithdrawn',
              data: '{"_tag":"QuestionWithdrawn","inboxId":"01GOLDENINBOXB000000000000","number":1}',
              tags: B_TAGS,
              uuid: '00000000-0000-4000-8000-000000000001',
              occurred_at: '2026-10-16T09:00:00.000Z',
            },
          ],
          [TAG_TABLE]: [],
        });
        const { events } = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          return yield* log.read(INBOX_B);
        }).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: file })),
          Effect.scoped,
        );
        expect(events).toEqual([
          {
            _tag: 'QuestionWithdrawn',
            inboxId: INBOX_B,
            number: n(1),
            reason: '',
          },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('an empty reason is WRITTEN, not left out', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped();
      const file = path.join(base, 'withdrawal.sqlite');
      yield* Effect.gen(function* () {
        const log = yield* InboxLog;
        const { head } = yield* log.read(INBOX_B);
        yield* log.append(
          [
            {
              _tag: 'QuestionWithdrawn',
              inboxId: INBOX_B,
              number: n(1),
              reason: '',
            },
          ],
          { after: head },
        );
      }).pipe(
        Effect.provide(connectInboxLog({ source: 'env', path: file })),
        Effect.scoped,
      );
      expect(readRows(file)[MAIN_TABLE].map((r) => r.data)).toEqual([
        '{"_tag":"QuestionWithdrawn","inboxId":"01GOLDENINBOXB000000000000","number":1,"reason":""}',
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// --- the inbox watcher record ------------------------------------------------------

// `registerWatcher` in `inbox-watch.ts` is private and records the live
// process's own `ps` fingerprint, which no golden can hold. Its encoder is
// mirrored here verbatim (`Schema.encodeSync(Schema.fromJsonString(...))` over
// core's production `InboxWatcherRecord`, no indent, no trailing newline). The
// DECODE goes through the production reader, `watcherAlive`.
const WATCHER: typeof InboxWatcherRecord.Type = {
  inboxId: INBOX_A,
  pid: DEAD_PID,
  fingerprint: 'node Fri Oct 16 09:00:00 2026',
};

describe('the inbox watcher record', () => {
  it('encodes to the golden bytes and decodes back', () => {
    const RecordJson = Schema.fromJsonString(InboxWatcherRecord);
    expect(Schema.encodeSync(RecordJson)(WATCHER)).toBe(
      golden('inbox-watcher-record.json'),
    );
    expect(
      Schema.decodeUnknownSync(RecordJson)(golden('inbox-watcher-record.json')),
    ).toEqual(WATCHER);
  });

  it.effect(
    'watcherAlive decodes the golden: a gone watcher is removed, while a record it cannot decode is left alone',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const folder = path.join(
          base,
          'state',
          'operator-inbox',
          'inbox-watchers',
        );
        yield* fs.makeDirectory(folder, { recursive: true });
        const record = path.join(folder, `${INBOX_A}.${DEAD_PID}.json`);
        // The control: `watcherAlive` skips a record it cannot decode and
        // keeps it, so removal of the golden is evidence it DECODED.
        const undecodable = path.join(folder, `${INBOX_A}.1.json`);
        yield* fs.writeFileString(record, golden('inbox-watcher-record.json'));
        yield* fs.writeFileString(undecodable, '{"inboxId":1}');
        expect(
          yield* watcherAlive(INBOX_A).pipe(Effect.provide(pointedAt(base))),
        ).toBe(false);
        expect(yield* fs.exists(record)).toBe(false);
        expect(yield* fs.exists(undecodable)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
