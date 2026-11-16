import { Console, DateTime, Effect } from 'effect';
import { Command, Flag } from 'effect/cli';
import type { QuestionCounts } from '../inbox-read-model';
import { InboxLog } from '../inbox-store';

// `operator-inbox stats`: counts over every Question on this machine, from the
// list's read model (`inbox-read-model.ts`), so they are one SQL query over
// its rows. "This month" is the calendar month in UTC.

export interface StatsReport {
  readonly since: string;
  readonly counts: QuestionCounts;
}

/** The start of the current month, in UTC, as ISO. */
const startOfMonth = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(DateTime.startOf(now, 'month')),
);

export const dispatchStats = Effect.gen(function* () {
  const since = yield* startOfMonth;
  const log = yield* InboxLog;
  return { since, counts: yield* log.countQuestions(since) };
});

export const renderStats = ({ since, counts }: StatsReport): string =>
  [
    `this month (since ${since.slice(0, 10)}, UTC): ${counts.askedSince} asked, ${counts.answeredSince} answered, ${counts.processedSince} processed, ${counts.withdrawnSince} withdrawn`,
    `open now: ${counts.awaitingOperator} awaiting you, ${counts.awaitingAgent} with the agent`,
  ].join('\n');

export const statsCommand = Command.make(
  'stats',
  {
    json: Flag.Boolean('json').pipe(
      Flag.withDescription('Print the counts as JSON'),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Effect.flatMap(dispatchStats, (report) =>
      Console.log(json ? JSON.stringify(report, null, 2) : renderStats(report)),
    ),
).pipe(
  Command.withDescription(
    'Count the Questions on this machine: asked, answered, processed and withdrawn this month (UTC), and open now. A Question moved to another inbox counts once, where it is now',
  ),
);
