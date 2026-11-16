import { Effect, Schema } from 'effect';
import type { EventStamp, InboxEvent, InboxModeOffReason } from './inbox';
import { WATCH_COMMAND } from './inbox-watch';
import { type InboxId, PromptId, SessionId } from './schema/identifiers';

// Inbox mode, the pure half. While the mode
// is on for a session, three Claude Code hooks route every question for the
// operator to that session's Inbox:
//
// - `operator-inbox guard` (Stop) blocks a turn whose last message asks the
//   operator something in chat (`decideGuard`);
// - `operator-inbox hook pre-tool` (PreToolUse) refuses AskUserQuestion and a
//   next-step box with an `ask` in it (`decidePreTool`);
// - `operator-inbox hook prompt` (UserPromptSubmit) turns the mode off on an
//   off phrase, and otherwise pauses it for the one prompt the operator typed
//   (`decidePrompt`).
//
// On and off are events on the inbox log (`InboxModeOn` / `InboxModeOff`),
// folded per session here. The pause and the last log head a passing Stop saw
// are turn-scratch in a sidecar file the edge reads and writes
// (`InboxSessionScratch`): current-state. The edge
// hands everything in; nothing here reads a clock, a file or the environment.

// --- the mode, folded per session ----------------------------------------------------

/**
 * One session's Inbox mode, folded from the events its session tag holds.
 * `inboxId` is the Inbox this session opened or adopted most recently: where
 * its questions go, and the one `operator-inbox ask` writes to. While the mode
 * is on there always is one, and `onSeq` is the seq of the `InboxModeOn` that
 * turned it on: the Stop guard's baseline before any passing Stop has
 * recorded a log head.
 */
export type SessionInboxMode =
  | { readonly on: false; readonly inboxId?: InboxId }
  | { readonly on: true; readonly onSeq: number; readonly inboxId: InboxId };

export const modeOff: SessionInboxMode = { on: false };

/**
 * Fold one session's mode from its events, oldest first. The events may be
 * mixed (anything the session tag holds, or more): only this session's opens,
 * adoptions and mode events count. The one fold for both questions the
 * session tag answers: which Inbox is the session's (`findBySession`), and is
 * the mode on.
 */
export const sessionInboxMode = (
  sessionId: SessionId,
  events: ReadonlyArray<{
    readonly event: InboxEvent;
    readonly stamp: EventStamp;
  }>,
): SessionInboxMode => {
  let inboxId: InboxId | undefined;
  // The `InboxModeOn` in force, while the mode is on.
  let on: { readonly onSeq: number; readonly inboxId: InboxId } | undefined;
  for (const { event, stamp } of events) {
    switch (event._tag) {
      case 'InboxOpened':
      case 'InboxAdopted':
        if (event.sessionId === sessionId) inboxId = event.inboxId;
        break;
      case 'InboxModeOn':
        if (event.sessionId === sessionId)
          on = { onSeq: stamp.seq, inboxId: event.inboxId };
        break;
      case 'InboxModeOff':
        if (event.sessionId === sessionId) on = undefined;
        break;
      default:
        break;
    }
  }
  // `inbox mode on` needs an opened or adopted Inbox, so the mode event's
  // own Inbox stands in only for a log that holds the mode without one.
  if (on !== undefined)
    return { on: true, onSeq: on.onSeq, inboxId: inboxId ?? on.inboxId };
  return inboxId === undefined ? modeOff : { on: false, inboxId };
};

/** `operator-inbox mode on`: idempotent, so on when on appends nothing. */
export const decideModeOn = (input: {
  readonly mode: SessionInboxMode;
  readonly sessionId: SessionId;
  readonly inboxId: InboxId;
}): ReadonlyArray<InboxEvent> =>
  input.mode.on
    ? []
    : [
        {
          _tag: 'InboxModeOn',
          inboxId: input.inboxId,
          sessionId: input.sessionId,
        },
      ];

/**
 * Off, by the command or an off phrase, recorded in the session's Inbox: off
 * when off appends nothing.
 */
export const decideModeOff = (input: {
  readonly mode: SessionInboxMode;
  readonly sessionId: SessionId;
  readonly reason: InboxModeOffReason;
}): ReadonlyArray<InboxEvent> =>
  input.mode.on
    ? [
        {
          _tag: 'InboxModeOff',
          inboxId: input.mode.inboxId,
          sessionId: input.sessionId,
          reason: input.reason,
        },
      ]
    : [];

// --- the sidecar ------------------------------------------------------------------------

/**
 * One session's turn-scratch, `inbox-sessions/<sessionId>.json` beside the
 * watcher records. `pausedPromptId` is the prompt the operator last typed: the
 * reply to it may ask inline. `lastSeenSeq` is the log head the last passing
 * Stop saw: a question asked above it was asked this turn.
 */
export const InboxSessionScratch = Schema.Struct({
  pausedPromptId: Schema.optionalKey(PromptId),
  lastSeenSeq: Schema.optionalKey(Schema.Int),
});
export type InboxSessionScratch = typeof InboxSessionScratch.Type;

export const emptyScratch: InboxSessionScratch = {};

/**
 * The sidecar's file name for a session, or none when the id could not be a
 * file name: the id arrives on a hook's stdin, so it is never trusted to
 * name a path (no `/`, no `..`).
 */
export const scratchFileName = (sessionId: SessionId): string | undefined =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)
    ? `${sessionId}.json`
    : undefined;

// --- the hooks' stdin -----------------------------------------------------------------

// Each payload as Claude Code writes it to a hook's stdin, decoded leniently:
// unknown keys are dropped (Schema's default), and only what a decision reads
// is named. A key the harness leaves out is optional here wherever the
// decision can go on without it, and each such key is read on its own
// (`lenientKey`): one that arrives `null` or of the wrong type reads as
// absent, so it never fails the decode and takes the other keys with it. A
// required key is one the hook cannot decide without: missing, `null` or
// wrongly typed, it fails the decode and the hook prints nothing.

/**
 * An optional payload key read on its own: a value its schema refuses (`null`
 * included) reads as the key being absent.
 */
const lenientKey = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  );

/** The Stop hook's input. `session_id` absent: the guard walks the process tree. */
export const StopHookInput = Schema.Struct({
  session_id: lenientKey(SessionId),
  prompt_id: lenientKey(PromptId),
  stop_hook_active: lenientKey(Schema.Boolean),
  last_assistant_message: lenientKey(Schema.String),
  transcript_path: lenientKey(Schema.String),
});
export type StopHookInput = typeof StopHookInput.Type;

/** The UserPromptSubmit hook's input. */
export const PromptHookInput = Schema.Struct({
  session_id: SessionId,
  prompt_id: lenientKey(PromptId),
  prompt: lenientKey(Schema.String),
});
export type PromptHookInput = typeof PromptHookInput.Type;

/**
 * The PreToolUse hook's input. `tool_input` is the tool's own, unchecked, so
 * a `null` one is kept: `decidePreTool` reads it as asking nothing.
 */
export const PreToolHookInput = Schema.Struct({
  session_id: SessionId,
  prompt_id: lenientKey(PromptId),
  tool_name: Schema.String,
  tool_input: Schema.optionalKey(Schema.Unknown),
});
export type PreToolHookInput = typeof PreToolHookInput.Type;

/** Is the mode paused for this prompt? Only the prompt the operator typed. */
export const pausedFor = (
  scratch: InboxSessionScratch,
  promptId: PromptId | undefined,
): boolean => promptId !== undefined && scratch.pausedPromptId === promptId;

// --- "?" outside code -------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi;

/**
 * The text with its fenced code blocks, inline code spans and URLs taken out,
 * so a `?` in a shell glob, a regex or a query string does not read as a
 * question. An unclosed fence runs to the end; an unmatched backtick run is
 * kept as text.
 */
export const proseOutsideCode = (text: string): string => {
  const kept: Array<string> = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  for (const line of text.split('\n')) {
    const opening = FENCE.exec(line);
    if (fence !== undefined) {
      const close = opening?.[1];
      if (
        close !== undefined &&
        close[0] === fence.char &&
        close.length >= fence.length &&
        line.trim() === close
      )
        fence = undefined;
      continue;
    }
    const marker = opening?.[1];
    if (marker !== undefined) {
      fence = { char: marker[0] ?? '`', length: marker.length };
      continue;
    }
    kept.push(line);
  }
  return withoutInlineCode(kept.join('\n')).replace(URL, ' ');
};

/** Inline code spans out: a run of n backticks up to the next run of exactly n. */
const withoutInlineCode = (text: string): string => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === '`') run += 1;
    const close = closingRun(text, i + run, run);
    if (close === undefined) {
      out += text.slice(i, i + run);
      i += run;
    } else {
      out += ' ';
      i = close + run;
    }
  }
  return out;
};

const closingRun = (
  text: string,
  from: number,
  length: number,
): number | undefined => {
  let i = from;
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === '`') run += 1;
    if (run === length) return i;
    i += run;
  }
  return undefined;
};

/**
 * Does the Stop guard ask the classifier about this message? Yes when a
 * `?` stands in its prose, and yes when it has no `?` at all ("Let me know
 * which you prefer."). No when every `?` sits in code or a URL, and no for an
 * empty message, which asks nothing.
 */
export const needsClassification = (text: string): boolean => {
  if (text.trim().length === 0) return false;
  if (!text.includes('?')) return true;
  return proseOutsideCode(text).includes('?');
};

// --- the Stop guard ------------------------------------------------------------------

export interface GuardInput {
  readonly promptId?: PromptId;
  readonly mode: SessionInboxMode;
  readonly scratch: InboxSessionScratch;
  // The session's Inbox's events with their stamps, oldest first: where this
  // turn's `inbox ask` would show.
  readonly inbox: ReadonlyArray<{
    readonly event: InboxEvent;
    readonly stamp: EventStamp;
  }>;
  readonly message: string;
}

/**
 * What the Stop guard does next, at the first rule that applies after
 * `stop_hook_active`, which the edge answers before it reads anything (the
 * hook is already continuing because of a stop hook, so never twice in a
 * row):
 * - `watcher`: only the existing watcher check (`decideWatchGuard`);
 * - `classify`: ask the classifier whether `text` asks the operator something;
 *   `yes` blocks with `GUARD_BLOCK_REASON`, anything else (an error too) goes
 *   on to the watcher check.
 * While the mode is on, the edge records the log head as `lastSeenSeq` on
 * every outcome that lets the turn end.
 */
export type GuardStep =
  | { readonly kind: 'watcher' }
  | { readonly kind: 'classify'; readonly text: string };

/**
 * The seq a question must be above to count as asked this turn: the head the
 * last passing Stop recorded, or the `InboxModeOn` when none has, whichever is
 * later (a head recorded before the mode was last turned on says nothing
 * about this stretch of it).
 */
export const guardBaseline = (
  mode: Extract<SessionInboxMode, { readonly on: true }>,
  scratch: InboxSessionScratch,
): number => Math.max(scratch.lastSeenSeq ?? mode.onSeq, mode.onSeq);

/**
 * Did the agent ask the operator a question in this Inbox above `baseline`?
 * A question the operator put to the agent from the app does not count.
 */
export const askedSince = (
  inbox: GuardInput['inbox'],
  baseline: number,
): boolean =>
  inbox.some(
    ({ event, stamp }) =>
      event._tag === 'QuestionAsked' &&
      event.operatorQuestion !== true &&
      stamp.seq > baseline,
  );

export const decideGuard = (input: GuardInput): GuardStep => {
  if (!input.mode.on) return { kind: 'watcher' };
  if (pausedFor(input.scratch, input.promptId)) return { kind: 'watcher' };
  // A question went to the Inbox this turn: nothing to route, though the
  // watcher check still applies (it is unchanged by the mode).
  if (askedSince(input.inbox, guardBaseline(input.mode, input.scratch)))
    return { kind: 'watcher' };
  if (needsClassification(input.message))
    return { kind: 'classify', text: input.message };
  return { kind: 'watcher' };
};

/**
 * What the agent reads when the guard blocks: what to do, either way. The
 * stop after a block carries `stop_hook_active` and is let through without
 * the watcher check (never block twice), so the reason asks for the
 * watcher itself.
 */
export const GUARD_BLOCK_REASON = `Inbox mode is on for this session, and your last message looks like it asks the operator something. Questions for the operator go to the Inbox, not the chat: post each one with \`operator-inbox ask --title "<the decision>" --body-file <file with the context they need>\`, and, unless a watcher is already running, arm one with the Monitor tool (\`${WATCH_COMMAND}\`), since your next stop is not checked. Then end the turn. If the message holds no question for the operator, simply end the turn again.`;

// --- the prompt hook --------------------------------------------------------------------

/** The off phrases, in the normalised form `normalisePrompt` gives. */
export const OFF_PHRASES: ReadonlyArray<string> = [
  'inbox off',
  'stop using the inbox',
  'ask me here',
];

/**
 * A prompt in the form the off phrases are matched against: lower case, runs
 * of whitespace as one space, and the punctuation around it stripped.
 */
export const normalisePrompt = (prompt: string): string =>
  prompt
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Is the WHOLE prompt an off phrase? A phrase inside a longer prompt ("don't
 * ask me here, use the inbox") is not one.
 */
export const isOffPhrase = (prompt: string): boolean =>
  OFF_PHRASES.includes(normalisePrompt(prompt));

// `renderAnswerSignal`'s line, as a pattern: what the watcher prints.
const ANSWER_SIGNAL =
  /^inbox: \d+ new answers? in ".*" — run `operator-inbox answers`$/s;

/** Is the prompt exactly the watcher's line (`renderAnswerSignal`)? */
export const isAnswerSignal = (prompt: string): boolean =>
  ANSWER_SIGNAL.test(prompt.trim());

// An XML-style opening tag: `<`, a lower-case name (a letter, then letters,
// digits and hyphens), then whitespace, `>` or `/`. `< 5 items` and `<3` are
// not one.
const HARNESS_TAG = /^<[a-z][a-z0-9-]*[\s>/]/;

/**
 * A prompt the harness wrote rather than the operator: the watcher's own line,
 * or one whose first non-whitespace text is an XML-style tag. The harness
 * delivers a Monitor wake-up as `<task-notification>`, and was measured in real transcripts delivering prompts that open with
 * `<cross-session-message`, `<agent-message`, `<ci-monitor-event>`,
 * `<scheduled-task` and `<system-reminder>` (one of those after it). The rule
 * is strict on purpose: an operator who opens a prompt with such a tag does
 * not get the pause, and the reply is held to the inbox, which is the safe
 * way to be wrong.
 */
export const isHarnessPrompt = (prompt: string): boolean =>
  isAnswerSignal(prompt) || HARNESS_TAG.test(prompt.trimStart());

export type PromptDecision =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'off' }
  | { readonly kind: 'pause'; readonly promptId: PromptId };

/**
 * `operator-inbox hook prompt`. An off phrase is honoured only in a
 * prompt the operator typed, so a harness prompt is answered first (`<inbox
 * off>` opens with a tag); the phrase needs no `prompt_id`, while the pause,
 * which is keyed on it, does.
 */
export const decidePrompt = (input: {
  readonly modeOn: boolean;
  readonly prompt: string;
  readonly promptId?: PromptId;
}): PromptDecision => {
  if (!input.modeOn) return { kind: 'nothing' };
  if (isHarnessPrompt(input.prompt)) return { kind: 'nothing' };
  if (isOffPhrase(input.prompt)) return { kind: 'off' };
  if (input.promptId === undefined) return { kind: 'nothing' };
  return { kind: 'pause', promptId: input.promptId };
};

/** The one line the prompt hook adds when an off phrase turned the mode off. */
export const MODE_OFF_CONTEXT =
  'Inbox mode is now off for this session: ask the operator inline again. Offer to archive its Inbox (`operator-inbox archive`), and do not archive it unless they say so.';

// --- the pre-tool hook ------------------------------------------------------------------

export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up';

/**
 * The tools the pre-tool hook judges: its matcher in settings.json
 * (`claude-settings.ts`) and the edge's first filter are both built from
 * this, so a call to any other tool never reaches `decidePreTool`.
 */
export const PRE_TOOL_NAMES = [ASK_USER_QUESTION_TOOL, WRAP_UP_TOOL] as const;
export type PreToolName = (typeof PRE_TOOL_NAMES)[number];

export const isPreToolName = (toolName: string): toolName is PreToolName =>
  PRE_TOOL_NAMES.some((name) => name === toolName);

export type PreToolDecision =
  | { readonly deny: false }
  | { readonly deny: true; readonly reason: string };

const ASK_DENIED =
  'Inbox mode is on for this session, so questions for the operator go to its Inbox, not AskUserQuestion. Post each one with `operator-inbox ask --title "<the decision>" --body-file <file with the context they need>`, then carry on, or end the turn.';

const WRAP_UP_DENIED =
  'Inbox mode is on for this session, so a question for the operator goes to its Inbox, not the next-step box. Post it with `operator-inbox ask --title "<the decision>" --body-file <file with the context they need>`, then call wrap_up again with the recap alone, without `ask` or `actions`.';

/** Does the next-step box carry a question? Only a non-blank `ask` string. */
const wrapUpAsks = (toolInput: unknown): boolean => {
  if (typeof toolInput !== 'object' || toolInput === null) return false;
  const ask: unknown = Reflect.get(toolInput, 'ask');
  return typeof ask === 'string' && ask.trim().length > 0;
};

/**
 * `operator-inbox hook pre-tool`, for a session whose mode the edge has
 * found on and a tool it has found in `PRE_TOOL_NAMES`.
 */
export const decidePreTool = (input: {
  readonly paused: boolean;
  readonly toolName: PreToolName;
  readonly toolInput: unknown;
}): PreToolDecision => {
  if (input.paused) return { deny: false };
  switch (input.toolName) {
    case ASK_USER_QUESTION_TOOL:
      return { deny: true, reason: ASK_DENIED };
    case WRAP_UP_TOOL:
      return wrapUpAsks(input.toolInput)
        ? { deny: true, reason: WRAP_UP_DENIED }
        : { deny: false };
  }
};

/** The hook reply that denies a tool call (PreToolUse's documented shape). */
export const renderPreToolDeny = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });

/** The hook reply that adds one line of context to the prompt. */
export const renderPromptContext = (context: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  });
