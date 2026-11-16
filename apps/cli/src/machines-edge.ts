import { HerdrMachineList } from '@operator-inbox/core';
import { Duration, Effect, Schema, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { binConfig } from './bin-config';
import { InputError } from './errors';

// Herdr's saved SSH machines, read from Herdr itself (`herdr machine list
// --json`), so a label here means exactly what it means to `herdr
// --machine`. Serve resolves its Inbox machines with it.

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const collect = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

// How long a command interrupted mid-run (a caller's time limit, Ctrl-C) is
// given to end on SIGTERM before it is sent SIGKILL. Without it the spawner
// waits for the process however long it takes, so a Herdr that ignores
// SIGTERM would hold a short bound open for as long as it ran.
const KILL_AFTER = Duration.millis(500);

// Run a command to completion with both streams captured. A spawn failure
// (the bin missing) is the one error; any exit code is an answer.
const run = (bin: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const proc = yield* spawner.spawn(
        ChildProcess.make(bin, args, {
          stdout: 'pipe',
          stderr: 'pipe',
          forceKillAfter: KILL_AFTER,
        }),
      );
      const [stdout, stderr] = yield* Effect.all(
        [collect(proc.stdout), collect(proc.stderr)],
        { concurrency: 'unbounded' },
      );
      const code = yield* proc.exitCode;
      return { code, stdout, stderr } satisfies Ran;
    }),
  ).pipe(
    Effect.mapError(
      (e) =>
        new InputError({
          message: `could not run '${bin}': ${e.message} (is it installed and on PATH?)`,
        }),
    ),
  );

// The `herdr` bin, overridable so a test can stand a stub in for it.
const herdrBin = binConfig('OPERATOR_INBOX_HERDR_BIN', 'herdr').pipe(
  Effect.orDie,
);

const lastLine = (s: string): string =>
  s.trim().split('\n').at(-1)?.trim() || 'nothing on stderr';

/** The saved Herdr machines. */
export const loadMachines = Effect.gen(function* () {
  const herdr = yield* herdrBin;
  const out = yield* run(herdr, ['machine', 'list', '--json']);
  if (out.code !== 0) {
    return yield* new InputError({
      message: `'herdr machine list --json' failed: ${lastLine(out.stderr)}`,
    });
  }
  return yield* Schema.decodeUnknownEffect(HerdrMachineList)(out.stdout).pipe(
    Effect.mapError(
      (e) =>
        new InputError({
          message: `could not read 'herdr machine list --json': ${e.message}`,
        }),
    ),
  );
});
