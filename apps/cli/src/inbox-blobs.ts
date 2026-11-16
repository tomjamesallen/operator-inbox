import { createHash } from 'node:crypto';
import { Context, Effect, Layer, Ref, Schedule, Schema } from 'effect';
import { SqlClient, type SqlError } from 'effect/sql';
import { InputError } from './errors';
import { STORE_CONFIG } from './inbox-database';

// The store's blob table: content-addressed documents in the same SQLite file
// as the event log, beside kairos-es's own tables. An event names a blob by
// the SHA-256 of its bytes and never carries the bytes, so the log, its folds
// and the board stay small however large the documents are (an HTML block's
// document may be 512 KiB). A blob is written BEFORE the event that names it
// and is never updated or deleted: `INSERT OR IGNORE`, so the same document
// written twice is one row, and an append that then fails leaves a blob no
// event names, which costs only its bytes.
//
// The table is the app's, not kairos-es's: its name is the store's prefix
// with `_blobs`, it is made by `ensureBlobTable` beside the event table's
// schema, and `import-log` copies it with the events.

/** The blob table's name: the store's table prefix with `_blobs`. */
export const BLOB_TABLE = `${STORE_CONFIG.tablePrefix}_blobs`;

/** The statement that makes it, idempotent. */
export const blobTableStatement = (table: string) =>
  `CREATE TABLE IF NOT EXISTS "${table}" (sha TEXT PRIMARY KEY, kind TEXT NOT NULL, bytes INTEGER NOT NULL, doc BLOB NOT NULL)`;

/** One blob: its key, what it is, its size, and its bytes. */
export interface StoredBlob {
  readonly sha: string;
  readonly kind: string;
  readonly bytes: number;
  readonly doc: Uint8Array;
}

/** The SHA-256 of some bytes, in lower-case hex: a blob's key. */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export class InboxBlobs extends Context.Service<
  InboxBlobs,
  {
    /** Keep a blob; one already kept under its key is left as it is. */
    readonly put: (blob: StoredBlob) => Effect.Effect<void, InputError>;
    /** The blobs kept under these keys; a key with none is left out. */
    readonly get: (
      shas: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, StoredBlob>, InputError>;
  }
>()('operator-inbox/InboxBlobs') {}

// A busy lock answers at once (the store's client sets no busy wait), so the
// two statements here retry it, short and bounded, as the store's own
// migration does; nothing but a busy lock is retried.
const RETRY_BUSY = Schedule.max([
  Schedule.jittered(
    Schedule.min([
      Schedule.exponential('1 millis', 2),
      Schedule.spaced('100 millis'),
    ]),
  ),
  Schedule.recurs(10),
]).pipe(
  Schedule.while(
    ({ input }: { readonly input: SqlError.SqlError }) =>
      input.reason._tag === 'LockTimeoutError',
  ),
);

const BlobRow = Schema.Struct({
  sha: Schema.String,
  kind: Schema.String,
  bytes: Schema.Number,
  doc: Schema.Uint8Array,
});
const decodeRows = Schema.decodeUnknownSync(Schema.Array(BlobRow));

const failed = (doing: string) => (e: SqlError.SqlError) =>
  new InputError({
    message: `inbox could not ${doing} in its blob table: ${e.message}`,
  });

/** Make the blob table if it is missing. Idempotent. */
export const ensureBlobTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql
    .unsafe(blobTableStatement(BLOB_TABLE))
    .pipe(Effect.retry(RETRY_BUSY));
});

// SQLite takes at most 999 bound parameters in older builds; a Question
// carries at most eight blocks, so one statement always does.
const IN_CHUNK = 500;

/** `InboxBlobs` over the store's own SQL client. */
export const makeInboxBlobsSql = Effect.map(SqlClient.SqlClient, (sql) =>
  InboxBlobs.of({
    put: (blob) =>
      sql
        .unsafe(
          `INSERT OR IGNORE INTO "${BLOB_TABLE}" (sha, kind, bytes, doc) VALUES (?, ?, ?, ?)`,
          [blob.sha, blob.kind, blob.bytes, blob.doc],
        )
        .pipe(
          Effect.retry(RETRY_BUSY),
          Effect.asVoid,
          Effect.mapError(failed('keep a document')),
        ),
    get: (shas) =>
      Effect.gen(function* () {
        const out = new Map<string, StoredBlob>();
        const unique = [...new Set(shas)];
        for (let i = 0; i < unique.length; i += IN_CHUNK) {
          const keys = unique.slice(i, i + IN_CHUNK);
          const rows = yield* sql
            .unsafe(
              `SELECT sha, kind, bytes, doc FROM "${BLOB_TABLE}" WHERE sha IN (${keys.map(() => '?').join(', ')})`,
              keys,
            )
            .pipe(
              Effect.retry(RETRY_BUSY),
              Effect.mapError(failed('read documents')),
            );
          for (const row of decodeRows(rows)) out.set(row.sha, row);
        }
        return out;
      }),
  }),
);

/** The in-memory blob table, for tests and for folding a log in memory. */
export const InboxBlobsInMemory: Layer.Layer<InboxBlobs> = Layer.effect(
  InboxBlobs,
  Effect.map(Ref.make(new Map<string, StoredBlob>()), (ref) =>
    InboxBlobs.of({
      put: (blob) =>
        Ref.update(ref, (all) =>
          all.has(blob.sha) ? all : new Map(all).set(blob.sha, blob),
        ),
      get: (shas) =>
        Effect.map(Ref.get(ref), (all) => {
          const out = new Map<string, StoredBlob>();
          for (const sha of shas) {
            const blob = all.get(sha);
            if (blob !== undefined) out.set(sha, blob);
          }
          return out;
        }),
    }),
  ),
);
