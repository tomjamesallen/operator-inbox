import type { Position } from '@kairos-es/core';
import {
  decideGuard,
  decideModeOff,
  decideModeOn,
  decidePreTool,
  decidePrompt,
  GUARD_BLOCK_REASON,
  type InboxModeOffReason,
  inboxState,
  isPreToolName,
  MODE_OFF_CONTEXT,
  modeOff,
  PreToolHookInput,
  PromptHookInput,
  pausedFor,
  renderPreToolDeny,
  renderPromptContext,
  type SessionId,
  StopHookInput,
  sessionInboxMode,
} from '@operator-inbox/core';
import { Effect, Option, Schema } from 'effect';
import { InputError } from './errors';
import { inboxDatabaseExists } from './inbox-database';
import {
  readScratch,
  removeScratch,
  updateScratch,
  writeScratch,
} from './inbox-sessions';
import { decideSessionAndAppend, InboxLog } from './inbox-store';
import { watcherGuard } from './inbox-watch';
import { QuestionClassifier } from './question-classifier';

// Inbox mode's three hooks and its switch, the edge. The
// decisions are core's (`inbox-mode.ts`); this reads the hook's stdin, the
// session's tag in the log and its sidecar, runs the classifier, and writes
// back. These run on every prompt, every Stop and every AskUserQuestion or
// wrap_up in every session once installed. The mode is the log's, so
// each one reads it there: on a machine or path where the inbox's file does
// not exist yet, that is an existence check and nothing more (the file is
// never created by a hook); otherwise it opens the log and reads the
// session's tag once, and reads nothing else while the mode is off (the Stop
// hook goes on to the watcher check only when the session has an Inbox).
// Every failure is the caller's to swallow: a hook prints nothing and exits 0.

const decodeJson = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

/**
 * The session's mode, folded from one read of its tag, and the log's head at
 * that read. Off, with no read, while the inbox's file does not exist: a
 * session that never used the inbox must not create it.
 */
const modeOf = Effect.fnUntraced(function* (sessionId: SessionId) {
  if (!(yield* inboxDatabaseExists))
    return { mode: modeOff, head: undefined } as const;
  const log = yield* InboxLog;
  const read = yield* log.readSession(sessionId);
  return {
    mode: sessionInboxMode(sessionId, read.stamped),
    head: read.head,
  } as const;
});

/** Record the log head a passing Stop saw; a hook ignores a failed write. */
const recordSeen = (sessionId: SessionId, head: Position) =>
  updateScratch(sessionId, (scratch) => ({
    ...scratch,
    lastSeenSeq: Number(head),
  })).pipe(Effect.ignore);

// --- Stop ------------------------------------------------------------------------------

/**
 * `operator-inbox guard`, the Stop hook. The session comes from stdin's
 * `session_id`, and from `fallbackSession` (the process-tree walk) only
 * when stdin has none. A stop already continuing because of a stop hook is let
 * through. With the mode off this is the plain watcher guard. With
 * it on, a last message that asks the operator something blocks once, unless
 * the operator typed this turn's prompt (the pause) or a question went to the
 * Inbox this turn. Every outcome that lets the turn end records the log head
 * in the sidecar while the mode is on.
 */
export const dispatchStopGuard = Effect.fnUntraced(function* <E, R>(opts: {
  readonly stdin: string;
  readonly fallbackSession: Effect.Effect<Option.Option<SessionId>, E, R>;
}) {
  // Every key is lenient, so only stdin that is not a JSON object reads as
  // empty: a `null` in one key never costs the others (`stop_hook_active`).
  const input = yield* decodeJson(StopHookInput)(opts.stdin).pipe(
    Effect.orElseSucceed((): StopHookInput => ({})),
  );
  const sessionId =
    input.session_id !== undefined
      ? Option.some(input.session_id)
      : yield* opts.fallbackSession;
  if (Option.isNone(sessionId)) return '';
  const session = sessionId.value;
  const { mode, head } = yield* modeOf(session);

  if (input.stop_hook_active === true) {
    if (mode.on && head !== undefined) yield* recordSeen(session, head);
    return '';
  }
  if (mode.inboxId === undefined) return '';
  const log = yield* InboxLog;
  const inbox = yield* log.read(mode.inboxId);
  const state = inboxState(inbox.events);
  if (!mode.on) return yield* watcherGuard(mode.inboxId, state);

  const step = decideGuard({
    ...(input.prompt_id === undefined ? {} : { promptId: input.prompt_id }),
    mode,
    scratch: yield* readScratch(session),
    inbox: inbox.stamped,
    message: input.last_assistant_message ?? '',
  });
  if (step.kind === 'classify') {
    const classifier = yield* QuestionClassifier;
    // Any failure is a `no`: the turn ends.
    const asks = yield* classifier
      .asksOperator(step.text)
      .pipe(Effect.orElseSucceed(() => false));
    if (asks)
      return JSON.stringify({ decision: 'block', reason: GUARD_BLOCK_REASON });
  }
  const watched = yield* watcherGuard(mode.inboxId, state);
  if (watched === '') yield* recordSeen(session, inbox.head);
  return watched;
});

// --- UserPromptSubmit -------------------------------------------------------------------

/** Turn the session's mode off, by the command or an off phrase. */
const turnOff = (sessionId: SessionId, reason: InboxModeOffReason) =>
  decideSessionAndAppend(sessionId, (mode) => ({
    events: decideModeOff({ mode, sessionId, reason }),
    result: mode.inboxId,
  }));

/**
 * `operator-inbox hook prompt`, the UserPromptSubmit hook. With the mode
 * on: an off phrase turns it off and says so in one line of context; anything
 * else the operator typed pauses the mode for that prompt; the watcher's line
 * and a Monitor wake-up change nothing. Otherwise it prints nothing.
 */
export const dispatchPromptHook = Effect.fnUntraced(function* (stdin: string) {
  const input = yield* decodeJson(PromptHookInput)(stdin);
  const session = input.session_id;
  const { mode } = yield* modeOf(session);
  const decision = decidePrompt({
    modeOn: mode.on,
    prompt: input.prompt ?? '',
    ...(input.prompt_id === undefined ? {} : { promptId: input.prompt_id }),
  });
  switch (decision.kind) {
    case 'nothing':
      return '';
    case 'pause':
      yield* updateScratch(session, (scratch) => ({
        ...scratch,
        pausedPromptId: decision.promptId,
      })).pipe(Effect.ignore);
      return '';
    case 'off':
      yield* turnOff(session, 'phrase');
      yield* removeScratch(session).pipe(Effect.ignore);
      return renderPromptContext(MODE_OFF_CONTEXT);
  }
});

// --- PreToolUse -----------------------------------------------------------------------

/**
 * `operator-inbox hook pre-tool`, the PreToolUse hook: while the mode is
 * on and not paused, AskUserQuestion is denied, and wrap_up is denied when it
 * carries an `ask`. Otherwise it prints nothing, which leaves the normal
 * permission flow in place.
 */
export const dispatchPreToolHook = Effect.fnUntraced(function* (stdin: string) {
  const input = yield* decodeJson(PreToolHookInput)(stdin);
  const toolName = input.tool_name;
  if (!isPreToolName(toolName)) return '';
  const { mode } = yield* modeOf(input.session_id);
  if (!mode.on) return '';
  const decision = decidePreTool({
    paused: pausedFor(yield* readScratch(input.session_id), input.prompt_id),
    toolName,
    toolInput: input.tool_input,
  });
  return decision.deny ? renderPreToolDeny(decision.reason) : '';
});

// --- the switch -------------------------------------------------------------------------

const NOT_IN_SESSION =
  'inbox mode: not inside a Claude session, so there is no session to switch';
const NO_INBOX =
  'inbox mode: this session has no inbox yet — run `operator-inbox open --label "<what this session is doing>"` first';

/**
 * `operator-inbox mode on|off`, run by the agent for the inbox skill. Both
 * are idempotent, and both read the session's tag once, in
 * the cycle that decides. `on` writes the sidecar fresh; `off` removes it. A
 * sidecar that cannot be written or removed fails the command.
 */
export const dispatchMode = Effect.fnUntraced(function* (opts: {
  readonly session: Option.Option<SessionId>;
  readonly state: 'on' | 'off';
}) {
  if (Option.isNone(opts.session))
    return yield* new InputError({ message: NOT_IN_SESSION });
  const sessionId = opts.session.value;
  const decided = yield* decideSessionAndAppend(sessionId, (mode) => {
    const inboxId = mode.inboxId;
    if (inboxId === undefined) return { events: [], result: undefined };
    return {
      events:
        opts.state === 'on'
          ? decideModeOn({ mode, sessionId, inboxId })
          : decideModeOff({ mode, sessionId, reason: 'command' }),
      result: inboxId,
    };
  });
  const inboxId = decided.result;
  if (inboxId === undefined)
    return yield* new InputError({ message: NO_INBOX });
  const changed = decided.events.length > 0;
  if (opts.state === 'off') {
    yield* removeScratch(sessionId);
    return changed
      ? `inbox mode off for this session (inbox ${inboxId}); questions may be asked inline again`
      : `inbox mode was already off for this session (inbox ${inboxId})`;
  }
  // Already on: the sidecar is left as it is.
  if (changed) yield* writeScratch(sessionId, {});
  return changed
    ? `inbox mode on for this session (inbox ${inboxId}): every question for the operator goes to the inbox with \`operator-inbox ask\``
    : `inbox mode was already on for this session (inbox ${inboxId})`;
});
