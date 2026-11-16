import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { clientLayer, SqliteClient } from '@kairos-es/store-sqlite';
import { type EventStamp, InboxId, SessionId } from '@operator-inbox/core';
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { SqlClient } from 'effect/sql';
import { dispatchOpen, INBOX_CONFLICTED } from '../src/commands/inbox';
import { connectInboxLog, InboxLog } from '../src/inbox-store';

// The inbox log ACROSS PROCESSES on one SQLite file:
// `serve` and every session's CLI write the same log, so an append that one
// process is told succeeded must be in the file whatever the others do. Each
// case races real `tsx` writers (`fixtures/inbox-ask-worker.ts`), held at a
// start line so they begin together, then counts what the file holds against
// what each writer was told. Runs in `pnpm test-processes`, alone and
// serially (`vitest.processes.config.ts`).

const PER_WRITER = 150;
const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
const worker = path.resolve(__dirname, 'fixtures/inbox-ask-worker.ts');

const A = InboxId.make('01INBOXPR0CESSA00000000000');
const B = InboxId.make('01INBOXPR0CESSB00000000000');

const live = (file: string) =>
  connectInboxLog({ source: 'env', path: file }).pipe(
    Layer.provide(NodeServices.layer),
  );

const openInbox = (inboxId: InboxId, label: string) =>
  dispatchOpen({
    session: Option.some({ sessionId: SessionId.make(label), cwd: '/w' }),
    inbox: Option.none(),
    label: Option.some(label),
    freshId: inboxId,
    cwd: '/w',
  });

/** Every `QuestionAsked` in one Inbox, with its place in the whole log. */
const asked = (inboxId: InboxId) =>
  Effect.flatMap(InboxLog, (log) => log.read(inboxId)).pipe(
    Effect.map(({ stamped }) =>
      stamped.flatMap(
        (s): Array<{ title: string; n: number; stamp: EventStamp }> =>
          s.event._tag === 'QuestionAsked'
            ? [{ title: s.event.title, n: s.event.number, stamp: s.stamp }]
            : [],
      ),
    ),
  );

const WorkerResultJson = Schema.fromJsonString(
  Schema.Struct({ acked: Schema.Number, failed: Schema.Array(Schema.String) }),
);

/** Start one writer per (inbox, tag), release them together, collect results. */
const race = (
  base: string,
  file: string,
  writers: ReadonlyArray<{ readonly inboxId: InboxId; readonly tag: string }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const go = path.join(base, 'go');
    const fibers = yield* Effect.forEach(writers, (w) =>
      spawner
        .string(
          ChildProcess.make(
            tsx,
            [
              worker,
              file,
              w.inboxId,
              String(PER_WRITER),
              path.join(base, `ready-${w.tag}`),
              go,
              w.tag,
            ],
            { cwd: path.resolve(__dirname, '..') },
          ),
        )
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WorkerResultJson)),
          Effect.forkChild,
        ),
    );
    // The start line: every writer has opened the file before any appends.
    yield* Effect.forEach(writers, (w) =>
      fs.exists(path.join(base, `ready-${w.tag}`)),
    ).pipe(
      Effect.repeat({
        until: (ready) => ready.every(Boolean),
        schedule: Schedule.spaced('10 millis'),
      }),
      // A writer that dies before it is ready must fail the case, not hang it.
      Effect.timeoutOrElse({
        duration: Duration.seconds(60),
        orElse: () =>
          Effect.fail(new Error('a writer never reached the start line')),
      }),
    );
    yield* fs.writeFileString(go, 'go');
    return yield* Effect.forEach(fibers, (f) => Fiber.join(f));
  });

/**
 * Remove one event row behind the store's back — the control that shows the
 * count below can see a missing append. Through the store's own client, so
 * the file is opened as the store opens it.
 */
const deleteOneAsk = (file: string, inboxId: InboxId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      id: number;
    }>`SELECT id FROM operator_inbox WHERE type = 'QuestionAsked' AND tags LIKE ${`%inbox:${inboxId}%`} ORDER BY id DESC LIMIT 1`;
    if (row === undefined) return yield* Effect.fail(new Error('no ask'));
    yield* sql`DELETE FROM operator_inbox_tags WHERE main_id = ${row.id}`;
    yield* sql`DELETE FROM operator_inbox WHERE id = ${row.id}`;
  }).pipe(
    Effect.provideServiceEffect(SqlClient.SqlClient, SqliteClient),
    Effect.provide(clientLayer({ filename: file })),
  );

describe('the inbox log across processes, on one SQLite file', () => {
  it.live(
    'two PROCESSES asking in their own Inboxes lose no acknowledged ask',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'state', 'inbox.sqlite');
        yield* Effect.all([
          openInbox(A, 'race a'),
          openInbox(B, 'race b'),
        ]).pipe(Effect.provide(live(file)));

        const results = yield* race(base, file, [
          { inboxId: A, tag: 'a' },
          { inboxId: B, tag: 'b' },
        ]);
        // Different Inboxes never conflict, so every ask is acknowledged.
        expect(results).toEqual([
          { acked: PER_WRITER, failed: [] },
          { acked: PER_WRITER, failed: [] },
        ]);

        const [inA, inB] = yield* Effect.all([asked(A), asked(B)]).pipe(
          Effect.provide(live(file)),
        );
        expect(inA.map((q) => q.title)).toEqual(
          Array.from({ length: PER_WRITER }, (_, i) => `a-${i}`),
        );
        expect(inB.map((q) => q.title)).toEqual(
          Array.from({ length: PER_WRITER }, (_, i) => `b-${i}`),
        );

        // The race was real: the two writers' appends interleave in the log,
        // rather than one finishing before the other began.
        const seqs = (qs: typeof inA) => qs.map((q) => q.stamp.seq);
        expect(Math.min(...seqs(inB))).toBeLessThan(Math.max(...seqs(inA)));
        expect(Math.min(...seqs(inA))).toBeLessThan(Math.max(...seqs(inB)));

        // The control: delete one row behind the store's back, and the same
        // count sees it — so the equality above is one this count can break.
        yield* deleteOneAsk(file, A);
        const after = yield* asked(A).pipe(Effect.provide(live(file)));
        expect(after).toHaveLength(PER_WRITER - 1);
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );

  it.live(
    'two PROCESSES asking in ONE Inbox: every acknowledged ask is there, and no number is taken twice',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const file = path.join(base, 'state', 'inbox.sqlite');
        yield* openInbox(A, 'race shared').pipe(Effect.provide(live(file)));

        const results = yield* race(base, file, [
          { inboxId: A, tag: 'a' },
          { inboxId: A, tag: 'b' },
        ]);
        // A writer that loses the append condition twice in a row is refused
        // (`decideAndAppend` retries once) — refused, and told so. Every other
        // failure is the store breaking under contention, and fails the case.
        // What may never happen is an acknowledged ask missing, or two asks
        // with one number.
        const [ra, rb] = results;
        if (ra === undefined || rb === undefined || results.length !== 2)
          return yield* Effect.fail(new Error('expected two writers'));
        for (const r of [ra, rb]) {
          expect(r.acked + r.failed.length).toBe(PER_WRITER);
          expect(r.failed.filter((m) => m !== INBOX_CONFLICTED)).toEqual([]);
        }

        const questions = yield* asked(A).pipe(Effect.provide(live(file)));
        const byTag = (t: string) =>
          questions.filter((q) => q.title.startsWith(`${t}-`)).length;
        expect(byTag('a')).toBe(ra.acked);
        expect(byTag('b')).toBe(rb.acked);
        expect(questions.map((q) => q.n)).toEqual(
          Array.from({ length: questions.length }, (_, i) => i + 1),
        );
        // Both writers got asks in: the shared Inbox really was contended.
        expect(ra.acked).toBeGreaterThan(0);
        expect(rb.acked).toBeGreaterThan(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );
});
