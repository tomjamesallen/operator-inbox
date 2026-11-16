import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  GUARD_BLOCK_REASON,
  type InboxEvent,
  InboxId,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import { ConfigProvider, Effect, Layer, Option } from 'effect';
import { dispatchAsk, dispatchOpen, hookOutput } from '../src/commands/inbox';
import { envProvider } from '../src/env-config';
import { InputError } from '../src/errors';
import {
  dispatchMode,
  dispatchPreToolHook,
  dispatchPromptHook,
  dispatchStopGuard,
} from '../src/inbox-mode-hooks';
import {
  InboxLog,
  InboxLogInMemory,
  inboxLogLive,
  makeInboxLogLazy,
} from '../src/inbox-store';
import { readOwnerFingerprint } from '../src/process-edge';
import {
  makeTestQuestionClassifier,
  type QuestionClassifier,
  QuestionClassifierError,
} from '../src/question-classifier';

// Inbox mode's hooks and its switch, end to end against the in-memory log, a
// temporary folder for the sidecars and a stand-in classifier. The stdin
// fixtures carry the keys the real payloads carry, so the lenient decoding is
// exercised on the real shape.

const SESSION = SessionId.make('7c1e9a40-1b2c-4d5e-8f90-123456789abc');
const ID = InboxId.make('01INBOXM0DEAAAAAAAAAAAAAAA');

const stopPayload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    background_tasks: [],
    cwd: '/work/my-app',
    hook_event_name: 'Stop',
    last_assistant_message: 'Which of the two schemas do you want?',
    permission_mode: 'auto',
    prompt_id: 'prompt-1',
    session_crons: [],
    session_id: SESSION,
    stop_hook_active: false,
    transcript_path: '/tmp/transcript.jsonl',
    ...over,
  });

const promptPayload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    cwd: '/work/my-app',
    hook_event_name: 'UserPromptSubmit',
    permission_mode: 'auto',
    prompt: 'why that one?',
    prompt_id: 'prompt-1',
    session_id: SESSION,
    ...over,
  });

const preToolPayload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    cwd: '/work/my-app',
    hook_event_name: 'PreToolUse',
    mcp_server: 'ccd_turn',
    permission_mode: 'auto',
    prompt_id: 'prompt-2',
    session_id: SESSION,
    tool_input: { recap: 'Done.', ask: 'Proceed?' },
    tool_name: 'mcp__ccd_turn__wrap_up',
    tool_use_id: 'toolu_1',
    ...over,
  });

/** A classifier answering `verdict`, counting its calls. */
const classifier = (
  verdict: boolean | 'fail' | 'die' = true,
  calls: Array<string> = [],
) =>
  makeTestQuestionClassifier((message) => {
    calls.push(message);
    if (verdict === 'fail')
      return Effect.fail(new QuestionClassifierError({ message: 'timed out' }));
    if (verdict === 'die') return Effect.die(new Error('boom'));
    return Effect.succeed(verdict);
  });

/**
 * Record THIS test process as the Inbox's watcher, so the guard's watcher
 * check passes and a test sees only the mode's own decision.
 */
const watched = (folder: string) =>
  Effect.gen(function* () {
    const reading = yield* readOwnerFingerprint(process.pid);
    if (reading.kind !== 'alive') throw new Error('cannot read own process');
    const dir = join(folder, 'inbox-watchers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${ID}.${process.pid}.json`),
      JSON.stringify({
        inboxId: ID,
        pid: process.pid,
        fingerprint: reading.fingerprint,
      }),
    );
  });

const run = <A, E>(
  folder: string,
  body: Effect.Effect<
    A,
    E,
    InboxLog | QuestionClassifier | NodeServices.NodeServices
  >,
  classify = classifier(),
) =>
  // The inbox's file is there (empty: the log is in memory), as on any
  // machine that has used the inbox; the hooks read nothing without it.
  Effect.andThen(
    Effect.sync(() => writeFileSync(join(folder, 'inbox.sqlite'), '')),
    body,
  ).pipe(
    Effect.provide(InboxLogInMemory),
    Effect.provide(classify),
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({
        OPERATOR_INBOX_DATABASE_PATH: join(folder, 'inbox.sqlite'),
        XDG_CONFIG_HOME: folder,
      }),
    ),
  );

const sidecar = (folder: string) =>
  join(folder, 'inbox-sessions', `${SESSION}.json`);
const readSidecar = (folder: string) =>
  JSON.parse(readFileSync(sidecar(folder), 'utf8'));

const openInbox = dispatchOpen({
  session: Option.some({ sessionId: SESSION, cwd: '/w' }),
  inbox: Option.none(),
  label: Option.some('mode demo'),
  freshId: ID,
  cwd: '/w',
});
const modeOn = dispatchMode({ session: Option.some(SESSION), state: 'on' });
const modeOff = dispatchMode({ session: Option.some(SESSION), state: 'off' });

/** The mode events in the session's tag. */
const modeEvents = Effect.flatMap(InboxLog, (log) =>
  Effect.map(log.readSession(SESSION), ({ events }) =>
    events.filter(
      (e): e is Extract<InboxEvent, { _tag: 'InboxModeOn' | 'InboxModeOff' }> =>
        e._tag === 'InboxModeOn' || e._tag === 'InboxModeOff',
    ),
  ),
);

const guard = (stdin = stopPayload()) =>
  dispatchStopGuard({
    stdin,
    fallbackSession: Effect.die(new Error('stdin had the session')),
  });

const fresh = () => mkdtempSync(join(tmpdir(), 'inbox-mode-'));

describe('inbox mode on|off', () => {
  it.effect('on appends once, writes the sidecar, and is idempotent', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        expect(yield* modeOn).toContain('inbox mode on');
        expect(readSidecar(folder)).toStrictEqual({});
        expect(yield* modeOn).toContain('already on');
        const events = yield* modeEvents;
        expect(events.map((e) => e._tag)).toStrictEqual(['InboxModeOn']);
        // The session still finds its inbox through its tag.
        const log = yield* InboxLog;
        expect(yield* log.findBySession(SESSION)).toStrictEqual(
          Option.some(ID),
        );
      }),
    );
  });

  it.effect('off appends with reason command and removes the sidecar', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        expect(yield* modeOff).toContain('inbox mode off');
        expect(existsSync(sidecar(folder))).toBe(false);
        expect(yield* modeOff).toContain('already off');
        expect((yield* modeEvents).at(-1)).toStrictEqual({
          _tag: 'InboxModeOff',
          inboxId: ID,
          sessionId: SESSION,
          reason: 'command',
        });
      }),
    );
  });

  it.effect('needs a session and an inbox', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        const outside = yield* Effect.flip(
          dispatchMode({ session: Option.none(), state: 'on' }),
        );
        expect(outside).toBeInstanceOf(InputError);
        const noInbox = yield* Effect.flip(modeOn);
        expect(noInbox.message).toContain('operator-inbox open');
      }),
    );
  });
});

describe('inbox hook prompt', () => {
  it.effect('with the mode off it writes nothing, not even a sidecar', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        expect(yield* dispatchPromptHook(promptPayload())).toBe('');
        expect(
          yield* dispatchPromptHook(promptPayload({ prompt: 'inbox off' })),
        ).toBe('');
        expect(existsSync(sidecar(folder))).toBe(false);
      }),
    );
  });

  it.effect('a typed prompt pauses the mode for that prompt', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        expect(yield* dispatchPromptHook(promptPayload())).toBe('');
        expect(readSidecar(folder)).toStrictEqual({
          pausedPromptId: 'prompt-1',
        });
      }),
    );
  });

  it.effect('a Monitor wake-up and the watcher line do not pause', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        yield* dispatchPromptHook(
          promptPayload({
            prompt:
              '<task-notification>\n<task-id>b1</task-id>\n<event>inbox: 1 new answer in "mode demo" — run `operator-inbox answers`</event>',
            prompt_id: 'wake-1',
          }),
        );
        yield* dispatchPromptHook(
          promptPayload({
            prompt:
              'inbox: 2 new answers in "mode demo" — run `operator-inbox answers`',
            prompt_id: 'wake-2',
          }),
        );
        expect(readSidecar(folder)).toStrictEqual({});
      }),
    );
  });

  it.effect('an off phrase turns the mode off and offers the archive', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        const out = JSON.parse(
          yield* dispatchPromptHook(promptPayload({ prompt: 'Inbox off.' })),
        );
        expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
        expect(out.hookSpecificOutput.additionalContext).toContain(
          'operator-inbox archive',
        );
        expect((yield* modeEvents).at(-1)).toMatchObject({
          _tag: 'InboxModeOff',
          reason: 'phrase',
        });
        expect(existsSync(sidecar(folder))).toBe(false);
        // A phrase inside a longer prompt is not one.
        yield* modeOn;
        expect(
          yield* dispatchPromptHook(
            promptPayload({ prompt: "don't ask me here, use the inbox" }),
          ),
        ).toBe('');
        expect((yield* modeEvents).at(-1)?._tag).toBe('InboxModeOn');
      }),
    );
  });
});

describe('inbox hook pre-tool', () => {
  it.effect('denies a wrap_up ask and AskUserQuestion while on', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        const out = JSON.parse(yield* dispatchPreToolHook(preToolPayload()));
        expect(out.hookSpecificOutput).toMatchObject({
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        });
        expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
          'operator-inbox ask',
        );
        expect(
          yield* dispatchPreToolHook(
            preToolPayload({ tool_name: 'AskUserQuestion', tool_input: {} }),
          ),
        ).toContain('"deny"');
        // A wrap_up with no ask is left alone.
        expect(
          yield* dispatchPreToolHook(
            preToolPayload({ tool_input: { recap: 'Done.' } }),
          ),
        ).toBe('');
      }),
    );
  });

  it.effect('allows everything while off, and for the paused prompt', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        expect(yield* dispatchPreToolHook(preToolPayload())).toBe('');
        yield* modeOn;
        yield* dispatchPromptHook(promptPayload({ prompt_id: 'prompt-2' }));
        expect(yield* dispatchPreToolHook(preToolPayload())).toBe('');
        expect(
          yield* dispatchPreToolHook(preToolPayload({ prompt_id: 'prompt-3' })),
        ).toContain('"deny"');
      }),
    );
  });
});

describe("the mode is the log's, not the sidecar's", () => {
  it.effect(
    'a missing sidecar leaves the mode on, a stray one leaves it off',
    () => {
      const folder = fresh();
      return run(
        folder,
        Effect.gen(function* () {
          yield* openInbox;
          yield* modeOn;
          rmSync(sidecar(folder));
          expect(yield* dispatchPreToolHook(preToolPayload())).toContain(
            '"deny"',
          );
          yield* modeOff;
          writeFileSync(sidecar(folder), '{}');
          expect(yield* dispatchPreToolHook(preToolPayload())).toBe('');
        }),
      );
    },
  );
});

describe('the session cycle conditions on the session tag (DCB)', () => {
  /**
   * The in-memory log, with `interfere` landing right after each read of the
   * session's tag, between the cycle's read and its append, once armed.
   */
  const interfering = (
    interfere: (
      base: InboxLog['Service'],
      call: number,
    ) => Effect.Effect<void, unknown>,
  ) => {
    const state = { armed: false, calls: 0 };
    const layer = Layer.effect(
      InboxLog,
      Effect.map(InboxLog, (base) =>
        InboxLog.of({
          ...base,
          readSession: (id) =>
            Effect.tap(base.readSession(id), () => {
              if (!state.armed) return Effect.void;
              state.calls += 1;
              return Effect.orDie(interfere(base, state.calls));
            }),
        }),
      ),
    ).pipe(Layer.provide(InboxLogInMemory));
    return { state, layer };
  };

  const runOn = <A, E>(
    folder: string,
    layer: Layer.Layer<InboxLog>,
    body: Effect.Effect<
      A,
      E,
      InboxLog | QuestionClassifier | NodeServices.NodeServices
    >,
  ) =>
    body.pipe(
      Effect.provide(layer),
      Effect.provide(classifier()),
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        envProvider({
          OPERATOR_INBOX_DATABASE_PATH: join(folder, 'inbox.sqlite'),
          XDG_CONFIG_HOME: folder,
        }),
      ),
    );

  it.effect(
    'a question landing in the Inbox meanwhile does not conflict',
    () => {
      const folder = fresh();
      // Every read is overtaken: an inbox-boundary condition would conflict
      // on both tries and fail the command.
      const { state, layer } = interfering((base, call) =>
        Effect.flatMap(base.read(ID), ({ head }) =>
          base.append(
            [
              {
                _tag: 'QuestionAsked',
                inboxId: ID,
                number: QuestionNumber.make(call),
                title: `Q${call}`,
                body: '',
              },
            ],
            { after: head },
          ),
        ),
      );
      return runOn(
        folder,
        layer,
        Effect.gen(function* () {
          yield* openInbox;
          state.armed = true;
          expect(yield* modeOn).toContain('inbox mode on');
          expect(state.calls).toBe(1);
        }),
      );
    },
  );

  it.effect('the session adopting another Inbox meanwhile does', () => {
    const folder = fresh();
    const ID2 = InboxId.make('01INBOXM0DEBBBBBBBBBBBBBBB');
    // Only the first read is overtaken; the retry decides on the adoption.
    const { state, layer } = interfering((base, call) =>
      call > 1
        ? Effect.void
        : Effect.flatMap(base.read(ID2), ({ head }) =>
            base.append(
              [{ _tag: 'InboxAdopted', inboxId: ID2, sessionId: SESSION }],
              { after: head },
            ),
          ),
    );
    return runOn(
      folder,
      layer,
      Effect.gen(function* () {
        yield* openInbox;
        state.armed = true;
        expect(yield* modeOn).toContain(`inbox ${ID2}`);
        expect(state.calls).toBe(2);
        expect((yield* modeEvents).at(-1)).toMatchObject({
          _tag: 'InboxModeOn',
          inboxId: ID2,
        });
      }),
    );
  });
});

describe('inbox guard, in inbox mode', () => {
  it.effect('blocks a message that asks the operator something', () => {
    const folder = fresh();
    const calls: Array<string> = [];
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        const out = JSON.parse(yield* guard());
        expect(out).toStrictEqual({
          decision: 'block',
          reason: GUARD_BLOCK_REASON,
        });
        expect(calls).toStrictEqual(['Which of the two schemas do you want?']);
        // A block is not a pass: no head recorded.
        expect(readSidecar(folder)).toStrictEqual({});
        // The second stop is let through, and records the head.
        expect(yield* guard(stopPayload({ stop_hook_active: true }))).toBe('');
        expect(readSidecar(folder).lastSeenSeq).toBeGreaterThan(0);
      }),
      classifier(true, calls),
    );
  });

  it.effect('a "no" lets the turn end and records the head', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        yield* watched(folder);
        expect(yield* guard()).toBe('');
        expect(readSidecar(folder).lastSeenSeq).toBeGreaterThan(0);
      }),
      classifier(false),
    );
  });

  it.effect('a classifier failure or defect fails open', () => {
    const folder = fresh();
    return Effect.gen(function* () {
      for (const verdict of ['fail', 'die'] as const) {
        const out = yield* run(
          folder,
          Effect.gen(function* () {
            yield* openInbox;
            yield* modeOn;
            yield* watched(folder);
            return yield* hookOutput(stopPayload(), (stdin) => guard(stdin));
          }),
          classifier(verdict),
        );
        expect(out).toBe('');
      }
    });
  });

  it.effect('a question asked this turn skips the classifier', () => {
    const folder = fresh();
    const calls: Array<string> = [];
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        yield* dispatchAsk({ inboxId: ID, title: 'Schema?', body: '' });
        // The watcher check still runs: a question waits, nothing watches.
        const out = JSON.parse(yield* guard());
        expect(out.reason).toContain('operator-inbox watch');
        expect(calls).toStrictEqual([]);
      }),
      classifier(true, calls),
    );
  });

  it.effect('a paused prompt skips the classifier', () => {
    const folder = fresh();
    const calls: Array<string> = [];
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        yield* watched(folder);
        yield* dispatchPromptHook(promptPayload());
        expect(yield* guard()).toBe('');
        expect(calls).toStrictEqual([]);
        expect(readSidecar(folder)).toMatchObject({
          pausedPromptId: 'prompt-1',
        });
        expect(readSidecar(folder).lastSeenSeq).toBeGreaterThan(0);
      }),
      classifier(true, calls),
    );
  });

  it.effect('every ? in code, or a blank message, skips the classifier', () => {
    const folder = fresh();
    const calls: Array<string> = [];
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        yield* watched(folder);
        expect(
          yield* guard(
            stopPayload({ last_assistant_message: 'Ran `ls ?.ts`; three.' }),
          ),
        ).toBe('');
        expect(
          yield* guard(stopPayload({ last_assistant_message: '   ' })),
        ).toBe('');
        expect(calls).toStrictEqual([]);
      }),
      classifier(true, calls),
    );
  });

  it.effect('with the mode off it is the watcher guard as before', () => {
    const folder = fresh();
    const calls: Array<string> = [];
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        // Idle, but the operator can ask from the app: still watched for.
        expect(JSON.parse(yield* guard()).reason).toContain(
          'a question the operator asks',
        );
        yield* dispatchAsk({ inboxId: ID, title: 'Q?', body: '' });
        expect(JSON.parse(yield* guard()).reason).toContain(
          'operator-inbox watch',
        );
        expect(calls).toStrictEqual([]);
        expect(existsSync(sidecar(folder))).toBe(false);
      }),
      classifier(true, calls),
    );
  });

  it.effect('falls back to the process walk only without session_id', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        yield* watched(folder);
        const out = yield* dispatchStopGuard({
          stdin: stopPayload({ session_id: undefined }),
          fallbackSession: Effect.succeed(Option.some(SESSION)),
        });
        expect(JSON.parse(out).decision).toBe('block');
        // Malformed stdin: the fallback session, and an empty message.
        expect(
          yield* dispatchStopGuard({
            stdin: 'not json',
            fallbackSession: Effect.succeed(Option.some(SESSION)),
          }),
        ).toBe('');
        expect(
          yield* dispatchStopGuard({
            stdin: '{}',
            fallbackSession: Effect.succeed(Option.none()),
          }),
        ).toBe('');
      }),
    );
  });
});

describe('a null key costs only itself', () => {
  it.effect(
    'the guard still sees stop_hook_active beside a null key, and lets the turn end',
    () => {
      const folder = fresh();
      const calls: Array<string> = [];
      return run(
        folder,
        Effect.gen(function* () {
          yield* openInbox;
          yield* modeOn;
          expect(JSON.parse(yield* guard()).decision).toBe('block');
          for (const key of [
            'transcript_path',
            'prompt_id',
            'last_assistant_message',
          ])
            expect(
              yield* guard(
                stopPayload({ stop_hook_active: true, [key]: null }),
              ),
            ).toBe('');
          // Only the first stop reached the classifier: never twice.
          expect(calls).toHaveLength(1);
          expect(readSidecar(folder).lastSeenSeq).toBeGreaterThan(0);
        }),
        classifier(true, calls),
      );
    },
  );

  it.effect(
    'a null session_id in the Stop payload walks the process tree',
    () => {
      const folder = fresh();
      return run(
        folder,
        Effect.gen(function* () {
          yield* openInbox;
          yield* modeOn;
          const out = yield* dispatchStopGuard({
            stdin: stopPayload({ session_id: null, transcript_path: null }),
            fallbackSession: Effect.succeed(Option.some(SESSION)),
          });
          expect(JSON.parse(out).decision).toBe('block');
        }),
      );
    },
  );

  it.effect('a null prompt_id still honours an off phrase', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        const out = yield* dispatchPromptHook(
          promptPayload({ prompt: 'inbox off', prompt_id: null }),
        );
        expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(
          'operator-inbox archive',
        );
        expect((yield* modeEvents).at(-1)).toMatchObject({
          _tag: 'InboxModeOff',
          reason: 'phrase',
        });
      }),
    );
  });

  it.effect(
    'a null prompt_id or tool_input still denies AskUserQuestion',
    () => {
      const folder = fresh();
      return run(
        folder,
        Effect.gen(function* () {
          yield* openInbox;
          yield* modeOn;
          expect(
            yield* dispatchPreToolHook(
              preToolPayload({
                tool_name: 'AskUserQuestion',
                prompt_id: null,
                tool_input: null,
                mcp_server: null,
              }),
            ),
          ).toContain('"deny"');
        }),
      );
    },
  );
});

describe('inbox hook prompt, harness-written prompts', () => {
  it.effect(
    'a prompt opening with a tag does not pause; one opening with < does',
    () => {
      const folder = fresh();
      return run(
        folder,
        Effect.gen(function* () {
          yield* openInbox;
          yield* modeOn;
          const harness = [
            '<cross-session-message from="peer">ready</cross-session-message>',
            '<agent-message id="a1">done</agent-message>',
            '<ci-monitor-event>\n{"status":"failed"}\n</ci-monitor-event>',
            '<scheduled-task name="nightly">go</scheduled-task>',
            '<system-reminder>\nx\n</system-reminder>\n<agent-message id="a2">hi</agent-message>',
          ];
          for (const [i, prompt] of harness.entries())
            expect(
              yield* dispatchPromptHook(
                promptPayload({ prompt, prompt_id: `harness-${i}` }),
              ),
            ).toBe('');
          expect(readSidecar(folder)).toStrictEqual({});
          yield* dispatchPromptHook(
            promptPayload({ prompt: '<3 that worked', prompt_id: 'typed-1' }),
          );
          expect(readSidecar(folder)).toStrictEqual({
            pausedPromptId: 'typed-1',
          });
        }),
      );
    },
  );
});

describe('the hooks fail open', () => {
  it.effect('malformed stdin prints nothing', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        for (const stdin of ['', 'not json', '{"prompt":"x"}', '[]', 'null'])
          for (const hook of [dispatchPromptHook, dispatchPreToolHook])
            expect(yield* hookOutput(stdin, hook)).toBe('');
      }),
    );
  });

  it.effect('a log that cannot be opened prints nothing', () => {
    const folder = fresh();
    // The file is there, so the hooks go on to open the log, which fails.
    return Effect.gen(function* () {
      yield* Effect.sync(() => writeFileSync(join(folder, 'inbox.sqlite'), ''));
      const broken = makeInboxLogLazy(
        Layer.effect(
          InboxLog,
          Effect.fail(new InputError({ message: 'no store' })),
        ),
      );
      const outs = yield* Effect.all([
        hookOutput(promptPayload(), dispatchPromptHook),
        hookOutput(preToolPayload(), dispatchPreToolHook),
        hookOutput(stopPayload(), (stdin) => guard(stdin)),
      ]).pipe(
        Effect.provide(broken),
        Effect.provide(classifier()),
        Effect.provide(NodeServices.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          envProvider({
            OPERATOR_INBOX_DATABASE_PATH: join(folder, 'inbox.sqlite'),
            XDG_CONFIG_HOME: folder,
          }),
        ),
      );
      expect(outs).toStrictEqual(['', '', '']);
    });
  });

  it.effect(
    'without the inbox file the hooks read nothing and create nothing',
    () => {
      const folder = fresh();
      const file = join(folder, 'inbox.sqlite');
      // The live store: had any hook opened the log, the file would be there.
      return Effect.gen(function* () {
        const outs = yield* Effect.all([
          dispatchPromptHook(promptPayload()),
          dispatchPromptHook(promptPayload({ prompt: 'inbox off' })),
          dispatchPreToolHook(preToolPayload()),
          guard(),
          guard(stopPayload({ stop_hook_active: true })),
        ]).pipe(
          Effect.provide(makeInboxLogLazy(inboxLogLive)),
          Effect.provide(classifier()),
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            envProvider({
              OPERATOR_INBOX_DATABASE_PATH: file,
              XDG_CONFIG_HOME: folder,
            }),
          ),
        );
        expect(outs).toStrictEqual(['', '', '', '', '']);
        expect(readdirSync(folder)).toStrictEqual([]);
      });
    },
  );

  it.effect('a corrupt sidecar reads as empty', () => {
    const folder = fresh();
    return run(
      folder,
      Effect.gen(function* () {
        yield* openInbox;
        yield* modeOn;
        writeFileSync(sidecar(folder), '{not json');
        expect(yield* dispatchPromptHook(promptPayload())).toBe('');
        expect(readSidecar(folder)).toStrictEqual({
          pausedPromptId: 'prompt-1',
        });
      }),
    );
  });
});
