import {
  askEvents,
  awaitingAgent,
  awaitingOperator,
  CODE_SUFFIX_COUNT,
  codeSuffixAt,
  decideAdopt,
  decideArchive,
  decideAsk,
  decideAssignCode,
  decideDismissHighlight,
  decideEdit,
  decideHighlight,
  decideInboxMetadata,
  decideMove,
  decideOpen,
  decideProcess,
  decideQuestionMetadata,
  decideRename,
  decideUnarchive,
  decideWithdraw,
  evolveInbox,
  type InboxCode,
  type InboxEvent,
  InboxId,
  InboxRefusal,
  type InboxState,
  inboxCodeOf,
  inboxCodePrefix,
  inboxState,
  loadMetadataRules,
  type Metadata,
  newId,
  parseInboxCode,
  parseQuestionCode,
  QuestionNumber,
  questionCode,
  questionRef,
  type SessionId,
  WATCH_COMMAND,
  type WorkingSession,
} from '@operator-inbox/core';
import {
  DEFAULT_INBOX_METADATA,
  emptyMetadata,
  type InboxMetadataRules,
  keysAtLevel,
  type MetadataKey,
  type MetadataLevel,
  mergeMetadata,
  metadataFromFlags,
  metadataText,
  metadataValueProblem,
  missingMetadata,
  SERVE_DEFAULT_PORT,
  SESSION_LINK_KEY,
  SESSION_TITLE_KEY,
  withSessionLink,
  withSessionTitle,
} from '@operator-inbox/core/api';
import {
  Clock,
  Console,
  Data,
  Duration,
  Effect,
  FileSystem,
  Option,
  Random,
  Result,
} from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { InputError } from '../errors';
import { readHome } from '../home-dir';
import {
  dispatchMode,
  dispatchPreToolHook,
  dispatchPromptHook,
  dispatchStopGuard,
} from '../inbox-mode-hooks';
import {
  decideAndAppend,
  decideMoveAndAppend,
  decideNamedAndAppend,
  type InboxDecision,
  InboxLog,
  type MoveDecision,
  type NamedDecision,
} from '../inbox-store';
import { runInboxWatch, watcherAlive } from '../inbox-watch';
import {
  desktopSessionsDir,
  findDesktopSession,
  locateSession,
} from '../session-edge';

// The session's half of the Inbox: every `operator-inbox` subcommand an
// agent runs. The session opens an inbox, asks questions into it, waits for or reads the
// operator's answers (given in the local app at /inbox/<id>), and marks each
// answer processed. Until the operator answers, it may edit a question or
// withdraw it with a reason, which marks it processed too. Every write is read → core decision → append under the
// inbox's condition, through `decideAndAppend`.
//
// Each handler is a thin unwrap over an exported `dispatch*`, so the whole
// composition runs in a test against the in-memory log, with the session
// passed in rather than located.

/** What the dispatchers need of the session this runs inside, if any. */
export interface InboxSession {
  readonly sessionId: SessionId;
  readonly cwd: string;
}

export const inboxUrl = (inboxId: InboxId) =>
  `http://127.0.0.1:${SERVE_DEFAULT_PORT}/inbox/${inboxId}`;

// The exit code a taken name ends the process with, so an agent can tell it
// from every other failure (exit 1) without reading the sentence.
export const NAME_TAKEN_EXIT_CODE = 3;

/**
 * `open` or `rename` asked for a name another inbox holds. It carries that
 * inbox's id: the command prints it on a line of its own on stdout, and the
 * process exits `NAME_TAKEN_EXIT_CODE`, so the agent can look at the other
 * inbox and decide whether to adopt it or choose another name.
 */
export class InboxNameTaken extends Data.TaggedError('InboxNameTaken')<{
  readonly message: string;
  readonly conflictingInboxId: InboxId;
  readonly exitCode: number;
}> {}

const refused = (refusal: InboxRefusal): InputError | InboxNameTaken =>
  refusal.reason === 'name-taken' && refusal.conflictingInboxId !== undefined
    ? new InboxNameTaken({
        message: `inbox: ${refusal.message}`,
        conflictingInboxId: refusal.conflictingInboxId,
        exitCode: NAME_TAKEN_EXIT_CODE,
      })
    : new InputError({ message: `inbox: ${refusal.message}` });

/** The refusal when a decision loses its append condition twice running. */
export const INBOX_CONFLICTED =
  'inbox: the inbox changed twice while writing; run it again';

const conflicted = () => new InputError({ message: INBOX_CONFLICTED });

const unwrapDecided = <A>(
  decided: Result.Result<A, InboxRefusal>,
): Effect.Effect<A, InputError | InboxNameTaken> =>
  Result.isFailure(decided)
    ? Effect.fail(refused(decided.failure))
    : Effect.succeed(decided.success);

/** Run a decision against the log, mapping a refusal to one CLI line. */
const decideOrFail = <A>(inboxId: InboxId, decide: InboxDecision<A>) =>
  decideAndAppend(inboxId, decide).pipe(
    Effect.catchTag('AppendConditionFailed', () => Effect.fail(conflicted())),
    Effect.flatMap(unwrapDecided),
  );

/** The same, for a move between two inboxes. */
const decideMoveOrFail = <A>(
  from: InboxId,
  to: InboxId,
  decide: MoveDecision<A>,
) =>
  decideMoveAndAppend(from, to, decide).pipe(
    Effect.catchTag('AppendConditionFailed', () => Effect.fail(conflicted())),
    Effect.flatMap(unwrapDecided),
  );

/** The same, for a decision that takes a name (open, rename). */
const decideNamedOrFail = <A>(
  inboxId: InboxId,
  label: string,
  decide: NamedDecision<A>,
  codes: ReadonlyArray<InboxCode> = [],
) =>
  decideNamedAndAppend(inboxId, label, decide, codes).pipe(
    Effect.catchTag('AppendConditionFailed', () => Effect.fail(conflicted())),
    Effect.flatMap(unwrapDecided),
  );

const readState = Effect.fnUntraced(function* (inboxId: InboxId) {
  const log = yield* InboxLog;
  const { events } = yield* log.read(inboxId);
  const state = inboxState(events);
  if (!state.opened)
    return yield* new InputError({
      message: `inbox: inbox ${inboxId} does not exist`,
    });
  return state;
});

/**
 * The inbox a verb works on: `--inbox` when given, else the one this session
 * opened or adopted most recently.
 */
export const resolveInbox = Effect.fnUntraced(function* (
  given: Option.Option<string>,
  session: Option.Option<InboxSession>,
) {
  if (Option.isSome(given)) return yield* inboxOfFlag(given.value);
  if (Option.isNone(session))
    return yield* new InputError({
      message:
        'inbox: not inside a Claude session and no --inbox given — run `operator-inbox open`, or pass --inbox <id>',
    });
  const log = yield* InboxLog;
  const found = yield* log.findBySession(session.value.sessionId);
  if (Option.isNone(found))
    return yield* new InputError({
      message:
        'inbox: this session has no inbox yet — run `operator-inbox open --label "<what this session is doing>"`',
    });
  return found.value;
});

/**
 * An inbox named by `--inbox` or `--to`: its id, or its code (`ab-xyz`),
 * which is looked up.
 */
export const inboxOfFlag = Effect.fnUntraced(function* (given: string) {
  const code = parseInboxCode(given);
  if (code === undefined) return InboxId.make(given);
  return yield* inboxOfCode(code);
});

const inboxOfCode = Effect.fnUntraced(function* (code: InboxCode) {
  const log = yield* InboxLog;
  const found = yield* log.findByCode(code);
  if (Option.isNone(found))
    return yield* new InputError({
      message: `inbox: no inbox has the code ${code}; \`operator-inbox list\` shows every inbox with its code`,
    });
  return found.value;
});

/**
 * The questions a verb was given, each a number or a question code
 * (`ab-xyz#3`), and the inbox they are in. Numbers are in `--inbox`, or this
 * session's inbox; codes name their own inbox, so they need neither. One
 * verb works in one inbox, so codes from two inboxes, a code with plain
 * numbers, or a code from another inbox than `--inbox` names, are refused.
 */
export const resolveQuestions = Effect.fnUntraced(function* (
  verb: string,
  given: ReadonlyArray<string>,
  inbox: Option.Option<string>,
  session: Option.Option<InboxSession>,
) {
  const numbers: Array<number> = [];
  const codes = new Set<InboxCode>();
  let plain = false;
  for (const raw of given) {
    const text = raw.trim();
    if (/^-?[0-9]+$/.test(text)) {
      plain = true;
      numbers.push(Number(text));
      continue;
    }
    const parsed = parseQuestionCode(text);
    if (parsed === undefined)
      return yield* new InputError({
        message: `inbox ${verb}: "${raw}" is neither a question number (3) nor a question code (ab-xyz#3)`,
      });
    codes.add(parsed.code);
    numbers.push(parsed.number);
  }
  const [code, ...others] = codes;
  if (code === undefined)
    return { inboxId: yield* resolveInbox(inbox, session), numbers };
  if (others.length > 0)
    return yield* new InputError({
      message: `inbox ${verb}: the codes name ${codes.size} inboxes (${[...codes].join(', ')}); name the questions of one inbox at a time`,
    });
  if (plain)
    return yield* new InputError({
      message: `inbox ${verb}: give every question as a code (${questionCode(code, 3)}) or every one as a number, not both`,
    });
  const inboxId = yield* inboxOfCode(code);
  if (Option.isSome(inbox)) {
    const named = yield* inboxOfFlag(inbox.value);
    if (named !== inboxId)
      return yield* new InputError({
        message: `inbox ${verb}: ${code} is inbox ${inboxId}, not the --inbox ${inbox.value} given; leave --inbox out with a code`,
      });
  }
  return { inboxId, numbers };
});

const codeNote = (state: InboxState) =>
  state.code === undefined ? '' : ` [${state.code}]`;

const describe = (inboxId: InboxId, state: InboxState, how: string) =>
  `inbox ${inboxId} — ${state.label}${codeNote(state)} (${how}${state.archived ? ', archived' : ''})\n${inboxUrl(inboxId)}`;

// --- metadata rules ----------------------------------------------------------------

/**
 * The warning for keys the rules expect and `metadata` lacks: one sentence
 * naming each, on stderr. No near miss is suggested, so a `prs` is never read as
 * a `pr`.
 */
export const expectedKeysWarning = (missing: ReadonlyArray<string>): string =>
  `inbox: expected metadata not set: ${missing.join(', ')}. Set each that applies, with exactly these key names: --meta key=value here, or \`operator-inbox meta --meta key=value\` afterwards. \`operator-inbox keys\` lists them.`;

/** The refusal for keys the rules require and `metadata` lacks. */
export const requiredKeysRefusal = (missing: ReadonlyArray<string>): string =>
  `required metadata not set: ${missing.join(', ')}. Set each with --meta key=value; \`operator-inbox keys\` lists them.`;

/**
 * Warn, on stderr, for each key an Inbox should carry and lacks. Required keys
 * are named too: an Inbox from before the rules, reached again, is not refused
 * for them. No rules given says nothing.
 */
export const warnMissingMetadata = Effect.fnUntraced(function* (
  rules: InboxMetadataRules | undefined,
  metadata: Metadata,
) {
  if (rules === undefined) return;
  const keys = keysAtLevel(rules.keys, 'inbox');
  const missing = [
    ...missingMetadata(keys, metadata, 'required'),
    ...missingMetadata(keys, metadata, 'expected'),
  ];
  if (missing.length > 0) yield* Console.error(expectedKeysWarning(missing));
});

/** What the rules say of the values given, as a refusal. Never of what is stored. */
const valueRefusal = (
  rules: InboxMetadataRules | undefined,
  given: Metadata | undefined,
): InboxRefusal | undefined => {
  if (rules === undefined || given === undefined) return undefined;
  const problem = metadataValueProblem(rules, given);
  return problem === undefined
    ? undefined
    : new InboxRefusal({
        reason: 'bad-metadata',
        message: `metadata does not fit this machine's rules: ${problem}`,
      });
};

const requiredRefusal = (
  rules: InboxMetadataRules | undefined,
  metadata: Metadata,
  level: MetadataLevel,
): InboxRefusal | undefined => {
  if (rules === undefined) return undefined;
  const missing = missingMetadata(
    keysAtLevel(rules.keys, level),
    metadata,
    'required',
  );
  return missing.length === 0
    ? undefined
    : new InboxRefusal({
        reason: 'bad-metadata',
        message: requiredKeysRefusal(missing),
      });
};

/**
 * The value to fill in, unless these rules would refuse it: a value nobody typed
 * must never fail the command, so `extras: refuse` with no rule for the key, or
 * a rule the value does not fit, simply leaves it out.
 */
const fillable = <A extends string>(
  rules: InboxMetadataRules | undefined,
  key: string,
  value: A | undefined,
): A | undefined =>
  value === undefined ||
  rules === undefined ||
  metadataValueProblem(rules, { [key]: value }) === undefined
    ? value
    : undefined;

/**
 * This machine's metadata rules, read from `metadata.json` (the default when
 * there is no file). Unusable rules are said on stderr and give none: a
 * mistake in config must not stop an agent mid-session.
 */
export const readMetadataRules = loadMetadataRules().pipe(
  Effect.flatMap((loaded) =>
    Result.isSuccess(loaded.rules)
      ? Effect.succeed<InboxMetadataRules | undefined>(loaded.rules.success)
      : Console.error(
          `inbox: metadata rules not applied: ${loaded.rules.failure}`,
        ).pipe(Effect.as(undefined)),
  ),
  Effect.orElseSucceed((): InboxMetadataRules | undefined => undefined),
);

const keyLines = (
  keys: ReadonlyArray<MetadataKey>,
  indent: string,
): ReadonlyArray<string> =>
  keys.flatMap((key) => [
    `${indent}${key.key}  ${key.type === 'array' ? `array of ${key.of}` : key.type}  ${key.presence}  ${indent === '' ? `${key.level ?? 'both'}  ` : ''}${key.description}`,
    ...keyLines(key.keys ?? [], `${indent}  `),
  ]);

/** `operator-inbox keys`: the metadata rules, a key to a line, or as JSON. */
export const dispatchKeys = Effect.fnUntraced(function* (opts: {
  readonly json: boolean;
}) {
  const rules = (yield* readMetadataRules) ?? DEFAULT_INBOX_METADATA;
  return opts.json
    ? JSON.stringify(rules, null, 2)
    : [...keyLines(rules.keys, ''), `extras: ${rules.extras}`].join('\n');
});

// `open` without `--label` when there is no inbox to return: a new inbox
// needs a name a person can read, and a directory name like "my-app" would
// collide with every other session working there.
const NEEDS_LABEL =
  'inbox: this session has no inbox yet; open one with a readable name: `operator-inbox open --label "<what this session is doing>"`';
const NEEDS_LABEL_NO_SESSION =
  'inbox: not inside a Claude session and no --inbox given; open an inbox with a readable name: `operator-inbox open --label "<what it is for>"`';

/**
 * `open --label` on an Inbox that already exists renames it, when the name
 * differs; the same name, or no `--label`, changes nothing.
 */
const renameIfAsked = Effect.fnUntraced(function* (
  inboxId: InboxId,
  label: Option.Option<string>,
) {
  if (Option.isNone(label)) return;
  const wanted = label.value.trim();
  const state = yield* readState(inboxId);
  if (wanted.length === 0 || wanted === state.label) return;
  yield* dispatchRename({ inboxId, label: wanted });
});

/**
 * `open --meta` on an Inbox that already exists sets those keys; a change
 * that changes nothing is not an error here.
 */
const setMetadataIfAsked = Effect.fnUntraced(function* (
  inboxId: InboxId,
  metadata: Metadata | undefined,
) {
  if (metadata === undefined || Object.keys(metadata).length === 0) return;
  yield* decideAndAppend(inboxId, (state) =>
    Result.map(
      decideInboxMetadata(state, { inboxId, set: metadata, unset: [] }),
      (event) => ({ events: [event], result: undefined }),
    ),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () => Effect.fail(conflicted())),
    Effect.flatMap((decided) =>
      Result.isFailure(decided) && decided.failure.reason === 'unchanged'
        ? Effect.void
        : unwrapDecided(decided),
    ),
  );
});

// --- open ------------------------------------------------------------------------

export const dispatchOpen = Effect.fnUntraced(function* (opts: {
  readonly session: Option.Option<InboxSession>;
  readonly inbox: Option.Option<string>;
  readonly label: Option.Option<string>;
  // Minted at the edge, used only when a new inbox is opened.
  readonly freshId: InboxId;
  // The directory a new inbox records when there is no session.
  readonly cwd: string;
  // Recorded on a new inbox; set on one that already exists.
  readonly metadata?: Metadata;
  // The desktop session this runs inside, if it runs inside one. Its link and
  // title join the metadata before the rules run, so on an inbox that exists they
  // replace what is there: they mean the session working it now.
  readonly desktopSession?: WorkingSession;
  // This machine's metadata rules. Left out, nothing is checked.
  readonly rules?: InboxMetadataRules;
  // Three-letter suffixes drawn at the edge, tried in order for a new
  // inbox's code (`ab-` from its name, then one of these). Left out, a new
  // inbox opens without a code, as one opened before codes did.
  readonly codeSuffixes?: ReadonlyArray<string>;
}) {
  const metadata = withSessionTitle(
    withSessionLink(
      opts.metadata,
      fillable(opts.rules, SESSION_LINK_KEY, opts.desktopSession?.link),
    ),
    fillable(opts.rules, SESSION_TITLE_KEY, opts.desktopSession?.title),
  );
  const badValue = valueRefusal(opts.rules, metadata);
  if (badValue !== undefined) return yield* refused(badValue);
  // The inbox as it stands once the verb has done its work, described. The
  // rules are checked against the inbox's own metadata, so keys set earlier on
  // an inbox that already exists count as set.
  const finish = Effect.fnUntraced(function* (inboxId: InboxId, how: string) {
    const state = yield* readState(inboxId);
    yield* warnMissingMetadata(opts.rules, state.metadata);
    return describe(inboxId, state, how);
  });
  const log = yield* InboxLog;
  const existing = Option.isSome(opts.session)
    ? yield* log.findBySession(opts.session.value.sessionId)
    : Option.none<InboxId>();

  // Adopt: another session's inbox, by id.
  if (Option.isSome(opts.inbox)) {
    const inboxId = InboxId.make(opts.inbox.value);
    if (Option.isNone(opts.session)) {
      // Nothing to record without a session; just confirm it exists.
      yield* renameIfAsked(inboxId, opts.label);
      yield* setMetadataIfAsked(inboxId, metadata);
      return yield* finish(inboxId, 'found');
    }
    if (Option.contains(existing, inboxId)) {
      yield* renameIfAsked(inboxId, opts.label);
      yield* setMetadataIfAsked(inboxId, metadata);
      return yield* finish(inboxId, "this session's");
    }
    const sessionId = opts.session.value.sessionId;
    yield* decideOrFail(inboxId, (state) =>
      Result.map(decideAdopt(state, { inboxId, sessionId }), (event) => ({
        events: [event],
        result: undefined,
      })),
    );
    yield* renameIfAsked(inboxId, opts.label);
    yield* setMetadataIfAsked(inboxId, metadata);
    return yield* finish(inboxId, 'adopted');
  }

  // Idempotent per session: the inbox this session already has.
  if (Option.isSome(existing)) {
    yield* renameIfAsked(existing.value, opts.label);
    yield* setMetadataIfAsked(existing.value, metadata);
    return yield* finish(existing.value, "this session's");
  }

  // A new inbox: it starts with what the rules require.
  const missingRequired = requiredRefusal(
    opts.rules,
    metadata ?? emptyMetadata,
    'inbox',
  );
  if (missingRequired !== undefined) return yield* refused(missingRequired);

  // A new inbox: it needs a readable name, and one no other inbox holds.
  if (Option.isNone(opts.label))
    return yield* new InputError({
      message: Option.isSome(opts.session)
        ? NEEDS_LABEL
        : NEEDS_LABEL_NO_SESSION,
    });
  const label = opts.label.value;
  const cwd = Option.match(opts.session, {
    onNone: () => opts.cwd,
    onSome: (s) => s.cwd,
  });
  const sessionId = Option.getOrUndefined(
    Option.map(opts.session, (s) => s.sessionId),
  );
  const prefix = inboxCodePrefix(label.trim());
  const candidates = [
    ...new Set((opts.codeSuffixes ?? []).map((s) => inboxCodeOf(prefix, s))),
  ];
  const coded = yield* decideNamedOrFail(
    opts.freshId,
    label,
    (state, holder, free) =>
      Result.map(
        decideOpen(state, {
          inboxId: opts.freshId,
          label,
          holder,
          cwd,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(metadata === undefined ? {} : { metadata }),
        }),
        (opened) => {
          if (candidates.length === 0)
            return { events: [opened], result: true };
          // The code goes in the same append as the open, so a new inbox
          // never exists without one. Every candidate taken leaves it
          // without a code rather than refusing the open; serve's start-up
          // assignment gives it one.
          const assigned = decideAssignCode(evolveInbox(state, opened), {
            inboxId: opts.freshId,
            code: free,
          });
          return Result.isSuccess(assigned)
            ? { events: [opened, assigned.success], result: true }
            : { events: [opened], result: false };
        },
      ),
    candidates,
  );
  if (!coded)
    yield* Console.error(
      `inbox: every code drawn for this inbox was taken, so it has none yet; \`operator-inbox serve\` gives it one when it next starts`,
    );
  return yield* finish(opts.freshId, 'opened');
});

// --- rename ------------------------------------------------------------------------

/**
 * Give an Inbox a readable name: trimmed, not empty, not the one it has, and
 * not one another inbox holds. The name it gives up is free again.
 */
export const dispatchRename = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly label: string;
}) {
  const event = yield* decideNamedOrFail(
    opts.inboxId,
    opts.label,
    (state, holder) =>
      Result.map(
        decideRename(state, {
          inboxId: opts.inboxId,
          label: opts.label,
          holder,
        }),
        (e) => ({ events: [e], result: e }),
      ),
  );
  return `renamed inbox ${opts.inboxId} to "${event.label}"\n${inboxUrl(opts.inboxId)}`;
});

// --- archive / unarchive ------------------------------------------------------------

/**
 * Put an inbox away: its cards leave the operator's All view and it moves to
 * the sidebar's Archived section. Nothing is lost, and it keeps its name.
 */
export const dispatchArchive = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
}) {
  yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(decideArchive(state, { inboxId: opts.inboxId }), (e) => ({
      events: [e],
      result: undefined,
    })),
  );
  const state = yield* readState(opts.inboxId);
  return `archived inbox ${opts.inboxId} — ${state.label}\nunarchive it with \`operator-inbox unarchive --inbox ${opts.inboxId}\` before asking into it again`;
});

/** Bring an archived inbox back. */
export const dispatchUnarchive = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
}) {
  yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(decideUnarchive(state, { inboxId: opts.inboxId }), (e) => ({
      events: [e],
      result: undefined,
    })),
  );
  return describe(opts.inboxId, yield* readState(opts.inboxId), 'unarchived');
});

// --- ask ---------------------------------------------------------------------------

export const dispatchAsk = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly title: string;
  readonly body: string;
  readonly metadata?: Metadata;
  // This machine's metadata rules. Left out, nothing is checked.
  readonly rules?: InboxMetadataRules;
}) {
  const given = opts.metadata ?? emptyMetadata;
  const asked = yield* decideOrFail(opts.inboxId, (state) => {
    // A key already on the Inbox counts as present: the question inherits it.
    const refusal =
      valueRefusal(opts.rules, opts.metadata) ??
      requiredRefusal(
        opts.rules,
        mergeMetadata(state.metadata, given),
        'question',
      );
    if (refusal !== undefined) return Result.fail(refusal);
    return Result.map(
      decideAsk(state, {
        inboxId: opts.inboxId,
        title: opts.title,
        body: opts.body,
        ...(opts.metadata === undefined ? {} : { metadata: opts.metadata }),
      }),
      (event) => ({
        events: askEvents(state, event),
        result: questionRef(state.code, event.number),
      }),
    );
  });
  if (opts.rules !== undefined) {
    const state = yield* readState(opts.inboxId);
    const missing = missingMetadata(
      keysAtLevel(opts.rules.keys, 'question'),
      mergeMetadata(state.metadata, given),
      'expected',
    );
    if (missing.length > 0) yield* Console.error(expectedKeysWarning(missing));
  }
  return asked;
});

// --- answers / wait ---------------------------------------------------------------

// `operatorQuestion` marks a question put to the agent by the operator from
// the app: `response` is then their question, not an answer to one of the
// agent's. `deferred` marks an answer that hands the decision to the agent:
// `response` is then the operator's optional note.
// `code` is the question's code (`ab-xyz#3`), set once its inbox has one.
export interface AnswerLine {
  readonly number: QuestionNumber;
  readonly code?: string;
  readonly title: string;
  readonly response: string;
  readonly metadata: Metadata;
  readonly operatorQuestion?: true;
  readonly deferred?: true;
}

const answersOf = (state: InboxState): ReadonlyArray<AnswerLine> =>
  awaitingAgent(state).map((q) => ({
    number: q.number,
    ...(state.code === undefined
      ? {}
      : { code: questionCode(state.code, q.number) }),
    title: q.title,
    response: q.response ?? '',
    metadata: q.metadata,
    ...(q.operatorQuestion === undefined
      ? {}
      : { operatorQuestion: q.operatorQuestion }),
    ...(q.deferred === undefined ? {} : { deferred: q.deferred }),
  }));

/** A dictionary as `key=value` lines, sorted by key; a list or object as JSON. */
export const renderMetadata = (metadata: Metadata): ReadonlyArray<string> =>
  Object.keys(metadata)
    .sort()
    .map((key) => `${key}=${metadataText(metadata[key])}`);

// The line a deferred answer opens with, so the agent knows the call is its own.
export const DEFERRED_LINE =
  'DEFERRED TO AGENT: you decide. Record what you chose and why.';

export const renderAnswers = (
  answers: ReadonlyArray<AnswerLine>,
  json: boolean,
): string => {
  if (json) return JSON.stringify(answers, null, 2);
  if (answers.length === 0) return 'no answers yet';
  return answers
    .map(
      (a) =>
        `${a.code ?? `#${a.number}`} ${a.operatorQuestion === true ? '(the operator asks) ' : ''}${a.title}\n${[
          ...renderMetadata(a.metadata).map((m) => `meta ${m}`),
          ...(a.deferred === true ? [DEFERRED_LINE] : []),
          ...(a.deferred === true && a.response === ''
            ? []
            : a.response.split('\n')),
        ]
          .map((line) => `  ${line}`)
          .join('\n')}`,
    )
    .join('\n\n');
};

export const dispatchAnswers = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly json: boolean;
}) {
  const state = yield* readState(opts.inboxId);
  return renderAnswers(answersOf(state), opts.json);
});

export const WAIT_POLL = Duration.seconds(5);
export const WAIT_DEFAULT_MINUTES = 10;
export const WAIT_MAX_MINUTES = 60;

/**
 * Poll every 5s until at least one answer awaits the agent, then print them
 * as `answers` does. Bounded by construction: at the timeout it prints
 * "no answers yet" and returns (exit 0), so a backgrounded wait never outlives
 * its own limit.
 */
export const dispatchWait = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly timeoutMinutes: number;
  readonly json: boolean;
}) {
  if (
    !Number.isInteger(opts.timeoutMinutes) ||
    opts.timeoutMinutes < 1 ||
    opts.timeoutMinutes > WAIT_MAX_MINUTES
  )
    return yield* new InputError({
      message: `inbox wait: --timeout is whole minutes from 1 to ${WAIT_MAX_MINUTES}, got ${opts.timeoutMinutes}`,
    });
  const deadline =
    (yield* Clock.currentTimeMillis) + opts.timeoutMinutes * 60_000;
  for (;;) {
    const answers = answersOf(yield* readState(opts.inboxId));
    if (answers.length > 0) return renderAnswers(answers, opts.json);
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) return opts.json ? '[]' : 'no answers yet';
    yield* Effect.sleep(
      Duration.min(WAIT_POLL, Duration.millis(deadline - now)),
    );
  }
});

// --- done --------------------------------------------------------------------------

/** The numbers a verb was given, checked and de-duplicated, in order. */
const questionNumbers = Effect.fnUntraced(function* (
  verb: string,
  given: ReadonlyArray<number>,
) {
  const numbers: Array<QuestionNumber> = [];
  for (const n of given) {
    if (!Number.isInteger(n) || n < 1)
      return yield* new InputError({
        message: `inbox ${verb}: a question number is a whole number from 1, got ${n}`,
      });
    const number = QuestionNumber.make(n);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
});

export const dispatchDone = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly numbers: ReadonlyArray<number>;
}) {
  const numbers = yield* questionNumbers('done', opts.numbers);
  // All or nothing: one refusal appends none of them.
  const processed = yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(
      Result.all(
        numbers.map((number) =>
          decideProcess(state, { inboxId: opts.inboxId, number }),
        ),
      ),
      (events) => ({
        events,
        result: numbers.map((n) => questionRef(state.code, n)),
      }),
    ),
  );
  return `processed ${processed.join(', ')}`;
});

// --- edit / withdraw ---------------------------------------------------------------

/**
 * Rewrite a question the operator has not answered. A field left undefined
 * keeps its value. The page refuses an answer typed against the old text.
 */
export const dispatchEdit = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
}) {
  if (!Number.isInteger(opts.number) || opts.number < 1)
    return yield* new InputError({
      message: `inbox edit: a question number is a whole number from 1, got ${opts.number}`,
    });
  const number = QuestionNumber.make(opts.number);
  const input: Parameters<typeof decideEdit>[1] = {
    inboxId: opts.inboxId,
    number,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    ...(opts.body === undefined ? {} : { body: opts.body }),
  };
  const edited = yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(decideEdit(state, input), (e) => ({
      events: [e],
      result: questionRef(state.code, e.number),
    })),
  );
  return `edited ${edited}`;
});

/**
 * Take back questions the operator has not answered, all or nothing. Each is
 * marked processed with the one reason given, which the operator reads in the
 * Processed column.
 */
export const dispatchWithdraw = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly numbers: ReadonlyArray<number>;
  readonly reason: string;
}) {
  const numbers = yield* questionNumbers('withdraw', opts.numbers);
  const withdrawn = yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(
      Result.all(
        numbers.map((number) =>
          decideWithdraw(state, {
            inboxId: opts.inboxId,
            number,
            reason: opts.reason,
          }),
        ),
      ),
      (events) => ({
        events,
        result: numbers.map((n) => questionRef(state.code, n)),
      }),
    ),
  );
  return `withdrew ${withdrawn.join(', ')}`;
});

// --- highlight -----------------------------------------------------------------------

/**
 * Highlight questions waiting for the operator, so they rise to the top of
 * "Your inbox", newest highlight first. The agent uses it to answer "show me
 * the questions relating to this". Other highlights stay as they are.
 */
export const dispatchHighlight = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly numbers: ReadonlyArray<number>;
  readonly note?: string;
}) {
  const numbers = yield* questionNumbers('highlight', opts.numbers);
  const highlighted = yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(
      decideHighlight(state, {
        inboxId: opts.inboxId,
        numbers,
        ...(opts.note === undefined ? {} : { note: opts.note }),
      }),
      (events) => ({
        events,
        result: numbers.map((n) => questionRef(state.code, n)),
      }),
    ),
  );
  return `highlighted ${highlighted.join(', ')}`;
});

/** Take highlights away: the named questions, or every one in the inbox. */
export const dispatchUnhighlight = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly numbers: ReadonlyArray<number>;
}) {
  const numbers = yield* questionNumbers('unhighlight', opts.numbers);
  const dismissed = yield* decideOrFail(opts.inboxId, (state) =>
    Result.map(
      decideDismissHighlight(state, {
        inboxId: opts.inboxId,
        numbers,
        by: 'agent',
      }),
      (events) => ({
        events,
        result: events.map((e) => questionRef(state.code, e.number)),
      }),
    ),
  );
  return `unhighlighted ${dismissed.join(', ')}`;
});

// --- move ------------------------------------------------------------------------

/**
 * Move questions to another inbox, whole and in any state: they take the next
 * numbers there, and their old numbers here say where they went.
 */
export const dispatchMove = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly numbers: ReadonlyArray<number>;
  readonly toInboxId: InboxId;
}) {
  const numbers = yield* questionNumbers('move', opts.numbers);
  const moved = yield* decideMoveOrFail(
    opts.inboxId,
    opts.toInboxId,
    (from, to) =>
      Result.map(
        decideMove(from, to, {
          inboxId: opts.inboxId,
          numbers,
          toInboxId: opts.toInboxId,
        }),
        (events) => ({
          events,
          result: events.map(
            (e) =>
              `moved ${questionRef(from.code, e.number)} to inbox ${e.toInboxId} as ${questionRef(to.code, e.toNumber)}`,
          ),
        }),
      ),
  );
  return [...moved, inboxUrl(opts.toInboxId)].join('\n');
});

// --- meta --------------------------------------------------------------------------

/**
 * Read or change the metadata of an inbox, or of one of its questions when a
 * number is given. With nothing to set or remove it prints the dictionary;
 * otherwise it records the change and prints the dictionary after it.
 */
export const dispatchMeta = Effect.fnUntraced(function* (opts: {
  readonly inboxId: InboxId;
  readonly number?: number;
  readonly set: Metadata;
  readonly unset: ReadonlyArray<string>;
  readonly json: boolean;
  // This machine's metadata rules. Left out, nothing is checked. Only the values
  // set are: a change to one key must not fail on a key an older Inbox lacks.
  readonly rules?: InboxMetadataRules;
}) {
  const badValue = valueRefusal(opts.rules, opts.set);
  if (badValue !== undefined) return yield* refused(badValue);
  let number: QuestionNumber | undefined;
  if (opts.number !== undefined) {
    if (!Number.isInteger(opts.number) || opts.number < 1)
      return yield* new InputError({
        message: `inbox meta: a question number is a whole number from 1, got ${opts.number}`,
      });
    number = QuestionNumber.make(opts.number);
  }
  const changing = Object.keys(opts.set).length > 0 || opts.unset.length > 0;
  if (changing)
    yield* decideOrFail(opts.inboxId, (state) => {
      const decided: Result.Result<InboxEvent, InboxRefusal> =
        number === undefined
          ? decideInboxMetadata(state, {
              inboxId: opts.inboxId,
              set: opts.set,
              unset: opts.unset,
            })
          : decideQuestionMetadata(state, {
              inboxId: opts.inboxId,
              number,
              set: opts.set,
              unset: opts.unset,
            });
      return Result.map(decided, (event) => ({
        events: [event],
        result: undefined,
      }));
    });
  const state = yield* readState(opts.inboxId);
  let metadata: Metadata = state.metadata;
  if (number !== undefined) {
    const q = state.questions.find((x) => x.number === number);
    if (q === undefined)
      return yield* new InputError({
        message: `inbox: there is no question #${number}`,
      });
    metadata = q.metadata;
  }
  if (opts.json) return JSON.stringify(metadata, null, 2);
  const lines = renderMetadata(metadata);
  return lines.length === 0 ? 'no metadata' : lines.join('\n');
});

// --- list --------------------------------------------------------------------------

export const dispatchList = Effect.fnUntraced(function* () {
  const log = yield* InboxLog;
  const all = (yield* log.listAll()).filter((i) => i.state.opened);
  if (all.length === 0) return 'no inboxes';
  // The active inboxes first, then the archived, each in the order opened;
  // each with its code after its id, once it has one.
  return [
    ...all.filter((i) => !i.state.archived),
    ...all.filter((i) => i.state.archived),
  ]
    .map(
      ({ inboxId, state }) =>
        `${inboxId}  ${state.code === undefined ? '' : `${state.code}  `}${state.label}  ${awaitingOperator(state).length} awaiting you, ${awaitingAgent(state).length} with the agent${state.archived ? '  (archived)' : ''}`,
    )
    .join('\n');
});

// --- the commands ----------------------------------------------------------------

/** The session this runs inside, or none (a plain shell). */
// With no HOME there is no session file to find: a plain shell.
const currentSession = Effect.flatMap(readHome, (home) =>
  Option.match(home, {
    onNone: () => Effect.succeed(Option.none<InboxSession>()),
    onSome: (h) =>
      Effect.map(locateSession(h), (located) =>
        Option.map(
          located,
          (s): InboxSession => ({ sessionId: s.sessionId, cwd: s.cwd }),
        ),
      ),
  }),
);

/** The desktop session this runs inside, or undefined. */
export const desktopSessionOf = (
  sessionsDir: string,
  session: Option.Option<InboxSession>,
) =>
  Option.match(session, {
    onNone: () => Effect.succeed(undefined),
    onSome: (s) =>
      Effect.map(
        findDesktopSession(sessionsDir, s.sessionId),
        Option.getOrUndefined,
      ),
  });

const inboxOpt = Flag.String('inbox').pipe(
  Flag.withDescription(
    'The inbox, by id or by code (ab-xyz) (default: the inbox this session opened or adopted)',
  ),
  Flag.optional,
);

const jsonOpt = Flag.Boolean('json').pipe(
  Flag.withDescription('Print JSON'),
  Flag.withDefault(false),
);

// `--meta key=value`, repeatable: a metadata entry to record.
const metaOpt = Flag.KeyValuePair('meta').pipe(
  Flag.withDescription(
    "A metadata entry as key=value; repeat it for more than one. A dot reaches into an object (model.chapter=C02), and this machine's rules give the value its type. Set each key they ask for, with exactly that name: `operator-inbox keys` lists them",
  ),
  Flag.optional,
);

// `--meta-json key=json`, repeatable: a list or an object, whole.
const metaJsonOpt = Flag.KeyValuePair('meta-json').pipe(
  Flag.withDescription(
    'A metadata entry whose value is JSON, for a list or an object, as key=json; repeat it for more than one',
  ),
  Flag.optional,
);

// The flags as one dictionary; undefined when neither was given.
const metadataOf = Effect.fnUntraced(function* (
  meta: Option.Option<Record<string, string>>,
  metaJson: Option.Option<Record<string, string>>,
  rules: InboxMetadataRules | undefined,
) {
  if (Option.isNone(meta) && Option.isNone(metaJson)) return undefined;
  const parsed = metadataFromFlags(
    Option.getOrElse(meta, () => ({})),
    Option.getOrElse(metaJson, () => ({})),
    rules,
  );
  return Result.isSuccess(parsed)
    ? parsed.success
    : yield* new InputError({ message: `inbox: ${parsed.failure}` });
});

const print = <E, R>(effect: Effect.Effect<string, E, R>) =>
  Effect.flatMap(effect, (line) => Console.log(line));

const resolved = (inbox: Option.Option<string>) =>
  Effect.flatMap(currentSession, (session) => resolveInbox(inbox, session));

// The questions a verb's arguments name, and their inbox (`resolveQuestions`).
const questionsOf = (
  verb: string,
  given: ReadonlyArray<string>,
  inbox: Option.Option<string>,
) =>
  Effect.flatMap(currentSession, (session) =>
    resolveQuestions(verb, given, inbox, session),
  );

// A taken name also prints the holder's id alone on stdout, for an agent to
// parse; the sentence goes to stderr through the error boundary as usual.
export const printingHolder = <E, R>(effect: Effect.Effect<string, E, R>) =>
  print(effect).pipe(
    Effect.tapError((e) =>
      e instanceof InboxNameTaken
        ? Console.log(e.conflictingInboxId)
        : Effect.void,
    ),
  );

// How many suffixes a new inbox's code may try: enough that a clash with
// every one is out of reach until its two letters' 17,576 are nearly used.
const CODE_DRAWS = 16;

// The suffixes a new inbox's code tries, from Effect's injected `Random`, so a
// test can seed it. The only randomness codes have, kept here at the edge.
const drawCodeSuffixes = Effect.forEach(
  Array.from({ length: CODE_DRAWS }),
  () =>
    Effect.map(
      Random.nextIntBetween(0, CODE_SUFFIX_COUNT, { halfOpen: true }),
      codeSuffixAt,
    ),
);

// A question argument: its number, or its code (`ab-xyz#3`), which also
// names its inbox.
const questionArg = (description: string) =>
  Argument.String('n').pipe(
    Argument.withDescription(
      `${description}: each a number, or a question code such as ab-xyz#3, which names its inbox too`,
    ),
  );

const openCommand = Command.make(
  'open',
  {
    label: Flag.String('label').pipe(
      Flag.withDescription(
        "The inbox's readable name in the app, unique across inboxes; required to open a new inbox. On an inbox that already exists, a different name renames it",
      ),
      Flag.optional,
    ),
    inbox: Flag.String('inbox').pipe(
      Flag.withDescription(
        'Adopt this existing inbox for this session instead of opening one',
      ),
      Flag.optional,
    ),
    meta: metaOpt,
    metaJson: metaJsonOpt,
  },
  ({ label, inbox, meta, metaJson }) =>
    printingHolder(
      Effect.gen(function* () {
        const session = yield* currentSession;
        const cwd = yield* Effect.sync(() => process.cwd());
        const rules = yield* readMetadataRules;
        const metadata = yield* metadataOf(meta, metaJson, rules);
        const home = yield* readHome;
        const desktopSession = Option.isSome(home)
          ? yield* desktopSessionOf(desktopSessionsDir(home.value), session)
          : undefined;
        return yield* dispatchOpen({
          session,
          inbox,
          label,
          freshId: InboxId.make(newId()),
          codeSuffixes: yield* drawCodeSuffixes,
          cwd,
          ...(metadata === undefined ? {} : { metadata }),
          ...(desktopSession === undefined ? {} : { desktopSession }),
          ...(rules === undefined ? {} : { rules }),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "Open this session's inbox (or return the one it has), or adopt another by --inbox; prints its URL",
  ),
);

const renameCommand = Command.make(
  'rename',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription(
        'The new readable name, e.g. what this session is doing',
      ),
    ),
    inbox: inboxOpt,
  },
  ({ name, inbox }) =>
    printingHolder(
      Effect.flatMap(resolved(inbox), (inboxId) =>
        dispatchRename({ inboxId, label: name }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Rename this session's inbox (or --inbox <id>) so the operator can tell it apart",
  ),
);

const readBody = (verb: string, bodyFile: Option.Option<string>) =>
  Option.match(bodyFile, {
    onSome: (file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readFileString(file);
      }).pipe(
        Effect.mapError(
          () =>
            new InputError({
              message: `inbox ${verb}: cannot read ${file}`,
            }),
        ),
      ),
    // No file: the body is stdin, unless stdin is a terminal (nothing piped),
    // which would otherwise wait forever for a body nobody is typing.
    onNone: () =>
      Effect.tryPromise({
        try: async () => {
          if (process.stdin.isTTY === true) return '';
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
          return Buffer.concat(chunks).toString('utf8');
        },
        catch: () =>
          new InputError({ message: `inbox ${verb}: failed to read stdin` }),
      }),
  });

const askCommand = Command.make(
  'ask',
  {
    title: Flag.String('title').pipe(
      Flag.withDescription('The decision the question asks for'),
    ),
    bodyFile: Flag.File('body-file').pipe(
      Flag.withDescription('The markdown body (default: stdin)'),
      Flag.optional,
    ),
    inbox: inboxOpt,
    meta: metaOpt,
    metaJson: metaJsonOpt,
  },
  ({ title, bodyFile, inbox, meta, metaJson }) =>
    print(
      Effect.gen(function* () {
        const inboxId = yield* resolved(inbox);
        const body = yield* readBody('ask', bodyFile);
        const rules = yield* readMetadataRules;
        const metadata = yield* metadataOf(meta, metaJson, rules);
        const asked = yield* dispatchAsk({
          inboxId,
          title,
          body,
          ...(metadata === undefined ? {} : { metadata }),
          ...(rules === undefined ? {} : { rules }),
        });
        // A nudge at the moment it matters: nothing is watching for the
        // answer. On stderr, so `#n` stays the whole
        // of stdout; a check that fails says nothing.
        const watched = yield* watcherAlive(inboxId).pipe(
          Effect.orElseSucceed(() => true),
        );
        if (!watched)
          yield* Console.error(
            `no watcher is running for this inbox, so its answer will not wake you; arm one with the Monitor tool: ${WATCH_COMMAND}`,
          );
        return asked;
      }),
    ),
).pipe(
  Command.withDescription(
    'Ask the operator a question; prints its code (ab-xyz#n), or #n for an inbox that has no code yet',
  ),
);

const watchCommand = Command.make(
  'watch',
  {
    inbox: inboxOpt,
    ownerPid: Flag.String('owner-pid').pipe(
      Flag.withDescription(
        'Exit when this pid dies — pass "$CLAUDE_PID" from a Claude Code session',
      ),
      Flag.optional,
    ),
    maxDuration: Flag.Int('max-duration').pipe(
      Flag.withDescription(
        'Exit after this many seconds regardless (default 4h)',
      ),
      Flag.withDefault(4 * 60 * 60),
    ),
  },
  ({ inbox, ownerPid, maxDuration }) =>
    Effect.flatMap(resolved(inbox), (inboxId) =>
      runInboxWatch({
        inboxId,
        ownerPid: Option.getOrUndefined(ownerPid),
        maxDurationSeconds: maxDuration,
      }),
    ),
).pipe(
  Command.withDescription(
    'Watch this inbox for answers until the session ends (arm it with the Monitor tool; stdout: one line per burst of answers)',
  ),
);

// A hook's stdin, or '' when it cannot be read.
const hookStdin = readBody('hook', Option.none()).pipe(
  Effect.orElseSucceed(() => ''),
);

/**
 * What a hook prints: its decision, or nothing when it fails. A hook that
 * fails (bad stdin, no store, a defect) must never trap or slow a session, so
 * it prints nothing and exits 0.
 */
export const hookOutput = <E, R>(
  stdin: string,
  decide: (stdin: string) => Effect.Effect<string, E, R>,
): Effect.Effect<string, never, R> =>
  decide(stdin).pipe(Effect.catchCause(() => Effect.succeed('')));

const runHook = <E, R>(
  decide: (stdin: string) => Effect.Effect<string, E, R>,
) =>
  Effect.flatMap(hookStdin, (stdin) => hookOutput(stdin, decide)).pipe(
    Effect.flatMap((out) => (out.length > 0 ? Console.log(out) : Effect.void)),
    Effect.catchCause(() => Effect.void),
  );

const guardCommand = Command.make('guard', {}, () =>
  runHook((stdin) =>
    dispatchStopGuard({
      stdin,
      // Only when stdin carries no `session_id`.
      fallbackSession: Effect.map(currentSession, (session) =>
        Option.map(session, (s) => s.sessionId),
      ),
    }),
  ),
).pipe(
  Command.withDescription(
    "The Stop hook: blocks the turn ending while this session's inbox waits on answers with no watcher running, and, in inbox mode, while the last message asks the operator something in chat",
  ),
);

const hookPromptCommand = Command.make('prompt', {}, () =>
  runHook(dispatchPromptHook),
).pipe(
  Command.withDescription(
    'The UserPromptSubmit hook for inbox mode: an off phrase turns it off; a prompt the operator typed pauses it for that reply',
  ),
);

const hookPreToolCommand = Command.make('pre-tool', {}, () =>
  runHook(dispatchPreToolHook),
).pipe(
  Command.withDescription(
    'The PreToolUse hook for inbox mode: denies AskUserQuestion, and a wrap_up with an ask, while the mode is on',
  ),
);

const hookCommand = Command.make('hook').pipe(
  Command.withDescription(
    "Inbox mode's Claude Code hooks (read the hook's JSON on stdin; print nothing unless the mode is on)",
  ),
  Command.withSubcommands([hookPromptCommand, hookPreToolCommand]),
);

const modeCommand = Command.make(
  'mode',
  {
    state: Argument.Literals('state', ['on', 'off']).pipe(
      Argument.withDescription('on or off'),
    ),
  },
  ({ state }) =>
    print(
      Effect.flatMap(currentSession, (session) =>
        dispatchMode({
          session: Option.map(session, (s) => s.sessionId),
          state,
        }),
      ).pipe(
        Effect.catchTag('AppendConditionFailed', () =>
          Effect.fail(conflicted()),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Turn inbox mode on or off for this session: while it is on, hooks route every question for the operator to this session's inbox",
  ),
);

const answersCommand = Command.make(
  'answers',
  { inbox: inboxOpt, json: jsonOpt },
  ({ inbox, json }) =>
    print(
      Effect.flatMap(resolved(inbox), (inboxId) =>
        dispatchAnswers({ inboxId, json }),
      ),
    ),
).pipe(
  Command.withDescription(
    'The operator’s answers waiting for this session to act on',
  ),
);

const waitCommand = Command.make(
  'wait',
  {
    inbox: inboxOpt,
    json: jsonOpt,
    timeout: Flag.Int('timeout').pipe(
      Flag.withDescription(
        `Give up after this many minutes (default ${WAIT_DEFAULT_MINUTES}, at most ${WAIT_MAX_MINUTES})`,
      ),
      Flag.withDefault(WAIT_DEFAULT_MINUTES),
    ),
  },
  ({ inbox, json, timeout }) =>
    print(
      Effect.flatMap(resolved(inbox), (inboxId) =>
        dispatchWait({ inboxId, timeoutMinutes: timeout, json }),
      ),
    ),
).pipe(
  Command.withDescription(
    'Wait (polling every 5s, bounded) until an answer arrives, then print the answers',
  ),
);

const doneCommand = Command.make(
  'done',
  {
    numbers: questionArg('The questions to mark processed').pipe(
      Argument.atLeast(1),
    ),
    inbox: inboxOpt,
  },
  ({ numbers, inbox }) =>
    print(
      Effect.flatMap(questionsOf('done', numbers, inbox), (q) =>
        dispatchDone(q),
      ),
    ),
).pipe(
  Command.withDescription(
    'Mark answers processed; they move to the Processed column',
  ),
);

const editCommand = Command.make(
  'edit',
  {
    number: questionArg('The question to edit'),
    title: Flag.String('title').pipe(
      Flag.withDescription('The new title (default: unchanged)'),
      Flag.optional,
    ),
    bodyFile: Flag.File('body-file').pipe(
      Flag.withDescription(
        'The new markdown body (default: stdin; nothing piped keeps the body)',
      ),
      Flag.optional,
    ),
    inbox: inboxOpt,
  },
  ({ number, title, bodyFile, inbox }) =>
    print(
      Effect.gen(function* () {
        const {
          inboxId,
          numbers: [n = 0],
        } = yield* questionsOf('edit', [number], inbox);
        // An empty stdin means no new body; an empty --body-file clears it.
        const read = yield* readBody('edit', bodyFile);
        const body =
          Option.isNone(bodyFile) && read.length === 0 ? undefined : read;
        return yield* dispatchEdit({
          inboxId,
          number: n,
          ...(Option.isSome(title) ? { title: title.value } : {}),
          ...(body === undefined ? {} : { body }),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    'Rewrite a question the operator has not answered yet (title, body or both)',
  ),
);

const withdrawCommand = Command.make(
  'withdraw',
  {
    numbers: questionArg('The questions to withdraw').pipe(Argument.atLeast(1)),
    reason: Flag.String('reason').pipe(
      Flag.withDescription(
        'Why it no longer needs an answer; the operator reads it in Processed',
      ),
    ),
    inbox: inboxOpt,
  },
  ({ numbers, reason, inbox }) =>
    print(
      Effect.flatMap(questionsOf('withdraw', numbers, inbox), (q) =>
        dispatchWithdraw({ ...q, reason }),
      ),
    ),
).pipe(
  Command.withDescription(
    'Take back questions the operator has not answered, with a reason; they move to Processed',
  ),
);

const metaCommand = Command.make(
  'meta',
  {
    number: Argument.String('n').pipe(
      Argument.withDescription(
        "A question, by number or by code (ab-xyz#3): its metadata instead of the inbox's",
      ),
      Argument.optional,
    ),
    meta: metaOpt,
    metaJson: metaJsonOpt,
    unset: Flag.String('unset').pipe(
      Flag.withDescription(
        'A metadata key to remove, with dots to reach into an object; repeat it for more',
      ),
      Flag.atLeast(0),
    ),
    inbox: inboxOpt,
    json: jsonOpt,
  },
  ({ number, meta, metaJson, unset, inbox, json }) =>
    print(
      Effect.gen(function* () {
        const { inboxId, numbers } = Option.isSome(number)
          ? yield* questionsOf('meta', [number.value], inbox)
          : { inboxId: yield* resolved(inbox), numbers: [] };
        const [n] = numbers;
        const rules = yield* readMetadataRules;
        return yield* dispatchMeta({
          inboxId,
          ...(n === undefined ? {} : { number: n }),
          set: (yield* metadataOf(meta, metaJson, rules)) ?? {},
          unset,
          json,
          ...(rules === undefined ? {} : { rules }),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    "Print or change the metadata of this session's inbox, or of question n (--meta key=value and --meta-json key=json set, --unset key removes)",
  ),
);

const keysCommand = Command.make('keys', { json: jsonOpt }, ({ json }) =>
  print(dispatchKeys({ json })),
).pipe(
  Command.withDescription(
    "Print this machine's metadata rules (~/.config/operator-inbox/metadata.json, or the defaults when there is none): each key with its type, presence, its level (inbox, question or both) and what it is for. `required` refuses a write without it and `expected` warns, at its level only; set each with exactly that name",
  ),
);

const highlightCommand = Command.make(
  'highlight',
  {
    numbers: questionArg('The questions to highlight').pipe(
      Argument.atLeast(1),
    ),
    note: Flag.String('note').pipe(
      Flag.withDescription(
        'A short reason, shown on the highlight (e.g. "about the store")',
      ),
      Flag.optional,
    ),
    inbox: inboxOpt,
  },
  ({ numbers, note, inbox }) =>
    print(
      Effect.flatMap(questionsOf('highlight', numbers, inbox), (q) =>
        dispatchHighlight({
          ...q,
          ...(Option.isSome(note) ? { note: note.value } : {}),
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    'Highlight questions waiting for the operator: they rise to the top of their inbox, newest highlight first',
  ),
);

const unhighlightCommand = Command.make(
  'unhighlight',
  {
    numbers: questionArg(
      'The questions to unhighlight (default: every highlighted one)',
    ).pipe(Argument.variadic()),
    inbox: inboxOpt,
  },
  ({ numbers, inbox }) =>
    print(
      Effect.flatMap(questionsOf('unhighlight', numbers, inbox), (q) =>
        dispatchUnhighlight(q),
      ),
    ),
).pipe(
  Command.withDescription(
    'Take highlights away: the questions named, or every highlighted one in the inbox',
  ),
);

const moveCommand = Command.make(
  'move',
  {
    numbers: questionArg('The questions to move').pipe(Argument.atLeast(1)),
    to: Flag.String('to').pipe(
      Flag.withDescription(
        'The inbox to move them to: its id, or its code (ab-xyz)',
      ),
    ),
    inbox: inboxOpt,
  },
  ({ numbers, to, inbox }) =>
    print(
      Effect.gen(function* () {
        const q = yield* questionsOf('move', numbers, inbox);
        return yield* dispatchMove({
          ...q,
          toInboxId: yield* inboxOfFlag(to),
        });
      }),
    ),
).pipe(
  Command.withDescription(
    'Move questions, whole and in any state, to another inbox (--to <id>); they take its next numbers',
  ),
);

const listCommand = Command.make('list', {}, () => print(dispatchList())).pipe(
  Command.withDescription(
    'Every inbox on this machine, with its open counts; archived ones last',
  ),
);

const archiveCommand = Command.make(
  'archive',
  { inbox: inboxOpt },
  ({ inbox }) =>
    print(
      Effect.flatMap(resolved(inbox), (inboxId) =>
        dispatchArchive({ inboxId }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Archive this session's inbox (or --inbox <id>) when its work is finished: it leaves the operator's All view and keeps its name",
  ),
);

const unarchiveCommand = Command.make(
  'unarchive',
  { inbox: inboxOpt },
  ({ inbox }) =>
    print(
      Effect.flatMap(resolved(inbox), (inboxId) =>
        dispatchUnarchive({ inboxId }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Bring this session's archived inbox (or --inbox <id>) back, so it can be asked into again",
  ),
);

// Every subcommand an agent and its hooks run, each at the top level of
// `operator-inbox` (`index.ts` adds serve and the setup commands).
export const inboxSubcommands = [
  openCommand,
  renameCommand,
  askCommand,
  answersCommand,
  waitCommand,
  doneCommand,
  editCommand,
  withdrawCommand,
  metaCommand,
  keysCommand,
  highlightCommand,
  unhighlightCommand,
  watchCommand,
  guardCommand,
  hookCommand,
  modeCommand,
  moveCommand,
  listCommand,
  archiveCommand,
  unarchiveCommand,
] as const;
