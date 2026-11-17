import { describe, expect, it } from '@effect/vitest';
import type { WidgetConfig } from '@operator-inbox/core';
import { WidgetNotFound, type WidgetRunDto } from '@operator-inbox/core/api';
import { ConfigProvider, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { envProvider } from '../src/env-config';
import { templated } from '../src/serve-widget-run';
import { type LocalWidgets, makeWidgetRunner } from '../src/serve-widgets';
import {
  type FakeScript,
  type FakeSpawn,
  fakeSpawner,
  memoryFileSystem,
} from './widget-fakes';

// The widget runner on the TestClock, over a file system in memory and a
// spawner whose processes only print and wait: the schedule (no overlap, the
// coalesced refresh, the pause with nobody watching, `opened`), the
// reconcile with the file, the templates and the cache.

const FILE = '/cfg/operator-inbox/widgets.json';
const CACHE = '/state/operator-inbox/widgets';

interface Rig {
  readonly files: Map<string, string>;
  readonly spawns: Array<FakeSpawn>;
}

const writeWidgets = (
  rig: Rig,
  widgets: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => rig.files.set(FILE, JSON.stringify({ ...extra, widgets }));

// A runner over `rig`, each script's behaviour from `scripts` (a script not
// listed prints nothing and exits 0 at once).
const runnerOn = (rig: Rig, scripts: Record<string, FakeScript> = {}) =>
  makeWidgetRunner.pipe(
    Effect.provide(
      Layer.mergeAll(
        memoryFileSystem(rig.files),
        fakeSpawner((script) => scripts[script] ?? {}, rig.spawns),
      ),
    ),
  );

const rig = (): Rig => ({ files: new Map(), spawns: [] });

const withEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({
        XDG_CONFIG_HOME: '/cfg',
        XDG_STATE_HOME: '/state',
        HOME: '/home/op',
        PATH: '/usr/bin:/bin',
      }),
    ),
    Effect.scoped,
  );

// Let every fibre that can move, move, without the clock moving.
const settle = TestClock.adjust('0 millis');
const at = (seconds: number) => TestClock.setTime(seconds * 1000);

const startsOf = (r: Rig, script: string) =>
  r.spawns.filter((s) => s.script === script).map((s) => s.startedAt / 1000);

const widget = (local: LocalWidgets, id: string) => {
  const found = local.widgets.find((w) => w.id === id);
  if (found === undefined) throw new Error(`no widget ${id}`);
  return found;
};

describe('the widget runner — its schedule', () => {
  it.effect('never overlaps a run: a slow run stretches the interval', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [
          {
            label: 'Slow',
            command: 'slow',
            intervalSeconds: 5,
            timeoutSeconds: 20,
          },
        ]);
        const runner = yield* runnerOn(r, {
          slow: { durationMs: 8000, stdout: 'done' },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        expect(
          widget(yield* runner.read({ watching: true }), 'slow').running,
        ).toBe(true);
        yield* at(8);
        const after = widget(yield* runner.read({ watching: true }), 'slow');
        expect(after.running).toBe(false);
        expect(after.nextRunAt).toBe(13_000);
        expect(after.lastRun?.stdout).toBe('done');
        yield* at(12.9);
        expect(startsOf(r, 'slow')).toEqual([0]);
        yield* at(13);
        yield* at(21);
        yield* runner.read({ watching: true });
        yield* at(26);
        expect(startsOf(r, 'slow')).toEqual([0, 13, 26]);
        // Each started only once the one before had ended.
        for (const [i, s] of r.spawns.entries())
          if (i > 0)
            expect(s.startedAt).toBeGreaterThanOrEqual(
              r.spawns[i - 1]?.endedAt ?? Number.POSITIVE_INFINITY,
            );
      }),
    ),
  );

  it.effect('coalesces refreshes while running into one more run', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ label: 'Q', command: 'q', intervalSeconds: 60 }]);
        const runner = yield* runnerOn(r, { q: { durationMs: 3000 } });
        yield* runner.read({ watching: true });
        yield* settle;
        for (let i = 0; i < 5; i++) yield* runner.run('q');
        expect(
          widget(yield* runner.read({ watching: true }), 'q').refreshQueued,
        ).toBe(true);
        yield* at(3);
        const second = widget(yield* runner.read({ watching: true }), 'q');
        expect(second.running).toBe(true);
        expect(second.refreshQueued).toBe(false);
        yield* at(6);
        yield* at(9);
        expect(startsOf(r, 'q')).toEqual([0, 3]);
        expect(
          widget(yield* runner.read({ watching: true }), 'q').nextRunAt,
        ).toBe(66_000);
        // Idle, a refresh runs now and the interval starts from its end.
        yield* at(10);
        yield* runner.run('q');
        yield* settle;
        expect(startsOf(r, 'q')).toEqual([0, 3, 10]);
        yield* at(13);
        expect(
          widget(yield* runner.read({ watching: true }), 'q').nextRunAt,
        ).toBe(73_000);
      }),
    ),
  );

  it.effect(
    'skips scheduled runs with nobody watching, until opened or a watching read',
    () =>
      withEnv(
        Effect.gen(function* () {
          const r = rig();
          writeWidgets(r, [{ label: 'T', command: 't', intervalSeconds: 5 }]);
          const runner = yield* runnerOn(r);
          yield* runner.read({ watching: true });
          yield* settle;
          for (const s of [5, 10, 15, 20, 30]) yield* at(s);
          // Watched until 15s after the read at 0: runs at 0, 5 and 10.
          expect(startsOf(r, 't')).toEqual([0, 5, 10]);
          const paused = widget(yield* runner.read({ watching: false }), 't');
          expect(paused.nextRunAt).toBeNull();
          expect(paused.running).toBe(false);
          yield* at(35);
          yield* runner.opened;
          yield* settle;
          expect(startsOf(r, 't')).toEqual([0, 5, 10, 35]);
          for (const s of [40, 45, 50, 55, 60]) yield* at(s);
          expect(startsOf(r, 't')).toEqual([0, 5, 10, 35, 40, 45]);
          // A watching read wakes a paused widget too.
          yield* at(70);
          yield* runner.read({ watching: true });
          yield* settle;
          expect(startsOf(r, 't')).toEqual([0, 5, 10, 35, 40, 45, 70]);
        }),
      ),
  );

  it.effect(
    'opened runs each widget bar one running or run in the last 5s',
    () =>
      withEnv(
        Effect.gen(function* () {
          const r = rig();
          writeWidgets(r, [
            { label: 'Quick', command: 'quick', intervalSeconds: 60 },
            { label: 'Long', command: 'long', intervalSeconds: 60 },
          ]);
          const runner = yield* runnerOn(r, { long: { durationMs: 20_000 } });
          yield* runner.read({ watching: false });
          yield* settle;
          yield* at(3);
          const early = yield* runner.opened;
          yield* settle;
          expect(startsOf(r, 'quick')).toEqual([0]);
          expect(startsOf(r, 'long')).toEqual([0]);
          expect(widget(early, 'long').refreshQueued).toBe(false);
          yield* at(6);
          yield* runner.opened;
          yield* settle;
          expect(startsOf(r, 'quick')).toEqual([0, 6]);
          expect(startsOf(r, 'long')).toEqual([0]);
        }),
      ),
  );

  it.effect('a refresh of an unknown widget is WidgetNotFound', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, []);
        const runner = yield* runnerOn(r);
        const error = yield* Effect.flip(runner.run('nope'));
        expect(error).toBeInstanceOf(WidgetNotFound);
      }),
    ),
  );
});

describe('the widget runner — the file', () => {
  it.effect(
    'reconciles with an edit: changed, removed, added, relabelled',
    () =>
      withEnv(
        Effect.gen(function* () {
          const r = rig();
          writeWidgets(r, [
            { id: 'a', label: 'A', command: 'a-old' },
            { id: 'b', label: 'B', command: 'b' },
            { id: 'c', label: 'C', command: 'c' },
          ]);
          const runner = yield* runnerOn(r, {
            'a-old': { durationMs: 30_000 },
            b: { stdout: 'b out' },
          });
          yield* runner.read({ watching: true });
          yield* settle;
          expect(r.files.has(`${CACHE}/b.json`)).toBe(true);
          yield* at(2);
          writeWidgets(r, [
            { id: 'a', label: 'A', command: 'a-new' },
            { id: 'c', label: 'C, renamed', command: 'c', lines: 2 },
            { id: 'd', label: 'D', command: 'd' },
          ]);
          const after = yield* runner.read({ watching: true });
          yield* settle;
          expect(after.widgets.map((w) => w.id)).toEqual(['a', 'c', 'd']);
          expect(widget(after, 'c').label).toBe('C, renamed');
          expect(widget(after, 'c').lines).toBe(2);
          // The old command's run was ended, and the new one run at once.
          const old = r.spawns.find((s) => s.script === 'a-old');
          expect(old?.endedAt).toBe(2000);
          expect(startsOf(r, 'a-new')).toEqual([2]);
          expect(startsOf(r, 'c')).toEqual([0]);
          expect(startsOf(r, 'd')).toEqual([2]);
          expect(startsOf(r, 'b')).toEqual([0]);
          expect(r.files.has(`${CACHE}/b.json`)).toBe(false);
          yield* at(120);
          expect(startsOf(r, 'b')).toEqual([0]);
        }),
      ),
  );

  it.effect('a refresh right after an edit is the run the edit started', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ id: 'a', label: 'A', command: 'a-old' }]);
        const runner = yield* runnerOn(r, {
          'a-new': { durationMs: 3000 },
          b: { durationMs: 3000 },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        yield* at(2);
        // Changed, then refreshed before any read: the restart is the run.
        writeWidgets(r, [{ id: 'a', label: 'A', command: 'a-new' }]);
        const changed = widget(yield* runner.run('a'), 'a');
        expect(changed.running).toBe(true);
        expect(changed.refreshQueued).toBe(false);
        // Added, then refreshed: its first run is the run.
        writeWidgets(r, [
          { id: 'a', label: 'A', command: 'a-new' },
          { id: 'b', label: 'B', command: 'b' },
        ]);
        expect(widget(yield* runner.run('b'), 'b').refreshQueued).toBe(false);
        yield* at(5);
        yield* at(10);
        expect(startsOf(r, 'a-new')).toEqual([2]);
        expect(startsOf(r, 'b')).toEqual([2]);
      }),
    ),
  );

  it.effect('an edited command first runs once the old one has died', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ id: 'a', label: 'A', command: 'a-old' }]);
        const runner = yield* runnerOn(r, {
          'a-old': { durationMs: 30_000, dyingMs: 2000 },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        yield* at(2);
        writeWidgets(r, [{ id: 'a', label: 'A', command: 'a-new' }]);
        yield* runner.read({ watching: true });
        yield* settle;
        expect(startsOf(r, 'a-new')).toEqual([]);
        yield* at(4);
        expect(r.spawns.find((s) => s.script === 'a-old')?.endedAt).toBe(4000);
        expect(startsOf(r, 'a-new')).toEqual([4]);
      }),
    ),
  );

  it.effect('an edited command first runs once a timed-out run has died', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [
          { id: 'a', label: 'A', command: 'a-old', timeoutSeconds: 2 },
        ]);
        const runner = yield* runnerOn(r, {
          'a-old': { durationMs: 30_000, dyingMs: 2000 },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        yield* at(2);
        expect(
          widget(yield* runner.read({ watching: true }), 'a').lastRun,
        ).toMatchObject({ timedOut: true });
        // Edited while the timed-out run's group is still dying.
        yield* at(3);
        writeWidgets(r, [{ id: 'a', label: 'A', command: 'a-new' }]);
        yield* runner.read({ watching: true });
        yield* settle;
        expect(startsOf(r, 'a-new')).toEqual([]);
        yield* at(4);
        expect(startsOf(r, 'a-new')).toEqual([4]);
      }),
    ),
  );

  it.effect('a missing file is no widgets and no problems', () =>
    withEnv(
      Effect.gen(function* () {
        const runner = yield* runnerOn(rig());
        const local = yield* runner.read({ watching: true });
        expect(local.widgets).toEqual([]);
        expect(local.problems).toEqual([]);
      }),
    ),
  );

  it.effect(
    'a broken file is no widgets and one problem, and keeps the caches',
    () =>
      withEnv(
        Effect.gen(function* () {
          const r = rig();
          writeWidgets(r, [{ id: 'a', label: 'A', command: 'a' }]);
          const runner = yield* runnerOn(r, { a: { stdout: 'kept' } });
          yield* runner.read({ watching: true });
          yield* settle;
          r.files.set(FILE, '{ "widgets": [');
          const broken = yield* runner.read({ watching: true });
          expect(broken.widgets).toEqual([]);
          expect(broken.problems).toHaveLength(1);
          expect(broken.problems[0]).toContain('is not valid JSON');
          expect(r.files.has(`${CACHE}/a.json`)).toBe(true);
          writeWidgets(r, [{ id: 'a', label: 'A', command: 'a' }]);
          const back = yield* runner.read({ watching: true });
          expect(widget(back, 'a').lastOk?.stdout).toBe('kept');
        }),
      ),
  );

  it.effect(
    'a file gone for a moment stops the widgets but keeps their caches',
    () =>
      withEnv(
        Effect.gen(function* () {
          const r = rig();
          writeWidgets(r, [{ id: 'a', label: 'A', command: 'a' }]);
          const runner = yield* runnerOn(r, { a: { stdout: 'kept' } });
          yield* runner.read({ watching: true });
          yield* settle;
          expect(r.files.has(`${CACHE}/a.json`)).toBe(true);
          // As an editor that saves by renaming the old file away leaves it.
          r.files.delete(FILE);
          const gone = yield* runner.read({ watching: true });
          expect(gone.widgets).toEqual([]);
          expect(gone.problems).toEqual([]);
          expect(r.files.has(`${CACHE}/a.json`)).toBe(true);
          writeWidgets(r, [{ id: 'a', label: 'A', command: 'a' }]);
          const back = yield* runner.read({ watching: true });
          expect(widget(back, 'a').lastOk?.stdout).toBe('kept');
        }),
      ),
  );

  it.effect('passes on the problems of entries that cannot run', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [
          { label: 'Fine', command: 'fine' },
          { label: 'Bad', command: 'bad', intervalSeconds: 1 },
        ]);
        const runner = yield* runnerOn(r);
        const local = yield* runner.read({ watching: true });
        expect(local.widgets.map((w) => w.id)).toEqual(['fine']);
        expect(local.problems).toEqual([
          'widgets.1.intervalSeconds — at least 5',
        ]);
      }),
    ),
  );

  it.effect('gives a run the path entries and the widget variables', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ id: 'env', label: 'Env', command: 'env' }], {
          path: ['~/bin', '/opt/tools/bin'],
        });
        const runner = yield* runnerOn(r);
        yield* runner.read({ watching: true });
        yield* settle;
        expect(r.spawns[0]?.env).toEqual({
          FORCE_COLOR: '1',
          CLICOLOR_FORCE: '1',
          COLUMNS: '40',
          OPERATOR_INBOX_WIDGET: 'env',
          PATH: '/home/op/bin:/opt/tools/bin:/usr/bin:/bin',
        });
      }),
    ),
  );
});

describe('the widget runner — a run', () => {
  it.effect('a timeout ends the run at its bound, with what it printed', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [
          { label: 'Hang', command: 'hang', timeoutSeconds: 2 },
        ]);
        const runner = yield* runnerOn(r, {
          hang: { durationMs: 60_000, stdout: 'partial' },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        yield* at(2);
        const run = widget(
          yield* runner.read({ watching: true }),
          'hang',
        ).lastRun;
        expect(run).toMatchObject({
          timedOut: true,
          ok: false,
          exitCode: null,
          stdout: 'partial',
          durationMs: 2000,
        });
        expect(r.spawns[0]?.endedAt).toBe(2000);
      }),
    ),
  );

  it.effect('a failing command keeps its exit code and last stderr line', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ label: 'Fail', command: 'fail' }]);
        const runner = yield* runnerOn(r, {
          fail: { exitCode: 3, stderr: 'first\nthe last one\n\n' },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        const w = widget(yield* runner.read({ watching: true }), 'fail');
        expect(w.lastRun).toMatchObject({
          ok: false,
          exitCode: 3,
          stderrTail: 'the last one',
        });
        expect(w.lastOk).toBeNull();
      }),
    ),
  );

  it.effect('a command that cannot start is a spawn error', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ label: 'Gone', command: 'gone' }]);
        const runner = yield* runnerOn(r, { gone: { cannotStart: true } });
        yield* runner.read({ watching: true });
        yield* settle;
        const run = widget(
          yield* runner.read({ watching: true }),
          'gone',
        ).lastRun;
        expect(run?.ok).toBe(false);
        expect(run?.spawnError).toEqual(expect.any(String));
      }),
    ),
  );

  it.effect('maps a json widget through its templates', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [
          {
            label: 'Quota',
            command: 'quota',
            format: 'json',
            text: '{{used}} of {{of}} ',
            detail: '{{#parts}}{{name}}\n{{/parts}}',
            tone: { from: 'used', above: { '40': 'warn', '90': 'bad' } },
          },
          {
            label: 'Renamed',
            command: 'quota',
            format: 'json',
            text: '{{spent}}',
          },
        ]);
        const runner = yield* runnerOn(r, {
          quota: {
            stdout: '{"used": 41, "of": 100, "parts": [{"name": "a"}]}',
          },
        });
        yield* runner.read({ watching: true });
        yield* settle;
        const local = yield* runner.read({ watching: true });
        const good = widget(local, 'quota').lastRun;
        expect(good?.ok).toBe(true);
        expect(JSON.parse(good?.stdout ?? '')).toEqual({
          text: '41 of 100',
          detail: 'a',
          tone: 'warn',
        });
        expect(good?.raw).toContain('"used": 41');
        const bad = widget(local, 'renamed').lastRun;
        expect(bad?.ok).toBe(false);
        expect(bad?.templateError).toBe('no value at spent');
        expect(bad?.raw).toContain('"used": 41');
      }),
    ),
  );
});

describe('templated (pure)', () => {
  const config: WidgetConfig = {
    id: 'q',
    label: 'Q',
    command: 'q',
    intervalSeconds: 60,
    timeoutSeconds: 10,
    format: 'json',
    lines: 1,
    text: '{{used}}',
  };
  const run = (stdout: string, ok = true): WidgetRunDto => ({
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    exitCode: ok ? 0 : 1,
    signal: null,
    timedOut: false,
    spawnError: null,
    stdout,
    stderrTail: '',
    truncated: false,
    ok,
  });

  it('fails output that is not JSON', () => {
    expect(templated(config, run('used: 41'))).toMatchObject({
      ok: false,
      templateError: 'the command did not print JSON',
      raw: 'used: 41',
    });
  });

  it('leaves a failed run, a text widget and an envelope widget alone', () => {
    expect(templated(config, run('x', false))).toEqual(run('x', false));
    expect(templated({ ...config, format: 'text' }, run('x'))).toEqual(
      run('x'),
    );
    const { text: _none, ...envelope } = config;
    expect(templated(envelope, run('{"text":"hi"}'))).toEqual(
      run('{"text":"hi"}'),
    );
  });

  it('leaves the tone out when the map has none for the value', () => {
    const toned = templated(
      { ...config, tone: { from: 'used', map: { '1': 'bad' } } },
      run('{"used": 41}'),
    );
    expect(JSON.parse(toned.stdout)).toEqual({ text: '41' });
  });
});

describe('the widget runner — the cache', () => {
  it.effect('writes each good run, and reads it back after a restart', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ id: 'up', label: 'Up', command: 'up' }]);
        const first = yield* runnerOn(r, { up: { stdout: 'load 0.5' } });
        yield* first.read({ watching: true });
        yield* settle;
        const cached = JSON.parse(r.files.get(`${CACHE}/up.json`) ?? '{}');
        expect(cached).toMatchObject({ ok: true, stdout: 'load 0.5' });
        expect(r.files.has(`${CACHE}/.up.json.tmp`)).toBe(false);
        // A restart: a runner of its own, whose first run is still going.
        const second = yield* runnerOn(
          { files: r.files, spawns: [] },
          { up: { durationMs: 10_000, exitCode: 1 } },
        );
        const restarted = widget(yield* second.read({ watching: true }), 'up');
        expect(restarted.running).toBe(true);
        expect(restarted.lastRun).toBeNull();
        expect(restarted.lastOk?.stdout).toBe('load 0.5');
        // A failed run leaves the cache as it was.
        yield* at(10);
        yield* settle;
        expect(JSON.parse(r.files.get(`${CACHE}/up.json`) ?? '{}').stdout).toBe(
          'load 0.5',
        );
      }),
    ),
  );

  it.effect('ignores a cache file that does not decode', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        writeWidgets(r, [{ id: 'up', label: 'Up', command: 'up' }]);
        r.files.set(`${CACHE}/up.json`, '{"stdout": "half a run"');
        const runner = yield* runnerOn(r, { up: { durationMs: 10_000 } });
        const local = yield* runner.read({ watching: true });
        expect(widget(local, 'up').lastOk).toBeNull();
      }),
    ),
  );

  it.effect(
    'sweeps the cache of widgets gone while serve was down, once, from a whole file',
    () =>
      withEnv(
        Effect.gen(function* () {
          const r = rig();
          r.files.set(`${CACHE}/gone.json`, '{}');
          r.files.set(`${CACHE}/.gone.json.tmp`, '{}');
          r.files.set(`${CACHE}/up.json`, '{}');
          r.files.set(`${CACHE}/notes.txt`, 'not the cache');
          // A file that cannot be read, or one that dropped an entry, sweeps
          // nothing: the dropped entry's id is not known.
          r.files.set(FILE, '{"widgets": [');
          const runner = yield* runnerOn(r, { up: { durationMs: 10_000 } });
          yield* runner.read({ watching: true });
          writeWidgets(r, [
            { id: 'up', label: 'Up', command: 'up' },
            { id: 'bad', label: 'Bad', command: 'x', intervalSeconds: 1 },
          ]);
          yield* runner.read({ watching: true });
          expect(r.files.has(`${CACHE}/gone.json`)).toBe(true);
          // The first whole file sweeps every cache file of an id it lacks.
          writeWidgets(r, [{ id: 'up', label: 'Up', command: 'up' }]);
          yield* runner.read({ watching: true });
          expect(
            [...r.files.keys()].filter((f) => f.startsWith(CACHE)),
          ).toEqual([`${CACHE}/up.json`, `${CACHE}/notes.txt`]);
          // Once: a cache file that turns up later is left alone.
          r.files.set(`${CACHE}/later.json`, '{}');
          yield* runner.read({ watching: true });
          expect(r.files.has(`${CACHE}/later.json`)).toBe(true);
        }),
      ),
  );

  it.effect('a missing file sweeps nothing', () =>
    withEnv(
      Effect.gen(function* () {
        const r = rig();
        r.files.set(`${CACHE}/kept.json`, '{}');
        const runner = yield* runnerOn(r);
        yield* runner.read({ watching: true });
        expect(r.files.has(`${CACHE}/kept.json`)).toBe(true);
      }),
    ),
  );
});
