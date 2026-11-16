import os from 'node:os';
import path from 'node:path';
import {
  Config,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Stream,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { binConfig } from './bin-config';
import { disconnect, RECURSION_MARKER } from './headless-agent';
import {
  assetsDirOf,
  CLASSIFIER_PROMPT_FILE,
  moduleDir,
} from './package-paths';

// Inbox mode's classifier: does an agent's last message ask the operator
// something? It runs on EVERY Stop of a session with the mode on, inside a
// hook with a 30 s budget, so it must be quick, quiet and harmless when it
// fails.
//
// - The judgement is the prompt's: `assets/classify-question.md`, shipped
//   with the CLI package (`package-paths.ts`), passed as the child's system
//   prompt (`--system-prompt`); stdin carries only the message, between
//   markers. This module only spawns the child and reads one word back.
// - `claude -p --model haiku --settings '{"disableAllHooks":true}'
//   --no-session-persistence --tools ""`, with `CLAUDE_CODE_DISABLE_CLAUDE_MDS`
//   set, from the OS temp dir.
//   Without persistence a classified Stop leaves no transcript of the agent's
//   last message under ~/.claude/projects. From the temp dir because a
//   project cwd would load that project's CLAUDE.md and MCP servers first,
//   which costs seconds. Hooks off, so the child's own Stop cannot recurse.
// - `ANTHROPIC_API_KEY` is removed from the child's environment, so the check
//   always runs on the subscription login rather than billing an API key.
// - stderr is piped and drained, never inherited: a hook's stderr is the
//   operator's transcript.
// - Bounded at 20 s, inside the hook's 30 s.
// - Skipped (answers `no`) inside a headless agent: a child with no operator
//   has nobody to ask.
//
// It fails with `QuestionClassifierError`; the guard treats every failure as
// `no`, so the turn ends (fail open).

export class QuestionClassifierError extends Data.TaggedError(
  'QuestionClassifierError',
)<{
  readonly message: string;
}> {}

export interface QuestionClassifierService {
  /** True when the message asks the operator something they must answer. */
  readonly asksOperator: (
    message: string,
  ) => Effect.Effect<boolean, QuestionClassifierError>;
}

export class QuestionClassifier extends Context.Service<
  QuestionClassifier,
  QuestionClassifierService
>()('operator-inbox/QuestionClassifier') {}

/** The classifier's prompt file, in the CLI package's assets. */
export const classifierPromptPath = (dir: string = moduleDir): string =>
  path.join(assetsDirOf(dir), CLASSIFIER_PROMPT_FILE);

/** The child's stdin: the message alone, between markers. */
export const classifierInput = (message: string): string =>
  `<<<BEGIN MESSAGE>>>\n${message}\n<<<END MESSAGE>>>\n`;

/**
 * The child's answer as a verdict: `yes` alone, in any case, with any
 * surrounding punctuation or quoting, is yes; anything else is no.
 */
export const parseVerdict = (stdout: string): boolean =>
  stdout
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '') === 'yes';

export const CLASSIFIER_ARGS: ReadonlyArray<string> = [
  '-p',
  '--model',
  'haiku',
  '--settings',
  '{"disableAllHooks":true}',
  '--no-session-persistence',
  // No tools: the child only labels the message.
  '--tools',
  '',
];

/**
 * The child's argv: the classifier's prompt replaces Claude Code's system prompt,
 * so the message on stdin is read as the thing to label rather than a task.
 * With the prompt and the message both on stdin, Haiku answered the message
 * instead and labelled "Which option do you want, A or B?" `no`.
 */
export const classifierArgs = (prompt: string): ReadonlyArray<string> => [
  ...CLASSIFIER_ARGS,
  '--system-prompt',
  prompt.trimEnd(),
];

export const CLASSIFIER_TIMEOUT = Duration.seconds(20);

const failed = (message: string) => new QuestionClassifierError({ message });

/** Collect a byte stream as text, failing into the classifier's error. */
const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Effect.map(Stream.runCollect(stream.pipe(Stream.decodeText())), (chunks) =>
    chunks.join(''),
  );

/**
 * The live classifier over the `claude` CLI; `timeout` and `promptFile` for
 * the tests.
 */
export const makeQuestionClassifierClaude = (
  opts: {
    readonly timeout?: Duration.Input;
    readonly promptFile?: string;
  } = {},
) =>
  Layer.effect(
    QuestionClassifier,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      return QuestionClassifier.of({
        asksOperator: (message) =>
          Effect.gen(function* () {
            // The headless-agent marker: set only inside a headless child, so a
            // classifier run never classifies its own child's messages.
            const inside = yield* Config.String(RECURSION_MARKER).pipe(
              Effect.orElseSucceed(() => ''),
            );
            if (inside !== '') return false;
            // Unset or empty: the `claude` on PATH.
            const bin = yield* binConfig(
              'OPERATOR_INBOX_CLAUDE_BIN',
              'claude',
            ).pipe(Effect.orElseSucceed(() => 'claude'));
            const promptFile = opts.promptFile ?? classifierPromptPath();
            const prompt = yield* fs
              .readFileString(promptFile)
              .pipe(
                Effect.mapError(() =>
                  failed(`cannot read the classifier prompt ${promptFile}`),
                ),
              );
            const cmd = ChildProcess.make(bin, classifierArgs(prompt), {
              cwd: os.tmpdir(),
              // Merged over process.env, so PATH stays; an `undefined` value
              // leaves the variable out of the child's environment.
              // The operator's CLAUDE.md files stay out of the child: they talk about
              // asking questions at length and swayed its verdicts.
              env: {
                [RECURSION_MARKER]: '1',
                ANTHROPIC_API_KEY: undefined,
                CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
              },
              extendEnv: true,
              stdin: Stream.make(
                new TextEncoder().encode(classifierInput(message)),
              ),
              stderr: 'pipe',
            });
            const run = Effect.scoped(
              Effect.gen(function* () {
                const proc = yield* spawner.spawn(cmd);
                // Both pipes drained together, so neither can fill and stall
                // the child before it exits.
                const [stdout, stderr] = yield* Effect.all(
                  [collectText(proc.stdout), collectText(proc.stderr)],
                  { concurrency: 2 },
                );
                const code = yield* proc.exitCode;
                return { stdout, stderr, code };
              }),
            ).pipe(
              Effect.mapError(() => failed(`could not run '${bin}'`)),
              // The timeout returns at once rather than wait on a hung
              // child's release.
              disconnect,
              Effect.timeoutOrElse({
                duration: opts.timeout ?? CLASSIFIER_TIMEOUT,
                orElse: () => Effect.fail(failed(`'${bin}' timed out`)),
              }),
            );
            const { stdout, stderr, code } = yield* run;
            if (code !== 0)
              return yield* failed(
                `'${bin}' exited ${code}: ${stderr.trim().split('\n')[0] ?? ''}`,
              );
            return parseVerdict(stdout);
          }),
      });
    }),
  );

export const QuestionClassifierClaude = makeQuestionClassifierClaude();

/** A stand-in classifier for tests: no spawn. */
export const makeTestQuestionClassifier = (
  asksOperator: QuestionClassifierService['asksOperator'],
) => Layer.succeed(QuestionClassifier, QuestionClassifier.of({ asksOperator }));
