import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';

// Hide node:sqlite's ExperimentalWarning and no other warning. Shown here in
// real child processes, because only a real Node can say its own
// `node:sqlite` still raises the warning through `process.emitWarning` (the
// one function the filter wraps). The predicate is pinned in
// `node-warnings.test.ts`.

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TSX = join(CLI_ROOT, 'node_modules', '.bin', 'tsx');
const CHILD = join(CLI_ROOT, 'test', 'fixtures', 'sqlite-warning-child.ts');
const ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const SPAWN_BUDGET_MS = 20_000;

const SQLITE_WARNING = 'ExperimentalWarning: SQLite is an experimental feature';

const spawn = (
  args: ReadonlyArray<string>,
  extraEnv: Record<string, string> = {},
) => {
  const r = spawnSync(TSX, args, {
    cwd: CLI_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('the SQLite warning in a real process', () => {
  it(
    'without the filter, loading node:sqlite prints the warning (the control)',
    () => {
      const { status, stderr } = spawn([CHILD, 'show']);
      expect(status).toBe(0);
      expect(stderr).toContain(SQLITE_WARNING);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    'with the filter, the SQLite warning is gone and every other warning still prints',
    () => {
      const { status, stderr } = spawn([CHILD, 'hide']);
      expect(status).toBe(0);
      expect(stderr).not.toContain('SQLite is an experimental feature');
      expect(stderr).toContain(
        'ExperimentalWarning: Another feature is an experimental feature',
      );
      expect(stderr).toContain(
        'DeprecationWarning: SQLite old option is deprecated',
      );
    },
    SPAWN_BUDGET_MS,
  );

  it(
    'the CLI entry point installs it: `list` on a fresh log prints no warning',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'operator-inbox-sqlite-warning-'));
      try {
        const xdg = join(dir, 'xdg');
        mkdirSync(xdg);
        const { status, stdout, stderr } = spawn([ENTRY, 'list'], {
          XDG_CONFIG_HOME: xdg,
          OPERATOR_INBOX_DATABASE_PATH: join(dir, 'inbox.sqlite'),
        });
        expect(status).toBe(0);
        expect(stdout).toBe('no inboxes\n');
        expect(stderr).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_BUDGET_MS,
  );
});
