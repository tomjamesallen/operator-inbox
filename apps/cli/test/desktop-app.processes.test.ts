import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from '@effect/vitest';

// `scripts/desktop-app.sh`, run for real by bash against a fake machine: pake
// and rustc are stand-ins on PATH, and the window goes to a temporary
// Applications folder (OPERATOR_INBOX_APPLICATIONS_DIR). The stand-in pake
// writes a bundle as Pake lays one out and prints its JSON result, so a build
// takes a moment rather than minutes. It reads bundles with macOS's own
// plutil, so it runs on macOS only.

const SCRIPT = fileURLToPath(
  new URL('../../../scripts/desktop-app.sh', import.meta.url),
);
const ICON = fileURLToPath(
  new URL('../../../scripts/desktop-app/operator-inbox.icns', import.meta.url),
);
const IDENTIFIER = 'com.operator-inbox.desktop';
const VERSION = /^VERSION=(\S+)$/m.exec(readFileSync(SCRIPT, 'utf8'))?.[1];
const SPAWN_BUDGET_MS = 20_000;

// Writes `<name>.app` in its working folder from its --name, --identifier,
// --app-version and --icon, then prints Pake's JSON result. FAKE_PAKE_ID
// overrides the identifier, for a build that comes out wrong.
const FAKE_PAKE = `#!/bin/bash
set -eu
echo "$*" >>"$FAKE_STATE/pake.log"
[ "$1" = --version ] && { echo "3.17.5"; exit 0; }
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift ;;
    --identifier) id="$2"; shift ;;
    --app-version) version="$2"; shift ;;
    --icon) icon="$2"; shift ;;
  esac
  shift
done
id="\${FAKE_PAKE_ID:-$id}"
app="$name.app"
mkdir -p "$app/Contents/Resources"
cp "$icon" "$app/Contents/Resources/operator_inbox.icns"
cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$id</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleIconFile</key><string>operator_inbox.icns</string>
</dict></plist>
PLIST
echo "building..." >&2
printf '{"ok":true,"outputs":[{"path":"%s","sizeBytes":1,"format":"app"}],"warnings":[],"error":null}\\n' "$app"
`;

const tool = (file: string, body: string) => {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
};

const infoPlist = (
  id: string,
  version: string,
) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIconFile</key><string>operator_inbox</string>
</dict></plist>
`;

let base = '';
afterEach(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

const machine = () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'oi-desktop-')));
  const bin = join(base, 'bin');
  // node alone, apart from the folder it is installed in, which may hold a
  // real pake.
  const nodeBin = join(base, 'node-bin');
  const state = join(base, 'state');
  const apps = join(base, 'Applications');
  const home = join(base, 'home');
  for (const dir of [bin, nodeBin, state, apps, home, join(base, 'tmp')])
    mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  tool(join(bin, 'pake'), FAKE_PAKE);
  tool(join(bin, 'rustc'), '#!/bin/sh\necho "rustc 1.90.0 (Homebrew)"\n');
  const bundle = join(apps, 'Operator Inbox.app');

  const run = (
    args: ReadonlyArray<string>,
    env: Record<string, string> = {},
  ) => {
    const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
      env: {
        // node, for reading pake's result.
        PATH: `${bin}:${nodeBin}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: join(base, 'tmp'),
        FAKE_STATE: state,
        OPERATOR_INBOX_APPLICATIONS_DIR: apps,
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  /** A bundle at the window's name, as a build of it (or another app) leaves one. */
  const install = (
    id: string,
    version: string,
    icon: 'committed' | 'other',
  ) => {
    mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(
      join(bundle, 'Contents', 'Info.plist'),
      infoPlist(id, version),
    );
    const bundled = join(
      bundle,
      'Contents',
      'Resources',
      'operator_inbox.icns',
    );
    if (icon === 'committed') copyFileSync(ICON, bundled);
    else writeFileSync(bundled, 'not the icon');
  };

  const pakeLog = () => {
    const file = join(state, 'pake.log');
    return existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
      : [];
  };

  return { apps, bundle, nodeBin, run, install, pakeLog };
};

describe.runIf(process.platform === 'darwin')('desktop-app.sh', () => {
  it('reads its build version from the script', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe('check', () => {
    it(
      'says the window is not installed, and how to build it',
      () => {
        const m = machine();
        const r = m.run(['check']);
        expect(r.status).toBe(1);
        expect(r.stdout.trim()).toBe(
          `desktop window: ${m.bundle} is not installed (optional; build it with: bash scripts/desktop-app.sh build)`,
        );
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'passes a build of this version with the committed icon',
      () => {
        const m = machine();
        m.install(IDENTIFIER, VERSION ?? '', 'committed');
        const r = m.run(['check']);
        expect(r.status, r.stdout).toBe(0);
        expect(r.stdout.trim()).toBe(
          `desktop window: ${m.bundle} is current (${VERSION})`,
        );
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'calls a build of another version stale',
      () => {
        const m = machine();
        m.install(IDENTIFIER, '1.0.0', 'committed');
        const r = m.run(['check']);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain(
          `is stale, its build is 1.0.0, this checkout builds ${VERSION}`,
        );
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'calls a build whose icon differs from the committed one stale',
      () => {
        const m = machine();
        m.install(IDENTIFIER, VERSION ?? '', 'other');
        const r = m.run(['check']);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('is stale, its icon differs');
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'says another app at the name is not this one',
      () => {
        const m = machine();
        m.install('com.example.other', '1.0.0', 'committed');
        const r = m.run(['check']);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain(
          'is not this app: it is another app (com.example.other, not com.operator-inbox.desktop)',
        );
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'names a folder an earlier build left behind',
      () => {
        const m = machine();
        m.install(IDENTIFIER, VERSION ?? '', 'committed');
        mkdirSync(join(m.apps, '.operator-inbox-install-abc123'));
        const r = m.run(['check']);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(
          `left behind by an earlier build, check and remove by hand: ${join(m.apps, '.operator-inbox-install-abc123')}`,
        );
      },
      SPAWN_BUDGET_MS,
    );
  });

  describe('build', () => {
    it(
      'builds and installs the window, leaving nothing behind',
      () => {
        const m = machine();
        const r = m.run(['build']);
        expect(r.status, r.stderr).toBe(0);
        expect(m.pakeLog().at(-1)).toBe(
          `http://127.0.0.1:7184 --name Operator Inbox --identifier ${IDENTIFIER} --icon ${ICON} --app-version ${VERSION} --targets app --no-restore-last-url --enable-find --json`,
        );
        expect(m.run(['check']).status).toBe(0);
        expect(readdirSync(m.apps)).toEqual(['Operator Inbox.app']);
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'replaces an earlier build of the window',
      () => {
        const m = machine();
        m.install(IDENTIFIER, '1.0.0', 'other');
        const r = m.run(['build']);
        expect(r.status, r.stderr).toBe(0);
        expect(m.run(['check']).status).toBe(0);
        expect(readdirSync(m.apps)).toEqual(['Operator Inbox.app']);
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'refuses to overwrite another app, before running pake',
      () => {
        const m = machine();
        m.install('com.example.other', '1.0.0', 'other');
        const r = m.run(['build']);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`refusing to overwrite ${m.bundle}`);
        expect(m.pakeLog()).toEqual([]);
        expect(
          readFileSync(join(m.bundle, 'Contents', 'Info.plist'), 'utf8'),
        ).toContain('com.example.other');
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'installs nothing when pake builds another identifier',
      () => {
        const m = machine();
        const r = m.run(['build'], { FAKE_PAKE_ID: 'com.example.wrong' });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('nothing was installed');
        expect(readdirSync(m.apps)).toEqual([]);
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'names every missing tool in one go',
      () => {
        const m = machine();
        rmSync(join(base, 'bin', 'pake'));
        rmSync(join(base, 'bin', 'rustc'));
        const r = m.run(['build'], { PATH: `${m.nodeBin}:/usr/bin:/bin` });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('pake is not on PATH');
        expect(r.stderr).toContain('rustc is not on PATH');
      },
      SPAWN_BUDGET_MS,
    );

    it(
      'under --dry-run says the pake command and runs nothing',
      () => {
        const m = machine();
        const r = m.run(['build', '--dry-run']);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain('desktop-app: would run: pake');
        expect(r.stdout).toContain(`--app-version ${VERSION}`);
        expect(m.pakeLog()).toEqual([]);
        expect(readdirSync(m.apps)).toEqual([]);
      },
      SPAWN_BUDGET_MS,
    );
  });
});
