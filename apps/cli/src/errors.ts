import { Data } from 'effect';

// The general EXPECTED error at the CLI command edge: the single channel for
// any failure a command handler has already accounted for and wants reported,
// not thrown. Two kinds live under the one tag:
//
// - unusable input (an unknown Inbox id, a malformed `--meta` pair);
// - a downstream failure wrapped at the edge, where the cause is already a
//   human sentence and a stack trace would add nothing (a shelled-out tool).
//
// So the name is narrower than the role, and deliberately so: one tag keeps one
// rendering. The error boundary in index.ts prints any of it as a single clean
// `operator-inbox: <message>` line and exits non-zero, with no stack trace.
export class InputError extends Data.TaggedError('InputError')<{
  readonly message: string;
}> {}
