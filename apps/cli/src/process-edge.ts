import * as NodeServices from '@effect/platform-node/NodeServices';
import type { OwnerReading } from '@operator-inbox/core';
import { Effect, Layer, Result, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

// Shared process-spawn edges for the CLI's external-process orchestration:
//
// - `captureStdout`: capture stdout AND check the exit code from a SINGLE
//   spawn, failing loud on a non-zero exit or a spawn error. The canonical
//   "run a tool, read what it prints, never trust a partial result" helper, so a
//   failing tool can never be silently parsed as an empty success (the hazard
//   `ChildProcessSpawner.string` carries: it accumulates stdout but ignores the
//   exit code).
// - `readOwnerFingerprint`: the watcher's read of its owner's identity.
// - `NodeServicesSparingExitedGroups`: `NodeServices` with a spawner that
//   leaves the process group of a child that has already exited cleanly
//   alone, provided at the runtime edge.
//
// `captureStdout` maps every failure through a caller-supplied constructor, so
// every caller shares the exact same plumbing.

// Why a spawn failed, handed to the caller's error constructor. `spawn` carries
// the underlying platform error so the caller can surface the real cause (an
// ENOENT for a missing bin, a permission error, …) rather than only guessing
// "is it installed?"; `exit` carries the non-zero code.
export type CaptureFailure =
  | { readonly _tag: 'spawn'; readonly cause: unknown }
  | { readonly _tag: 'exit'; readonly code: number };

// Capture stdout AND the exit code from a SINGLE spawn, mapping BOTH failure
// modes (spawn error, non-zero exit) through `onFailure` to a caller error `E`.
// `ChildProcessSpawner.string` alone accumulates stdout but never inspects the exit code, so
// a failing tool would be silently parsed as an empty success — this closes that
// hole once, for every caller. stderr must already be configured on `cmd` so
// that it cannot fill an undrained parent pipe and deadlock the exitCode await:
// `'inherit'` is the norm (a tool's own diagnostics reach the terminal too); a
// probe whose entire stderr is one short line may `'pipe'` it.
// Scoped so the child process is reaped; the exit-code check runs on the SUCCESS
// value, so `onFailure` only ever sees a genuine spawn/platform failure.
export const captureStdout = <E>(
  cmd: ChildProcess.Command,
  onFailure: (reason: CaptureFailure) => E,
): Effect.Effect<string, E, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const proc = yield* spawner.spawn(cmd);
      const decoder = new TextDecoder();
      let stdout = '';
      yield* proc.stdout.pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => {
            stdout += decoder.decode(bytes, { stream: true });
          }),
        ),
      );
      stdout += decoder.decode();
      const code = yield* proc.exitCode;
      return { code, stdout } as const;
    }),
  ).pipe(
    Effect.matchEffect({
      onFailure: (cause) => Effect.fail(onFailure({ _tag: 'spawn', cause })),
      onSuccess: ({ code, stdout }) =>
        code === 0
          ? Effect.succeed(stdout)
          : Effect.fail(onFailure({ _tag: 'exit', code })),
    }),
  );

// Observe a process's IDENTITY, not merely its existence: `ps -o comm=,lstart=`
// yields a command name plus a start time, and the pair is what makes the pid
// stable to compare against over a long window.
//
// The reader is the watcher's owner watchdog, where existence alone would be
// unsafe: over a `--max-duration`-long window a pid can be recycled, and a
// watcher polling a recycled pid reports as working while watching a stranger.
// The comparison itself is pure (`decideOwnerVerdict`, core's watcher.ts);
// this is only the read.
//
// THREE OUTCOMES, NOT TWO, and the distinction is load-bearing. Collapsing
// every failure to "no fingerprint" would make a transient inability to run
// `ps` at all (EMFILE, a spawner failure, a fork limit) read as "the owner is
// gone" and end a perfectly healthy session while narrating something false.
// `ps` exiting non-zero IS the answer (no such pid). Failing to spawn `ps` is
// not an answer at all.
//
// `stderr: 'inherit'` meets `captureStdout`'s stderr rule. It matters more here
// than at most call sites: an undrained stderr pipe can fill and deadlock the
// `exitCode` await, and this spawns every few seconds over a long session, so
// a rare hang is not rare at this rate.
export const readOwnerFingerprint = (
  pid: number,
): Effect.Effect<
  OwnerReading,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> => readPs(pid, 'comm=,lstart=');

const readPs = (
  pid: number,
  format: 'comm=,lstart=',
): Effect.Effect<
  OwnerReading,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  captureStdout(
    ChildProcess.make('ps', ['-o', format, '-p', String(pid)], {
      stderr: 'inherit',
    }),
    (reason) => reason,
  ).pipe(
    Effect.map((out): OwnerReading => {
      const fingerprint = out.trim();
      return fingerprint.length === 0
        ? { kind: 'gone' }
        : { kind: 'alive', fingerprint };
    }),
    // A non-zero exit is `ps` answering; a spawn failure is `ps` not running.
    Effect.catch((reason) =>
      Effect.succeed<OwnerReading>(
        reason._tag === 'exit' ? { kind: 'gone' } : { kind: 'unreadable' },
      ),
    ),
  );

// A spawner that spares the process group of a child that has already exited
// cleanly. The Node spawner starts each child in its own process group and,
// when the child's scope closes, signals that WHOLE group if the child is
// still running or exited with a non-zero code. It also sends the group
// SIGTERM when the child has already exited with NO non-zero code (exit 0, or
// death by a signal, which Node reports as `code === null`):
// `NodeChildProcessSpawner.ts`, the `isReferenced && … detached !== false`
// branch of the release. So anything a child leaves running on purpose in its
// own group (a background job, a server it starts without `setsid`) would die
// with it. This layer keeps such a group alive.
//
// The wrapper adds one finalizer per spawn. It runs BEFORE the spawner's own
// release (a scope runs finalizers last-in first-out) and, when the child has
// already exited 0 or died by a signal, unrefs the handle. Unref clears the
// spawner's `isReferenced` flag, which is exactly the condition that kill tests;
// unref on an exited child changes nothing else. The handle's `exitCode`
// succeeds with the code when there is one and FAILS (a PlatformError) when the
// code is null, i.e. on a signal death — and that is its only failure — so a
// failed `exitCode` is read as the signal case. A child still running, or one
// that exited with a non-zero code, is untouched, so the group kill on
// interruption, timeout and failure stays.
//
// Not `detached: false` per site: that also moves the child into the CLI's own
// process group (Ctrl+C then reaches it) and turns every group kill into a
// leader-only kill.
export const ChildProcessSpawnerSparingExitedGroups: Layer.Layer<
  ChildProcessSpawner.ChildProcessSpawner,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      Effect.tap(inner.spawn(command), (handle) =>
        Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (yield* handle.isRunning) return;
            const exit = yield* Effect.result(handle.exitCode);
            // A non-zero code keeps the group kill; a failure is a signal death.
            if (Result.isSuccess(exit) && exit.success !== 0) return;
            // The Reref it returns is dropped: the group is never re-referenced.
            yield* Effect.asVoid(handle.unref);
          }).pipe(Effect.ignore),
        ),
      ),
    );
  }),
);

// `NodeServices.layer` with the spawner above: the drop-in for every place the
// CLI provides `NodeServices.layer` to a program that spawns.
export const NodeServicesSparingExitedGroups =
  ChildProcessSpawnerSparingExitedGroups.pipe(
    Layer.provideMerge(NodeServices.layer),
  );
