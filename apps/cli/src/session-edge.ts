import path from 'node:path';
import {
  desktopSessionOfFile,
  SessionId,
  type WorkingSession,
} from '@operator-inbox/core';
import { Effect, FileSystem, Option, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

// Locating the Claude session that OWNS this CLI invocation, by walking the
// process tree, and the Claude desktop app's record of that session.
//
// A total, never-failing read throughout: no session file simply means no
// session, which is the ordinary case for a CLI run from a plain shell.

// The Claude session file's two fields we consume (sessionId + cwd); decoded via
// Schema so a malformed / partial file simply yields no location. Extra fields
// are ignored.
const SessionFile = Schema.fromJsonString(
  Schema.Struct({ sessionId: SessionId, cwd: Schema.String }),
);
const decodeSessionFile = Schema.decodeUnknownEffect(SessionFile);

export interface SessionLocation {
  readonly sessionId: SessionId;
  readonly cwd: string;
  // The pid whose session file this is — the handle used to ask, later,
  // whether that session is still running.
  readonly pid: number;
}

// The Claude session file for a pid (if this pid owns a session).
export const sessionFileFor = (homedir: string, pid: number): string =>
  path.join(homedir, '.claude', 'sessions', `${pid}.json`);

// One `ps -o ppid= -p <pid>` hop → the parent pid, or 0 on any failure (a total,
// never-failing read).
export const parentPid = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(
      ChildProcess.make('ps', ['-o', 'ppid=', '-p', String(pid)]),
    );
  }).pipe(
    Effect.map((s) => {
      const n = Number.parseInt(s.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    }),
    Effect.catch(() => Effect.succeed(0)),
  );

// Walk the process tree from this command's own pid upward until a pid owns a
// `<homedir>/.claude/sessions/<pid>.json` file (the session), reading its
// sessionId + cwd. Stop at pid <= 1, cap depth ~40 (a defensive guard against a
// pathological tree). Returns Option.none if no session file is found — the
// on-demand degrade case.
export const locateSession = (homedir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let pid = yield* Effect.sync(() => process.pid);
    for (let depth = 0; depth < 40 && pid > 1; depth++) {
      const file = sessionFileFor(homedir, pid);
      if (yield* fs.exists(file)) {
        const decoded = yield* Effect.option(
          fs.readFileString(file).pipe(Effect.flatMap(decodeSessionFile)),
        );
        if (Option.isSome(decoded)) {
          return Option.some<SessionLocation>({
            sessionId: decoded.value.sessionId,
            cwd: decoded.value.cwd,
            pid,
          });
        }
      }
      pid = yield* parentPid(pid);
    }
    return Option.none<SessionLocation>();
  });

// Where the Claude desktop app keeps one file per session it runs, two opaque
// directory levels down. The app runs on a Mac, so nowhere else has one.
export const desktopSessionsDir = (homedir: string): string =>
  path.join(
    homedir,
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions',
  );

// The desktop session whose CLI session id this is. A total read, like everything
// here: no directory, no file for this id, or a file that cannot be read is no
// session, since a plain terminal session has none and that must never
// stop `open`. Files run to hundreds of KB and hundreds of them accumulate,
// so the newest go first: a running session's file is one of them, and the read
// stops at the match.
export const findDesktopSession = (sessionsDir: string, sessionId: SessionId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A file among the directories fails to list, and so holds nothing.
    const under = (dirs: ReadonlyArray<string>) =>
      Effect.map(
        Effect.forEach(dirs, (dir) =>
          fs.readDirectory(dir).pipe(
            Effect.map((names) => names.map((n) => path.join(dir, n))),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          ),
        ),
        (lists) => lists.flat(),
      );
    const entries = yield* under(yield* under(yield* under([sessionsDir])));
    const files = entries.filter((file) => {
      const name = path.basename(file);
      return name.startsWith('local_') && name.endsWith('.json');
    });
    const dated = yield* Effect.forEach(
      files,
      (file) =>
        fs.stat(file).pipe(
          Effect.map((info) => ({
            file,
            at: Option.match(info.mtime, {
              onNone: () => 0,
              onSome: (mtime) => mtime.getTime(),
            }),
          })),
          Effect.orElseSucceed(() => ({ file, at: 0 })),
        ),
      { concurrency: 16 },
    );
    for (const { file } of [...dated].sort((a, b) => b.at - a.at)) {
      const content = yield* Effect.option(fs.readFileString(file));
      if (Option.isNone(content)) continue;
      const found = desktopSessionOfFile(content.value, sessionId);
      if (found !== undefined) return Option.some<WorkingSession>(found);
    }
    return Option.none<WorkingSession>();
  }).pipe(Effect.orElseSucceed(() => Option.none<WorkingSession>()));

// Hand a session link to the Claude app with macOS's `open`, for the desktop
// app's window, which cannot open one itself. Serve runs in the operator's own
// login session, so `open` reaches the app they are looking at.
export const openSessionLink = (link: string, bin = 'open') =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.exitCode(ChildProcess.make(bin, [link]));
  }).pipe(
    Effect.catch(() => Effect.succeed(-1)),
    Effect.map((code) => code === 0),
  );
