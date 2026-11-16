import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from '@effect/vitest';

// `scripts/setup.sh rebuild`, run for real by bash against a fake machine:
// launchctl, pnpm, node, curl and uname are stand-ins on PATH, and the plist
// lives in a temporary LaunchAgents folder (OPERATOR_INBOX_LAUNCH_AGENTS_DIR).
// The script is copied into fake checkouts, so which checkout runs it is the
// test's choice. Nothing outside the temporary folder is read or written, and
// the environment is built from nothing, so this shell's own leaks into none.

const SETUP = fileURLToPath(
  new URL('../../../scripts/setup.sh', import.meta.url),
);
const LABEL = 'com.operator-inbox.serve';
const SPAWN_BUDGET_MS = 20_000;

const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$*" >>"$FAKE_STATE/launchctl.log"
case "$1" in
  print) [ -f "$FAKE_STATE/loaded" ] ;;
  bootout) rm -f "$FAKE_STATE/loaded" ;;
  bootstrap)
    n=$(cat "$FAKE_STATE/bootstrap-failures" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then
      echo $((n - 1)) >"$FAKE_STATE/bootstrap-failures"
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    touch "$FAKE_STATE/loaded"
    ;;
esac
`;

const tool = (file: string, body: string) => {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
};

const xml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A plist in the layout setup.sh renders. */
const plistFor = (
  node: string,
  entry: string,
  home: string,
) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(entry)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/gone/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${xml(home)}</string>
    <key>XDG_STATE_HOME</key>
    <string>/kept/state</string>
    <key>OPERATOR_INBOX_DATABASE_PATH</key>
    <string>${xml('/kept/a&b.sqlite')}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/kept/state/operator-inbox/serve.log</string>
  <key>StandardErrorPath</key>
  <string>/kept/state/operator-inbox/serve.log</string>
</dict>
</plist>
`;

let base = '';
afterEach(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

/** A fake machine with checkouts `a` and `b`, and an installed plist naming `node` and `a`'s build. */
const machine = (options: {
  readonly installedNode: 'present' | 'gone';
  readonly loaded?: boolean;
  readonly bootstrapFailures?: number;
  /** False for a server that never answers the health check. */
  readonly serveAnswers?: boolean;
}) => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'oi-setup-')));
  const bin = join(base, 'bin');
  const state = join(base, 'state');
  const agents = join(base, 'LaunchAgents');
  const home = join(base, 'home');
  for (const dir of [bin, state, agents, home, join(base, 'tmp')])
    mkdirSync(dir, { recursive: true });
  const checkout = (name: string) => {
    const root = join(base, name);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'apps', 'cli', 'dist'), { recursive: true });
    copyFileSync(SETUP, join(root, 'scripts', 'setup.sh'));
    writeFileSync(join(root, 'apps', 'cli', 'dist', 'index.js'), '');
    return root;
  };
  const roots = { a: checkout('a'), b: checkout('b') };
  tool(join(bin, 'launchctl'), FAKE_LAUNCHCTL);
  tool(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  tool(join(bin, 'node'), '#!/bin/sh\necho v22.16.0\n');
  tool(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n');
  tool(
    join(bin, 'curl'),
    `#!/bin/sh\necho "$*" >>"${state}/curl.log"\nexit ${(options.serveAnswers ?? true) ? 0 : 7}\n`,
  );
  const oldNode = join(base, 'old node', 'node');
  if (options.installedNode === 'present') {
    mkdirSync(join(base, 'old node'));
    tool(oldNode, '#!/bin/sh\n');
  }
  if (options.loaded ?? true) writeFileSync(join(state, 'loaded'), '');
  if (options.bootstrapFailures !== undefined)
    writeFileSync(
      join(state, 'bootstrap-failures'),
      `${options.bootstrapFailures}`,
    );
  const plist = join(agents, `${LABEL}.plist`);
  const installed = plistFor(
    oldNode,
    join(roots.a, 'apps', 'cli', 'dist', 'index.js'),
    home,
  );
  writeFileSync(plist, installed);

  const rebuild = (
    from: keyof typeof roots,
    callerEnv: Record<string, string> = {},
  ) => {
    const r = spawnSync(
      '/bin/bash',
      [join(roots[from], 'scripts', 'setup.sh'), 'rebuild'],
      {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          TMPDIR: join(base, 'tmp'),
          FAKE_STATE: state,
          OPERATOR_INBOX_LAUNCH_AGENTS_DIR: agents,
          OPERATOR_INBOX_LAUNCHCTL: join(bin, 'launchctl'),
          OPERATOR_INBOX_PNPM_LINK: join(bin, 'pnpm'),
          ...callerEnv,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
      : [];
  const domain = `gui/${process.getuid?.() ?? ''}`;
  return {
    bin,
    oldNode,
    plist,
    installed,
    entryA: join(roots.a, 'apps', 'cli', 'dist', 'index.js'),
    domain,
    home,
    rebuild,
    launchctl: () => lines(join(state, 'launchctl.log')),
    curls: () => lines(join(state, 'curl.log')),
    readPlist: () => readFileSync(plist, 'utf8'),
  };
};

/** A caller whose environment differs from the one the plist was made in. */
const otherCaller = {
  OPERATOR_INBOX_DATABASE_PATH: '/elsewhere/inbox.sqlite',
  XDG_CONFIG_HOME: '/elsewhere/config',
};

describe('setup.sh rebuild', () => {
  it(
    'replaces a node that is gone with the caller node, keeps every other byte, and reloads and checks the agent',
    () => {
      const m = machine({ installedNode: 'gone' });
      const r = m.rebuild('b', otherCaller);
      expect(r.status, r.stderr).toBe(0);
      // Run from checkout b, with another store and config set: only the
      // node line moved, and the agent still runs checkout a's build.
      expect(m.readPlist()).toBe(
        m.installed.replace(
          `<string>${xml(m.oldNode)}</string>`,
          `<string>${xml(join(m.bin, 'node'))}</string>`,
        ),
      );
      expect(m.readPlist()).not.toBe(m.installed);
      expect(m.launchctl()).toEqual([
        `print ${m.domain}/${LABEL}`,
        `bootout ${m.domain}/${LABEL}`,
        `bootstrap ${m.domain} ${m.plist}`,
      ]);
      expect(m.curls()).toHaveLength(1);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    'leaves the plist alone when its node is there, whatever the caller environment, and restarts and checks the agent',
    () => {
      const m = machine({ installedNode: 'present' });
      const r = m.rebuild('a', otherCaller);
      expect(r.status, r.stderr).toBe(0);
      expect(m.readPlist()).toBe(m.installed);
      expect(m.launchctl()).toEqual([
        `print ${m.domain}/${LABEL}`,
        `kickstart -k ${m.domain}/${LABEL}`,
      ]);
      expect(m.curls()).toHaveLength(1);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    "run from another checkout, does not point the agent at that checkout's build",
    () => {
      const m = machine({ installedNode: 'present' });
      const r = m.rebuild('b');
      expect(r.status, r.stderr).toBe(0);
      expect(m.readPlist()).toBe(m.installed);
      expect(r.stdout).toContain(`runs ${m.entryA}, not this checkout's build`);
      expect(m.launchctl()).toEqual([
        `print ${m.domain}/${LABEL}`,
        `kickstart -k ${m.domain}/${LABEL}`,
      ]);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    'tries the bootstrap again when launchd refuses it just after the bootout',
    () => {
      const m = machine({ installedNode: 'gone', bootstrapFailures: 2 });
      const r = m.rebuild('a');
      expect(r.status, r.stderr).toBe(0);
      expect(
        m.launchctl().filter((l) => l.startsWith('bootstrap')),
      ).toHaveLength(3);
      expect(m.curls()).toHaveLength(1);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    'when the agent never loads again, exits non-zero with one line naming the command that loads it',
    () => {
      const m = machine({ installedNode: 'gone', bootstrapFailures: 99 });
      const r = m.rebuild('a');
      expect(r.status).not.toBe(0);
      const stderr = r.stderr.split('\n').filter(Boolean);
      expect(stderr.at(-1)).toBe(
        `setup: the launch agent ${LABEL} is not loaded; load it with: launchctl bootstrap ${m.domain} ${m.plist}`,
      );
      expect(
        m.launchctl().filter((l) => l.startsWith('bootstrap')),
      ).toHaveLength(5);
      expect(m.curls()).toEqual([]);
    },
    SPAWN_BUDGET_MS,
  );

  it('exits non-zero, naming the log, when the restarted server does not answer', () => {
    const m = machine({ installedNode: 'present', serveAnswers: false });
    const r = m.rebuild('a');
    expect(r.status).toBe(1);
    // The log the installed plist names, not the caller's state folder.
    expect(r.stdout).toContain(
      'serve did NOT answer at http://127.0.0.1:7184/api/inboxes yet; see /kept/state/operator-inbox/serve.log',
    );
    expect(r.stderr.split('\n').filter(Boolean).at(-1)).toBe(
      `setup: serve did not answer at http://127.0.0.1:7184/api/inboxes after the restart; read /kept/state/operator-inbox/serve.log`,
    );
    expect(m.curls()).toHaveLength(10);
  }, 30_000);

  it(
    'leaves an agent that is not loaded alone, plist and all',
    () => {
      const m = machine({ installedNode: 'gone', loaded: false });
      const r = m.rebuild('a');
      expect(r.status, r.stderr).toBe(0);
      expect(m.readPlist()).toBe(m.installed);
      expect(m.launchctl()).toEqual([`print ${m.domain}/${LABEL}`]);
      expect(m.curls()).toEqual([]);
    },
    SPAWN_BUDGET_MS,
  );
});
