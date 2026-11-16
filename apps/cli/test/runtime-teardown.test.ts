import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from '@effect/vitest';

// THE 64 KB CLIFF, pinned by a running process rather than by a comment.
//
// `process.exit` discards whatever is still sitting in Node's stdout buffer, so
// a command that prints a large report and then exits non-zero loses the tail of
// it — silently, with no error on either side of the pipe. Any caller that
// parses a command's JSON at the moment it exits non-zero would get a
// truncated, unparseable answer.
//
// This is an integration test on purpose. The defect is not in any function: it
// is in what the Node runtime does between the last write and the exit, and only
// a real child process behind a real pipe can show it. A unit test on
// `flushingTeardown` would assert that a callback was handed a zero, which is
// the shape of the fix rather than the property it buys.
//
// THE READER IS DELIBERATELY SLOW. A reader that drains continuously keeps the
// pipe empty and the bug never appears. The delay before attaching the handler
// is what lets the pipe fill.
const PAYLOAD = 400_000;
const READ_DELAY_MS = 400;

const cliRoot = path.join(import.meta.dirname, '..');
const tsx = path.join(cliRoot, 'node_modules', '.bin', 'tsx');
const child = path.join(import.meta.dirname, 'fixtures', 'teardown-child.ts');

const runChild = (mode: 'flushing' | 'default') =>
  new Promise<{ readonly bytes: number; readonly code: number | null }>(
    (resolve) => {
      const proc = spawn(tsx, [child, mode, String(PAYLOAD)], {
        cwd: cliRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let bytes = 0;
      const timer = setTimeout(() => {
        proc.stdout.on('data', (d: Buffer) => {
          bytes += d.length;
        });
      }, READ_DELAY_MS);
      proc.on('close', (code) => {
        clearTimeout(timer);
        // Let any already-buffered chunks land before reading the count.
        setTimeout(() => resolve({ bytes, code }), 250);
      });
    },
  );

describe('the CLI runtime flushes stdout before exiting non-zero', () => {
  it('delivers the whole report AND still exits non-zero', async () => {
    const flushing = await runChild('flushing');
    // +1 for the newline `Console.log` appends.
    expect(flushing.bytes).toBe(PAYLOAD + 1);
    expect(flushing.code).toBe(1);
  }, 30_000);

  it('control: Effect default teardown truncates the same report', async () => {
    // Without this the test above could pass on a runtime that never
    // truncated, and would then be evidence of nothing. If this assertion
    // ever fails, the platform has changed — that is a finding, not noise.
    const control = await runChild('default');
    expect(control.bytes).toBeLessThan(PAYLOAD + 1);
    expect(control.code).toBe(1);
  }, 30_000);
});
