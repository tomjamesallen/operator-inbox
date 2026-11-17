import { WidgetDto, WidgetRunDto, WidgetsDto } from '@operator-inbox/core/api';
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  ago,
  drawnWidgetOf,
  drawnWidgetsOf,
  widgetFailureOf,
} from '../src/widgets';
import {
  failedRun,
  local,
  machine,
  NOW,
  run,
  widget,
  widgetsOf,
} from './widget-fixture';

// How a widget is drawn from serve's account of it, and how a machine that
// misses a read keeps its widgets, greyed.

const decode = Schema.decodeUnknownSync(WidgetDto);
const decodeAll = Schema.decodeUnknownSync(WidgetsDto);

describe('a widget’s phase', () => {
  it('waits for its first run', () => {
    const w = decode(
      widget('load', { lastRun: null, lastOk: null, running: true }),
    );
    expect(drawnWidgetOf(w, NOW).phase).toBe('waiting');
  });

  it('is fresh after a good run, and running while another goes', () => {
    expect(drawnWidgetOf(decode(widget('load')), NOW)).toMatchObject({
      phase: 'fresh',
      ageMs: 4_000,
    });
    expect(
      drawnWidgetOf(decode(widget('load', { running: true })), NOW).phase,
    ).toBe('running');
  });

  it('is stale after two intervals and the timeout, on the machine’s clock', () => {
    const at = (agoMs: number) => {
      const ok = run(agoMs);
      return decode(widget('load', { lastRun: ok, lastOk: ok }));
    };
    expect(drawnWidgetOf(at(130_000), NOW).phase).toBe('fresh');
    expect(drawnWidgetOf(at(130_001), NOW).phase).toBe('stale');
    // The page's clock has no say: only the `now` it is given.
    expect(drawnWidgetOf(at(130_001), NOW - 10).phase).toBe('fresh');
  });

  it('draws a cached good run with no latest one as any good run', () => {
    const w = decode(widget('load', { lastRun: null }));
    expect(drawnWidgetOf(w, NOW).phase).toBe('fresh');
  });

  it('is an error over its last good output, and failed with none', () => {
    const bad = failedRun(1_000, { stderrTail: 'disk gone' });
    expect(
      drawnWidgetOf(decode(widget('disk', { lastRun: bad })), NOW),
    ).toMatchObject({
      phase: 'error',
      failure: 'exit 7: disk gone',
    });
    expect(
      drawnWidgetOf(decode(widget('disk', { lastRun: bad, lastOk: null })), NOW)
        .phase,
    ).toBe('failed');
  });

  it('is stale and not running on a greyed machine', () => {
    expect(
      drawnWidgetOf(decode(widget('load', { running: true })), NOW, true),
    ).toMatchObject({ phase: 'stale', running: false });
  });
});

describe('what failed', () => {
  const w = { timeoutSeconds: 3 };
  const of = (more: Record<string, unknown>) =>
    widgetFailureOf(
      w,
      Schema.decodeUnknownSync(WidgetRunDto)(failedRun(0, more)),
    );

  it('names each failure in one line', () => {
    expect(of({ stderrTail: '  no such volume ' })).toBe(
      'exit 7: no such volume',
    );
    expect(of({})).toBe('exit 7');
    expect(of({ exitCode: null, timedOut: true, signal: 'SIGTERM' })).toBe(
      'timed out after 3s',
    );
    expect(
      of({ exitCode: 127, stderrTail: 'bash: nope: command not found' }),
    ).toBe('command not found');
    expect(of({ exitCode: null, spawnError: 'ENOENT' })).toBe(
      'could not start: ENOENT',
    );
    expect(of({ exitCode: 0, templateError: 'no value at used' })).toBe(
      'template: no value at used',
    );
    expect(of({ exitCode: null, signal: 'SIGKILL' })).toBe('ended by SIGKILL');
  });
});

describe('ages', () => {
  it('reads in seconds, minutes and hours', () => {
    expect(ago(undefined)).toBe('');
    expect(ago(4_400)).toBe('4s');
    expect(ago(5 * 60_000 + 10_000)).toBe('5m');
    expect(ago(125 * 60_000)).toBe('2h 5m');
  });
});

describe('a machine that misses a read', () => {
  const LAPTOP_UP = machine('3010', 'laptop', 'reachable', [widget('queue')], {
    now: NOW + 7_000,
  });
  const LAPTOP_DOWN = machine('3010', 'laptop', 'unreachable', [], {
    reason: 'tunnel-down',
    detail: 'nothing answered on port 3010',
  });

  it('keeps its last widgets, greyed, its clock running on with Local’s', () => {
    const first = drawnWidgetsOf(
      undefined,
      decodeAll(widgetsOf(local([]), LAPTOP_UP)),
    );
    const second = drawnWidgetsOf(
      first,
      decodeAll(widgetsOf(local([], { now: NOW + 60_000 }), LAPTOP_DOWN)),
    );
    const laptop = second.machines[1];
    expect(laptop).toMatchObject({ status: 'unreachable', greyed: true });
    expect(laptop?.widgets.map((w) => w.id)).toEqual(['queue']);
    expect(laptop?.now).toBe(NOW + 67_000);
    // And on through a second miss.
    const third = drawnWidgetsOf(
      second,
      decodeAll(widgetsOf(local([], { now: NOW + 120_000 }), LAPTOP_DOWN)),
    );
    expect(third.machines[1]).toMatchObject({
      greyed: true,
      now: NOW + 127_000,
    });
  });

  it('draws nothing for a machine never read, and is live again once it answers', () => {
    const down = drawnWidgetsOf(
      undefined,
      decodeAll(widgetsOf(local([]), LAPTOP_DOWN)),
    );
    expect(down.machines[1]).toMatchObject({ greyed: false, widgets: [] });
    const up = drawnWidgetsOf(down, decodeAll(widgetsOf(local([]), LAPTOP_UP)));
    expect(up.machines[1]).toMatchObject({
      greyed: false,
      status: 'reachable',
    });
  });
});
