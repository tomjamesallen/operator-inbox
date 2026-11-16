import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { afterEach, describe, expect, it, vi } from '@effect/vitest';
import { Clock, ConfigProvider, Effect, FileSystem, Result } from 'effect';
import { envProvider } from '../src/env-config';
import {
  classifierArgs,
  classifierInput,
  makeQuestionClassifierClaude,
  parseVerdict,
  QuestionClassifier,
  QuestionClassifierError,
} from '../src/question-classifier';
import { writeStubBin } from './stub-fixtures';

// Inbox mode's classifier over a stub `claude` (`OPERATOR_INBOX_CLAUDE_BIN`), with
// no live model: the verdict parse, the child's argv, stdin, cwd and
// environment, and every failure surfacing as `QuestionClassifierError` for
// the guard to fail open on. The prompt is the real skill-owned file.

const withConfig = (entries: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, envProvider(entries));

const ask = (bin: string, message = 'Shall I merge?', extra = {}) =>
  Effect.flatMap(QuestionClassifier, (c) => c.asksOperator(message)).pipe(
    Effect.provide(makeQuestionClassifierClaude({ timeout: '2 seconds' })),
    withConfig({ OPERATOR_INBOX_CLAUDE_BIN: bin, ...extra }),
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseVerdict', () => {
  it('reads yes alone, loosely, and everything else as no', () => {
    expect(parseVerdict('yes')).toBe(true);
    expect(parseVerdict(' Yes.\n')).toBe(true);
    expect(parseVerdict('`yes`')).toBe(true);
    expect(parseVerdict('no')).toBe(false);
    expect(parseVerdict('yes, it asks')).toBe(false);
    expect(parseVerdict('')).toBe(false);
  });

  it('puts the message alone between markers', () => {
    expect(classifierInput('Hello?')).toBe(
      '<<<BEGIN MESSAGE>>>\nHello?\n<<<END MESSAGE>>>\n',
    );
  });

  it('passes the prompt as the system prompt, after no tools', () => {
    expect(classifierArgs('Label it.\n').slice(-4)).toEqual([
      '--tools',
      '',
      '--system-prompt',
      'Label it.',
    ]);
  });
});

describe('QuestionClassifier over a stub claude', () => {
  it.effect('answers from the stub, which sees argv, stdin, cwd and env', () =>
    Effect.gen(function* () {
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-placeholder');
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory();
      const seen = path.join(dir, 'seen');
      const bin = yield* writeStubBin(
        'claude-stub',
        [
          '#!/bin/sh',
          `{ echo "args:$*"; echo "cwd:$(pwd -P)"; echo "key:\${ANTHROPIC_API_KEY-unset}"; echo "marker:\${OPERATOR_INBOX_INSIDE_HEADLESS_AGENT-unset}"; echo "mds:\${CLAUDE_CODE_DISABLE_CLAUDE_MDS-unset}"; cat; } > "${seen}"`,
          'echo "spam" >&2',
          'echo Yes',
        ].join('\n'),
      );
      expect(yield* ask(bin)).toBe(true);
      const record = yield* fs.readFileString(seen);
      expect(record).toContain(
        'args:-p --model haiku --settings {"disableAllHooks":true} --no-session-persistence --tools  --system-prompt You label one message.',
      );
      expect(record).toContain(`cwd:${realpathSync(tmpdir())}`);
      expect(record).toContain('key:unset');
      expect(record).toContain('marker:1');
      expect(record).toContain('mds:1');
      expect(record).toContain('Reply with exactly one word');
      expect(record).toContain(
        '<<<BEGIN MESSAGE>>>\nShall I merge?\n<<<END MESSAGE>>>',
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('anything but yes is no', () =>
    Effect.gen(function* () {
      const bin = yield* writeStubBin(
        'claude-stub',
        '#!/bin/sh\ncat >/dev/null\necho "I think so"',
      );
      expect(yield* ask(bin)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('a non-zero exit fails', () =>
    Effect.gen(function* () {
      const bin = yield* writeStubBin(
        'claude-stub',
        '#!/bin/sh\necho "not logged in" >&2\nexit 1',
      );
      const r = yield* Effect.result(ask(bin));
      expect(Result.isFailure(r)).toBe(true);
      if (Result.isFailure(r)) {
        expect(r.failure).toBeInstanceOf(QuestionClassifierError);
        expect(r.failure.message).toContain('not logged in');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('an empty OPERATOR_INBOX_CLAUDE_BIN runs the claude on PATH', () =>
    Effect.gen(function* () {
      const bin = yield* writeStubBin('claude', '#!/bin/sh\necho yes');
      vi.stubEnv('PATH', path.dirname(bin));
      expect(yield* ask('')).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('a missing bin fails', () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(ask('/nonexistent/claude-nowhere'));
      expect(Result.isFailure(r)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // The real clock: the bound races a real subprocess.
  it.live('a hung child times out', () =>
    Effect.gen(function* () {
      const bin = yield* writeStubBin('claude-stub', '#!/bin/sh\nsleep 10');
      const started = yield* Clock.currentTimeMillis;
      const r = yield* Effect.result(
        Effect.flatMap(QuestionClassifier, (c) => c.asksOperator('x')).pipe(
          Effect.provide(
            makeQuestionClassifierClaude({ timeout: '200 millis' }),
          ),
          withConfig({ OPERATOR_INBOX_CLAUDE_BIN: bin }),
        ),
      );
      expect(Result.isFailure(r)).toBe(true);
      if (Result.isFailure(r)) expect(r.failure.message).toContain('timed out');
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('inside a headless agent it answers no without spawning', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory();
      const sentinel = path.join(dir, 'ran');
      const bin = yield* writeStubBin(
        'claude-stub',
        `#!/bin/sh\ntouch "${sentinel}"\necho yes`,
      );
      expect(
        yield* ask(bin, 'Shall I?', {
          OPERATOR_INBOX_INSIDE_HEADLESS_AGENT: '1',
        }),
      ).toBe(false);
      expect(yield* fs.exists(sentinel)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
