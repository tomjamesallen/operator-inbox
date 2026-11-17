import path from 'node:path';
import { render, toneOf, type WidgetConfig } from '@operator-inbox/core';
import type { WidgetRunDto } from '@operator-inbox/core/api';
import {
  Clock,
  Config,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Result,
  type Scope,
  Stream,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { readHome } from './home-dir';

// One run of a widget's command, as serve's runner (`serve-widgets.ts`) makes
// it: `/bin/bash -c <command>` through the spawner, in its own process group,
// with the widget's environment, its stdout kept up to a cap and the last line
// of its stderr, ended at its timeout, and a templated `json` widget's output
// mapped to the envelope the page reads.

/** The most of a run's stdout that is kept; the rest is read and dropped. */
export const WIDGET_STDOUT_CAP = 8 * 1024;
// The most of stderr kept to find its last line in, and the most of that line.
const STDERR_KEPT = 8 * 1024;
const STDERR_LINE_CAP = 500;
/** How long a timed-out command has after SIGTERM before its group is sent SIGKILL. */
export const WIDGET_KILL_GRACE = Duration.millis(1500);
// How long, once the command has exited, its output streams have to close: a
// job it left in the background may hold them open for ever.
const OUTPUT_GRACE = Duration.millis(250);
// The search path a `path` entry goes in front of when serve has no `PATH`.
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** What a run is spawned with beyond serve's own environment. */
export interface WidgetEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}

// A `path` entry with a leading `~` read as the home folder, as a shell would.
const expandHome = (entry: string, home: Option.Option<string>): string =>
  Option.match(home, {
    onNone: () => entry,
    onSome: (h) =>
      entry === '~'
        ? h
        : entry.startsWith('~/')
          ? path.join(h, entry.slice(2))
          : entry,
  });

/**
 * A widget's environment: serve's own (the spawner extends it), with the
 * file's `path` entries in front of `PATH`, colour asked for (a command
 * writing to a pipe drops it otherwise), a narrow terminal width, and the
 * widget's id. It runs in the home folder. `PATH` and `HOME` are read through
 * `Config`, as every environment variable is.
 */
export const widgetEnvironment = (
  id: string,
  pathEntries: ReadonlyArray<string>,
): Effect.Effect<WidgetEnvironment> =>
  Effect.gen(function* () {
    const home = yield* readHome;
    const servePath = yield* Config.option(Config.String('PATH')).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.map(Option.filter((p) => p.trim() !== '')),
    );
    const searched =
      pathEntries.length === 0
        ? Option.getOrUndefined(servePath)
        : [
            ...pathEntries.map((entry) => expandHome(entry, home)),
            Option.getOrElse(servePath, () => FALLBACK_PATH),
          ].join(':');
    return {
      env: {
        FORCE_COLOR: '1',
        CLICOLOR_FORCE: '1',
        COLUMNS: '40',
        OPERATOR_INBOX_WIDGET: id,
        ...(searched === undefined ? {} : { PATH: searched }),
      },
      cwd: Option.getOrUndefined(home),
    };
  });

// --- the output ---------------------------------------------------------------

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

// The first `cap` bytes of a stream, and whether there was more.
const headOf = (cap: number) => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  let truncated = false;
  return {
    push: (chunk: Uint8Array) => {
      const room = cap - size;
      if (chunk.length > room) truncated = true;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      size += kept.length;
    },
    // Decoded as a stream that may go on, so a character the cap cut in two
    // is dropped rather than shown as a replacement mark.
    text: () => new TextDecoder().decode(concat(chunks), { stream: true }),
    truncated: () => truncated,
  };
};

// The last `cap` bytes of a stream.
const tailOf = (cap: number) => {
  let kept: Uint8Array = new Uint8Array(0);
  return {
    push: (chunk: Uint8Array) => {
      const joined = concat([kept, chunk]);
      kept =
        joined.length > cap ? joined.subarray(joined.length - cap) : joined;
    },
    text: () => new TextDecoder().decode(kept),
  };
};

/** The last line of `text` with anything on it, cut to a sensible length. Pure. */
export const lastLineOf = (text: string): string => {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '')
      .at(-1) ?? '';
  return line.length > STDERR_LINE_CAP
    ? `${line.slice(0, STDERR_LINE_CAP)}…`
    : line;
};

// --- the process --------------------------------------------------------------

// How the command's process ended, once it did.
type Ended =
  | { readonly _tag: 'Exited'; readonly code: number }
  | { readonly _tag: 'Signalled'; readonly signal: string }
  | { readonly _tag: 'NotStarted'; readonly message: string };

// An error's message, and its causes' in turn: a spawner's error says what
// it was doing, and its cause what went wrong.
const messagesOf = (error: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = [];
  let at: unknown = error;
  for (let depth = 0; depth < 4 && at !== undefined; depth++) {
    const message = at instanceof Error ? at.message : String(at);
    if (message !== '' && !messages.includes(message)) messages.push(message);
    at = at instanceof Error ? at.cause : undefined;
  }
  return messages;
};

const messageOf = (error: unknown): string => messagesOf(error).join(': ');

// The handle's `exitCode` fails when the process died on a signal, with the
// signal's name in its cause's message (`NodeChildProcessSpawner`): the only
// way it says which.
const SIGNAL_IN = /signal: '([A-Z0-9]+)'/;

const signalOf = (error: unknown): string | undefined =>
  messagesOf(error)
    .map((m) => SIGNAL_IN.exec(m)?.[1])
    .find((s) => s !== undefined);

const drain = (
  stream: Stream.Stream<Uint8Array, unknown>,
  push: (chunk: Uint8Array) => void,
) =>
  stream.pipe(
    Stream.runForEach((chunk) => Effect.sync(() => push(chunk))),
    Effect.ignore,
  );

// Spawn the command and wait for it to exit, reading its output as it comes.
// Scoped, so ending it (the scope closing once it exits, or the fibre it runs
// on interrupted at a timeout) has the spawner signal the whole process group:
// SIGTERM, then SIGKILL after `WIDGET_KILL_GRACE` (`forceKillAfter`). Never
// fails.
const spawnAndWait = (
  command: string,
  environment: WidgetEnvironment,
  out: (chunk: Uint8Array) => void,
  err: (chunk: Uint8Array) => void,
): Effect.Effect<Ended, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Effect.result(
        spawner.spawn(
          ChildProcess.make('/bin/bash', ['-c', command], {
            env: { ...environment.env },
            extendEnv: true,
            ...(environment.cwd === undefined ? {} : { cwd: environment.cwd }),
            stdin: 'ignore',
            killSignal: 'SIGTERM',
            forceKillAfter: WIDGET_KILL_GRACE,
          }),
        ),
      );
      if (Result.isFailure(spawned))
        return {
          _tag: 'NotStarted',
          message: messageOf(spawned.failure),
        } satisfies Ended;
      const handle = spawned.success;
      // Both streams drained the whole time, so a chatty command never blocks
      // on a full pipe; what is past the caps is read and dropped.
      const reading = yield* Effect.forkScoped(
        Effect.all([drain(handle.stdout, out), drain(handle.stderr, err)], {
          concurrency: 'unbounded',
          discard: true,
        }),
      );
      const exit = yield* Effect.result(handle.exitCode);
      yield* Fiber.await(reading).pipe(Effect.timeoutOption(OUTPUT_GRACE));
      if (Result.isSuccess(exit))
        return { _tag: 'Exited', code: exit.success } satisfies Ended;
      const signal = signalOf(exit.failure);
      return signal === undefined
        ? ({
            _tag: 'NotStarted',
            message: messageOf(exit.failure),
          } satisfies Ended)
        : ({ _tag: 'Signalled', signal } satisfies Ended);
    }),
  );

/** A run, and what waits for a timed-out run's process group to be ended. */
export interface WidgetRunOutcome {
  readonly run: WidgetRunDto;
  // Done at once unless the run timed out; then done once the group is gone.
  // The runner waits on it before the widget's next run, so no two of one
  // widget's runs overlap even while a killed one is dying.
  readonly reaped: Effect.Effect<void>;
}

/**
 * Run a widget's command once. The process runs on a fibre of `scope` (the
 * runner's, so stopping serve ends it), and this waits for it at most the
 * widget's timeout. At the timeout, or when the fibre calling this is
 * interrupted (the widget removed or changed), the process's fibre is
 * interrupted on a fibre of its own, so this returns at once rather than
 * waiting for the group to die: `Effect.timeout` around the process would
 * wait for its finalizer, which is the kill and up to its grace. Whenever it
 * ends the process itself, at the timeout or interrupted, it hands `ending`
 * what waits for the group to be gone (a timed-out run's `reaped`), before
 * it returns or its interruption goes on. Never fails.
 */
export const runWidgetCommand = (
  config: WidgetConfig,
  environment: WidgetEnvironment,
  scope: Scope.Scope,
  ending: (reaped: Effect.Effect<void>) => Effect.Effect<void> = () =>
    Effect.void,
): Effect.Effect<
  WidgetRunOutcome,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const stdout = headOf(WIDGET_STDOUT_CAP);
    const stderr = tailOf(STDERR_KEPT);
    // Uninterruptible but for the wait, so no interrupt lands between the
    // fork and the wait, nor between the timeout and the end, to leave the
    // process running with no timeout over it.
    const { ended, reaped } = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const child = yield* Effect.forkIn(
          spawnAndWait(config.command, environment, stdout.push, stderr.push),
          scope,
        );
        const end = Effect.gen(function* () {
          const dying = yield* Effect.forkIn(Fiber.interrupt(child), scope);
          const reaped = Effect.asVoid(Fiber.await(dying));
          yield* ending(reaped);
          return reaped;
        });
        const ended = yield* restore(
          Fiber.await(child).pipe(
            Effect.timeoutOption(Duration.seconds(config.timeoutSeconds)),
          ),
        ).pipe(Effect.onInterrupt(() => Effect.asVoid(end)));
        return {
          ended,
          reaped: Option.isNone(ended) ? yield* end : Effect.void,
        };
      }),
    );
    const finishedAt = yield* Clock.currentTimeMillis;
    const how: Ended | undefined = Option.match(ended, {
      onNone: () => undefined,
      onSome: (exit): Ended =>
        Exit.isSuccess(exit)
          ? exit.value
          : { _tag: 'NotStarted', message: 'the run was interrupted' },
    });
    const run: WidgetRunDto = {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      exitCode: how?._tag === 'Exited' ? how.code : null,
      signal: how?._tag === 'Signalled' ? how.signal : null,
      timedOut: how === undefined,
      spawnError: how?._tag === 'NotStarted' ? how.message : null,
      stdout: stdout.text(),
      stderrTail: lastLineOf(stderr.text()),
      truncated: stdout.truncated(),
      ok: how?._tag === 'Exited' && how.code === 0,
    };
    return { run: templated(config, run), reaped };
  });

// --- templates ----------------------------------------------------------------

/**
 * A good run of a templated `json` widget, its JSON mapped through the
 * widget's templates to the envelope the page reads (`{text, detail?,
 * tone?}`), with the command's own output kept in `raw`. Output that is not
 * JSON, or a template that cannot be filled from it, fails the run with
 * `templateError`. Any other run is as it was. Pure.
 */
export const templated = (
  config: WidgetConfig,
  run: WidgetRunDto,
): WidgetRunDto => {
  if (!run.ok || config.format !== 'json' || config.text === undefined)
    return run;
  const failed = (templateError: string): WidgetRunDto => ({
    ...run,
    raw: run.stdout,
    ok: false,
    templateError,
  });
  let data: unknown;
  try {
    data = JSON.parse(run.stdout);
  } catch {
    return failed(
      run.truncated
        ? `the command printed more than ${WIDGET_STDOUT_CAP} bytes, so its JSON was cut short`
        : 'the command did not print JSON',
    );
  }
  const text = render(config.text, data);
  if (Result.isFailure(text)) return failed(text.failure.message);
  const detail =
    config.detail === undefined ? undefined : render(config.detail, data);
  if (detail !== undefined && Result.isFailure(detail))
    return failed(detail.failure.message);
  const tone =
    config.tone === undefined ? undefined : toneOf(config.tone, data);
  if (tone !== undefined && Result.isFailure(tone))
    return failed(tone.failure.message);
  const envelope = {
    text: text.success.trim(),
    ...(detail === undefined
      ? {}
      : { detail: detail.success.replace(/\n+$/, '') }),
    ...(tone === undefined || tone.success === undefined
      ? {}
      : { tone: tone.success }),
  };
  return { ...run, raw: run.stdout, stdout: JSON.stringify(envelope) };
};
