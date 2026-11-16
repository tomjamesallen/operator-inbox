import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/cli';
import { describeImport, importLog } from '../import-log';
import { resolveInboxDatabaseEdge } from '../inbox-database';

// Copy another kairos-es inbox log into this app's store, which must not exist
// yet. `import-log.ts` holds the copy and its checks.

export const importLogCommand = Command.make(
  'import-log',
  {
    from: Flag.String('from').pipe(
      Flag.withDescription('The absolute path of the SQLite file to copy from'),
    ),
    fromPrefix: Flag.String('from-prefix').pipe(
      Flag.withDescription("The source log's table prefix"),
    ),
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('Read and check the source, and write nothing'),
      Flag.withDefault(false),
    ),
  },
  ({ from, fromPrefix, dryRun }) =>
    Effect.gen(function* () {
      const target = yield* resolveInboxDatabaseEdge;
      const options = { from, fromPrefix, dryRun, target };
      const summary = yield* importLog(options);
      yield* Console.log(describeImport(options, summary));
    }),
).pipe(
  Command.withDescription(
    "Copy another kairos-es inbox log, under its own table prefix, into this app's store, which must not exist yet; verified before it is moved into place. A source with no -wal beside it is read without locks, so nothing may write it while the import runs",
  ),
);
