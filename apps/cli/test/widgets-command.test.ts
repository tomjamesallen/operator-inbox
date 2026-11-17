import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { CONFIG_DIR_NAME, WIDGETS_FILE } from '@operator-inbox/core';
import { ConfigProvider, Effect } from 'effect';
import { Command } from 'effect/cli';
import { TestConsole } from 'effect/testing';
import {
  readWidgets,
  renderWidgets,
  widgetsCommand,
} from '../src/commands/widgets';
import { envProvider } from '../src/env-config';

// `operator-inbox widgets`: it reads and checks `widgets.json` as serve
// does, prints what will run and what was dropped or ignored, and runs
// nothing.

const FILE = {
  path: ['~/bin', '/opt/tools/bin'],
  widgets: [
    { label: 'Load', command: 'uptime', intervalSeconds: 30 },
    {
      id: 'quota',
      label: 'Quota',
      command: 'quota-tool --json',
      format: 'json',
      lines: 2,
      text: '{{used}} of {{of}}',
      tone: { from: 'used', above: { '75': 'warn', '90': 'bad' } },
      interval: 5,
    },
    { label: 'Disk', command: 'df -h /', intervalSeconds: 2 },
  ],
};

const configHome = (text?: string) => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-widgets-'));
  if (text !== undefined) {
    mkdirSync(path.join(xdg, CONFIG_DIR_NAME));
    writeFileSync(path.join(xdg, CONFIG_DIR_NAME, WIDGETS_FILE), text);
  }
  return xdg;
};

const under =
  (xdg: string) =>
  <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
    effect.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        envProvider({ XDG_CONFIG_HOME: xdg }),
      ),
      Effect.provide(NodeServices.layer),
    );

const printed = Effect.map(TestConsole.logLines, (lines) =>
  lines.map(String).join('\n'),
);

describe('operator-inbox widgets', () => {
  it.effect(
    'prints the path, each widget that will run, and each problem with what it costs',
    () =>
      Effect.gen(function* () {
        const xdg = configHome(JSON.stringify(FILE));
        const report = yield* under(xdg)(readWidgets);
        const file = path.join(xdg, CONFIG_DIR_NAME, WIDGETS_FILE);
        expect(renderWidgets(report)).toBe(
          [
            file,
            "path, in front of serve's PATH: ~/bin:/opt/tools/bin",
            'load   Load — every 30s, timeout 10s, text, 1 line',
            '       runs: uptime',
            'quota  Quota — every 60s, timeout 10s, json, 2 lines, templated',
            '       runs: quota-tool --json',
            'problems:',
            '  ignored  widgets.1.interval — not a widget key',
            '  dropped  widgets.2.intervalSeconds — at least 5',
            '2 widgets will run, 2 problems',
          ].join('\n'),
        );
      }),
  );

  it.effect('--json prints the path, the widgets and the problems', () =>
    Effect.gen(function* () {
      const xdg = configHome(JSON.stringify(FILE));
      yield* under(xdg)(
        Command.runWith(widgetsCommand, { version: '0.0.0' })(['--json']),
      );
      const json = JSON.parse(yield* printed);
      expect(json.path).toBe(path.join(xdg, CONFIG_DIR_NAME, WIDGETS_FILE));
      expect(json.searchPath).toEqual(FILE.path);
      expect(json.widgets.map((w: { id: string }) => w.id)).toEqual([
        'load',
        'quota',
      ]);
      expect(json.problems).toHaveLength(2);
    }),
  );

  it.effect(
    'no file is no widgets, says how to start one, and is not a failure',
    () =>
      Effect.gen(function* () {
        const report = yield* under(configHome())(readWidgets);
        expect(report.exists).toBe(false);
        expect(report.widgets).toEqual([]);
        expect(renderWidgets(report)).toMatch(
          /^no widgets: there is no .*widgets\.json\. To start one, write \{ "widgets": \[/,
        );
      }),
  );

  it.effect('a file of no widgets says so', () =>
    Effect.gen(function* () {
      const report = yield* under(configHome('{ "widgets": [] }'))(readWidgets);
      expect(renderWidgets(report).split('\n').at(-1)).toBe(
        'no widgets in the file',
      );
    }),
  );

  it.effect('a file that does not decode fails, with the one sentence', () =>
    Effect.gen(function* () {
      const notJson = yield* Effect.flip(
        under(configHome('{ widgets: '))(readWidgets),
      );
      expect(notJson.message).toMatch(/widgets\.json at .* is not valid JSON/);
      const notTheShape = yield* Effect.flip(
        under(configHome('{ "widgets": {} }'))(readWidgets),
      );
      expect(notTheShape.message).toContain('widgets.json at');
      const command = yield* Effect.flip(
        under(configHome('[]'))(
          Command.runWith(widgetsCommand, { version: '0.0.0' })([]),
        ),
      );
      expect(command).toBeTruthy();
    }),
  );
});
