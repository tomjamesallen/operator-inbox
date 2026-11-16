import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  DcbEventStore,
  DcbEventStoreInMemory,
  EventType,
  Tag,
} from '@kairos-es/core';
import {
  describeInboxDatabase,
  InboxEvent,
  type ResolvedInboxDatabase,
} from '@operator-inbox/core';
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Random,
  Schema,
} from 'effect';
import { InputError } from './errors';
import { InboxBlobsInMemory, sha256Hex } from './inbox-blobs';
import { STORE_CONFIG } from './inbox-database';
import { InboxReadModelInMemory } from './inbox-read-model';
import {
  connectInboxLog,
  InboxLog,
  type ListedInbox,
  makeInboxLog,
} from './inbox-store';

// Copy another kairos-es inbox log, kept under a different table prefix, into
// this app's store. The copy is exact: every event row keeps its id, type,
// payload bytes, tags, uuid, time and metadata, so positions, stamps and the
// fold are the same on both sides. It is built in a temporary file beside the
// store, made by the store's own wiring (`connectInboxLog`) so the DDL is the
// app's, and moved into place only after it is verified:
//
// (a) every row equals its source row column for column, payloads as bytes;
// (b) every event decodes through the app's event schema and re-encodes to its
//     stored bytes (an older form whose only difference is a key the schema
//     now supplies by default is kept as stored and counted, see
//     `checkEncodedForm`);
// (c) the app's read model folds the same Inboxes, with the same number of
//     Questions in each, over the source and over the copy;
// (d) the tag rows the copy's trigger fanned out equal the source's;
// (e) the blob table's rows (`inbox-blobs.ts`), when the source has one, are
//     copied too, each its hash's own bytes, and equal the source's.
//
// The source is opened read-only and never written. The store file must not
// exist yet: an import never merges into or replaces a log.

/** A table prefix, as a bare SQL identifier: nothing to quote or escape. */
const PREFIX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The event table's columns, in the order this copies and compares them. */
const COLUMNS = [
  'id',
  'type',
  'data',
  'tags',
  'uuid',
  'occurred_at',
  'metadata',
] as const;

/** One event row. `data` is the payload BLOB. */
interface EventRow {
  readonly id: number;
  readonly type: string;
  readonly data: Uint8Array;
  readonly tags: string;
  readonly uuid: string;
  readonly occurred_at: string;
  readonly metadata: string;
}

interface TagRow {
  readonly tag: string;
  readonly main_id: number;
}

/** One row of the blob table. */
interface BlobRow {
  readonly sha: string;
  readonly kind: string;
  readonly bytes: number;
  readonly doc: Uint8Array;
}

/** The blob table's columns, in the order this copies and compares them. */
const BLOB_COLUMNS = ['sha', 'kind', 'bytes', 'doc'] as const;

/** A log as read: its event rows in id order, its tag rows, its blobs by key, its sequence. */
interface LogRows {
  readonly events: ReadonlyArray<EventRow>;
  readonly tags: ReadonlyArray<TagRow>;
  /** The blob table's rows in key order; none when the log has no such table. */
  readonly blobs: ReadonlyArray<BlobRow>;
  /** `sqlite_sequence`'s value for the event table and its SQLite type. */
  readonly sequence: typeof StoredSequence.Type | undefined;
}

const StoredEventRow = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  data: Schema.Uint8Array,
  tags: Schema.String,
  uuid: Schema.String,
  occurred_at: Schema.String,
  metadata: Schema.String,
});
const StoredTagRow = Schema.Struct({
  tag: Schema.String,
  main_id: Schema.Number,
});
const StoredBlobRow = Schema.Struct({
  sha: Schema.String,
  kind: Schema.String,
  bytes: Schema.Number,
  doc: Schema.Uint8Array,
});
const StoredName = Schema.Struct({ name: Schema.String });
const StoredSequence = Schema.Struct({
  seq: Schema.Number,
  kind: Schema.String,
});

const quote = (name: string) => `"${name}"`;

const fail = (message: string) =>
  Effect.fail(new InputError({ message: `import-log: ${message}` }));

/** Run a node:sqlite call, any throw becoming one line naming `doing`. */
const sqlite = <A>(doing: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (e) =>
      new InputError({
        message: `import-log: ${doing}: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/** Decode one row, naming the row when it does not have the expected shape. */
const decodeRow = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  row: unknown,
  what: string,
) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(row),
    (e) =>
      new InputError({
        message: `import-log: ${what} is not the shape a kairos-es log stores: ${e.message}`,
      }),
  );

// The bundler drops the `node:` prefix of a literal builtin specifier, and
// `sqlite` exists only as `node:sqlite`, so the specifier is not a literal.
const NODE_SQLITE = 'node:sqlite';

/**
 * node:sqlite, loaded when an import runs (it warns on load). A Node without
 * it fails with the one line every other refusal here gives.
 */
const loadSqlite = Effect.tryPromise({
  try: (): Promise<typeof import('node:sqlite')> => import(NODE_SQLITE),
  catch: (e) =>
    new InputError({
      message: `import-log: could not load node:sqlite, which Node 22.16 or later provides: ${e instanceof Error ? e.message : String(e)}`,
    }),
});

/**
 * Open a log read-only. A WAL-mode file needs its `-wal` file beside it to
 * open read-only, and is opened that way when it has one. With no `-wal`, it
 * is opened as immutable, which reads the main file with no locking and no
 * recovery: right only when the main file holds every committed transaction
 * and nothing uncommitted. A `-journal` beside it breaks that (a rollback
 * journal left by a crash, or one a writer holds open), and immutable would
 * read the pages it has not rolled back, so a source with one is refused.
 * That check is made once, at open: immutable takes no locks, so a writer
 * that starts after it can still give a torn read. A source with no `-wal`
 * must not be written while it is imported.
 */
const openReadOnly = (file: string) =>
  Effect.gen(function* () {
    const { DatabaseSync } = yield* loadSqlite;
    const fs = yield* FileSystem.FileSystem;
    const exists = (p: string) =>
      fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    if (yield* exists(`${file}-journal`))
      return yield* fail(
        `${file}-journal exists beside the source: a rollback journal from a crash or a write in progress, so the file may hold uncommitted pages; once nothing is writing it, open ${file} once with sqlite3 to recover it, then import again`,
      );
    const hasWal = yield* exists(`${file}-wal`);
    return yield* sqlite(`could not open ${file} read-only`, () =>
      hasWal
        ? new DatabaseSync(file, { readOnly: true })
        : new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, {
            readOnly: true,
          }),
    );
  });

/** Close a database, ignoring a second close. */
const close = (db: DatabaseSync) =>
  Effect.sync(() => {
    if (db.isOpen) db.close();
  });

/** The column names of `table`, empty when there is no such table. */
const columnsOf = (db: DatabaseSync, table: string) =>
  Effect.gen(function* () {
    const rows = yield* sqlite(`could not read ${table}'s columns`, () =>
      db.prepare(`PRAGMA table_info(${quote(table)})`).all(),
    );
    return yield* Effect.forEach(rows, (r) =>
      Effect.map(
        decodeRow(StoredName, r, `a column of ${table}`),
        (c) => c.name,
      ),
    );
  });

/**
 * Every row of a log's two tables, under `prefix`, and its sequence, read in
 * one read transaction. For a WAL source (opened through its `-wal`) that is
 * one snapshot: an append by another connection while this reads is either
 * wholly in what it reads or wholly out of it. A source opened immutable
 * takes no locks, so the transaction isolates nothing there: such a source
 * must not be written while it is read (see `openReadOnly`). Refuses a log whose tables are missing or
 * whose event table has a column this does not copy. A log from before
 * kairos-es's `metadata` column reads every row's metadata as the empty bag,
 * which is what the store gives such a log when it migrates it.
 *
 * Exported for its test, which appends to the file between the reads.
 */
export const readLog = (db: DatabaseSync, prefix: string, describe: string) =>
  Effect.acquireUseRelease(
    sqlite(`could not begin a read of ${describe}`, () => db.exec('BEGIN')),
    () => readLogRows(db, prefix, describe),
    () =>
      Effect.sync(() => {
        if (db.isOpen && db.isTransaction) db.exec('ROLLBACK');
      }),
  );

const readLogRows = (db: DatabaseSync, prefix: string, describe: string) =>
  Effect.gen(function* () {
    const tagTable = `${prefix}_tags`;
    const columns = yield* columnsOf(db, prefix);
    if (columns.length === 0)
      return yield* fail(`${describe} has no event table "${prefix}"`);
    if ((yield* columnsOf(db, tagTable)).length === 0)
      return yield* fail(`${describe} has no tag table "${tagTable}"`);
    const known: ReadonlyArray<string> = COLUMNS;
    const unknown = columns.filter((c) => !known.includes(c));
    if (unknown.length > 0)
      return yield* fail(
        `${describe}'s event table "${prefix}" has columns this cannot copy: ${unknown.join(', ')}`,
      );
    const missing = COLUMNS.filter(
      (c) => c !== 'metadata' && !columns.includes(c),
    );
    if (missing.length > 0)
      return yield* fail(
        `${describe}'s event table "${prefix}" lacks columns: ${missing.join(', ')}`,
      );
    const metadata = columns.includes('metadata')
      ? 'metadata'
      : `'{}' AS metadata`;
    const eventRows = yield* sqlite(`could not read ${describe}'s events`, () =>
      db
        .prepare(
          `SELECT id, type, data, tags, uuid, occurred_at, ${metadata} FROM ${quote(prefix)} ORDER BY id`,
        )
        .all(),
    );
    const events = yield* Effect.forEach(eventRows, (r, i) =>
      decodeRow(StoredEventRow, r, `${describe}'s event row ${i + 1}`),
    );
    const tagRows = yield* sqlite(`could not read ${describe}'s tags`, () =>
      db
        .prepare(
          `SELECT tag, main_id FROM ${quote(tagTable)} ORDER BY main_id, tag`,
        )
        .all(),
    );
    const tags = yield* Effect.forEach(tagRows, (r) =>
      decodeRow(StoredTagRow, r, `a tag row of ${describe}`),
    );
    const blobs = yield* readBlobRows(db, `${prefix}_blobs`, describe);
    const sequence = yield* readSequence(db, prefix, describe);
    return { events, tags, blobs, sequence } satisfies LogRows;
  });

/**
 * The blob table's rows, in key order, when the log has the table; none when
 * it has not (a log from before blobs). A table with other columns is
 * refused, since this would not copy it whole.
 */
const readBlobRows = (db: DatabaseSync, table: string, describe: string) =>
  Effect.gen(function* () {
    const columns = yield* columnsOf(db, table);
    if (columns.length === 0) return [];
    const known: ReadonlyArray<string> = BLOB_COLUMNS;
    if (
      columns.length !== BLOB_COLUMNS.length ||
      columns.some((c) => !known.includes(c))
    )
      return yield* fail(
        `${describe}'s blob table "${table}" has the columns ${columns.join(', ')}, not ${BLOB_COLUMNS.join(', ')}`,
      );
    const rows = yield* sqlite(`could not read ${describe}'s blobs`, () =>
      db
        .prepare(
          `SELECT ${BLOB_COLUMNS.join(', ')} FROM ${quote(table)} ORDER BY sha`,
        )
        .all(),
    );
    return yield* Effect.forEach(rows, (r, i) =>
      decodeRow(StoredBlobRow, r, `${describe}'s blob row ${i + 1}`),
    );
  });

/** (e) every blob is its hash's own bytes, and the size it says. */
const checkBlobs = (rows: ReadonlyArray<BlobRow>, describe: string) =>
  Effect.forEach(
    rows,
    (row) =>
      sha256Hex(row.doc) === row.sha && row.bytes === row.doc.byteLength
        ? Effect.void
        : fail(
            `${describe}'s blob ${row.sha} is not the SHA-256 of its ${row.doc.byteLength} bytes, or not the ${row.bytes} bytes it says`,
          ),
    { discard: true },
  );

/** `sqlite_sequence`'s value for `table`, when the file has one. */
const readSequence = (db: DatabaseSync, table: string, describe: string) =>
  Effect.gen(function* () {
    const hasTable = yield* sqlite(`could not read ${describe}'s schema`, () =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        )
        .all(),
    );
    if (hasTable.length === 0) return undefined;
    const rows = yield* sqlite(`could not read ${describe}'s sequence`, () =>
      db
        .prepare(
          'SELECT seq, typeof(seq) AS kind FROM sqlite_sequence WHERE name = ?',
        )
        .all(table),
    );
    const [first] = rows;
    if (first === undefined) return undefined;
    return yield* decodeRow(StoredSequence, first, `${describe}'s sequence`);
  });

// --- (b) the encoded forms ---------------------------------------------------------

const EventJson = Schema.fromJsonString(InboxEvent);
const decodeEvent = Schema.decodeUnknownEffect(EventJson);
const encodeEvent = Schema.encodeEffect(EventJson);
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const isObject = (u: unknown): u is Readonly<Record<string, unknown>> =>
  typeof u === 'object' && u !== null && !Array.isArray(u);

/**
 * True when the stored payload is the re-encoded one with some top-level keys
 * LEFT OUT, and nothing else different: the re-encoding with only the stored
 * keys kept is the stored text, byte for byte. That is the shape of an event
 * written before the schema gained a key it now supplies by default (a
 * withdrawal's `reason`, say): the app reads it, and writes the newer form
 * only for new events. Spacing, key order and every value must still match.
 */
const onlyAddsKeys = (stored: string, reencoded: string) => {
  const before: unknown = JSON.parse(stored);
  const after: unknown = JSON.parse(reencoded);
  if (!isObject(before) || !isObject(after)) return false;
  const kept = Object.fromEntries(
    Object.entries(after).filter(([key]) => Object.hasOwn(before, key)),
  );
  return (
    Object.keys(kept).length === Object.keys(before).length &&
    JSON.stringify(kept) === stored
  );
};

/**
 * One row's payload through the app's own schema: it must decode, be the
 * event its `type` column names, and re-encode to the stored bytes. Returns
 * whether it is an older form (see `onlyAddsKeys`), which is kept as stored.
 */
const checkEncodedForm = (row: EventRow, describe: string) =>
  Effect.gen(function* () {
    const where = `${describe}'s event ${row.id}`;
    const text = yield* Effect.try({
      try: () => textDecoder.decode(row.data),
      catch: () =>
        new InputError({
          message: `import-log: ${where} is not UTF-8 text`,
        }),
    });
    const event = yield* Effect.mapError(
      decodeEvent(text),
      (e) =>
        new InputError({
          message: `import-log: ${where} (${row.type}) does not decode as an inbox event: ${e.message}`,
        }),
    );
    if (event._tag !== row.type)
      return yield* fail(
        `${where} is stored as ${row.type} but its payload is ${event._tag}`,
      );
    const reencoded = yield* Effect.mapError(
      encodeEvent(event),
      (e) =>
        new InputError({
          message: `import-log: ${where} (${row.type}) does not re-encode: ${e.message}`,
        }),
    );
    if (sameBytes(textEncoder.encode(reencoded), row.data)) return false;
    if (onlyAddsKeys(text, reencoded)) return true;
    return yield* fail(
      `${where} (${row.type}) re-encodes to different bytes: stored ${text}, re-encoded ${reencoded}`,
    );
  });

/** Check every row's encoded form; the count of older forms kept as stored. */
const checkEncodedForms = (rows: ReadonlyArray<EventRow>, describe: string) =>
  Effect.map(
    Effect.forEach(rows, (row) => checkEncodedForm(row, describe)),
    (older) => older.filter(Boolean).length,
  );

// --- (c) the fold ------------------------------------------------------------------

const Tags = Schema.fromJsonString(Schema.Array(Schema.String));
const MetadataBag = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.String),
);

/** What the comparison of folds reads: each Inbox and its Question count. */
type Folded = ReadonlyMap<string, number>;

const foldedOf = (listed: ReadonlyArray<ListedInbox>): Folded =>
  new Map(listed.map((l) => [l.inboxId, l.state.questions.length]));

/**
 * The app's read model (`InboxLog.listAll`) over the source's rows, loaded
 * into kairos-es's in-memory store in id order: the source file itself is
 * never opened by the store, which would switch it to WAL and migrate it.
 */
const foldRows = (rows: ReadonlyArray<EventRow>, describe: string) =>
  Effect.gen(function* () {
    const events = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const where = `${describe}'s event ${row.id}`;
        const tags = yield* Effect.mapError(
          Schema.decodeUnknownEffect(Tags)(row.tags),
          (e) =>
            new InputError({
              message: `import-log: ${where}'s tags are not a JSON list of strings: ${e.message}`,
            }),
        );
        const metadata = yield* Effect.mapError(
          Schema.decodeUnknownEffect(MetadataBag)(row.metadata),
          (e) =>
            new InputError({
              message: `import-log: ${where}'s metadata is not a JSON object of strings: ${e.message}`,
            }),
        );
        const occurredAt = DateTime.make(row.occurred_at).pipe(
          Option.map(DateTime.toUtc),
        );
        if (Option.isNone(occurredAt))
          return yield* fail(`${where}'s occurred_at is not a time`);
        return {
          type: EventType.make(row.type),
          data: row.data,
          tags: tags.map((t) => Tag.make(t)),
          uuid: row.uuid,
          occurredAt: occurredAt.value,
          metadata,
        };
      }),
    );
    const store = yield* DcbEventStore;
    const [first, ...rest] = events;
    if (first !== undefined) yield* store.append([first, ...rest]);
    const log = yield* InboxLog;
    return foldedOf(yield* log.listAll());
  }).pipe(
    Effect.provide(
      Layer.effect(InboxLog, makeInboxLog).pipe(
        Layer.provideMerge(DcbEventStoreInMemory),
        Layer.provide(InboxBlobsInMemory),
        Layer.provide(InboxReadModelInMemory),
      ),
    ),
  );

/** Compare two folds, naming the first difference. */
const compareFolds = (source: Folded, target: Folded) =>
  Effect.gen(function* () {
    if (source.size !== target.size)
      return yield* fail(
        `the copy folds to ${target.size} Inboxes, the source to ${source.size}`,
      );
    for (const [inboxId, questions] of source) {
      const copied = target.get(inboxId);
      if (copied === undefined)
        return yield* fail(`Inbox ${inboxId} is missing from the copy's fold`);
      if (copied !== questions)
        return yield* fail(
          `Inbox ${inboxId} folds to ${copied} Questions in the copy, ${questions} in the source`,
        );
    }
  });

const totalQuestions = (folded: Folded) =>
  [...folded.values()].reduce((sum, n) => sum + n, 0);

// --- (a) and (d) the rows ----------------------------------------------------------

const describeValue = (value: unknown) =>
  value instanceof Uint8Array ? `${value.length} bytes` : JSON.stringify(value);

/** Compare the source's rows with the copy's, naming the first difference. */
const compareRows = (source: LogRows, target: LogRows) =>
  Effect.gen(function* () {
    if (source.events.length !== target.events.length)
      return yield* fail(
        `the copy holds ${target.events.length} events, the source ${source.events.length}`,
      );
    for (const [i, from] of source.events.entries()) {
      const to = target.events[i];
      if (to === undefined) return yield* fail(`the copy lacks row ${from.id}`);
      for (const column of COLUMNS) {
        const a = from[column];
        const b = to[column];
        const same =
          a instanceof Uint8Array && b instanceof Uint8Array
            ? sameBytes(a, b)
            : a === b;
        if (!same)
          return yield* fail(
            `event ${from.id}'s ${column} differs: the source has ${describeValue(a)}, the copy ${describeValue(b)}`,
          );
      }
    }
    if (source.tags.length !== target.tags.length)
      return yield* fail(
        `the copy holds ${target.tags.length} tag rows, the source ${source.tags.length}`,
      );
    for (const [i, from] of source.tags.entries()) {
      const to = target.tags[i];
      if (
        to === undefined ||
        to.tag !== from.tag ||
        to.main_id !== from.main_id
      )
        return yield* fail(
          `tag row ${i + 1} differs: the source has ${JSON.stringify(from)}, the copy ${JSON.stringify(to)}`,
        );
    }
    if (source.blobs.length !== target.blobs.length)
      return yield* fail(
        `the copy holds ${target.blobs.length} blobs, the source ${source.blobs.length}`,
      );
    for (const [i, from] of source.blobs.entries()) {
      const to = target.blobs[i];
      if (
        to === undefined ||
        to.sha !== from.sha ||
        to.kind !== from.kind ||
        to.bytes !== from.bytes ||
        !sameBytes(to.doc, from.doc)
      )
        return yield* fail(`blob ${from.sha} differs in the copy`);
    }
    const sequenceOf = (rows: LogRows) =>
      rows.sequence === undefined
        ? 'none'
        : `${rows.sequence.seq} (${rows.sequence.kind})`;
    if (sequenceOf(source) !== sequenceOf(target))
      return yield* fail(
        `the copy's sequence is ${sequenceOf(target)}, the source's ${sequenceOf(source)}`,
      );
  });

// --- the copy ----------------------------------------------------------------------

/** Insert every event row in id order, in one transaction, and the sequence. */
const copyRows = (db: DatabaseSync, rows: LogRows) =>
  sqlite('could not copy the events', () => {
    const table = quote(STORE_CONFIG.tablePrefix);
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare(
        `INSERT INTO ${table} (${COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows.events)
        insert.run(
          r.id,
          r.type,
          r.data,
          r.tags,
          r.uuid,
          r.occurred_at,
          r.metadata,
        );
      if (rows.blobs.length > 0) {
        const blobs = db.prepare(
          `INSERT INTO ${quote(`${STORE_CONFIG.tablePrefix}_blobs`)} (${BLOB_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?)`,
        );
        for (const b of rows.blobs) blobs.run(b.sha, b.kind, b.bytes, b.doc);
      }
      // The explicit ids moved the sequence to the highest; a source whose
      // sequence ran past it (an append rolled back after taking an id) keeps
      // its own, so the next position is the one the source would have used.
      if (rows.sequence !== undefined)
        // A BigInt binds as an INTEGER; a number would bind as a REAL.
        db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(
          BigInt(rows.sequence.seq),
          STORE_CONFIG.tablePrefix,
        );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

/** The SQLite files that belong to `file`. */
const sidecars = (file: string) => [
  `${file}-wal`,
  `${file}-shm`,
  `${file}-journal`,
];

/** A short random suffix from the injected generator. */
const randomSuffix = Effect.map(
  Effect.forEach(Array.from({ length: 6 }), () =>
    Random.nextIntBetween(0, 256, { halfOpen: true }),
  ),
  (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(''),
);

// --- the command -------------------------------------------------------------------

export interface ImportLogOptions {
  /** Absolute path of the log to copy from. */
  readonly from: string;
  /** Its table prefix. */
  readonly fromPrefix: string;
  readonly dryRun: boolean;
  /** This app's store, resolved the usual way. */
  readonly target: ResolvedInboxDatabase;
}

export interface ImportLogSummary {
  readonly events: number;
  readonly inboxes: number;
  readonly questions: number;
  /** Events kept in an older encoded form (see `onlyAddsKeys`). */
  readonly olderForms: number;
  /** Rows of the blob table. */
  readonly blobs: number;
}

/** The name every temporary copy beside the store starts with. */
const tempPrefix = (target: ResolvedInboxDatabase) =>
  `${path.basename(target.path)}.import-`;

/** The refusals that hold before anything is read. */
const refuseUnusable = (options: ImportLogOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { from, fromPrefix, target } = options;
    if (!path.isAbsolute(from))
      return yield* fail(`--from must be an absolute path (it is ${from})`);
    if (!PREFIX.test(fromPrefix))
      return yield* fail(
        `--from-prefix must be a bare table name (letters, digits and _), not ${JSON.stringify(fromPrefix)}`,
      );
    // The same file under another name (a symlink, `..`) is still the store.
    const real = (p: string) =>
      fs.realPath(p).pipe(Effect.orElseSucceed(() => path.resolve(p)));
    const fromReal = yield* real(from);
    const targetReal = path.join(
      yield* real(path.dirname(target.path)),
      path.basename(target.path),
    );
    if (
      path.resolve(from) === path.resolve(target.path) ||
      fromReal === targetReal
    )
      return yield* fail(
        `--from is this app's own store (${describeInboxDatabase(target)})`,
      );
    if (!(yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false))))
      return yield* fail(`${from} does not exist`);
    // A copy left by an import that was killed, looked for before the store
    // itself: one killed between the link and the removal of its temporary
    // name leaves the store in place and the copy a second name for it, which
    // is the case to name. SQLite opened under that name would keep its own
    // `-wal` and `-shm`, so nothing here opens or removes it.
    const dir = path.dirname(target.path);
    const leftovers = (yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
      .filter((name) => name.startsWith(tempPrefix(target)))
      .sort()
      .map((name) => path.join(dir, name));
    if (leftovers.length > 0) {
      const list = (files: ReadonlyArray<string>) =>
        `${files.join(', ')} ${files.length === 1 ? 'is' : 'are'}`;
      const them = (files: ReadonlyArray<string>) =>
        files.length === 1 ? 'it' : 'them';
      const storeExists = yield* fs
        .exists(target.path)
        .pipe(Effect.orElseSucceed(() => true));
      // A copy's own `-wal`, `-shm` or `-journal` is never the store's file;
      // only a main file can be a second name for it.
      const copies = leftovers.filter(
        (file) => !sidecars('').some((suffix) => file.endsWith(suffix)),
      );
      if (!storeExists || copies.length === 0)
        return yield* fail(
          `${list(leftovers)} left from an import that did not finish; delete ${them(leftovers)} only when no import is running, then import again`,
        );
      const copySidecars = leftovers.filter((file) => !copies.includes(file));
      const besides =
        copySidecars.length === 0
          ? ''
          : `. ${list(copySidecars)} only ${copySidecars.length === 1 ? 'a sidecar' : 'sidecars'} of ${copies.length === 1 ? 'the copy' : 'the copies'}, never the store's file, and safe to delete once ${copies.length === 1 ? 'the copy is' : 'the copies are'} dealt with`;
      return yield* fail(
        `${list(copies)} left from an import that did not finish, and the store ${target.path} exists, so ${copies.length === 1 ? 'it' : 'each'} may be a second name for the live store; never open ${them(copies)}, and remove ${copies.length === 1 ? 'it' : 'one'} only when no import is running and after checking it is not the store's file (\`ls -i\` shows the same inode for both when it is)${besides}`,
      );
    }
    for (const file of [target.path, ...sidecars(target.path)])
      if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true)))
        return yield* fail(
          `${file} already exists; an import only ever makes a new store (target: ${describeInboxDatabase(target)})`,
        );
  });

/** Read and check the source: rows, encoded forms, fold. */
const readSource = (options: ImportLogOptions) =>
  Effect.acquireUseRelease(
    openReadOnly(options.from),
    (db) =>
      Effect.gen(function* () {
        const describe = options.from;
        const rows = yield* readLog(db, options.fromPrefix, describe);
        const olderForms = yield* checkEncodedForms(rows.events, describe);
        yield* checkBlobs(rows.blobs, describe);
        const folded = yield* foldRows(rows.events, describe);
        return { rows, olderForms, folded };
      }),
    close,
  );

/**
 * Import the log at `options.from` into a store that does not exist yet, or,
 * with `dryRun`, read and check the source and write nothing.
 */
export const importLog = (options: ImportLogOptions) =>
  Effect.gen(function* () {
    yield* refuseUnusable(options);
    const source = yield* readSource(options);
    const summary: ImportLogSummary = {
      events: source.rows.events.length,
      inboxes: source.folded.size,
      questions: totalQuestions(source.folded),
      olderForms: source.olderForms,
      blobs: source.rows.blobs.length,
    };
    if (options.dryRun) return summary;

    const fs = yield* FileSystem.FileSystem;
    const { target } = options;
    const temp = path.join(
      path.dirname(target.path),
      `${tempPrefix(target)}${yield* randomSuffix}`,
    );
    const tempResolved: ResolvedInboxDatabase = { ...target, path: temp };
    // The cleanup on every exit, for a build that stopped part way.
    const removeTemp = Effect.forEach(
      [...sidecars(temp), temp],
      (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

    const build = Effect.gen(function* () {
      // The store's own wiring makes the file and its schema.
      yield* Effect.scoped(Layer.build(connectInboxLog(tempResolved)));
      const { DatabaseSync } = yield* loadSqlite;
      yield* Effect.acquireUseRelease(
        sqlite(`could not open ${temp}`, () => new DatabaseSync(temp)),
        (db) => copyRows(db, source.rows),
        close,
      );
      // (c) the app's read model over the copy, through the store itself.
      const copiedFold = yield* Effect.gen(function* () {
        const log = yield* InboxLog;
        return foldedOf(yield* log.listAll());
      }).pipe(Effect.provide(connectInboxLog(tempResolved)), Effect.scoped);
      yield* compareFolds(source.folded, copiedFold);
      // (a), (b) and (d) over the copy's own rows, then fold the WAL back so
      // the main file is the whole store before it moves.
      yield* Effect.acquireUseRelease(
        sqlite(`could not open ${temp}`, () => new DatabaseSync(temp)),
        (db) =>
          Effect.gen(function* () {
            const copied = yield* readLog(db, STORE_CONFIG.tablePrefix, temp);
            yield* compareRows(source.rows, copied);
            yield* checkEncodedForms(copied.events, temp);
            yield* sqlite(`could not checkpoint ${temp}`, () =>
              db.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
            );
          }),
        close,
      );
      const wal = yield* fs.stat(`${temp}-wal`).pipe(Effect.option);
      if (Option.isSome(wal) && wal.value.size > 0n)
        return yield* fail(
          `${temp}-wal still holds frames after the checkpoint`,
        );
      // The copy moves as its main file alone: its emptied sidecars go first.
      yield* Effect.forEach(
        sidecars(temp),
        (file) =>
          fs.remove(file, { force: true }).pipe(
            Effect.mapError(
              (e) =>
                new InputError({
                  message: `import-log: could not remove ${file}: ${e.message}`,
                }),
            ),
          ),
        { discard: true },
      );
      // A hard link never replaces: if a store appeared at the target while
      // this ran (a `serve` opening it), the link fails and nothing is lost.
      yield* fs.link(temp, target.path).pipe(
        Effect.mapError(
          (e) =>
            new InputError({
              message: `import-log: could not move the verified copy to ${describeInboxDatabase(target)}: ${e.message}`,
            }),
        ),
      );
      // At once, so the store has a second name for as short a time as can
      // be. Should this fail, the cleanup on exit tries again, and the next
      // import refuses to start while it is still there.
      yield* fs.remove(temp).pipe(
        Effect.mapError(
          (e) =>
            new InputError({
              message: `import-log: the store is in place at ${describeInboxDatabase(target)}, but could not remove ${temp}, a second name for it; check it is gone: ${e.message}`,
            }),
        ),
      );
    });
    yield* build.pipe(Effect.onExit(() => removeTemp));
    return summary;
  });

/** The one line an import prints. */
export const describeImport = (
  options: ImportLogOptions,
  summary: ImportLogSummary,
) => {
  const counts = `${summary.events} events, ${summary.inboxes} Inboxes, ${summary.questions} Questions${summary.blobs === 0 ? '' : `, ${summary.blobs} blobs`}`;
  const older =
    summary.olderForms === 0
      ? ''
      : ` (${summary.olderForms} in an older encoded form, kept as stored)`;
  return options.dryRun
    ? `import-log: dry run: ${options.from} (prefix ${options.fromPrefix}) holds ${counts}${older}; verified; nothing written`
    : `import-log: copied ${counts}${older} from ${options.from} (prefix ${options.fromPrefix}) into ${describeInboxDatabase(options.target)}; verified`;
};
