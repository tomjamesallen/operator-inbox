import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
  type EventStamp,
  type InboxEvent,
  inboxState,
  QuestionNumber,
} from '../src/inbox';
import {
  decideGuard,
  decideModeOff,
  decideModeOn,
  decidePreTool,
  decidePrompt,
  GUARD_BLOCK_REASON,
  type GuardInput,
  guardBaseline,
  InboxSessionScratch,
  isAnswerSignal,
  isHarnessPrompt,
  isOffPhrase,
  isPreToolName,
  modeOff,
  needsClassification,
  PRE_TOOL_NAMES,
  PreToolHookInput,
  PromptHookInput,
  proseOutsideCode,
  renderPreToolDeny,
  type SessionInboxMode,
  StopHookInput,
  scratchFileName,
  sessionInboxMode,
} from '../src/inbox-mode';
import { renderAnswerSignal } from '../src/inbox-watch';
import { InboxId, PromptId, SessionId } from '../src/schema/identifiers';

// Inbox mode's pure half: the per-session fold, the Stop guard's rules (with
// the prompt's pause and the seq rule), the `?`-outside-code detector, the
// off phrases, and the prompt and pre-tool decisions.

const S = SessionId.make('session-a');
const OTHER = SessionId.make('session-b');
const ID = InboxId.make('01INBOXMODEAAAAAAAAAAAAAAA');
const ID2 = InboxId.make('01INBOXMODEBBBBBBBBBBBBBBB');
const P1 = PromptId.make('prompt-1');
const P2 = PromptId.make('prompt-2');

const at = (seq: number): EventStamp => ({ seq });
const stamped = (events: ReadonlyArray<readonly [number, InboxEvent]>) =>
  events.map(([seq, event]) => ({ event, stamp: at(seq) }));

const opened: InboxEvent = {
  _tag: 'InboxOpened',
  inboxId: ID,
  label: 'demo',
  sessionId: S,
};
const on = (sessionId = S): InboxEvent => ({
  _tag: 'InboxModeOn',
  inboxId: ID,
  sessionId,
});
const off = (sessionId = S): InboxEvent => ({
  _tag: 'InboxModeOff',
  inboxId: ID,
  sessionId,
  reason: 'command',
});
const asked = (n: number, operatorQuestion = false): InboxEvent => ({
  _tag: 'QuestionAsked',
  inboxId: ID,
  number: QuestionNumber.make(n),
  title: `Q${n}`,
  body: '',
  ...(operatorQuestion ? { operatorQuestion: true as const } : {}),
});

describe('the mode fold, per session', () => {
  it('is off with no mode events, and names the session inbox', () => {
    expect(sessionInboxMode(S, stamped([[1, opened]]))).toStrictEqual({
      on: false,
      inboxId: ID,
    });
  });

  it('turns on, then off, then on again, carrying the latest on seq', () => {
    const events = stamped([
      [1, opened],
      [2, on()],
      [3, asked(1)],
      [4, off()],
      [5, on()],
    ]);
    expect(sessionInboxMode(S, events)).toStrictEqual({
      on: true,
      onSeq: 5,
      inboxId: ID,
    });
    expect(sessionInboxMode(S, events.slice(0, 4))).toStrictEqual({
      on: false,
      inboxId: ID,
    });
  });

  it("ignores another session's mode events and opens in a mixed read", () => {
    const events = stamped([
      [1, opened],
      [2, on(OTHER)],
      [
        3,
        {
          _tag: 'InboxOpened',
          inboxId: ID2,
          label: 'other',
          sessionId: OTHER,
        },
      ],
    ]);
    expect(sessionInboxMode(S, events)).toStrictEqual({
      on: false,
      inboxId: ID,
    });
    expect(sessionInboxMode(OTHER, events)).toStrictEqual({
      on: true,
      onSeq: 2,
      inboxId: ID2,
    });
  });

  it('follows an adoption to the adopted inbox, and the mode stays', () => {
    const events = stamped([
      [1, opened],
      [2, on()],
      [3, { _tag: 'InboxAdopted', inboxId: ID2, sessionId: S }],
    ]);
    expect(sessionInboxMode(S, events)).toStrictEqual({
      on: true,
      onSeq: 2,
      inboxId: ID2,
    });
  });

  it('is off with no inbox when the session never opened one', () => {
    expect(sessionInboxMode(S, [])).toStrictEqual({ on: false });
  });

  it("leaves the Inbox's own fold unchanged", () => {
    const base = [opened, asked(1)];
    expect(inboxState([...base, on(), off()])).toStrictEqual(inboxState(base));
  });

  it('on and off are idempotent', () => {
    const mode: SessionInboxMode = { on: true, onSeq: 2, inboxId: ID };
    expect(decideModeOn({ mode, sessionId: S, inboxId: ID })).toStrictEqual([]);
    expect(
      decideModeOn({ mode: modeOff, sessionId: S, inboxId: ID }),
    ).toStrictEqual([{ _tag: 'InboxModeOn', inboxId: ID, sessionId: S }]);
    expect(
      decideModeOff({ mode: modeOff, sessionId: S, reason: 'phrase' }),
    ).toStrictEqual([]);
    expect(
      decideModeOff({ mode, sessionId: S, reason: 'phrase' }),
    ).toStrictEqual([
      { _tag: 'InboxModeOff', inboxId: ID, sessionId: S, reason: 'phrase' },
    ]);
  });
});

describe('the Stop guard', () => {
  const modeOn = { on: true, onSeq: 10, inboxId: ID } as const;
  const input = (over: Partial<GuardInput> = {}): GuardInput => ({
    promptId: P1,
    mode: modeOn,
    scratch: {},
    inbox: stamped([[1, opened]]),
    message: 'Which approach do you want?',
    ...over,
  });

  it('mode off: the existing watcher check only', () => {
    expect(decideGuard(input({ mode: modeOff }))).toStrictEqual({
      kind: 'watcher',
    });
  });

  it('paused for this prompt: the watcher check only', () => {
    expect(
      decideGuard(input({ scratch: { pausedPromptId: P1 } })),
    ).toStrictEqual({ kind: 'watcher' });
  });

  it('a pause for an earlier prompt does not hold', () => {
    expect(decideGuard(input({ scratch: { pausedPromptId: P2 } })).kind).toBe(
      'classify',
    );
  });

  it('a question asked above lastSeenSeq skips the classifier', () => {
    const inbox = stamped([
      [1, opened],
      [12, asked(1)],
    ]);
    expect(
      decideGuard(input({ inbox, scratch: { lastSeenSeq: 11 } })),
    ).toStrictEqual({ kind: 'watcher' });
    // At or below the recorded head: an earlier turn's question.
    expect(
      decideGuard(input({ inbox, scratch: { lastSeenSeq: 12 } })).kind,
    ).toBe('classify');
  });

  it('with no lastSeenSeq the baseline is the InboxModeOn', () => {
    const before = stamped([
      [1, opened],
      [9, asked(1)],
    ]);
    const after = stamped([
      [1, opened],
      [11, asked(1)],
    ]);
    expect(decideGuard(input({ inbox: before })).kind).toBe('classify');
    expect(decideGuard(input({ inbox: after })).kind).toBe('watcher');
  });

  it('a head recorded before the mode was turned on again does not lower the baseline', () => {
    expect(guardBaseline(modeOn, { lastSeenSeq: 3 })).toBe(10);
    expect(guardBaseline(modeOn, { lastSeenSeq: 20 })).toBe(20);
    const inbox = stamped([
      [1, opened],
      [5, asked(1)],
    ]);
    expect(
      decideGuard(input({ inbox, scratch: { lastSeenSeq: 3 } })).kind,
    ).toBe('classify');
  });

  it("an operator's question from the app is not the agent asking", () => {
    const inbox = stamped([
      [1, opened],
      [12, asked(1, true)],
    ]);
    expect(decideGuard(input({ inbox })).kind).toBe('classify');
  });

  it('a ? in prose goes to the classifier', () => {
    expect(decideGuard(input())).toStrictEqual({
      kind: 'classify',
      text: 'Which approach do you want?',
    });
  });

  it('no ? at all goes to the classifier too', () => {
    expect(
      decideGuard(input({ message: 'Let me know which you prefer.' })).kind,
    ).toBe('classify');
  });

  it('every ? in code: the watcher check only', () => {
    expect(
      decideGuard(input({ message: 'Ran `ls ?.ts` and it listed three.' })),
    ).toStrictEqual({ kind: 'watcher' });
  });

  it('a blank message passes without classification', () => {
    expect(decideGuard(input({ message: '  \n ' }))).toStrictEqual({
      kind: 'watcher',
    });
  });

  it('the block reason names inbox ask and the way out', () => {
    expect(GUARD_BLOCK_REASON).toContain('operator-inbox ask --title');
    expect(GUARD_BLOCK_REASON).toContain('--body-file');
    expect(GUARD_BLOCK_REASON).toContain('simply end the turn again');
    // The next stop is let through unchecked, so the reason arms the watcher.
    expect(GUARD_BLOCK_REASON).toContain(
      'operator-inbox watch --owner-pid "$CLAUDE_PID"',
    );
    expect(GUARD_BLOCK_REASON).toContain('Monitor tool');
  });
});

describe('? outside code', () => {
  it('drops fenced blocks, closed or not', () => {
    expect(
      proseOutsideCode('Done.\n```sh\nls ?\n```\nAll good.'),
    ).not.toContain('?');
    expect(proseOutsideCode('Done.\n~~~\nwhat?\n~~~')).not.toContain('?');
    expect(proseOutsideCode('Done.\n```\nwhat?')).not.toContain('?');
    // A shorter fence does not close a longer one.
    expect(
      proseOutsideCode('````\n```\nx?\n```\nstill code?\n````\nprose'),
    ).toBe('prose');
  });

  it('drops inline code of any backtick run length', () => {
    expect(proseOutsideCode('Use `a?b` here')).not.toContain('?');
    expect(proseOutsideCode('Use ``a ` ?`` here')).not.toContain('?');
  });

  it('keeps an unmatched backtick as text', () => {
    expect(proseOutsideCode('a ` lone tick, ok?')).toContain('?');
  });

  it('drops URLs, query strings included', () => {
    expect(
      proseOutsideCode('See https://example.com/search?q=x for it.'),
    ).not.toContain('?');
    expect(proseOutsideCode('Open http://127.0.0.1:7184/inbox/x#q=2?')).toBe(
      'Open  ',
    );
  });

  it('needsClassification: only a ? that is all in code skips it', () => {
    expect(needsClassification('Shall I merge?')).toBe(true);
    expect(needsClassification('Merged.')).toBe(true);
    expect(needsClassification('Ran `x?`, then asked: proceed?')).toBe(true);
    expect(needsClassification('Ran `x?`.')).toBe(false);
    expect(needsClassification('See https://a.b/?c=d.')).toBe(false);
    expect(needsClassification('')).toBe(false);
  });
});

describe('the prompt hook', () => {
  it('matches the off phrases as whole prompts, loosely', () => {
    expect(isOffPhrase('inbox off')).toBe(true);
    expect(isOffPhrase('  Inbox   OFF. ')).toBe(true);
    expect(isOffPhrase('Stop using the inbox!')).toBe(true);
    expect(isOffPhrase('"ask me here"')).toBe(true);
    expect(isOffPhrase("don't ask me here, use the inbox")).toBe(false);
    expect(isOffPhrase('turn inbox off please')).toBe(false);
  });

  it('knows the watcher line as renderAnswerSignal writes it', () => {
    expect(isAnswerSignal(renderAnswerSignal(1, 'demo'))).toBe(true);
    expect(isAnswerSignal(`${renderAnswerSignal(3, 'a "b"')}\n`)).toBe(true);
    expect(isAnswerSignal(`hello ${renderAnswerSignal(1, 'demo')}`)).toBe(
      false,
    );
  });

  it('mode off: nothing, whatever the prompt', () => {
    expect(
      decidePrompt({ modeOn: false, prompt: 'inbox off', promptId: P1 }),
    ).toStrictEqual({ kind: 'nothing' });
  });

  it('an off phrase turns it off', () => {
    expect(
      decidePrompt({ modeOn: true, prompt: 'Inbox off', promptId: P1 }),
    ).toStrictEqual({ kind: 'off' });
  });

  it('the watcher line and a Monitor wake-up do not pause', () => {
    expect(
      decidePrompt({
        modeOn: true,
        prompt: renderAnswerSignal(2, 'demo'),
        promptId: P1,
      }),
    ).toStrictEqual({ kind: 'nothing' });
    expect(
      decidePrompt({
        modeOn: true,
        prompt:
          '<task-notification>\n<task-id>b1</task-id>\n<event>WAKE</event>',
        promptId: P1,
      }),
    ).toStrictEqual({ kind: 'nothing' });
  });

  it('a prompt opening with an XML-style tag is the harness, not the operator', () => {
    const shapes = [
      '<task-notification>\n<task-id>b1</task-id>',
      '<cross-session-message from="peer">hello</cross-session-message>',
      '<agent-message id="a1">done</agent-message>',
      '<ci-monitor-event>\n{"status":"failed"}\n</ci-monitor-event>',
      '<scheduled-task name="nightly">run it</scheduled-task>',
      '<system-reminder>\nnote\n</system-reminder>\n<cross-session-message from="peer">hi</cross-session-message>',
      '  \n<agent-message/>',
    ];
    for (const prompt of shapes) {
      expect(isHarnessPrompt(prompt)).toBe(true);
      expect(
        decidePrompt({ modeOn: true, prompt, promptId: P1 }),
      ).toStrictEqual({ kind: 'nothing' });
    }
  });

  it('a prompt opening with < that is no tag still pauses', () => {
    for (const prompt of [
      '< 5 items, please',
      '<3 thanks',
      '<-- that one',
      '<Task> is not lower case',
      '<task',
    ]) {
      expect(isHarnessPrompt(prompt)).toBe(false);
      expect(
        decidePrompt({ modeOn: true, prompt, promptId: P1 }),
      ).toStrictEqual({ kind: 'pause', promptId: P1 });
    }
  });

  it('an off phrase needs no prompt id, and is never read from a harness prompt', () => {
    expect(decidePrompt({ modeOn: true, prompt: 'inbox off' })).toStrictEqual({
      kind: 'off',
    });
    expect(
      decidePrompt({ modeOn: true, prompt: '<inbox off>', promptId: P1 }),
    ).toStrictEqual({ kind: 'nothing' });
  });

  it('anything the operator typed pauses for that prompt', () => {
    expect(
      decidePrompt({ modeOn: true, prompt: 'why that one?', promptId: P2 }),
    ).toStrictEqual({ kind: 'pause', promptId: P2 });
    expect(decidePrompt({ modeOn: true, prompt: 'hi' })).toStrictEqual({
      kind: 'nothing',
    });
  });
});

describe('the pre-tool hook', () => {
  const base = { paused: false };

  it('denies AskUserQuestion outright while on and not paused', () => {
    const d = decidePreTool({
      ...base,
      toolName: 'AskUserQuestion',
      toolInput: {},
    });
    expect(d.deny).toBe(true);
    if (d.deny) expect(d.reason).toContain('operator-inbox ask');
  });

  it('denies wrap_up only with a non-blank ask', () => {
    const wrap = (toolInput: unknown) =>
      decidePreTool({ ...base, toolName: 'mcp__ccd_turn__wrap_up', toolInput })
        .deny;
    expect(wrap({ recap: 'r', ask: 'Proceed?' })).toBe(true);
    expect(wrap({ recap: 'r' })).toBe(false);
    expect(wrap({ recap: 'r', ask: '  ' })).toBe(false);
    expect(wrap({ recap: 'r', ask: 3 })).toBe(false);
    expect(wrap(undefined)).toBe(false);
  });

  it('allows both tools while paused', () => {
    for (const toolName of PRE_TOOL_NAMES)
      expect(
        decidePreTool({
          paused: true,
          toolName,
          toolInput: { ask: 'Proceed?' },
        }).deny,
      ).toBe(false);
  });

  it('judges only its own tools, the matcher settings.json registers', () => {
    expect(PRE_TOOL_NAMES).toStrictEqual([
      'AskUserQuestion',
      'mcp__ccd_turn__wrap_up',
    ]);
    expect(isPreToolName('AskUserQuestion')).toBe(true);
    expect(isPreToolName('Bash')).toBe(false);
  });

  it('renders the documented deny shape', () => {
    expect(JSON.parse(renderPreToolDeny('why'))).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'why',
      },
    });
  });
});

describe('the hook payloads and the sidecar', () => {
  const decode = <A>(schema: Schema.Decoder<A>, json: string) =>
    Schema.decodeUnknownSync(Schema.fromJsonString(schema))(json);

  it('decode leniently, unknown keys dropped', () => {
    expect(
      decode(
        StopHookInput,
        JSON.stringify({
          session_id: 's',
          prompt_id: 'p',
          stop_hook_active: false,
          last_assistant_message: 'hi',
          background_tasks: [],
          session_crons: [],
        }),
      ),
    ).toStrictEqual({
      session_id: 's',
      prompt_id: 'p',
      stop_hook_active: false,
      last_assistant_message: 'hi',
    });
    expect(
      decode(
        PromptHookInput,
        JSON.stringify({ session_id: 's', prompt: 'x', cwd: '/' }),
      ),
    ).toStrictEqual({ session_id: 's', prompt: 'x' });
    expect(
      decode(
        PreToolHookInput,
        JSON.stringify({
          session_id: 's',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [] },
          mcp_server: 'x',
        }),
      ),
    ).toStrictEqual({
      session_id: 's',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] },
    });
    expect(() => decode(PromptHookInput, '{"prompt":"x"}')).toThrow();
    expect(decode(InboxSessionScratch, '{"lastSeenSeq":4}')).toStrictEqual({
      lastSeenSeq: 4,
    });
  });

  it('a null or wrongly typed key reads as absent, never costing the others', () => {
    const stop: Record<string, unknown> = {
      session_id: 's',
      prompt_id: 'p',
      stop_hook_active: true,
      last_assistant_message: 'hi',
      transcript_path: '/t.jsonl',
    };
    for (const key of Object.keys(stop)) {
      for (const bad of [null, 42]) {
        const { [key]: _dropped, ...rest } = stop;
        expect(
          decode(StopHookInput, JSON.stringify({ ...stop, [key]: bad })),
        ).toStrictEqual(rest);
      }
    }
    expect(
      decode(
        StopHookInput,
        '{"session_id":"s","stop_hook_active":true,"transcript_path":null,"prompt_id":null}',
      ),
    ).toStrictEqual({ session_id: 's', stop_hook_active: true });
    expect(
      decode(
        PromptHookInput,
        '{"session_id":"s","prompt_id":null,"prompt":"inbox off"}',
      ),
    ).toStrictEqual({ session_id: 's', prompt: 'inbox off' });
    expect(
      decode(
        PromptHookInput,
        '{"session_id":"s","prompt_id":"p","prompt":null}',
      ),
    ).toStrictEqual({ session_id: 's', prompt_id: 'p' });
    expect(
      decode(
        PreToolHookInput,
        '{"session_id":"s","prompt_id":null,"tool_name":"AskUserQuestion","tool_input":null}',
      ),
    ).toStrictEqual({
      session_id: 's',
      tool_name: 'AskUserQuestion',
      tool_input: null,
    });
    // A key the hook cannot decide without still fails the decode.
    expect(() =>
      decode(PromptHookInput, '{"session_id":null,"prompt":"x"}'),
    ).toThrow();
    expect(() =>
      decode(PreToolHookInput, '{"session_id":"s","tool_name":null}'),
    ).toThrow();
    for (const stdin of ['[]', 'null', '"s"', 'not json'])
      expect(() => decode(StopHookInput, stdin)).toThrow();
  });

  it('names a sidecar only for an id that is a safe file name', () => {
    expect(
      scratchFileName(SessionId.make('7c1e9a40-1b2c-4d5e-8f90-123456789abc')),
    ).toBe('7c1e9a40-1b2c-4d5e-8f90-123456789abc.json');
    expect(scratchFileName(SessionId.make('../x'))).toBeUndefined();
    expect(scratchFileName(SessionId.make('a/b'))).toBeUndefined();
    expect(scratchFileName(SessionId.make(''))).toBeUndefined();
  });
});
