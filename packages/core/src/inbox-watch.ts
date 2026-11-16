import { Schema } from 'effect';
import { awaitingAgent, awaitingOperator, type InboxState } from './inbox';
import { InboxId } from './schema/identifiers';

// The inbox watcher and its guard, the pure half. The watcher
// (`operator-inbox watch`) polls one Inbox and prints a line when the
// operator answers, so a session armed with it through the harness's Monitor is
// woken; the guard (`operator-inbox guard`, run by the Stop hook) stops a turn
// ending while answers wait, or while no watcher is running. The burst and owner
// rules are `watcher.ts`'s.

/**
 * The questions in the operator's answered column, by number. A question
 * enters that column once (an answer cannot be taken back), so its number is
 * enough to tell a new answer from one already seen. A question moved in with
 * its answer counts as new here, which is right: it is new to this Inbox.
 */
export const answeredNumbers = (state: InboxState): ReadonlySet<number> =>
  new Set(awaitingAgent(state).map((q) => q.number));

/** The answers in `now` that `seen` has not had, and `seen` grown by them. */
export const newAnswers = (
  seen: ReadonlySet<number>,
  now: ReadonlySet<number>,
): { readonly fresh: number; readonly seen: ReadonlySet<number> } => {
  let fresh = 0;
  for (const n of now) if (!seen.has(n)) fresh += 1;
  return fresh === 0
    ? { fresh, seen }
    : { fresh, seen: new Set([...seen, ...now]) };
};

/**
 * THE ONLY thing the watcher writes to stdout: one line per burst, which the
 * harness's Monitor turns into a wake-up. An agent reads it cold, so it says
 * what to run.
 */
export const renderAnswerSignal = (count: number, label: string): string =>
  `inbox: ${count} new answer${count === 1 ? '' : 's'} in "${label}" — run \`operator-inbox answers\``;

/** One running watcher, as it records itself for the guard to find. */
export const InboxWatcherRecord = Schema.Struct({
  inboxId: InboxId,
  pid: Schema.Int,
  // `ps -o comm=,lstart=` at start, so a recycled pid is not taken for it.
  fingerprint: Schema.String,
});
export type InboxWatcherRecord = typeof InboxWatcherRecord.Type;

/** The arming command, as the guard and `ask` print it. */
export const WATCH_COMMAND = 'operator-inbox watch --owner-pid "$CLAUDE_PID"';

export type WatchGuardInput = {
  // The Stop hook is already continuing because of a stop hook: never block
  // twice in a row, or the session could not stop at all.
  readonly stopHookActive: boolean;
  // This session's Inbox, or none.
  readonly inbox:
    | {
        readonly label: string;
        readonly state: InboxState;
        readonly watcherAlive: boolean;
      }
    | undefined;
};

/**
 * Should the turn end? Not while this session's active Inbox has no watcher
 * running: an answer would then land with nothing to wake the session, and an
 * agent often forgets to watch for one. That holds when nothing waits too,
 * because the operator can put a Question to the agent from the app at any
 * time, and a watcher paused on an empty Inbox would miss it. Nor while
 * answers wait, watcher or not: a watcher counts every answer there when it
 * starts as seen, so an answer that landed before it was armed never wakes the
 * session. The reason is what the agent reads, so it says exactly what to do.
 */
export const decideWatchGuard = (
  input: WatchGuardInput,
):
  | { readonly block: false }
  | { readonly block: true; readonly reason: string } => {
  const inbox = input.inbox;
  if (input.stopHookActive || inbox === undefined) return { block: false };
  if (inbox.state.archived) return { block: false };
  const asked = awaitingOperator(inbox.state).length;
  const answered = awaitingAgent(inbox.state).length;
  const them = answered === 1 ? 'it' : 'them';
  if (inbox.watcherAlive) {
    if (answered === 0) return { block: false };
    return {
      block: true,
      reason: `Inbox "${inbox.label}": ${answered} answer${answered === 1 ? ' is' : 's are'} already waiting, and the running watcher will not report ${them}: run \`operator-inbox answers\`, act on ${them}, then mark ${them} with \`operator-inbox done\`.`,
    };
  }
  const parts: Array<string> = [];
  if (answered > 0)
    parts.push(
      `${answered} answer${answered === 1 ? ' is' : 's are'} already waiting: run \`operator-inbox answers\` and act on ${answered === 1 ? 'it' : 'them'}.`,
    );
  if (asked > 0)
    parts.push(
      `${asked} question${asked === 1 ? ' waits' : 's wait'} for the operator, and no watcher is running, so an answer would not wake this session.`,
    );
  if (asked === 0 && answered === 0)
    parts.push(
      'Nothing waits, but no watcher is running, so a question the operator asks from the app would not wake this session.',
    );
  parts.push(
    `Arm the watcher with the Monitor tool (persistent if it is offered): \`${WATCH_COMMAND}\`. If the inbox's work is finished, archive it instead: \`operator-inbox archive\`.`,
  );
  return {
    block: true,
    reason: `Inbox "${inbox.label}": ${parts.join(' ')}`,
  };
};
