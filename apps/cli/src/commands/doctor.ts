import path from 'node:path';
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { claudeSettingsPath, loadConfig } from '@operator-inbox/core';
import { SERVE_DEFAULT_PORT } from '@operator-inbox/core/api';
import {
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Stream,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { HttpClient } from 'effect/http';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { binConfig } from '../bin-config';
import {
  binCheck,
  configCheck,
  type DoctorCheck,
  desktopCheck,
  hooksCheck,
  LAUNCH_AGENT_LABEL,
  launchAgentCheck,
  nodeCheck,
  plistProgramArguments,
  plistString,
  renderDoctor,
  reportOf,
  serverCheck,
  skillCheck,
  storeCheck,
  voiceCheck,
} from '../doctor';
import { InputError } from '../errors';
import { readHome } from '../home-dir';
import { resolveInboxDatabaseEdge } from '../inbox-database';
import { connectInboxLog } from '../inbox-store';
import { moduleDir, packageRootOf } from '../package-paths';
import { findReadoutPython } from '../readout-kokoro';
import { readSkill } from './skill';

// `operator-inbox doctor`: observe this machine's install and say, one row
// per check, whether it is ok, worth a look (warn) or broken (fail), with a
// one-line fix. The rules are pure, in `doctor.ts`; this file only observes.
//
// Read-only. It writes no file and makes no folder: the store is opened only
// when its file is already there, the hooks are read from settings.json and
// never merged, and the desktop window is checked by `desktop-app.sh check`,
// which never changes anything. It prints paths, never a variable's value
// beyond the paths the app itself uses.

/** What the command reads from the process, injected so a test sets it. */
export interface DoctorHost {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly uid: number | undefined;
  /** The CLI's module directory, from which the checkout is found. */
  readonly moduleDir: string;
}

export const processHost = (): DoctorHost => ({
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  uid: process.getuid?.(),
  moduleDir,
});

const tilde = (home: string | undefined, p: string): string =>
  home !== undefined && p.startsWith(`${home}${path.sep}`)
    ? `~${p.slice(home.length)}`
    : p;

const readOrNull = (fs: FileSystem.FileSystem, p: string) =>
  fs.readFileString(p).pipe(Effect.orElseSucceed(() => null));

const existsOr = (fs: FileSystem.FileSystem, p: string) =>
  fs.exists(p).pipe(Effect.orElseSucceed(() => false));

const collect = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

// Run a command to completion, stdout captured, bounded so a hung tool never
// holds doctor open. Undefined when it could not be run at all.
const run = (
  bin: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const proc = yield* spawner.spawn(
        ChildProcess.make(bin, args, {
          stdout: 'pipe',
          stderr: 'ignore',
          forceKillAfter: Duration.millis(500),
          ...(env === undefined ? {} : { env, extendEnv: true }),
        }),
      );
      const stdout = yield* collect(proc.stdout);
      const code = yield* proc.exitCode;
      return { code, stdout };
    }),
  ).pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.orElseSucceed(() => undefined),
  );

// --- each observation -------------------------------------------------------

const onPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathVar = yield* Config.String('PATH').pipe(
    Effect.orElseSucceed(() => ''),
  );
  for (const dir of pathVar.split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'operator-inbox');
    if (yield* existsOr(fs, candidate)) return candidate;
  }
  return undefined;
});

const configRow = loadConfig().pipe(
  Effect.map(({ path: p, loaded }) =>
    configCheck(
      loaded ? { kind: 'loaded', path: p } : { kind: 'absent', path: p },
    ),
  ),
  Effect.catch((e) =>
    Effect.succeed(
      configCheck({
        kind: 'broken',
        message:
          'message' in e && typeof e.message === 'string'
            ? e.message
            : 'config.json does not load',
      }),
    ),
  ),
);

const storeRow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const resolved = yield* Effect.result(resolveInboxDatabaseEdge);
  if (resolved._tag === 'Failure') {
    return storeCheck({
      kind: 'unresolved',
      message: resolved.failure.message,
    });
  }
  const file = resolved.success.path;
  if (!(yield* existsOr(fs, file)))
    return storeCheck({ kind: 'absent', path: file });
  // The very layer every command opens the log with, so "opens" means what
  // it means to the app. The file is there, so this makes nothing new.
  const opened = yield* Effect.result(
    Effect.scoped(Layer.build(connectInboxLog(resolved.success))),
  );
  return opened._tag === 'Success'
    ? storeCheck({ kind: 'opened', path: file })
    : storeCheck({
        kind: 'broken',
        path: file,
        message: opened.failure.message,
      });
});

const serverRow = (
  port: number,
  launchAgent: boolean,
  log: string | undefined,
) =>
  Effect.gen(function* () {
    const url = `http://127.0.0.1:${port}/api/inboxes`;
    const client = yield* HttpClient.HttpClient;
    const answer = yield* client.get(url).pipe(
      Effect.timeout(Duration.seconds(3)),
      Effect.map((response) => ({ status: response.status })),
      Effect.catch((e) =>
        Effect.succeed({
          reason: e._tag === 'TimeoutError' ? 'timed out' : 'refused',
        }),
      ),
    );
    if ('reason' in answer) {
      return serverCheck(
        { kind: 'silent', url, reason: answer.reason },
        launchAgent,
        log,
      );
    }
    return answer.status >= 200 && answer.status < 300
      ? serverCheck({ kind: 'answered', url }, launchAgent, log)
      : serverCheck(
          { kind: 'status', url, status: answer.status },
          launchAgent,
          log,
        );
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

// The launch agent's plist, where setup.sh writes it.
const launchAgentPlist = (home: string | undefined) =>
  Effect.gen(function* () {
    const dir = yield* Config.String('OPERATOR_INBOX_LAUNCH_AGENTS_DIR').pipe(
      Effect.orElseSucceed(() => ''),
    );
    const base =
      dir !== '' ? dir : path.join(home ?? '', 'Library', 'LaunchAgents');
    return path.join(base, `${LAUNCH_AGENT_LABEL}.plist`);
  });

const launchAgentRow = (
  plist: string,
  text: string | null,
  uid: number | undefined,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const launchctl = yield* binConfig(
      'OPERATOR_INBOX_LAUNCHCTL',
      'launchctl',
    ).pipe(Effect.orDie);
    const domain = `gui/${uid ?? '$(id -u)'}`;
    const printed = yield* run(launchctl, [
      'print',
      `${domain}/${LAUNCH_AGENT_LABEL}`,
    ]);
    const paths = text === null ? [] : plistProgramArguments(text).slice(0, 2);
    const present = new Set<string>();
    for (const p of paths) if (yield* existsOr(fs, p)) present.add(p);
    return launchAgentCheck({
      plist,
      text: text ?? undefined,
      loaded: printed?.code === 0,
      exists: (p) => present.has(p),
      bootstrap: `launchctl bootstrap ${domain} ${plist}`,
    });
  });

const hooksRow = (home: string | undefined) =>
  Effect.gen(function* () {
    if (home === undefined) {
      return hooksCheck('~/.claude/settings.json', null);
    }
    const fs = yield* FileSystem.FileSystem;
    const file = claudeSettingsPath(home);
    return hooksCheck(tilde(home, file), yield* readOrNull(fs, file));
  });

const skillRow = (home: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(
      home ?? '',
      '.claude',
      'skills',
      'operator-inbox',
      'SKILL.md',
    );
    const shipped = yield* readSkill().pipe(Effect.orElseSucceed(() => ''));
    const installed = home === undefined ? null : yield* readOrNull(fs, file);
    return skillCheck(tilde(home, file), installed, shipped);
  });

// The checkout the CLI was built in: the CLI package is `<root>/apps/cli`.
const checkoutRootOf = (dir: string): string =>
  path.resolve(packageRootOf(dir), '..', '..');

// The script reads HOME and its own override from its environment, so both are
// handed over from Config: the window checked is the one this run's
// environment names, never another found through the process's own.
const desktopRow = (dir: string, home: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const script = path.join(checkoutRootOf(dir), 'scripts', 'desktop-app.sh');
    const build = `bash ${script} build`;
    if (!(yield* existsOr(fs, script)))
      return desktopCheck({ kind: 'no-script' }, build);
    const appsDir = yield* Config.String(
      'OPERATOR_INBOX_APPLICATIONS_DIR',
    ).pipe(Effect.orElseSucceed(() => ''));
    const out = yield* run('bash', [script, 'check'], {
      ...(home === undefined ? {} : { HOME: home }),
      ...(appsDir === '' ? {} : { OPERATOR_INBOX_APPLICATIONS_DIR: appsDir }),
    });
    if (out === undefined) return desktopCheck({ kind: 'no-script' }, build);
    return desktopCheck(
      {
        kind: 'checked',
        code: out.code,
        line: out.stdout.trim().split('\n').at(-1) ?? '',
      },
      build,
    );
  });

const voiceRow = (host: DoctorHost) =>
  host.platform !== 'darwin' || host.arch !== 'arm64'
    ? Effect.succeed(
        voiceCheck({
          kind: 'unsupported',
          platform: `${host.platform}-${host.arch}`,
        }),
      )
    : findReadoutPython.pipe(
        Effect.map((python) => voiceCheck({ kind: 'found', python })),
        Effect.catch((e) =>
          Effect.succeed(voiceCheck({ kind: 'missing', message: e.message })),
        ),
      );

// --- the whole run ----------------------------------------------------------

export const runDoctor = (host: DoctorHost, port: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = Option.getOrUndefined(yield* readHome);
    const mac = host.platform === 'darwin';
    const plist = yield* launchAgentPlist(home);
    const plistText = mac ? yield* readOrNull(fs, plist) : null;
    const log =
      plistText === null
        ? undefined
        : (plistString(plistText, 'StandardOutPath') ??
          plistString(plistText, 'StandardErrorPath'));

    const checks = yield* Effect.all(
      [
        Effect.succeed(nodeCheck(host.nodeVersion)),
        Effect.map(onPath, binCheck),
        configRow,
        storeRow,
        serverRow(port, mac, log),
        mac
          ? launchAgentRow(plist, plistText, host.uid)
          : Effect.succeed<DoctorCheck>({
              id: 'launch-agent',
              status: 'ok',
              detail:
                'not macOS, so no launch agent: run operator-inbox serve yourself',
            }),
        hooksRow(home),
        skillRow(home),
        desktopRow(host.moduleDir, home),
        voiceRow(host),
      ],
      { concurrency: 'unbounded' },
    );
    return reportOf(checks);
  });

export const doctorCommand = Command.make(
  'doctor',
  {
    json: Flag.Boolean('json').pipe(
      Flag.withDescription('Print the report as one JSON object'),
      Flag.withDefault(false),
    ),
    port: Flag.Int('port').pipe(
      Flag.withDescription(
        `The port the server is checked on (default ${SERVE_DEFAULT_PORT})`,
      ),
      Flag.withDefault(SERVE_DEFAULT_PORT),
    ),
  },
  ({ json, port }) =>
    Effect.gen(function* () {
      const report = yield* runDoctor(processHost(), port);
      yield* Console.log(
        json ? JSON.stringify(report, null, 2) : renderDoctor(report),
      );
      if (!report.ok) {
        const n = report.counts.fail;
        return yield* new InputError({
          message: `doctor: ${n} check${n === 1 ? '' : 's'} failed`,
        });
      }
    }),
).pipe(
  Command.withDescription(
    'Check this install: Node, the bin on PATH, config.json, the store, the server, the launch agent, the Claude Code hooks, the skill, the desktop window and listen mode. Each row is ok, warn or fail with a fix; exits non-zero on any fail. Changes nothing',
  ),
);
