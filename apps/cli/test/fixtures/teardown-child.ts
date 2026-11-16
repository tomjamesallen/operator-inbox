import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { Console, Effect } from 'effect';
import { flushingTeardown } from '../../src/runtime-teardown';

// A stand-in for any command that prints a large report and THEN exits
// non-zero. Run with `flushing` to use this repo's teardown, `default` to use
// Effect's, which is the control that keeps the test non-vacuous.
const payload = 'x'.repeat(Number(process.argv[3] ?? 400_000));

const main = Console.log(payload).pipe(
  Effect.andThen(Console.error('operator-inbox: the command failed')),
  Effect.andThen(Effect.fail('the command failed')),
);

NodeRuntime.runMain(main, {
  disableErrorReporting: true,
  ...(process.argv[2] === 'flushing' ? { teardown: flushingTeardown } : {}),
});
