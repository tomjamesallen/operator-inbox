import { readFileSync } from 'node:fs';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, type Layer, Result, Schedule, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { InputError } from '../src/errors';
import {
  captureStdout,
  NodeServicesSparingExitedGroups,
} from '../src/process-edge';
import { writeStubBin } from './stub-fixtures';

// The shared capture-stdout-AND-check-exit-code edge, exercised over tiny stub
// shell scripts (the capture.ts stub-bin idiom): stdout capture, a non-zero exit
// mapped to the `exit` reason, and a spawn error (missing bin) mapped to the
// `spawn` reason carrying the real cause.

const run = (bin: string) =>
  captureStdout(ChildProcess.make(bin), (reason) =>
    reason._tag === 'exit'
      ? new InputError({ message: `exit ${reason.code}` })
      : new InputError({ message: `spawn: ${reason.cause}` }),
  );

describe('captureStdout', () => {
  it.effect('captures the stub bin stdout', () =>
    Effect.gen(function* () {
      const bin = yield* writeStubBin('stub', '#!/bin/sh\nprintf "hello"');
      const out = yield* run(bin);
      expect(out).toBe('hello');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('fails loud on a non-zero exit (never a silent empty result)', () =>
    Effect.gen(function* () {
      const bin = yield* writeStubBin(
        'stub',
        '#!/bin/sh\necho partial\nexit 7',
      );
      const r = yield* Effect.result(run(bin));
      expect(Result.isFailure(r)).toBe(true);
      if (Result.isFailure(r)) {
        expect(r.failure).toBeInstanceOf(InputError);
        expect(r.failure.message).toBe('exit 7');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('maps a spawn error (missing bin) to the spawn reason', () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(run('/no/such/bin-xyz'));
      expect(Result.isFailure(r)).toBe(true);
      if (Result.isFailure(r)) {
        expect(r.failure).toBeInstanceOf(InputError);
        expect(r.failure.message).toMatch(/^spawn: /);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// The child-process lifetime the CLI runs under (process-edge.ts,
// `NodeServicesSparingExitedGroups`): an exited child's process group is left
// alone unless it failed, and a child still running when its scope closes has
// its group killed. Each stub backgrounds a `sleep` (its own stdio to /dev/null, so it cannot hold
// the stdout pipe open) in the child's process group, prints its pid, and then
// exits 0, exits non-zero, or keeps running. The sleep is the grandchild a real
// tool would leave behind on purpose, and whether it is alive after the child's
// scope closes is the whole question. Every sleep is bounded at 30s and killed at
// the end of its test.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Poll for up to ~2s: the spawner's own group wait is bounded at 1s, and a
// killed sleep is reaped by launchd, not by us.
const settles = (pid: number, want: boolean) =>
  Effect.sync(() => alive(pid)).pipe(
    Effect.repeat({
      until: (a) => a === want,
      schedule: Schedule.spaced('50 millis'),
      times: 40,
    }),
  );

const reap = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });

const grandchildStub = (tail: string) =>
  writeStubBin(
    'grandchild',
    `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $!\n${tail}\n`,
  );

// `spawner.exitCode` waits for the exit before the scope closes, so the clean-exit
// rule is what decides. (`spawner.string` closes its scope at stdout EOF, which
// usually lands BEFORE the exit event, so the leader still counts as running and
// the group is killed most of the time. It cannot pin this rule, so it is not
// used here.) The stub's stdout
// goes to a pid file beside it.
const viaExitCode = (bin: string, expected = 0) =>
  Effect.gen(function* () {
    const s = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pidFile = `${bin}.pid`;
    const code = yield* s.exitCode(
      ChildProcess.make('/bin/sh', ['-c', `"${bin}" > "${pidFile}"`]),
    );
    expect(code).toBe(expected);
    const out = yield* s.string(ChildProcess.make('cat', [pidFile]));
    return Number(out.trim());
  });

const survivesCleanExit = (
  layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  spawnVia: (
    bin: string,
  ) => Effect.Effect<number, unknown, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const bin = yield* grandchildStub('exit 0').pipe(
      Effect.provide(NodeServices.layer),
    );
    const pid = yield* spawnVia(bin).pipe(Effect.provide(layer));
    expect(pid).toBeGreaterThan(0);
    const survived = yield* settles(pid, false).pipe(
      Effect.map(() => alive(pid)),
    );
    yield* reap(pid);
    return survived;
  });

describe('child-process lifetime (exited groups spared)', () => {
  it.live(
    'plain Effect 4 kills a grandchild after a CLEAN exit (why the wrapper exists)',
    () =>
      Effect.gen(function* () {
        expect(yield* survivesCleanExit(NodeServices.layer, viaExitCode)).toBe(
          false,
        );
      }),
  );

  it.live('the grandchild survives a clean exit through spawner.exitCode', () =>
    Effect.gen(function* () {
      expect(
        yield* survivesCleanExit(NodeServicesSparingExitedGroups, viaExitCode),
      ).toBe(true);
    }),
  );

  it.live(
    'the grandchild survives a clean exit through captureStdout (spawn)',
    () =>
      Effect.gen(function* () {
        const viaCapture = (bin: string) =>
          captureStdout(ChildProcess.make(bin, []), (r) => r).pipe(
            Effect.map((out) => Number(out.trim())),
          );
        expect(
          yield* survivesCleanExit(NodeServicesSparingExitedGroups, viaCapture),
        ).toBe(true);
      }),
  );

  it.live('a NON-ZERO exit still kills the group', () =>
    Effect.gen(function* () {
      const bin = yield* grandchildStub('exit 3').pipe(
        Effect.provide(NodeServices.layer),
      );
      const pid = yield* viaExitCode(bin, 3).pipe(
        Effect.provide(NodeServicesSparingExitedGroups),
      );
      const killed = yield* settles(pid, false).pipe(
        Effect.map(() => !alive(pid)),
      );
      yield* reap(pid);
      expect(killed).toBe(true);
    }),
  );
  // A child that dies by a SIGNAL has no exit code (Node reports `code === null`),
  // and its group is left alone: the release kills an exited child's group
  // only when `code !== 0 && code !== null`. `spawner.exitCode` fails on a signal
  // death, so the stub is spawned directly and its exit awaited as an Exit.
  const viaSignalDeath = (bin: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* ChildProcessSpawner.ChildProcessSpawner;
        const proc = yield* s.spawn(ChildProcess.make(bin, []));
        const out = yield* proc.stdout.pipe(Stream.decodeText, Stream.mkString);
        const exit = yield* Effect.exit(proc.exitCode);
        expect(Exit.isFailure(exit)).toBe(true);
        return Number(out.trim());
      }),
    );

  const survivesSignalDeath = (
    layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  ) =>
    Effect.gen(function* () {
      const bin = yield* grandchildStub('kill -TERM $$').pipe(
        Effect.provide(NodeServices.layer),
      );
      const pid = yield* viaSignalDeath(bin).pipe(Effect.provide(layer));
      expect(pid).toBeGreaterThan(0);
      const survived = yield* settles(pid, false).pipe(
        Effect.map(() => alive(pid)),
      );
      yield* reap(pid);
      return survived;
    });

  it.live(
    'plain Effect 4 kills a grandchild after a SIGNAL death (the control)',
    () =>
      Effect.gen(function* () {
        expect(yield* survivesSignalDeath(NodeServices.layer)).toBe(false);
      }),
  );

  it.live('the grandchild survives a SIGNAL death of its parent', () =>
    Effect.gen(function* () {
      expect(yield* survivesSignalDeath(NodeServicesSparingExitedGroups)).toBe(
        true,
      );
    }),
  );

  it.live(
    'a child still RUNNING when its scope closes (a timeout) still has its group killed',
    () =>
      Effect.gen(function* () {
        const bin = yield* grandchildStub('sleep 30').pipe(
          Effect.provide(NodeServices.layer),
        );
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const s = yield* ChildProcessSpawner.ChildProcessSpawner;
            const proc = yield* s.spawn(ChildProcess.make(bin, []));
            const first = yield* proc.stdout.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runHead,
            );
            return Number(first._tag === 'Some' ? first.value : 0);
          }),
        ).pipe(Effect.provide(NodeServicesSparingExitedGroups));
        const killed = yield* settles(pid, false).pipe(
          Effect.map(() => !alive(pid)),
        );
        yield* reap(pid);
        expect(killed).toBe(true);
      }),
  );
});

// The CLI's runtime edge must provide the wrapper, not plain NodeServices: the
// behaviour above only holds for the commands if `src/index.ts` wires it in, and
// nothing else exercises that wiring (reverting it left every test green). A
// source read is the cheapest honest pin; it catches the revert, not a rename.
describe('the CLI runtime edge', () => {
  const source = readFileSync(
    new URL('../src/index.ts', import.meta.url),
    'utf8',
  );

  it('provides NodeServicesSparingExitedGroups', () => {
    expect(source).toMatch(
      /import \{ NodeServicesSparingExitedGroups \} from '\.\/process-edge';/,
    );
    expect(source).toMatch(
      /Layer\.provide(Merge)?\(NodeServicesSparingExitedGroups\)/,
    );
  });

  it('never provides plain NodeServices.layer', () => {
    expect(source).not.toMatch(/NodeServices\.layer/);
    expect(source).not.toMatch(/@effect\/platform-node\/NodeServices/);
  });
});
