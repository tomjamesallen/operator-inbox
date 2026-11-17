// Widgets as serve answers them, for the widget tests. Generic widgets only:
// load, disk use, a build queue, a quota.

export const NOW = 1_800_000_000_000;

export type WireRun = Record<string, unknown>;

/** A run that finished `agoMs` before `NOW`, good unless told otherwise. */
export const run = (agoMs: number, more: WireRun = {}): WireRun => ({
  startedAt: NOW - agoMs - 12,
  finishedAt: NOW - agoMs,
  durationMs: 12,
  exitCode: 0,
  signal: null,
  timedOut: false,
  spawnError: null,
  stdout: 'load 0.42',
  stderrTail: '',
  truncated: false,
  ok: true,
  ...more,
});

export const failedRun = (agoMs: number, more: WireRun = {}): WireRun =>
  run(agoMs, { exitCode: 7, stdout: '', ok: false, ...more });

export const widget = (
  id: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> => {
  const ok = run(4_000);
  return {
    id,
    label: id,
    format: 'text',
    lines: 1,
    intervalSeconds: 60,
    timeoutSeconds: 10,
    running: false,
    runningSince: null,
    refreshQueued: false,
    lastRun: ok,
    lastOk: ok,
    nextRunAt: NOW + 50_000,
    ...more,
  };
};

export const machine = (
  key: string,
  label: string,
  status: string,
  widgets: ReadonlyArray<object>,
  more: Record<string, unknown> = {},
) => ({ key, label, status, widgets, problems: [], now: NOW, ...more });

export const local = (
  widgets: ReadonlyArray<object>,
  more: Record<string, unknown> = {},
) => machine('local', 'Local', 'local', widgets, more);

export const widgetsOf = (...machines: ReadonlyArray<object>) => ({
  machines,
});

/** Serve's widgets with none configured: Local alone, with nothing to run. */
export const NO_WIDGETS = widgetsOf(local([]));
