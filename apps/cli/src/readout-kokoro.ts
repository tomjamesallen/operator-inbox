import path from 'node:path';
import { ReadoutTimedSegment } from '@operator-inbox/core/api';
import type { Cause } from 'effect';
import {
  Config,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { readHome } from './home-dir';
import { assetsDirOf, moduleDir } from './package-paths';
import {
  ReadoutVoiceError,
  type ReadoutVoiceService,
  type SpokenScript,
} from './readout-voice';

// Listen mode's first voice: Kokoro-82M, run locally through mlx-audio by a
// long-lived Python child (`assets/readout-kokoro.py`). The child is started
// the first time a script is spoken, never at serve's start, and lives in the
// scope this voice is made in, which is serve's, so it stops with serve. It
// also exits on its own when its stdin closes or its parent changes, so a
// serve that dies without closing it does not leave it behind.
//
// The protocol is JSON lines over the child's stdin and stdout, one request
// at a time; the script's header has it. A child that dies is started again
// by the next request; the request it was serving fails `failed`.
//
// The Python is the one mlx-audio is installed in: `OPERATOR_INBOX_READOUT_PYTHON`
// when it is set, else the interpreter that `mlx_audio.tts.generate` (the
// console script `uv tool install mlx-audio` puts on PATH) names, looked for on
// PATH and then in `~/.local/bin`, since serve often runs under launchd with a
// thin PATH.

export const READOUT_PYTHON_VAR = 'OPERATOR_INBOX_READOUT_PYTHON';
/** The model, in every voice id this adapter makes. */
export const KOKORO_MODEL = 'kokoro-82m-bf16';
export const READOUT_SCRIPT_FILE = 'readout-kokoro.py';
/** mlx-audio's console script, whose shebang names its Python. */
export const MLX_AUDIO_LAUNCHER = 'mlx_audio.tts.generate';
export const MLX_AUDIO_MISSING =
  'Listen mode needs mlx-audio: run `uv tool install mlx-audio`';

// The first load may download the model (about 330 MB), so it gets long.
const READY_WITHIN = Duration.minutes(10);
// One script at the contract's limits is long; a request that takes longer
// than this is taken as hung, and the child is stopped.
const SPOKEN_WITHIN = Duration.minutes(10);
const STDERR_TAIL = 20;

/**
 * The Python a launcher script runs under, from its text: a plain shebang
 * (`#!/…/bin/python`), or the `/bin/sh` trampoline a long path makes
 * (`'''exec' '/…/bin/python' "$0" "$@"`). Pure.
 */
export const pythonFromLauncher = (text: string): string | undefined => {
  const [first = '', second = ''] = text.split('\n', 2);
  if (!first.startsWith('#!')) return undefined;
  const interpreter = first.slice(2).trim().split(/\s+/)[0] ?? '';
  if (
    path.isAbsolute(interpreter) &&
    path.basename(interpreter).startsWith('python')
  ) {
    return interpreter;
  }
  const trampoline = /^'''exec' (?:'([^']+)'|"([^"]+)"|(\S+))/.exec(second);
  return trampoline?.[1] ?? trampoline?.[2] ?? trampoline?.[3];
};

/** Where to look for the launcher: each PATH entry, then `~/.local/bin`. Pure. */
export const launcherCandidates = (
  pathVar: string,
  home: string | undefined,
): ReadonlyArray<string> => [
  ...pathVar
    .split(':')
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, MLX_AUDIO_LAUNCHER)),
  ...(home === undefined
    ? []
    : [path.join(home, '.local', 'bin', MLX_AUDIO_LAUNCHER)]),
];

const unavailable = (message: string) =>
  new ReadoutVoiceError({ reason: 'unavailable', message });
const failed = (message: string) =>
  new ReadoutVoiceError({ reason: 'failed', message });

/** The Python mlx-audio is installed in, or `unavailable` saying how to get it. */
export const findReadoutPython: Effect.Effect<
  string,
  ReadoutVoiceError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const exists = (p: string) =>
    fs.exists(p).pipe(Effect.orElseSucceed(() => false));
  const named = (yield* Config.String(READOUT_PYTHON_VAR).pipe(
    Effect.orElseSucceed(() => ''),
  )).trim();
  if (named !== '') {
    if (yield* exists(named)) return named;
    return yield* unavailable(
      `${READOUT_PYTHON_VAR} names ${named}, which is not there`,
    );
  }
  const pathVar = yield* Config.String('PATH').pipe(
    Effect.orElseSucceed(() => ''),
  );
  const home = Option.getOrUndefined(yield* readHome);
  for (const launcher of launcherCandidates(pathVar, home)) {
    if (!(yield* exists(launcher))) continue;
    const text = yield* fs
      .readFileString(launcher)
      .pipe(Effect.orElseSucceed(() => ''));
    const python = pythonFromLauncher(text);
    if (python !== undefined && (yield* exists(python))) return python;
  }
  return yield* unavailable(MLX_AUDIO_MISSING);
});

// --- the child ---------------------------------------------------------------

const Reply = Schema.Union([
  Schema.Struct({ type: Schema.Literal('ready') }),
  Schema.Struct({
    type: Schema.Literal('fatal'),
    reason: Schema.Literals(['unavailable', 'failed']),
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('done'),
    duration: Schema.Number,
    segments: Schema.Array(ReadoutTimedSegment),
  }),
]);
type Reply = typeof Reply.Type;
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

interface Sidecar {
  readonly scope: Scope.Closeable;
  readonly dead: Ref.Ref<boolean>;
  readonly send: (line: string) => Effect.Effect<Reply, ReadoutVoiceError>;
}

// Start the child in a scope of its own under `parent`, and wait until it
// says it is ready. Closing that scope ends its stdin and stops it.
const startSidecar = (
  python: string,
  script: string,
  voice: string,
  parent: Scope.Scope,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.fork(parent, 'sequential');
    const stdin = yield* Queue.make<string, Cause.Done>();
    yield* Scope.addFinalizer(scope, Queue.end(stdin));
    const ready = yield* Deferred.make<void, ReadoutVoiceError>();
    const pending = yield* Ref.make(
      Option.none<Deferred.Deferred<Reply, ReadoutVoiceError>>(),
    );
    const dead = yield* Ref.make(false);
    const tail: Array<string> = [];
    const lastWords = () =>
      tail.length === 0 ? '' : `: ${tail.slice(-3).join(' / ')}`;

    const handle = yield* spawner
      .spawn(
        ChildProcess.make(python, ['-I', script, voice], {
          stdin: {
            stream: Stream.fromQueue(stdin).pipe(Stream.encodeText),
            endOnDone: true,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      )
      .pipe(
        Scope.provide(scope),
        Effect.mapError((e) =>
          failed(`could not start the voice (${python}): ${e.message}`),
        ),
      );

    // stderr: drained, and its last lines kept for the message when the
    // child dies.
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          tail.push(line);
          if (tail.length > STDERR_TAIL) tail.shift();
        }),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    const settle = (reply: Reply) =>
      Effect.gen(function* () {
        if (reply.type === 'ready') {
          yield* Deferred.succeed(ready, undefined);
          return;
        }
        if (reply.type === 'fatal') {
          yield* Deferred.fail(
            ready,
            new ReadoutVoiceError({
              reason: reply.reason,
              message: reply.message,
            }),
          );
          return;
        }
        const waiting = yield* Ref.getAndSet(pending, Option.none());
        if (Option.isSome(waiting))
          yield* Deferred.succeed(waiting.value, reply);
      });

    // stdout: the replies. When it ends, the child is gone: whatever waits
    // on it fails.
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const reply = decodeReply(line);
        return Option.isSome(reply) ? settle(reply.value) : Effect.void;
      }),
      Effect.ignore,
      Effect.andThen(
        Effect.gen(function* () {
          yield* Ref.set(dead, true);
          const gone = failed(`the voice stopped${lastWords()}`);
          yield* Deferred.fail(ready, gone);
          const waiting = yield* Ref.getAndSet(pending, Option.none());
          if (Option.isSome(waiting)) yield* Deferred.fail(waiting.value, gone);
          if (tail.length > 0) {
            yield* Effect.logWarning(
              `readout: the voice stopped; its last words:\n${tail.join('\n')}`,
            );
          }
        }),
      ),
      Effect.forkIn(scope),
    );

    const waitFor = <A>(
      effect: Effect.Effect<A, ReadoutVoiceError>,
      within: Duration.Duration,
      what: string,
    ) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: within,
          orElse: () =>
            Effect.fail(
              failed(`the voice did not ${what} in ${Duration.format(within)}`),
            ),
        }),
      );

    yield* waitFor(Deferred.await(ready), READY_WITHIN, 'start').pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );

    const send = (line: string) =>
      Effect.gen(function* () {
        if (yield* Ref.get(dead)) return yield* failed('the voice stopped');
        const reply = yield* Deferred.make<Reply, ReadoutVoiceError>();
        yield* Ref.set(pending, Option.some(reply));
        yield* Queue.offer(stdin, `${line}\n`);
        return yield* waitFor(Deferred.await(reply), SPOKEN_WITHIN, 'answer');
      });
    return { scope, dead, send } satisfies Sidecar;
  });

/**
 * The Kokoro voice `voice`, its child started on the first `speak` and kept
 * in the scope this runs in.
 */
export const makeKokoroVoice = (
  voice: string,
  script: string = path.join(assetsDirOf(moduleDir), READOUT_SCRIPT_FILE),
) =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope;
    const context = yield* Effect.context<
      FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
    >();
    const current = yield* Ref.make(Option.none<Sidecar>());
    const lock = yield* Semaphore.make(1);

    const drop = (sidecar: Sidecar) =>
      Ref.set(current, Option.none()).pipe(
        Effect.andThen(Scope.close(sidecar.scope, Exit.void)),
      );

    const sidecar = Effect.gen(function* () {
      const have = yield* Ref.get(current);
      if (Option.isSome(have)) {
        if (!(yield* Ref.get(have.value.dead))) return have.value;
        yield* drop(have.value);
      }
      const python = yield* findReadoutPython;
      const started = yield* startSidecar(python, script, voice, parent);
      yield* Ref.set(current, Option.some(started));
      return started;
    });

    const speak = (
      segments: Parameters<ReadoutVoiceService['speak']>[0],
      to: string,
    ) =>
      Semaphore.withPermits(
        lock,
        1,
      )(
        Effect.gen(function* () {
          const child = yield* sidecar;
          const reply = yield* child
            .send(JSON.stringify({ segments, out: to }))
            // A child that hung or died is stopped, so the next request
            // starts a fresh one.
            .pipe(Effect.tapError(() => drop(child)));
          if (reply.type === 'done') {
            return {
              duration: reply.duration,
              segments: reply.segments,
            } satisfies SpokenScript;
          }
          return yield* failed(
            reply.type === 'error' || reply.type === 'fatal'
              ? reply.message
              : 'the voice answered out of turn',
          );
        }),
      ).pipe(Effect.provide(context));

    return {
      id: `${KOKORO_MODEL}/${voice}`,
      voice,
      available: Effect.asVoid(findReadoutPython).pipe(Effect.provide(context)),
      speak,
    } satisfies ReadoutVoiceService;
  });
