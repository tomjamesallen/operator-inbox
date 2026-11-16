import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Position } from '@kairos-es/core';
import {
  type EventStamp,
  InboxEvent,
  type InboxId,
  inboxStateStamped,
} from '@operator-inbox/core';
import { Duration, Effect, FileSystem, Option, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { dispatchStats, renderStats } from '../src/commands/stats';
import {
  catchUpReadModel,
  countQuestions,
  InboxReadModel,
  InboxReadModelInMemory,
  type ListedInbox,
  questionRowsOf,
  READ_MODEL_VERSION,
  RM_CHECKPOINT_TABLE,
  RM_INBOX_TABLE,
  type StampedEvent,
} from '../src/inbox-read-model';
import {
  connectInboxLog,
  InboxLog,
  InboxLogInMemory,
} from '../src/inbox-store';

// The list's read model against the full scan it replaced. The oracle below
// is `listAll` as it was before the read model, copied whole: fold every
// Inbox's events with core's `inboxStateStamped`, and take `lastActivity`
// from its newest event that is not a mode switch or a priority mark. Every
// golden event log in the repo is replayed through the store, on SQLite and
// in memory, and after EACH append `listAll` (caught up from wherever the
// last call left it) must equal the oracle over the whole log so far.

const CORE_GOLDEN = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'core',
  'test',
  'golden',
  'v3',
);
const CLI_GOLDEN = path.join(import.meta.dirname, 'golden', 'v3');

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(InboxEvent));

/** Every `.jsonl` event log of core's goldens, by file name. */
const coreLogs: ReadonlyArray<readonly [string, ReadonlyArray<InboxEvent>]> =
  readdirSync(CORE_GOLDEN)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => [
      f,
      readFileSync(path.join(CORE_GOLDEN, f), { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => decodeEvent(line)),
    ]);

/** The CLI's golden log: its event rows' payloads, in order. */
const cliLog: ReadonlyArray<InboxEvent> = (
  JSON.parse(
    readFileSync(path.join(CLI_GOLDEN, 'inbox-log-rows.json'), {
      encoding: 'utf8',
    }),
  ).operator_inbox as ReadonlyArray<{ readonly data: string }>
).map((row) => decodeEvent(row.data));

const inboxesOfEvent = (event: InboxEvent): ReadonlyArray<InboxId> =>
  event._tag === 'QuestionMoved'
    ? [event.inboxId, event.toInboxId]
    : [event.inboxId];

// --- the oracle: the full scan, as it was ---------------------------------------------

const isQuietEvent = (event: InboxEvent) =>
  event._tag === 'InboxModeOn' ||
  event._tag === 'InboxModeOff' ||
  event._tag === 'InboxPriorityMarked' ||
  event._tag === 'InboxPriorityCleared';

const fullScan = (
  stamped: ReadonlyArray<StampedEvent>,
): ReadonlyArray<ListedInbox> => {
  const byInbox = new Map<
    InboxId,
    Array<{ readonly event: InboxEvent; readonly stamp: EventStamp }>
  >();
  for (const entry of stamped)
    for (const inboxId of inboxesOfEvent(entry.event)) {
      const list = byInbox.get(inboxId) ?? [];
      list.push(entry);
      byInbox.set(inboxId, list);
    }
  return [...byInbox].flatMap(([inboxId, list]): Array<ListedInbox> => {
    const last =
      list.filter((e) => !isQuietEvent(e.event)).at(-1) ?? list.at(-1);
    if (last === undefined) return [];
    return [
      { inboxId, state: inboxStateStamped(list), lastActivity: last.stamp },
    ];
  });
};

/**
 * The whole log, stamped, through the store's own reads: every event carries
 * its Inbox's tag, so the union of every Inbox's read is the log.
 */
const wholeLog = (ids: ReadonlyArray<InboxId>) =>
  Effect.gen(function* () {
    const log = yield* InboxLog;
    const bySeq = new Map<number, StampedEvent>();
    for (const id of ids)
      for (const entry of (yield* log.read(id)).stamped)
        bySeq.set(entry.stamp.seq, entry);
    return [...bySeq.values()].sort((a, b) => a.stamp.seq - b.stamp.seq);
  });

/** Append the events one at a time, a minute apart; the Inboxes they touch. */
const appendAll = (events: ReadonlyArray<InboxEvent>) =>
  Effect.gen(function* () {
    const log = yield* InboxLog;
    const ids: Array<InboxId> = [];
    for (const event of events) {
      for (const id of inboxesOfEvent(event))
        if (!ids.includes(id)) ids.push(id);
      yield* TestClock.adjust(Duration.minutes(1));
      const { head } = yield* log.read(event.inboxId);
      yield* log.append([event], { after: head });
    }
    return ids;
  });

/**
 * Append the events one at a time, a minute apart, and after each one compare
 * the read model's list with the oracle's over the log so far.
 */
const replayAndCompare = (events: ReadonlyArray<InboxEvent>) =>
  Effect.gen(function* () {
    const log = yield* InboxLog;
    const ids: Array<InboxId> = [];
    expect(yield* log.listAll()).toStrictEqual([]);
    for (const event of events) {
      for (const id of inboxesOfEvent(event))
        if (!ids.includes(id)) ids.push(id);
      yield* TestClock.adjust(Duration.minutes(1));
      const { head } = yield* log.read(event.inboxId);
      yield* log.append([event], { after: head });
      expect(yield* log.listAll()).toStrictEqual(
        fullScan(yield* wholeLog(ids)),
      );
    }
    return ids;
  });

const onSqlite = <A, E>(
  body: Effect.Effect<A, E, InboxLog>,
): Effect.Effect<A, E | unknown, never> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped();
    const file = path.join(base, 'inbox.sqlite');
    return yield* body.pipe(
      Effect.provide(connectInboxLog({ source: 'env', path: file })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const sqliteFile = <A, E>(
  body: (file: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped();
    return yield* body(path.join(base, 'inbox.sqlite'));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const logOn = (file: string) => connectInboxLog({ source: 'env', path: file });

const sql = (file: string, statement: string) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
};

const allGoldens = [
  ['the CLI golden log', cliLog] as const,
  ...coreLogs,
  [
    'every core golden log, as one log',
    coreLogs.flatMap(([, e]) => e),
  ] as const,
];

describe('the read model gives what the full scan gave', () => {
  for (const [name, events] of allGoldens) {
    it.effect(`on SQLite, append by append: ${name}`, () =>
      onSqlite(replayAndCompare(events)),
    );
    it.effect(`in memory, append by append: ${name}`, () =>
      replayAndCompare(events).pipe(Effect.provide(InboxLogInMemory)),
    );
  }

  it.effect('on SQLite, caught up in one batch from nothing', () =>
    sqliteFile((file) =>
      Effect.gen(function* () {
        const events = coreLogs.flatMap(([, e]) => e);
        // Every event lands before the first list: one catch-up folds them all.
        const ids = yield* appendAll(events).pipe(Effect.provide(logOn(file)));
        // A second connection to the file, as a second process would be.
        const { listed, scanned } = yield* Effect.gen(function* () {
          const log = yield* InboxLog;
          return {
            listed: yield* log.listAll(),
            scanned: fullScan(yield* wholeLog(ids)),
          };
        }).pipe(Effect.provide(logOn(file)));
        expect(listed).toStrictEqual(scanned);
        expect(listed.length).toBeGreaterThan(0);
      }),
    ),
  );
});

// --- the rows are disposable ---------------------------------------------------------

/** Append the CLI golden log on `file`, list once, and hand back the oracle. */
const seeded = (file: string) =>
  Effect.gen(function* () {
    const log = yield* InboxLog;
    const ids = yield* appendAll(cliLog);
    yield* log.listAll();
    return fullScan(yield* wholeLog(ids));
  }).pipe(Effect.provide(logOn(file)));

const listOn = (file: string) =>
  Effect.flatMap(InboxLog, (log) => log.listAll()).pipe(
    Effect.provide(logOn(file)),
  );

describe('the read model is rebuilt when it cannot be trusted', () => {
  it.effect('rows of another fold version are dropped and folded again', () =>
    sqliteFile((file) =>
      Effect.gen(function* () {
        const expected = yield* seeded(file);
        // A row the current fold would never write, under an older version.
        sql(
          file,
          `UPDATE "${RM_INBOX_TABLE}" SET state = '{"opened":false,"label":"stale","questions":[]}'; UPDATE "${RM_CHECKPOINT_TABLE}" SET fold_version = ${READ_MODEL_VERSION - 1}`,
        );
        expect(yield* listOn(file)).toStrictEqual(expected);
      }),
    ),
  );

  it.effect(
    'a checkpoint past the log head is folded again from the start',
    () =>
      sqliteFile((file) =>
        Effect.gen(function* () {
          const expected = yield* seeded(file);
          sql(
            file,
            `UPDATE "${RM_INBOX_TABLE}" SET state = '{"opened":false,"label":"stale","questions":[]}'; UPDATE "${RM_CHECKPOINT_TABLE}" SET position = '999999'`,
          );
          expect(yield* listOn(file)).toStrictEqual(expected);
        }),
      ),
  );

  it.effect('dropped rows with their checkpoint are rebuilt', () =>
    sqliteFile((file) =>
      Effect.gen(function* () {
        const expected = yield* seeded(file);
        sql(
          file,
          `DELETE FROM "${RM_INBOX_TABLE}"; DELETE FROM "${RM_CHECKPOINT_TABLE}"`,
        );
        expect(yield* listOn(file)).toStrictEqual(expected);
      }),
    ),
  );

  it.effect('a warm list writes nothing', () =>
    sqliteFile((file) =>
      Effect.gen(function* () {
        yield* seeded(file);
        const before = new DatabaseSync(file);
        const read = () =>
          before
            .prepare(
              `SELECT position, fold_version FROM "${RM_CHECKPOINT_TABLE}"`,
            )
            .all();
        const was = read();
        yield* listOn(file);
        expect(read()).toStrictEqual(was);
        before.close();
      }),
    ),
  );
});

// --- racing another process -------------------------------------------------------------

describe('a catch-up that loses the race reads again', () => {
  it.effect('a commit refused because the checkpoint moved is retried', () =>
    Effect.gen(function* () {
      const inner = yield* InboxReadModel;
      const events: ReadonlyArray<StampedEvent> = cliLog.map((event, i) => ({
        event,
        stamp: {
          seq: i + 1,
          at: `2026-10-16T09:${String(i).padStart(2, '0')}:00.000Z`,
        },
      }));
      const head = Position.make(BigInt(events.length));
      const readAfter = (after: Position) =>
        Effect.succeed({
          stamped: events.filter((e) => BigInt(e.stamp.seq) > after),
          head,
        });
      // The first commit is overtaken: "another process" catches up first,
      // to half the log, so the checkpoint this catch-up read has moved.
      const overtaken = yield* Ref.make(false);
      const half = Position.make(BigInt(Math.floor(events.length / 2)));
      const racing = InboxReadModel.of({
        ...inner,
        commit: (commit) =>
          Effect.gen(function* () {
            if (!(yield* Ref.getAndSet(overtaken, true)))
              yield* catchUpReadModel(inner, (after) =>
                Effect.succeed({
                  stamped: events.filter(
                    (e) =>
                      BigInt(e.stamp.seq) > after &&
                      BigInt(e.stamp.seq) <= half,
                  ),
                  head: half,
                }),
              );
            return yield* inner.commit(commit);
          }),
      });
      yield* catchUpReadModel(racing, readAfter);
      expect(yield* inner.checkpoint).toStrictEqual(
        Option.some({ position: head, version: READ_MODEL_VERSION }),
      );
      const listed = (yield* inner.all).map((row) => ({
        inboxId: row.inboxId,
        state: row.state,
        lastActivity: row.lastNews ?? row.lastEvent,
      }));
      expect(listed).toStrictEqual(fullScan(events));
    }).pipe(Effect.provide(InboxReadModelInMemory)),
  );
});

// --- counts -------------------------------------------------------------------------------

describe('counts over the Question rows', () => {
  // The test clock starts at the epoch and each append is a minute on.
  const since = '1970-01-01T00:10:00.000Z';

  it.effect('SQLite and memory agree, and both match the rows', () =>
    Effect.gen(function* () {
      // Each run from the epoch, so both stamp the same times.
      const counted = Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* appendAll(cliLog);
        const log = yield* InboxLog;
        return {
          counts: yield* log.countQuestions(since),
          rows: (yield* log.listAll()).flatMap((i) =>
            questionRowsOf({
              inboxId: i.inboxId,
              firstSeq: 0,
              state: i.state,
              lastEvent: i.lastActivity,
            }),
          ),
        };
      });
      const onDisk = yield* onSqlite(counted);
      const inMemory = yield* counted.pipe(Effect.provide(InboxLogInMemory));
      expect(onDisk.rows).toStrictEqual(inMemory.rows);
      expect(onDisk.counts).toStrictEqual(inMemory.counts);
      expect(onDisk.counts).toStrictEqual(countQuestions(onDisk.rows, since));
      expect(
        onDisk.counts.askedSince + onDisk.counts.awaitingAgent,
      ).toBeGreaterThan(0);
    }),
  );
});

// --- the fold version ------------------------------------------------------------------

describe('the fold version moves with the fold', () => {
  // The rows a store already holds were folded by the code that wrote them,
  // and are kept while the stored fold version is `READ_MODEL_VERSION`. So a
  // change to core's fold that leaves the version alone leaves every store
  // serving rows the new fold would not write. This pins the fold's source
  // text beside the version: when it fails, bump `READ_MODEL_VERSION` and
  // pin the new hash with it.
  const PINNED: Readonly<Record<number, string>> = {
    1: '40d2d5c792a48ecd1672fb28de5e52b9c6bb15a8cac2c2bb00b0bb3d71a2bf63',
    // Drawings held as `{ stored, revision }`, a scene's text or its blob's ref.
    2: 'b22234eaf8d64f12239e5ce74142ac136f71248cde4d0a2d87cc7a51f47fb411',
    // A Question holds the files the operator attached (`attachments`).
    3: '3ccd0976c8c48a566854e340a73481c6b2118dc93908289d1cbe4b63cc05ca83',
  };

  it('core fold section is the one this version was pinned with', () => {
    const source = readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'packages',
        'core',
        'src',
        'inbox.ts',
      ),
      { encoding: 'utf8' },
    );
    const from = source.indexOf('// --- the fold');
    const to = source.indexOf('// --- the index of every Inbox');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(
      createHash('sha256').update(source.slice(from, to)).digest('hex'),
    ).toBe(PINNED[READ_MODEL_VERSION]);
  });
});

// --- operator-inbox stats -----------------------------------------------------------------

describe('operator-inbox stats', () => {
  it.effect('counts this month in UTC, from the read model', () =>
    Effect.gen(function* () {
      // 31 October, 23:50 UTC, a minute an append: the first land in October, the rest in November.
      yield* TestClock.setTime(Date.UTC(2026, 9, 31, 23, 50));
      yield* appendAll(cliLog);
      const report = yield* dispatchStats;
      expect(report.since).toBe('2026-11-01T00:00:00.000Z');
      const log = yield* InboxLog;
      expect(report.counts).toStrictEqual(
        yield* log.countQuestions('2026-11-01T00:00:00.000Z'),
      );
      // Some of the log's Questions were asked in October, so fewer count.
      expect(report.counts.askedSince).toBeLessThan(
        (yield* log.countQuestions('1970-01-01T00:00:00.000Z')).askedSince,
      );
      expect(renderStats(report).split('\n')[0]).toMatch(
        /^this month \(since 2026-11-01, UTC\): \d+ asked, \d+ answered, \d+ processed, \d+ withdrawn$/,
      );
    }).pipe(Effect.provide(InboxLogInMemory)),
  );
});
