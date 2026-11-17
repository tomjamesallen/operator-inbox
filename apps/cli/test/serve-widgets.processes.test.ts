import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import type { WidgetConfig } from '@operator-inbox/core';
import { ConfigProvider, Effect, Exit, Scope } from 'effect';
import { ChildProcess } from 'effect/process';
import { envProvider } from '../src/env-config';
import {
  captureStdout,
  NodeServicesSparingExitedGroups,
} from '../src/process-edge';
import {
  runWidgetCommand,
  WIDGET_STDOUT_CAP,
  widgetEnvironment,
} from '../src/serve-widget-run';
import { makeWidgetRunner } from '../src/serve-widgets';

// A widget's run with real processes, under the spawner serve runs with: the
// timeout ending the whole process group, SIGKILL for a command that ignores
// SIGTERM, the stdout cap, the stderr tail, a missing command, a signal
// death, the PATH and variables a command sees, and stopping the runner
// ending what it runs. Each `sleep` carries an odd length of its own, so the
// check that none survives cannot be fooled by another one on the machine.

const config = (
  command: string,
  over: Partial<WidgetConfig> = {},
): WidgetConfig => ({
  id: 'probe',
  label: 'Probe',
  command,
  intervalSeconds: 60,
  timeoutSeconds: 10,
  format: 'text',
  lines: 1,
  ...over,
});

const run = (widget: WidgetConfig, pathEntries: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const environment = yield* widgetEnvironment(widget.id, pathEntries);
    return yield* runWidgetCommand(widget, environment, scope);
  });

const live = <A, E, R>(effect: Effect.Effect<A, E, R>, env = {}) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(NodeServicesSparingExitedGroups),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider(env, { fallBackToEnv: true }),
    ),
  );

// Whether any process on the machine has `marker` in its command line.
const anyRunning = (marker: string) =>
  captureStdout(
    ChildProcess.make('ps', ['-A', '-o', 'command='], { stderr: 'inherit' }),
    (reason) => new Error(`ps: ${reason._tag}`),
  ).pipe(Effect.map((out) => out.split('\n').some((l) => l.includes(marker))));

describe('a widget run, with real processes', () => {
  it.live(
    'a timeout returns at its bound and ends the whole pipeline',
    () =>
      live(
        Effect.gen(function* () {
          const { run: result, reaped } = yield* run(
            config('echo begun; sleep 31.4159 | cat', { timeoutSeconds: 1 }),
          );
          expect(result.timedOut).toBe(true);
          expect(result.ok).toBe(false);
          expect(result.exitCode).toBeNull();
          expect(result.stdout).toBe('begun\n');
          expect(result.durationMs).toBeLessThan(1500);
          yield* reaped;
          expect(yield* anyRunning('sleep 31.4159')).toBe(false);
        }),
      ),
    15_000,
  );

  it.live(
    'a command that ignores SIGTERM is sent SIGKILL after the grace',
    () =>
      live(
        Effect.gen(function* () {
          const { run: result, reaped } = yield* run(
            config("trap '' TERM; sleep 31.2718 | cat", { timeoutSeconds: 1 }),
          );
          expect(result.timedOut).toBe(true);
          expect(yield* anyRunning('sleep 31.2718')).toBe(true);
          yield* reaped;
          expect(yield* anyRunning('sleep 31.2718')).toBe(false);
        }),
      ),
    15_000,
  );

  it.live('keeps the first 8 KB of stdout and says it cut the rest', () =>
    live(
      Effect.gen(function* () {
        const { run: result } = yield* run(
          config("head -c 100000 /dev/zero | tr '\\0' a"),
        );
        expect(result.ok).toBe(true);
        expect(result.truncated).toBe(true);
        expect(result.stdout).toBe('a'.repeat(WIDGET_STDOUT_CAP));
      }),
    ),
  );

  it.live('keeps the last line stderr had on it, and the exit code', () =>
    live(
      Effect.gen(function* () {
        const { run: result } = yield* run(
          config('echo out; echo one >&2; echo two >&2; echo >&2; exit 4'),
        );
        expect(result).toMatchObject({
          ok: false,
          exitCode: 4,
          stdout: 'out\n',
          stderrTail: 'two',
          truncated: false,
          spawnError: null,
        });
      }),
    ),
  );

  it.live('a missing command is bash’s 127 and its complaint', () =>
    live(
      Effect.gen(function* () {
        const { run: result } = yield* run(config('no-such-widget-command'));
        expect(result.ok).toBe(false);
        expect(result.exitCode).toBe(127);
        expect(result.stderrTail).toContain('command not found');
      }),
    ),
  );

  it.live('a shell killed by a signal names it', () =>
    live(
      Effect.gen(function* () {
        const { run: result } = yield* run(config('kill -9 $$'));
        expect(result.ok).toBe(false);
        expect(result.exitCode).toBeNull();
        expect(result.signal).toBe('SIGKILL');
      }),
    ),
  );

  it.live('puts the path entries in front of PATH, ~ as the home', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'operator-inbox-widget-'));
    const bin = path.join(home, 'tools');
    mkdirSync(bin);
    const probe = path.join(bin, 'widget-probe');
    writeFileSync(probe, '#!/bin/sh\necho probed\n');
    chmodSync(probe, 0o755);
    return live(
      Effect.gen(function* () {
        const { run: result } = yield* run(config('widget-probe; pwd -P'), [
          '~/tools',
        ]);
        expect(result.ok).toBe(true);
        // Run in the home folder: `pwd -P`, since the temp folder may be a link.
        expect(result.stdout).toBe(`probed\n${realpathSync(home)}\n`);
        const { run: still } = yield* run(config('command -v cat'), [
          '~/tools',
        ]);
        expect(still.ok).toBe(true);
      }),
      { HOME: home },
    );
  });

  it.live('sets the colour, width and widget variables', () =>
    live(
      Effect.gen(function* () {
        const { run: result } = yield* run(
          config(
            'printf "%s|%s|%s|%s" "$FORCE_COLOR" "$CLICOLOR_FORCE" "$COLUMNS" "$OPERATOR_INBOX_WIDGET"',
            { id: 'envy' },
          ),
        );
        expect(result.stdout).toBe('1|1|40|envy');
      }),
    ),
  );

  it.live(
    'stopping the runner ends every process it runs',
    () => {
      const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-widgets-'));
      mkdirSync(path.join(xdg, 'config', 'operator-inbox'), {
        recursive: true,
      });
      writeFileSync(
        path.join(xdg, 'config', 'operator-inbox', 'widgets.json'),
        JSON.stringify({
          widgets: [{ label: 'Hang', command: 'sleep 31.5772 | cat' }],
        }),
      );
      return live(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const runner = yield* makeWidgetRunner.pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          const local = yield* runner.read({ watching: true });
          expect(local.widgets[0]?.running).toBe(true);
          yield* Effect.sleep('500 millis');
          expect(yield* anyRunning('sleep 31.5772')).toBe(true);
          yield* Scope.close(scope, Exit.void);
          expect(yield* anyRunning('sleep 31.5772')).toBe(false);
        }),
        {
          XDG_CONFIG_HOME: path.join(xdg, 'config'),
          XDG_STATE_HOME: path.join(xdg, 'state'),
        },
      );
    },
    15_000,
  );
});
