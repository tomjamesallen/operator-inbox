import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { planClaudeSettings } from '@operator-inbox/core';
import { Result } from 'effect';
import {
  binCheck,
  configCheck,
  desktopCheck,
  hooksCheck,
  launchAgentCheck,
  NODE_MIN,
  nodeCheck,
  plistProgramArguments,
  plistString,
  renderDoctor,
  reportOf,
  serverCheck,
  skillCheck,
  storeCheck,
  versionAtLeast,
  voiceCheck,
} from '../src/doctor';

// `operator-inbox doctor`'s rules, pure: each observation the command makes,
// and the row it becomes.

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.operator-inbox.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>/src/a &amp; b/apps/cli/dist/index.js</string>
    <string>serve</string>
  </array>
  <key>StandardOutPath</key>
  <string>/home/me/.local/state/operator-inbox/serve.log</string>
</dict>
</plist>
`;

const agent = (over: Partial<Parameters<typeof launchAgentCheck>[0]> = {}) =>
  launchAgentCheck({
    plist: '/home/me/Library/LaunchAgents/com.operator-inbox.serve.plist',
    text: PLIST,
    loaded: true,
    exists: () => true,
    bootstrap: 'launchctl bootstrap gui/501 /x.plist',
    ...over,
  });

describe('doctor: Node', () => {
  it('compares versions part by part', () => {
    expect(versionAtLeast('v22.16.0', '22.16.0')).toBe(true);
    expect(versionAtLeast('v22.9.1', '22.16.0')).toBe(false);
    expect(versionAtLeast('v24.0.0', '22.16.0')).toBe(true);
    expect(versionAtLeast('v22.16', '22.16.0')).toBe(true);
  });

  it('fails a Node older than the engines field allows', () => {
    expect(nodeCheck('v22.23.0').status).toBe('ok');
    const old = nodeCheck('v20.11.0');
    expect(old.status).toBe('fail');
    expect(old.fix).toContain(NODE_MIN);
  });

  it('holds the same minimum as the root package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${NODE_MIN}`);
  });
});

describe('doctor: bin, config and store', () => {
  it('fails when the bin is not on PATH', () => {
    expect(binCheck('/usr/local/bin/operator-inbox').status).toBe('ok');
    expect(binCheck(undefined).status).toBe('fail');
  });

  it('takes a missing config.json as the defaults, and fails a broken one', () => {
    expect(configCheck({ kind: 'absent', path: '/c.json' }).status).toBe('ok');
    expect(configCheck({ kind: 'loaded', path: '/c.json' }).status).toBe('ok');
    const broken = configCheck({ kind: 'broken', message: 'bad key' });
    expect(broken).toMatchObject({ status: 'fail', detail: 'bad key' });
  });

  it('warns of a store not made yet, and fails one that does not open', () => {
    expect(storeCheck({ kind: 'opened', path: '/s' }).status).toBe('ok');
    expect(storeCheck({ kind: 'absent', path: '/s' })).toMatchObject({
      status: 'warn',
      fix: 'run: operator-inbox install',
    });
    expect(
      storeCheck({ kind: 'broken', path: '/s', message: 'locked' }).status,
    ).toBe('fail');
    expect(storeCheck({ kind: 'unresolved', message: 'no HOME' }).status).toBe(
      'fail',
    );
  });
});

describe('doctor: the server', () => {
  const url = 'http://127.0.0.1:7184/api/inboxes';

  it('is ok when it answers', () => {
    expect(serverCheck({ kind: 'answered', url }, true, undefined).status).toBe(
      'ok',
    );
  });

  it('fails when nothing answers, naming the log on macOS', () => {
    const mac = serverCheck(
      { kind: 'silent', url, reason: 'refused' },
      true,
      '/x/serve.log',
    );
    expect(mac.status).toBe('fail');
    expect(mac.fix).toContain('/x/serve.log');
    const other = serverCheck(
      { kind: 'silent', url, reason: 'refused' },
      false,
      undefined,
    );
    expect(other.fix).toBe('run: operator-inbox serve');
  });

  it('fails when something else answers the port', () => {
    const c = serverCheck(
      { kind: 'status', url, status: 404 },
      true,
      undefined,
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('404');
  });
});

describe('doctor: the launch agent', () => {
  it('reads the plist setup.sh writes', () => {
    expect(plistProgramArguments(PLIST)).toEqual([
      '/opt/node/bin/node',
      '/src/a & b/apps/cli/dist/index.js',
      'serve',
    ]);
    expect(plistString(PLIST, 'StandardOutPath')).toBe(
      '/home/me/.local/state/operator-inbox/serve.log',
    );
    expect(plistString(PLIST, 'StandardErrorPath')).toBeUndefined();
    expect(plistProgramArguments('<plist/>')).toEqual([]);
  });

  it('is ok when loaded and its paths are there', () => {
    expect(agent()).toMatchObject({ status: 'ok' });
  });

  it('fails when the plist is missing', () => {
    expect(agent({ text: undefined, loaded: false }).status).toBe('fail');
    expect(agent({ text: undefined, loaded: true }).status).toBe('warn');
  });

  it('fails when the node it names is gone, pointing at rebuild', () => {
    const c = agent({ exists: (p) => p !== '/opt/node/bin/node' });
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('rebuild');
  });

  it('fails when the build it runs is gone', () => {
    const c = agent({ exists: (p) => !p.endsWith('index.js') });
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('index.js');
  });

  it('fails when not loaded, with the command that loads it', () => {
    const c = agent({ loaded: false });
    expect(c.status).toBe('fail');
    expect(c.fix).toBe('run: launchctl bootstrap gui/501 /x.plist');
  });
});

describe('doctor: the hooks', () => {
  const installed = (() => {
    const planned = planClaudeSettings(null);
    if (Result.isFailure(planned)) throw new Error(planned.failure);
    return planned.success.next;
  })();

  it('is ok when the hooks are as install-claude-hooks writes them', () => {
    expect(hooksCheck('~/.claude/settings.json', installed).status).toBe('ok');
  });

  it('warns when the file or the hooks are missing', () => {
    expect(hooksCheck('~/.claude/settings.json', null).status).toBe('warn');
    const none = hooksCheck('~/.claude/settings.json', '{"model":"x"}');
    expect(none).toMatchObject({
      status: 'warn',
      fix: 'run: operator-inbox install-claude-hooks',
    });
  });

  it('warns, without the fix that would refuse, when the file does not parse', () => {
    const c = hooksCheck('~/.claude/settings.json', '{ nope');
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('by hand');
  });
});

describe('doctor: the skill', () => {
  const shown = '~/.claude/skills/operator-inbox/SKILL.md';

  it('is ok when it matches the shipped skill, else warns with the install line', () => {
    expect(skillCheck(shown, 'same', 'same').status).toBe('ok');
    const old = skillCheck(shown, 'old', 'new');
    expect(old.status).toBe('warn');
    expect(old.fix).toBe(
      `run: mkdir -p ~/.claude/skills/operator-inbox && operator-inbox skill > ${shown}`,
    );
    expect(skillCheck(shown, null, 'new').detail).toContain('not installed');
  });
});

describe('doctor: the desktop window and the voice', () => {
  const build = 'bash /src/scripts/desktop-app.sh build';

  it('takes desktop-app.sh check exit 0 as ok, and anything else as a warn', () => {
    expect(
      desktopCheck(
        {
          kind: 'checked',
          code: 0,
          line: 'desktop window: /A/Operator Inbox.app is current (1.3.0)',
        },
        build,
      ),
    ).toMatchObject({
      status: 'ok',
      detail: '/A/Operator Inbox.app is current (1.3.0)',
    });
    const stale = desktopCheck(
      { kind: 'checked', code: 1, line: 'desktop window: … is stale' },
      build,
    );
    expect(stale.status).toBe('warn');
    expect(stale.fix).toContain(build);
    expect(desktopCheck({ kind: 'no-script' }, build).status).toBe('warn');
  });

  it('warns when listen mode has no voice, and is ok where it cannot run', () => {
    expect(voiceCheck({ kind: 'found', python: '/py' }).status).toBe('ok');
    expect(voiceCheck({ kind: 'missing', message: 'no mlx' }).status).toBe(
      'warn',
    );
    expect(
      voiceCheck({ kind: 'unsupported', platform: 'linux-x64' }).status,
    ).toBe('ok');
  });
});

describe('doctor: the report', () => {
  it('counts the rows, and is not ok when any row fails', () => {
    const report = reportOf([
      nodeCheck('v22.16.0'),
      binCheck(undefined),
      voiceCheck({ kind: 'missing', message: 'no mlx' }),
    ]);
    expect(report.counts).toEqual({ ok: 1, warn: 1, fail: 1 });
    expect(report.ok).toBe(false);
    expect(reportOf([nodeCheck('v22.16.0')]).ok).toBe(true);
  });

  it('renders one row per check, its fix under it, then the counts', () => {
    const text = renderDoctor(
      reportOf([nodeCheck('v22.16.0'), binCheck(undefined)]),
    );
    expect(text.split('\n')).toEqual([
      'ok    node  Node v22.16.0',
      'fail  bin   operator-inbox is not on PATH, and agents and the hooks run it from there',
      "            fix: run scripts/setup.sh, and check pnpm's global bin folder is on PATH (pnpm setup)",
      '',
      '1 ok, 0 warn, 1 fail',
    ]);
  });
});
