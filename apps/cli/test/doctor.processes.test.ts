import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { afterEach, describe, expect, it } from '@effect/vitest';
import { planClaudeSettings } from '@operator-inbox/core';
import { ConfigProvider, Effect, Result } from 'effect';
import { type DoctorHost, runDoctor } from '../src/commands/doctor';
import { readSkill } from '../src/commands/skill';
import { envProvider } from '../src/env-config';
import { moduleDir } from '../src/package-paths';

// `doctor` run whole against a fake machine: a temporary home, a stand-in
// launchctl and bin on PATH, and a local server on a free port. It spawns
// launchctl's stand-in and `desktop-app.sh check`, so it runs with the
// process tests. Every row is asked of the fake home, and the fake home is
// left exactly as it was found: doctor writes nothing.

const host: DoctorHost = {
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: process.version,
  uid: 501,
  moduleDir,
};

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const listen = (status: number) =>
  new Promise<number>((resolve) => {
    const server = createServer((_, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('[]');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

// A port nothing listens on: one the OS just handed out, closed again.
const freePort = async () => {
  const port = await listen(200);
  await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
  return port;
};

const listing = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { recursive: true }).map(String).sort();

interface Machine {
  readonly root: string;
  readonly env: Record<string, string>;
}

const machine = (launchctlExit: number): Machine => {
  const root = mkdtempSync(path.join(tmpdir(), 'operator-inbox-doctor-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const launchctl = path.join(bin, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh\nexit ${launchctlExit}\n`);
  chmodSync(launchctl, 0o755);
  return {
    root,
    env: {
      HOME: path.join(root, 'home'),
      PATH: bin,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      OPERATOR_INBOX_LAUNCHCTL: launchctl,
      OPERATOR_INBOX_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      OPERATOR_INBOX_APPLICATIONS_DIR: path.join(root, 'Applications'),
    },
  };
};

const doctor = (m: Machine, port: number) =>
  runDoctor(host, port).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, envProvider(m.env)),
    Effect.provide(NodeServices.layer),
  );

const statuses = (checks: ReadonlyArray<{ id: string; status: string }>) =>
  Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('operator-inbox doctor, on a fake machine', () => {
  it.effect('passes a machine set up as setup.sh sets one up', () =>
    Effect.gen(function* () {
      const m = machine(0);
      const home = m.env.HOME as string;
      // The bin on PATH, the launch agent's plist naming a node and a build
      // that exist, the hooks as install-claude-hooks writes them, and the
      // skill this CLI ships.
      writeFileSync(path.join(m.env.PATH as string, 'operator-inbox'), '');
      const entry = path.join(m.root, 'index.js');
      writeFileSync(entry, '');
      mkdirSync(m.env.OPERATOR_INBOX_LAUNCH_AGENTS_DIR as string);
      writeFileSync(
        path.join(
          m.env.OPERATOR_INBOX_LAUNCH_AGENTS_DIR as string,
          'com.operator-inbox.serve.plist',
        ),
        `<plist><dict><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${entry}</string><string>serve</string></array></dict></plist>`,
      );
      mkdirSync(path.join(home, '.claude', 'skills', 'operator-inbox'), {
        recursive: true,
      });
      const planned = planClaudeSettings(null);
      if (Result.isFailure(planned)) throw new Error(planned.failure);
      writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        planned.success.next,
      );
      writeFileSync(
        path.join(home, '.claude', 'skills', 'operator-inbox', 'SKILL.md'),
        yield* readSkill().pipe(Effect.provide(NodeServices.layer)),
      );
      const port = yield* Effect.promise(() => listen(200));
      const before = listing(m.root);

      const report = yield* doctor(m, port);

      expect(statuses(report.checks)).toMatchObject({
        node: 'ok',
        bin: 'ok',
        config: 'ok',
        // Not made yet: made on first use, and doctor never makes it.
        store: 'warn',
        server: 'ok',
        'launch-agent': 'ok',
        hooks: 'ok',
        skill: 'ok',
        // Not built in the fake Applications folder (and not checked off macOS).
        desktop: process.platform === 'darwin' ? 'warn' : 'ok',
      });
      expect(report.ok).toBe(true);
      expect(listing(m.root)).toEqual(before);
    }),
  );

  it.effect(
    'fails a bare machine, with a fix on every row that is not ok',
    () =>
      Effect.gen(function* () {
        const m = machine(113);
        const port = yield* Effect.promise(freePort);
        const before = listing(m.root);

        const report = yield* doctor(m, port);

        expect(statuses(report.checks)).toMatchObject({
          bin: 'fail',
          server: 'fail',
          'launch-agent': 'fail',
          hooks: 'warn',
          skill: 'warn',
        });
        expect(report.ok).toBe(false);
        for (const c of report.checks) {
          if (c.status !== 'ok') expect(c.fix).toBeTruthy();
        }
        expect(listing(m.root)).toEqual(before);
      }),
  );

  it.effect('fails a server that answers with an error', () =>
    Effect.gen(function* () {
      const m = machine(0);
      const port = yield* Effect.promise(() => listen(500));
      const report = yield* doctor(m, port);
      const server = report.checks.find((c) => c.id === 'server');
      expect(server?.status).toBe('fail');
      expect(server?.detail).toContain('500');
    }),
  );
});
