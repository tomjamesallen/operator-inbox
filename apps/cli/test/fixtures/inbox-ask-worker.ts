import { existsSync, writeFileSync } from 'node:fs';
import { InboxId } from '@operator-inbox/core';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Layer, Result, Schedule } from 'effect';
import { dispatchAsk } from '../../src/commands/inbox';
import { connectInboxLog, InboxLog } from '../../src/inbox-store';

// One writer in `inbox-sqlite.processes.test.ts`: opens the log on one SQLite
// file, says it is ready, waits for the start file so every writer begins at
// once, then asks `count` Questions in one Inbox through the real `ask` path.
// It prints how many asks were acknowledged, and each failure's message, as
// JSON. It gives up after 60 seconds at the start line, so a parent that dies
// before releasing it does not leave it polling.
//
// argv: <file> <inboxId> <count> <readyFile> <goFile> <tag>

const [file, inboxId, count, readyFile, goFile, tag] = process.argv.slice(2);
if (
  file === undefined ||
  inboxId === undefined ||
  count === undefined ||
  readyFile === undefined ||
  goFile === undefined ||
  tag === undefined
)
  throw new Error('inbox-ask-worker: missing arguments');

const id = InboxId.make(inboxId);

const program = Effect.gen(function* () {
  // Force the open now, so the race below is appends, not start-up.
  yield* Effect.flatMap(InboxLog, (log) => log.read(id));
  writeFileSync(readyFile, 'ready');
  yield* Effect.sync(() => existsSync(goFile)).pipe(
    Effect.repeat({
      until: (go) => go,
      schedule: Schedule.spaced('2 millis'),
    }),
    Effect.timeoutOrElse({
      duration: '60 seconds',
      orElse: () => Effect.fail(new Error('no start signal within 60s')),
    }),
  );
  let acked = 0;
  const failed: Array<string> = [];
  for (let i = 0; i < Number(count); i++) {
    const result = yield* Effect.result(
      dispatchAsk({ inboxId: id, title: `${tag}-${i}`, body: '' }),
    );
    if (Result.isSuccess(result)) acked++;
    else failed.push(result.failure.message);
  }
  return { acked, failed };
});

Effect.runPromise(
  program.pipe(
    Effect.provide(
      connectInboxLog({ source: 'env', path: file }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
).then(
  (result) => {
    process.stdout.write(JSON.stringify(result));
  },
  (error: unknown) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  },
);
