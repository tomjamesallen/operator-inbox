import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { configPath, InboxMachinePort, tunnelArgs } from '@operator-inbox/core';
import {
  ConfigProvider,
  type Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
} from 'effect';
import { TestClock } from 'effect/testing';
import {
  openTunnel,
  parseLsofListeners,
  portInUseMessage,
} from '../src/commands/tunnel';
import { envProvider } from '../src/env-config';
import { HERDR_LIST_TIMEOUT } from '../src/inbox-machine-resolution';

// `operator-inbox tunnel <machine>`, with herdr and ssh stood in for by
// shell scripts named through OPERATOR_INBOX_HERDR_BIN and OPERATOR_INBOX_SSH_BIN, and a
// config.json under a temp XDG_CONFIG_HOME. lsof is the real one: the
// port-in-use refusal must name this very process.

const HERDR_MACHINES = JSON.stringify([
  {
    id: 'm_1',
    label: 'laptop',
    target: 'operator@laptop.local',
    session: 'main',
    enabled: true,
    selected: false,
  },
]);

// A temp XDG_CONFIG_HOME holding `inboxMachines`, a herdr running `herdr`
// (by default, listing `HERDR_MACHINES`), and an ssh that records its argv
// and exits 3.
const setup = Effect.fnUntraced(function* (
  inboxMachines: ReadonlyArray<{ herdrMachine: string; port: number }>,
  herdrBody = `cat <<'EOF'\n${HERDR_MACHINES}\nEOF`,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();
  const cfg = configPath(path.join(dir, 'config'));
  yield* fs.makeDirectory(path.dirname(cfg), { recursive: true });
  yield* fs.writeFileString(cfg, JSON.stringify({ repos: {}, inboxMachines }));
  const herdr = path.join(dir, 'herdr');
  yield* fs.writeFileString(herdr, `#!/bin/sh\n${herdrBody}\n`);
  const argvFile = path.join(dir, 'ssh-argv');
  const ssh = path.join(dir, 'ssh');
  yield* fs.writeFileString(
    ssh,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexit 3\n`,
  );
  yield* fs.chmod(herdr, 0o755);
  yield* fs.chmod(ssh, 0o755);
  const env = envProvider({
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    OPERATOR_INBOX_HERDR_BIN: herdr,
    OPERATOR_INBOX_SSH_BIN: ssh,
  });
  return { env, argvFile, cfg };
});

// A port held by a listener in this process, for one test.
const holdPort = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly close: () => void }>(
    (resume) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () =>
        resume(
          Effect.succeed({
            port: (server.address() as AddressInfo).port,
            close: () => server.close(),
          }),
        ),
      );
    },
  ),
  (s) => Effect.sync(s.close),
);

// A port nothing listens on: bound, then released.
const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const run = (
  selector: string,
  env: ConfigProvider.ConfigProvider,
  within?: Duration.Input,
) =>
  openTunnel(selector, within).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, ConfigProvider.layer(env))),
    Effect.flip,
  );

describe('tunnel: ssh argv', () => {
  it('forwards loopback’s local port to the machine serve on 127.0.0.1:7184', () => {
    expect(tunnelArgs({ target: 'operator@laptop.local' }, 3010)).toEqual([
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-L',
      '127.0.0.1:3010:127.0.0.1:7184',
      '--',
      'operator@laptop.local',
    ]);
  });
});

describe('tunnel: lsof', () => {
  it('reads each listener once, past the header', () => {
    const out = [
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'ssh     41234 tom    5u  IPv4 0x1      0t0  TCP 127.0.0.1:3010 (LISTEN)',
      'ssh     41234 tom    6u  IPv6 0x2      0t0  TCP [::1]:3010 (LISTEN)',
      '',
    ].join('\n');
    expect(parseLsofListeners(out)).toEqual([{ command: 'ssh', pid: 41234 }]);
  });

  it('asks whether the tunnel is already open when ssh holds the port', () => {
    expect(
      portInUseMessage(
        { label: 'laptop', port: InboxMachinePort.make(3010) },
        [{ command: 'ssh', pid: 41234 }],
        '/x/operator-inbox/config.json',
      ),
    ).toContain('Is the tunnel to laptop already open?');
  });
});

describe('tunnel: refusals and the ssh run', () => {
  it.live('refuses a machine with no inboxMachines configured', () =>
    Effect.gen(function* () {
      const { env, cfg } = yield* setup([]);
      const e = yield* run('laptop', env);
      // The config.json named is the one read, under XDG_CONFIG_HOME.
      expect(e.message).toBe(
        `"laptop" is not an Inbox machine: no Inbox machines are configured; add it to \`inboxMachines\` in ${cfg}, e.g. \`"inboxMachines": [{ "herdrMachine": "<id or label>", "port": 3010 }]\``,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live('refuses a machine inboxMachines does not list', () =>
    Effect.gen(function* () {
      const { env, cfg } = yield* setup([
        { herdrMachine: 'laptop', port: 3010 },
      ]);
      const e = yield* run('desktop', env);
      expect(e.message).toContain(
        `"desktop" is not an Inbox machine (configured: laptop); add it to \`inboxMachines\` in ${cfg},`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    'refuses an entry that cannot be used, naming the config.json read',
    () =>
      Effect.gen(function* () {
        const { env, argvFile, cfg } = yield* setup([
          { herdrMachine: 'desktop', port: 3011 },
        ]);
        const e = yield* run('desktop', env);
        expect(e.message).toMatch(
          new RegExp(
            `^the inboxMachines entry "desktop" in ${cfg} cannot be used: `,
          ),
        );
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(argvFile)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Herdr failing, or not answering in time, is no entry's
  // fault, so the refusal is Herdr's, with Herdr's advice, never the entry's.
  const herdrAdvice =
    'Herdr could not be read on this machine, which is no fault of any inboxMachines entry: check that Herdr is installed and that `herdr machine list --json` answers here';

  it.live('refuses with Herdr’s advice when Herdr fails', () =>
    Effect.gen(function* () {
      const { env, argvFile } = yield* setup(
        [{ herdrMachine: 'laptop', port: 3010 }],
        'echo boom >&2\nexit 1',
      );
      const e = yield* run('laptop', env);
      expect(e.message).toMatch(/^cannot open the tunnel to "laptop": /);
      expect(e.message).not.toContain('cannot be used');
      expect(e.message.endsWith(`. ${herdrAdvice}`)).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(argvFile)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The bound runs on the TestClock: the stand-in says it has started
  // through a FIFO (the bound starts before Herdr is run), then the clock is
  // moved past the bound, so no test time is spent waiting on it.
  it.effect(
    'refuses with Herdr’s advice when Herdr does not answer in time',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const started = path.join(yield* fs.makeTempDirectoryScoped(), 'fifo');
        expect(spawnSync('mkfifo', [started]).status).toBe(0);
        const { env, argvFile } = yield* setup(
          [{ herdrMachine: 'laptop', port: 3010 }],
          `echo started > '${started}'\nexec sleep 8`,
        );
        const refusing = yield* Effect.forkChild(run('laptop', env));
        yield* Effect.promise(() => readFile(started, 'utf8'));
        yield* TestClock.adjust(HERDR_LIST_TIMEOUT);
        const e = yield* Fiber.join(refusing);
        expect(e.message).toBe(
          `cannot open the tunnel to "laptop": 'herdr machine list --json' did not answer within 3s. ${herdrAdvice}`,
        );
        expect(yield* fs.exists(argvFile)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Two entries a selector answers to, one by its Herdr label (m_1 is
  // labelled laptop), the other by its selector only in another case. With
  // Herdr read, the selector is refused as naming both; with Herdr down, no
  // Herdr id or label can be matched, so the refusal is Herdr's, naming the
  // selector as given, never one entry.
  it.live('refuses an ambiguous selector, or Herdr’s refusal when down', () =>
    Effect.gen(function* () {
      const machines = [
        { herdrMachine: 'm_1', port: 3010 },
        { herdrMachine: 'LAPTOP', port: 3011 },
      ];
      const read = yield* setup(machines);
      const ambiguous = yield* run('Laptop', read.env);
      expect(ambiguous.message).toBe(
        '"Laptop" names more than one Inbox machine: name one by its label, laptop, LAPTOP:3011',
      );
      const down = yield* setup(machines, 'exit 1');
      const e = yield* run('Laptop', down.env);
      expect(e.message).toMatch(/^cannot open the tunnel to "Laptop": /);
      expect(e.message.endsWith(`. ${herdrAdvice}`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // With Herdr down, a selector no entry has as configured
  // cannot be checked against Herdr's ids and labels. The refusal says
  // Herdr cannot be read first, then that the selector could not be checked,
  // so a typo is not hidden behind Herdr's sentence alone.
  it.live(
    'with Herdr down, says a selector no entry has could not be checked',
    () =>
      Effect.gen(function* () {
        const { env, cfg } = yield* setup(
          [{ herdrMachine: 'laptop', port: 3010 }],
          'echo boom >&2\nexit 1',
        );
        const typo = yield* run('mpb', env);
        expect(typo.message).toMatch(/^cannot open the tunnel to "mpb": /);
        expect(typo.message).toContain(
          `. ${herdrAdvice}. So "mpb" could not be checked: it is no entry's selector in ${cfg} (configured: laptop), and only Herdr can say whether it is a machine's Herdr id or label`,
        );
        expect(typo.message.indexOf(herdrAdvice)).toBeLessThan(
          typo.message.indexOf('could not be checked'),
        );
        // The entry's own selector is found, so Herdr's refusal stands alone.
        const known = yield* run('laptop', env);
        expect(known.message.endsWith(`. ${herdrAdvice}`)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The second entry names m_1 (laptop) again, so it cannot be
  // used, and its label is its selector, m_1, the first's Herdr id. Asked
  // for by that label, tunnel names the duplicate entry and why, the advice
  // that can be followed, rather than "name one as it is written".
  it.live(
    'a duplicate entry named by its label is refused as the duplicate',
    () =>
      Effect.gen(function* () {
        const { env, cfg } = yield* setup([
          { herdrMachine: 'laptop', port: 3010 },
          { herdrMachine: 'm_1', port: 3011 },
        ]);
        const e = yield* run('m_1', env);
        expect(e.message).toBe(
          `the inboxMachines entry "m_1" in ${cfg} cannot be used: "m_1" names the same Herdr machine as "laptop", already listed`,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live('refuses a held port before ssh runs, naming this process', () =>
    Effect.gen(function* () {
      const held = yield* holdPort;
      const { env, argvFile, cfg } = yield* setup([
        { herdrMachine: 'laptop', port: held.port },
      ]);
      const e = yield* run('laptop', env);
      expect(e.message).toContain(`port ${held.port} is already in use by `);
      expect(e.message).toContain(`another port in inboxMachines in ${cfg}`);
      expect(e.message).toContain(`(pid ${process.pid})`);
      // ssh never ran.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(argvFile)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    'runs ssh with the Herdr target, by label, and ends with its code',
    () =>
      Effect.gen(function* () {
        const port = yield* freePort;
        // Configured by the Herdr id, asked for by the label.
        const { env, argvFile } = yield* setup([{ herdrMachine: 'm_1', port }]);
        const e = yield* run('laptop', env);
        expect(e).toMatchObject({ _tag: 'TunnelEnded', exitCode: 3 });
        const fs = yield* FileSystem.FileSystem;
        expect((yield* fs.readFileString(argvFile)).trim().split('\n')).toEqual(
          [...tunnelArgs({ target: 'operator@laptop.local' }, port)],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Labels are unique regardless of case (core's `inboxMachineLabels`), so
  // the label in another case names the one machine.
  it.live('finds a machine by its label in another case', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const { env, argvFile } = yield* setup([{ herdrMachine: 'm_1', port }]);
      const e = yield* run('LAPTOP', env);
      expect(e).toMatchObject({ _tag: 'TunnelEnded', exitCode: 3 });
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.readFileString(argvFile)).trim().split('\n')).toEqual([
        ...tunnelArgs({ target: 'operator@laptop.local' }, port),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // A bad `inboxMachines` is refused with why, before ssh.
  it.live('refuses an inboxMachines that cannot be read, saying why', () =>
    Effect.gen(function* () {
      const { env, argvFile, cfg } = yield* setup([
        { herdrMachine: 'laptop', port: 3010 },
        { herdrMachine: 'm_1', port: 3010 },
      ]);
      const e = yield* run('laptop', env);
      expect(e.message).toMatch(
        new RegExp(
          `^cannot open the tunnel to "laptop": config\\.json at ${cfg}: inboxMachines — .*3010`,
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(argvFile)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live('finds by its Herdr id a machine the entry names by its label', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      // Configured by the label, asked for by the Herdr id.
      const { env, argvFile } = yield* setup([
        { herdrMachine: 'laptop', port },
      ]);
      const e = yield* run('m_1', env);
      expect(e).toMatchObject({ _tag: 'TunnelEnded', exitCode: 3 });
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.readFileString(argvFile)).trim().split('\n')).toEqual([
        ...tunnelArgs({ target: 'operator@laptop.local' }, port),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
