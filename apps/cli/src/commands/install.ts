import { describeInboxDatabase } from '@operator-inbox/core';
import { Console, Effect, Layer } from 'effect';
import { Command } from 'effect/cli';
import { resolveInboxDatabaseEdge } from '../inbox-database';
import { connectInboxLog } from '../inbox-store';

// Set up the inbox's event log, idempotently: make the folder, open the
// SQLite file and ensure its schema, then say which file it is. The default
// is `$XDG_STATE_HOME/operator-inbox/inbox.sqlite`; an override
// (`OPERATOR_INBOX_DATABASE_PATH`, else config.json's `databasePath`) is named
// with where it came from.
//
// It builds the very layer the inbox opens on first use (`connectInboxLog`),
// so it does exactly what first use does, which makes it a way to see that
// happen, or to see the driver's reason it cannot, not a prerequisite.

export const installEffect = Effect.gen(function* () {
  const resolved = yield* resolveInboxDatabaseEdge;
  yield* Effect.scoped(Layer.build(connectInboxLog(resolved)));
  yield* Console.log(
    `inbox: its event log is ${describeInboxDatabase(resolved)}, and its schema is in place`,
  );
});

export const installCommand = Command.make(
  'install',
  {},
  () => installEffect,
).pipe(
  Command.withDescription(
    "Make the inbox's SQLite event log (its folder, the file and its schema) and say where it is",
  ),
);
