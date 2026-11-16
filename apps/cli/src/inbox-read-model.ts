import { ORIGIN, Position } from '@kairos-es/core';
import {
  type EventStamp,
  emptyInboxState,
  evolveInbox,
  type InboxEvent,
  InboxId,
  type InboxState,
  questionGroup,
} from '@operator-inbox/core';
import { Context, Effect, Layer, Option, Ref, Schedule, Schema } from 'effect';
import { SqlClient, type SqlError } from 'effect/sql';
import { InputError } from './errors';
import { STORE_CONFIG } from './inbox-database';

// The inbox list's read model: derived tables in the store's own SQLite file,
// beside the event log, so listing every Inbox is a SELECT rather than a
// decode and fold of the whole log.
//
// - `<prefix>_rm_inbox`: one row per Inbox, holding its folded state (as JSON)
//   and the stamps its `lastActivity` is taken from;
// - `<prefix>_rm_question`: one row per Question, with its state and its
//   asked, answered, processed and withdrawn times as real columns, so a count
//   is SQL;
// - `<prefix>_rm_checkpoint`: one row, the log position the rows are folded up
//   to and the fold version they were folded by.
//
// The rows are never the truth. Any process catches them up on read
// (`catchUpReadModel`): it reads the log after the checkpoint, folds those
// events into the rows they touch, and writes the rows and the new checkpoint
// in one transaction, on the condition that the checkpoint is still the one it
// read. The CLI and `serve` both write the log, so there is no one subscriber
// to rely on: a process that loses the race reads again. When the stored fold
// version is not `READ_MODEL_VERSION`, or the checkpoint is past the log's
// head (a log replaced under it), the rows are dropped and rebuilt from the
// start.
//
// The fold is core's `evolveInbox`, event by event, so a row's state is what
// `inboxStateStamped` gives over the same Inbox's events.

/**
 * The version of the fold the rows were made by. Bump it whenever what a row
 * holds would change for the same events: core's `evolveInbox` or
 * `InboxState`, `isQuietEvent`, `inboxesOf`, or the question rows' columns.
 * A store whose rows carry another version rebuilds them on its next read.
 */
export const READ_MODEL_VERSION = 3;

/**
 * One inbox as `listAll` hands it back: its folded state and the stamp of its
 * newest event (the seq is what core's `orderInboxes` sorts on; the time is
 * for display and never for ordering).
 */
export interface ListedInbox {
  readonly inboxId: InboxId;
  // Folded with stamps, so every question knows when it moved.
  readonly state: InboxState;
  readonly lastActivity: EventStamp;
}

/** One event as the fold takes it: the event and its place in the log. */
export interface StampedEvent {
  readonly event: InboxEvent;
  readonly stamp: EventStamp;
}

/** Every inbox an event belongs to: its own, and a move's destination. */
export const inboxesOf = (event: InboxEvent): ReadonlyArray<InboxId> =>
  event._tag === 'QuestionMoved'
    ? [event.inboxId, event.toInboxId]
    : [event.inboxId];

// A mode switch is the session's, and a priority mark the operator's own
// arrangement, as a pin is; neither is news in the Inbox.
export const isQuietEvent = (event: InboxEvent) =>
  event._tag === 'InboxModeOn' ||
  event._tag === 'InboxModeOff' ||
  event._tag === 'InboxPriorityMarked' ||
  event._tag === 'InboxPriorityCleared';

// --- the fold ------------------------------------------------------------------------

/**
 * One Inbox's row: its state, the seq of its first event (the list's order:
 * the order Inboxes first appear in the log), the stamp of its newest event,
 * and of its newest event that is news (`isQuietEvent`), if any.
 */
export interface FoldedInbox {
  readonly inboxId: InboxId;
  readonly firstSeq: number;
  readonly state: InboxState;
  readonly lastEvent: EventStamp;
  readonly lastNews?: EventStamp;
}

/**
 * An Inbox's `lastActivity`: its newest event that is news, so a mode switch
 * or a priority mark does not move it up the operator's list; its newest
 * event of any kind when it has nothing else.
 */
export const lastActivityOf = (row: FoldedInbox): EventStamp =>
  row.lastNews ?? row.lastEvent;

export const listedOf = (row: FoldedInbox): ListedInbox => ({
  inboxId: row.inboxId,
  state: row.state,
  lastActivity: lastActivityOf(row),
});

/** One event folded into one Inbox's row (none yet: a new Inbox). */
export const evolveFolded = (
  row: FoldedInbox | undefined,
  inboxId: InboxId,
  { event, stamp }: StampedEvent,
): FoldedInbox => {
  const lastNews = isQuietEvent(event) ? row?.lastNews : stamp;
  return {
    inboxId,
    firstSeq: row?.firstSeq ?? stamp.seq,
    state: evolveInbox(row?.state ?? emptyInboxState, event, stamp),
    lastEvent: stamp,
    ...(lastNews === undefined ? {} : { lastNews }),
  };
};

/**
 * Fold events, oldest first, into the rows of the Inboxes they touch. `rows`
 * holds the current row of every Inbox the events touch that has one; the
 * result holds the new row of each Inbox they touched.
 */
export const foldEvents = (
  rows: ReadonlyMap<InboxId, FoldedInbox>,
  events: ReadonlyArray<StampedEvent>,
): ReadonlyMap<InboxId, FoldedInbox> => {
  const touched = new Map<InboxId, FoldedInbox>();
  for (const entry of events)
    for (const inboxId of inboxesOf(entry.event))
      touched.set(
        inboxId,
        evolveFolded(touched.get(inboxId) ?? rows.get(inboxId), inboxId, entry),
      );
  return touched;
};

/** The Inboxes a batch of events touches, each once. */
export const touchedBy = (
  events: ReadonlyArray<StampedEvent>,
): ReadonlyArray<InboxId> => [
  ...new Set(events.flatMap((e) => inboxesOf(e.event))),
];

// --- the question rows ------------------------------------------------------------------

/** One Question's row: what a count over Questions reads. */
export interface QuestionRow {
  readonly inboxId: InboxId;
  readonly number: number;
  readonly state: string;
  readonly askedAt: string | null;
  readonly answeredAt: string | null;
  readonly processedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly group: string;
  readonly highlighted: boolean;
  readonly fromOperator: boolean;
}

/**
 * The Question rows of one Inbox. A Question the operator put to the agent
 * has no answered time: the operator answered nothing. A withdrawn one is
 * processed, and its withdrawn time is its processed time.
 */
export const questionRowsOf = (row: FoldedInbox): ReadonlyArray<QuestionRow> =>
  row.state.questions.map((q) => ({
    inboxId: row.inboxId,
    number: q.number,
    state: q.state,
    askedAt: q.askedStamp?.at ?? null,
    answeredAt:
      q.operatorQuestion === true ? null : (q.answeredStamp?.at ?? null),
    processedAt: q.processedStamp?.at ?? null,
    withdrawnAt: q.withdrawn ? (q.processedStamp?.at ?? null) : null,
    group: questionGroup(q.metadata),
    highlighted: q.highlight !== undefined,
    fromOperator: q.operatorQuestion === true,
  }));

/**
 * Counts over every Inbox's Questions. `since` is an ISO time; the `…Since`
 * counts take the Questions whose time is at or after it. A Question moved to
 * another Inbox is counted there, once, and not where it was.
 */
export interface QuestionCounts {
  readonly askedSince: number;
  readonly answeredSince: number;
  readonly processedSince: number;
  readonly withdrawnSince: number;
  readonly awaitingOperator: number;
  readonly awaitingAgent: number;
}

/** The same counts over rows in memory, as the SQL below takes them. */
export const countQuestions = (
  rows: ReadonlyArray<QuestionRow>,
  since: string,
): QuestionCounts => {
  const counted = rows.filter((r) => r.state !== 'moved');
  const after = (at: string | null) => at !== null && at >= since;
  return {
    askedSince: counted.filter((r) => !r.fromOperator && after(r.askedAt))
      .length,
    answeredSince: counted.filter((r) => after(r.answeredAt)).length,
    processedSince: counted.filter(
      (r) => r.withdrawnAt === null && after(r.processedAt),
    ).length,
    withdrawnSince: counted.filter((r) => after(r.withdrawnAt)).length,
    awaitingOperator: counted.filter((r) => r.state === 'awaiting-operator')
      .length,
    awaitingAgent: counted.filter((r) => r.state === 'awaiting-agent').length,
  };
};

// --- the rows' store -----------------------------------------------------------------

/** Where the rows are folded up to, and by which fold. */
export interface Checkpoint {
  readonly position: Position;
  readonly version: number;
}

const sameCheckpoint = (
  a: Option.Option<Checkpoint>,
  b: Option.Option<Checkpoint>,
) =>
  Option.isNone(a)
    ? Option.isNone(b)
    : Option.isSome(b) &&
      a.value.position === b.value.position &&
      a.value.version === b.value.version;

/** What one catch-up writes. */
export interface ReadModelCommit {
  // The checkpoint the catch-up read; the commit is refused if it moved.
  readonly expected: Option.Option<Checkpoint>;
  readonly next: Checkpoint;
  // Drop every row first: the rows are rebuilt from the start of the log.
  readonly rebuild: boolean;
  // The new row of every Inbox the folded events touched.
  readonly inboxes: ReadonlyArray<FoldedInbox>;
}

export class InboxReadModel extends Context.Service<
  InboxReadModel,
  {
    readonly checkpoint: Effect.Effect<Option.Option<Checkpoint>, InputError>;
    /** The rows of these Inboxes; an Inbox with none is left out. */
    readonly inboxes: (
      ids: ReadonlyArray<InboxId>,
    ) => Effect.Effect<ReadonlyMap<InboxId, FoldedInbox>, InputError>;
    /** Every row, in the order the Inboxes first appear in the log. */
    readonly all: Effect.Effect<ReadonlyArray<FoldedInbox>, InputError>;
    /**
     * Write the rows and the new checkpoint in one transaction, if the
     * checkpoint is still `expected`. False when another process moved it
     * first: nothing is written, and the caller reads again.
     */
    readonly commit: (
      commit: ReadModelCommit,
    ) => Effect.Effect<boolean, InputError>;
    readonly counts: (
      since: string,
    ) => Effect.Effect<QuestionCounts, InputError>;
  }
>()('operator-inbox/InboxReadModel') {}

/** The log after a position, decoded and stamped, with its head. */
export type ReadAfter = (after: Position) => Effect.Effect<
  {
    readonly stamped: ReadonlyArray<StampedEvent>;
    readonly head: Position;
  },
  InputError
>;

// A catch-up that loses the race to another process reads again; past this
// many losses the rows are served as they stand, which is no older than the
// winner's own catch-up.
const CATCH_UP_ATTEMPTS = 5;

/**
 * Bring the rows up to the log's head. Usually the read after the checkpoint
 * returns no events and nothing is written.
 */
export const catchUpReadModel = (
  model: InboxReadModel['Service'],
  readAfter: ReadAfter,
): Effect.Effect<void, InputError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < CATCH_UP_ATTEMPTS; attempt++) {
      const expected = yield* model.checkpoint;
      const current = Option.filter(
        expected,
        (c) => c.version === READ_MODEL_VERSION,
      );
      let rebuild = Option.isNone(current);
      let from = Option.match(current, {
        onNone: () => ORIGIN,
        onSome: (c) => c.position,
      });
      let read = yield* readAfter(from);
      // A head behind the checkpoint: the log is not the one the rows were
      // folded from. Fold it again from the start.
      if (!rebuild && read.head < from) {
        rebuild = true;
        from = ORIGIN;
        read = yield* readAfter(from);
      }
      if (!rebuild && read.stamped.length === 0 && read.head === from) return;
      const touched = touchedBy(read.stamped);
      const before = rebuild
        ? new Map<InboxId, FoldedInbox>()
        : yield* model.inboxes(touched);
      const folded = foldEvents(before, read.stamped);
      const won = yield* model.commit({
        expected,
        next: { position: read.head, version: READ_MODEL_VERSION },
        rebuild,
        inboxes: [...folded.values()],
      });
      if (won) return;
    }
  });

/** Every Inbox, caught up first, in the order they first appear in the log. */
export const listReadModel = (
  model: InboxReadModel['Service'],
  readAfter: ReadAfter,
): Effect.Effect<ReadonlyArray<ListedInbox>, InputError> =>
  Effect.andThen(
    catchUpReadModel(model, readAfter),
    Effect.map(model.all, (rows) => rows.map(listedOf)),
  );

// --- in memory -----------------------------------------------------------------------

interface MemoryRows {
  readonly checkpoint: Option.Option<Checkpoint>;
  readonly inboxes: ReadonlyMap<InboxId, FoldedInbox>;
}

/** The rows in memory, for the in-memory log. */
export const InboxReadModelInMemory: Layer.Layer<InboxReadModel> = Layer.effect(
  InboxReadModel,
  Effect.map(
    Ref.make<MemoryRows>({ checkpoint: Option.none(), inboxes: new Map() }),
    (ref) =>
      InboxReadModel.of({
        checkpoint: Effect.map(Ref.get(ref), (r) => r.checkpoint),
        inboxes: (ids) =>
          Effect.map(Ref.get(ref), (r) => {
            const out = new Map<InboxId, FoldedInbox>();
            for (const id of ids) {
              const row = r.inboxes.get(id);
              if (row !== undefined) out.set(id, row);
            }
            return out;
          }),
        all: Effect.map(Ref.get(ref), (r) =>
          [...r.inboxes.values()].sort((a, b) => a.firstSeq - b.firstSeq),
        ),
        commit: ({ expected, next, rebuild, inboxes }) =>
          Ref.modify(ref, (r): [boolean, MemoryRows] => {
            if (!sameCheckpoint(r.checkpoint, expected)) return [false, r];
            const rows = new Map(rebuild ? [] : r.inboxes);
            for (const row of inboxes) rows.set(row.inboxId, row);
            return [true, { checkpoint: Option.some(next), inboxes: rows }];
          }),
        counts: (since) =>
          Effect.map(Ref.get(ref), (r) =>
            countQuestions(
              [...r.inboxes.values()].flatMap(questionRowsOf),
              since,
            ),
          ),
      }),
  ),
);

// --- in SQLite -------------------------------------------------------------------------

const prefix = STORE_CONFIG.tablePrefix;
export const RM_INBOX_TABLE = `${prefix}_rm_inbox`;
export const RM_QUESTION_TABLE = `${prefix}_rm_question`;
export const RM_CHECKPOINT_TABLE = `${prefix}_rm_checkpoint`;

/** The statements that make the tables, each idempotent. */
export const readModelTableStatements: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS "${RM_INBOX_TABLE}" (inbox_id TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, last_event_seq INTEGER NOT NULL, last_event_at TEXT, last_news_seq INTEGER, last_news_at TEXT, state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "${RM_QUESTION_TABLE}" (inbox_id TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL, asked_at TEXT, answered_at TEXT, processed_at TEXT, withdrawn_at TEXT, group_name TEXT NOT NULL, highlighted INTEGER NOT NULL, from_operator INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS "${RM_QUESTION_TABLE}_inbox" ON "${RM_QUESTION_TABLE}" (inbox_id)`,
  `CREATE TABLE IF NOT EXISTS "${RM_CHECKPOINT_TABLE}" (id INTEGER PRIMARY KEY CHECK (id = 1), position TEXT NOT NULL, fold_version INTEGER NOT NULL)`,
];

// A busy lock answers at once (the store's client sets no busy wait), so each
// statement and transaction here retries it, short and bounded, as the
// store's own migration does; nothing but a busy lock is retried.
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

const failed = (doing: string) => (e: SqlError.SqlError) =>
  new InputError({
    message: `inbox could not ${doing} its list's read model: ${e.message}`,
  });

/** Make the read model's tables if they are missing. Idempotent. */
export const ensureReadModelTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of readModelTableStatements)
    yield* sql.unsafe(statement).pipe(Effect.retry(RETRY_BUSY));
});

const CheckpointRow = Schema.Struct({
  position: Schema.String,
  fold_version: Schema.Number,
});
const decodeCheckpointRows = Schema.decodeUnknownSync(
  Schema.Array(CheckpointRow),
);

const InboxRow = Schema.Struct({
  inbox_id: Schema.String,
  first_seq: Schema.Number,
  last_event_seq: Schema.Number,
  last_event_at: Schema.NullOr(Schema.String),
  last_news_seq: Schema.NullOr(Schema.Number),
  last_news_at: Schema.NullOr(Schema.String),
  state: Schema.String,
});
const decodeInboxRows = Schema.decodeUnknownSync(Schema.Array(InboxRow));

const CountsRow = Schema.Struct({
  asked_since: Schema.NullOr(Schema.Number),
  answered_since: Schema.NullOr(Schema.Number),
  processed_since: Schema.NullOr(Schema.Number),
  withdrawn_since: Schema.NullOr(Schema.Number),
  awaiting_operator: Schema.NullOr(Schema.Number),
  awaiting_agent: Schema.NullOr(Schema.Number),
});
const decodeCountsRows = Schema.decodeUnknownSync(Schema.Array(CountsRow));

const stampOf = (seq: number, at: string | null): EventStamp =>
  at === null ? { seq } : { seq, at };

const foldedOfRow = (row: typeof InboxRow.Type): FoldedInbox => {
  // The state is this module's own JSON of an `InboxState`, written by the
  // fold version the checkpoint names; a row of another version is never read.
  const state: InboxState = JSON.parse(row.state);
  return {
    inboxId: InboxId.make(row.inbox_id),
    firstSeq: row.first_seq,
    state,
    lastEvent: stampOf(row.last_event_seq, row.last_event_at),
    ...(row.last_news_seq === null
      ? {}
      : { lastNews: stampOf(row.last_news_seq, row.last_news_at) }),
  };
};

const INBOX_COLUMNS =
  'inbox_id, first_seq, last_event_seq, last_event_at, last_news_seq, last_news_at, state';

// SQLite takes at most 999 bound parameters in older builds.
const IN_CHUNK = 500;

/** The read model over the store's own SQL client. */
export const makeInboxReadModelSql = Effect.map(SqlClient.SqlClient, (sql) => {
  const run = (text: string, params: ReadonlyArray<unknown> = []) =>
    sql.unsafe(text, params).pipe(Effect.retry(RETRY_BUSY));
  const readCheckpoint = Effect.map(
    run(
      `SELECT position, fold_version FROM "${RM_CHECKPOINT_TABLE}" WHERE id = 1`,
    ),
    (rows) =>
      Option.map(
        Option.fromNullishOr(decodeCheckpointRows(rows)[0]),
        (r): Checkpoint => ({
          position: Position.make(BigInt(r.position)),
          version: r.fold_version,
        }),
      ),
  );
  const writeInbox = (row: FoldedInbox) =>
    Effect.gen(function* () {
      yield* run(
        `INSERT OR REPLACE INTO "${RM_INBOX_TABLE}" (${INBOX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.inboxId,
          row.firstSeq,
          row.lastEvent.seq,
          row.lastEvent.at ?? null,
          row.lastNews?.seq ?? null,
          row.lastNews?.at ?? null,
          JSON.stringify(row.state),
        ],
      );
      yield* run(`DELETE FROM "${RM_QUESTION_TABLE}" WHERE inbox_id = ?`, [
        row.inboxId,
      ]);
      for (const q of questionRowsOf(row))
        yield* run(
          `INSERT INTO "${RM_QUESTION_TABLE}" (inbox_id, number, state, asked_at, answered_at, processed_at, withdrawn_at, group_name, highlighted, from_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            q.inboxId,
            q.number,
            q.state,
            q.askedAt,
            q.answeredAt,
            q.processedAt,
            q.withdrawnAt,
            q.group,
            q.highlighted ? 1 : 0,
            q.fromOperator ? 1 : 0,
          ],
        );
    });
  return InboxReadModel.of({
    checkpoint: readCheckpoint.pipe(
      Effect.mapError(failed('read the checkpoint of')),
    ),
    inboxes: (ids) =>
      Effect.gen(function* () {
        const out = new Map<InboxId, FoldedInbox>();
        for (let i = 0; i < ids.length; i += IN_CHUNK) {
          const keys = ids.slice(i, i + IN_CHUNK);
          const rows = yield* run(
            `SELECT ${INBOX_COLUMNS} FROM "${RM_INBOX_TABLE}" WHERE inbox_id IN (${keys.map(() => '?').join(', ')})`,
            keys,
          );
          for (const row of decodeInboxRows(rows)) {
            const folded = foldedOfRow(row);
            out.set(folded.inboxId, folded);
          }
        }
        return out;
      }).pipe(Effect.mapError(failed('read'))),
    all: Effect.map(
      run(
        `SELECT ${INBOX_COLUMNS} FROM "${RM_INBOX_TABLE}" ORDER BY first_seq`,
      ),
      (rows) => decodeInboxRows(rows).map(foldedOfRow),
    ).pipe(Effect.mapError(failed('read'))),
    // `withTransaction` begins IMMEDIATE on this driver, so the transaction
    // holds the write lock from its first statement: the checkpoint it reads
    // is the latest, and no other process can move it before the commit.
    commit: ({ expected, next, rebuild, inboxes }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* readCheckpoint;
            if (!sameCheckpoint(now, expected)) return false;
            if (rebuild) {
              yield* run(`DELETE FROM "${RM_INBOX_TABLE}"`);
              yield* run(`DELETE FROM "${RM_QUESTION_TABLE}"`);
            }
            for (const row of inboxes) yield* writeInbox(row);
            yield* run(
              `INSERT OR REPLACE INTO "${RM_CHECKPOINT_TABLE}" (id, position, fold_version) VALUES (1, ?, ?)`,
              [String(next.position), next.version],
            );
            return true;
          }),
        )
        .pipe(Effect.retry(RETRY_BUSY), Effect.mapError(failed('write'))),
    counts: (since) =>
      Effect.map(
        run(
          `SELECT
             SUM(from_operator = 0 AND asked_at >= ?) AS asked_since,
             SUM(answered_at >= ?) AS answered_since,
             SUM(withdrawn_at IS NULL AND processed_at >= ?) AS processed_since,
             SUM(withdrawn_at >= ?) AS withdrawn_since,
             SUM(state = 'awaiting-operator') AS awaiting_operator,
             SUM(state = 'awaiting-agent') AS awaiting_agent
           FROM "${RM_QUESTION_TABLE}" WHERE state <> 'moved'`,
          [since, since, since, since],
        ),
        (rows): QuestionCounts => {
          const r = decodeCountsRows(rows)[0];
          return {
            askedSince: r?.asked_since ?? 0,
            answeredSince: r?.answered_since ?? 0,
            processedSince: r?.processed_since ?? 0,
            withdrawnSince: r?.withdrawn_since ?? 0,
            awaitingOperator: r?.awaiting_operator ?? 0,
            awaitingAgent: r?.awaiting_agent ?? 0,
          };
        },
      ).pipe(Effect.mapError(failed('count over'))),
  });
});
