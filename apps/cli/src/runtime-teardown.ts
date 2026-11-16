import { Cause, Exit, Option, type Runtime } from 'effect';

// WHY THIS EXISTS: `process.exit` truncates a piped stdout.
//
// `NodeRuntime.runMain`'s default teardown hands the exit code to a callback
// that reads `if (receivedSignal || code !== 0) { process.exit(code) }`. Node
// does not flush a pipe on `process.exit`, so on ANY non-zero exit the tail of
// stdout is discarded at the 64 KB pipe buffer, silently, with a zero-length
// read and no error anywhere. A command that prints a large JSON payload and
// then fails would hand its reader unparseable JSON.
//
// HOW: report the failure through `process.exitCode` and hand the callback a
// ZERO, so `process.exit` is never reached on the failure path. Node then exits
// of its own accord once the event loop drains, and draining stdout is part of
// that. The observable exit code is unchanged.
//
// THE TRADE: a natural exit waits for the pipe. A reader that never reads
// hangs rather than getting a truncated answer. That is already true of
// every successful run (the default teardown does not call `process.exit` for
// code 0 either), so this makes the failure path behave like the success path
// rather than inventing a new behaviour.
//
// A failure that carries its own exit code (`exitCodeOf`: `open`'s taken name
// exits 3) exits with it; every other failure exits 1.
export const flushingTeardown: Runtime.Teardown = (exit, onExit) => {
  process.exitCode =
    Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
      ? exitCodeOf(Option.getOrUndefined(Cause.findErrorOption(exit.cause)))
      : 0;
  onExit(0);
};

// The exit code for an error: its own `exitCode` when it carries one in
// 2–125 (a code a caller is meant to branch on, like `open`'s taken
// name, exit 3), else 1. Read here from the failure the boundary in index.ts
// re-fails with.
export const exitCodeOf = (e: unknown): number => {
  const code =
    typeof e === 'object' && e !== null
      ? (e as { readonly exitCode?: unknown }).exitCode
      : undefined;
  return typeof code === 'number' &&
    Number.isInteger(code) &&
    code >= 2 &&
    code <= 125
    ? code
    : 1;
};
