import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  PlatformError,
  Sink,
  Stream,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process';

// Stand-ins for the widget runner's edges, so its tests run on the TestClock
// with nothing spawned and nothing written to disk: a file system held in a
// Map, and a spawner whose "processes" print what a script says and exit
// after a while on the clock.

/** A file system of a Map from path to text, its folders implied: enough for the runner. */
export const memoryFileSystem = (files: Map<string, string>) => {
  const notFound = (method: string, p: string) =>
    PlatformError.systemError({
      _tag: 'NotFound',
      module: 'FileSystem',
      method,
      pathOrDescriptor: p,
    });
  return Layer.succeed(FileSystem.FileSystem)(
    FileSystem.makeNoop({
      // A folder exists while a file is in it.
      exists: (p) =>
        Effect.succeed(
          files.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`)),
        ),
      readDirectory: (p) =>
        Effect.succeed(
          [...files.keys()]
            .filter((f) => f.startsWith(`${p}/`))
            .map((f) => f.slice(p.length + 1))
            .filter((name) => !name.includes('/')),
        ),
      readFileString: (p) => {
        const text = files.get(p);
        return text === undefined
          ? Effect.fail(notFound('readFileString', p))
          : Effect.succeed(text);
      },
      writeFileString: (p, text) =>
        Effect.sync(() => {
          files.set(p, text);
        }),
      makeDirectory: () => Effect.void,
      rename: (from, to) => {
        const text = files.get(from);
        if (text === undefined) return Effect.fail(notFound('rename', from));
        return Effect.sync(() => {
          files.delete(from);
          files.set(to, text);
        });
      },
      remove: (p) =>
        Effect.sync(() => {
          files.delete(p);
        }),
    }),
  );
};

/** What a fake process does: print, wait, exit; or never start. */
export interface FakeScript {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly cannotStart?: boolean;
  // How long it takes to die once ended, as a group given SIGTERM may.
  readonly dyingMs?: number;
}

/** One fake process: its script, its env, when it started and ended. */
export interface FakeSpawn {
  readonly script: string;
  readonly env: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  endedAt: number | undefined;
}

const encoder = new TextEncoder();

/**
 * A spawner for `/bin/bash -c <script>`: `scriptOf` says what the script
 * does, and every spawn is recorded in `spawns`. A process ends at its exit or
 * when its scope closes (interrupted), whichever comes first, and a script
 * with `dyingMs` only that long after its scope closes.
 */
export const fakeSpawner = (
  scriptOf: (script: string) => FakeScript,
  spawns: Array<FakeSpawn>,
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== 'StandardCommand')
          return yield* Effect.die('the fake spawns no pipeline');
        const script = String(command.args[1] ?? '');
        const does = scriptOf(script);
        if (does.cannotStart === true)
          return yield* PlatformError.systemError({
            _tag: 'NotFound',
            module: 'ChildProcess',
            method: 'spawn',
            description: 'no such file',
          });
        const spawn: FakeSpawn = {
          script,
          env: command.options.env ?? {},
          startedAt: yield* Clock.currentTimeMillis,
          endedAt: undefined,
        };
        spawns.push(spawn);
        const ended = Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            spawn.endedAt ??= now;
          }),
        );
        // Ended before its exit, it dies only after `dyingMs`.
        yield* Effect.addFinalizer(() =>
          spawn.endedAt !== undefined
            ? Effect.void
            : does.dyingMs === undefined
              ? ended
              : Effect.andThen(Effect.sleep(`${does.dyingMs} millis`), ended),
        );
        const bytes = (text: string | undefined) =>
          text === undefined || text === ''
            ? Stream.empty
            : Stream.make(encoder.encode(text));
        const exitCode = Effect.sleep(`${does.durationMs ?? 0} millis`).pipe(
          Effect.andThen(ended),
          Effect.as(ChildProcessSpawner.ExitCode(does.exitCode ?? 0)),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawns.length),
          exitCode,
          isRunning: Effect.succeed(spawn.endedAt === undefined),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: bytes(does.stdout),
          stderr: bytes(does.stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
