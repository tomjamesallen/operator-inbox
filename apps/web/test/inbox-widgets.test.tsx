import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json } from './fixture';
import {
  aside,
  BOARD,
  LAPTOP,
  LOCAL,
  mounted,
  nav,
  openRail,
  reread,
  serve,
  settle,
  summary,
  useInboxPage,
  VIEW_A,
  VIEW_M,
} from './inbox-page-harness';
import {
  failedRun,
  local,
  machine,
  run,
  widget,
  widgetsOf,
} from './widget-fixture';

// The sidebar's widgets on the page: each state's chip, its rows, its
// popover by keyboard, its refresh, the runs the sidebar asks for, and where
// the widgets sit with one machine and with several.

useInboxPage();

const chip = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-widget="${id}"]`);

const trigger = (id: string): HTMLElement =>
  chip(id)?.querySelector<HTMLElement>('[data-widget-chip]') as HTMLElement;

const refresh = (id: string): HTMLButtonElement =>
  chip(id)?.querySelector<HTMLButtonElement>(
    '[data-widget-refresh]',
  ) as HTMLButtonElement;

const rows = (id: string): ReadonlyArray<string> =>
  [...(chip(id)?.querySelectorAll<HTMLElement>('[data-widget-row]') ?? [])].map(
    (r) => r.textContent ?? '',
  );

const stateOf = (id: string): string =>
  chip(id)?.querySelector('[data-widget-state]')?.textContent ?? '';

const opened = (): number =>
  serve.widgetPosts.filter((p) => p.path === '/api/widgets/opened').length;

const showing = async (widgets: unknown, id: string): Promise<void> => {
  serve.widgets = widgets;
  await mounted();
  await openRail();
  await waitFor(() => expect(chip(id)).not.toBeNull());
};

describe('a chip in each state', () => {
  const STATES = widgetsOf(
    local([
      widget('waiting', { lastRun: null, lastOk: null, running: true }),
      widget('fresh'),
      widget('running', { running: true, runningSince: 1_800_000_000_000 }),
      widget('stale', {
        lastRun: run(300_000),
        lastOk: run(300_000),
      }),
      widget('error', {
        lastRun: failedRun(2_000, { stderrTail: 'volume gone' }),
      }),
      widget('failed', {
        lastRun: failedRun(2_000, {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
        }),
        lastOk: null,
        timeoutSeconds: 3,
      }),
    ]),
  );

  it('draws each state’s phase, word and first row', async () => {
    await showing(STATES, 'failed');
    const drawn = (id: string) => ({
      phase: chip(id)?.dataset.widgetPhase,
      state: stateOf(id),
      row: rows(id)[0],
    });
    expect(drawn('waiting')).toEqual({
      phase: 'waiting',
      state: 'running…',
      row: '…',
    });
    expect(drawn('fresh')).toEqual({
      phase: 'fresh',
      state: '4s',
      row: 'load 0.42',
    });
    expect(drawn('running')).toEqual({
      phase: 'running',
      state: 'running…',
      row: 'load 0.42',
    });
    expect(drawn('stale')).toEqual({
      phase: 'stale',
      state: 'stale · 5m',
      row: 'load 0.42',
    });
    expect(drawn('error')).toEqual({
      phase: 'error',
      state: 'failed',
      row: 'exit 7: volume gone',
    });
    expect(drawn('failed')).toEqual({
      phase: 'failed',
      state: 'failed',
      row: 'timed out after 3s',
    });
  });

  it('marks stale with a dashed border, a failure with red, and fades old output', async () => {
    await showing(STATES, 'failed');
    expect(chip('stale')?.className).toContain('border-dashed');
    expect(chip('error')?.className).toContain('border-red/40');
    expect(chip('failed')?.className).toContain('border-red/40');
    expect(chip('fresh')?.className).toContain('border-fg/10');
    const row = (id: string) =>
      chip(id)?.querySelector('[data-widget-row]')?.className ?? '';
    expect(row('stale')).toContain('opacity-45');
    expect(row('error')).toContain('opacity-45');
    expect(row('fresh')).not.toContain('opacity-45');
  });

  it('colours the strip by tone, red on a failure, grey with none, pulsing while it runs', async () => {
    await showing(
      widgetsOf(
        local([
          widget('quota', {
            format: 'json',
            lastRun: run(1_000, {
              stdout: JSON.stringify({ text: '41 of 100', tone: 'warn' }),
            }),
            lastOk: run(1_000, {
              stdout: JSON.stringify({ text: '41 of 100', tone: 'warn' }),
            }),
          }),
          widget('plain'),
          widget('broken', { lastRun: failedRun(1_000), lastOk: null }),
          widget('busy', { running: true }),
        ]),
      ),
      'busy',
    );
    const strip = (id: string) =>
      chip(id)?.querySelector('[data-widget-strip]')?.className ?? '';
    expect(strip('quota')).toContain('bg-orange');
    expect(strip('plain')).toContain('bg-fg/20');
    expect(strip('broken')).toContain('bg-red');
    expect(strip('busy')).toContain('motion-safe:animate-pulse');
    expect(strip('plain')).not.toContain('animate-pulse');
    expect(rows('quota')[0]).toBe('41 of 100');
    // The state is said where only colour shows it.
    expect(trigger('quota').textContent).toContain('warning');
    expect(trigger('broken').textContent).toContain('last run failed: exit 7');
  });

  it('leaves the tone to the strip: no output line takes its colour, bar output that is not an envelope', async () => {
    const env = JSON.stringify({
      text: '5h 19/85',
      tone: 'ok',
      detail: 'wk 16/95',
    });
    await showing(
      widgetsOf(
        local([
          widget('limits', {
            format: 'json',
            lines: 2,
            lastRun: run(1_000, { stdout: env }),
            lastOk: run(1_000, { stdout: env }),
          }),
          widget('garbled', {
            format: 'json',
            lastRun: run(1_000, { stdout: 'not json' }),
            lastOk: run(1_000, { stdout: 'not json' }),
          }),
        ]),
      ),
      'limits',
    );
    const rowClasses = (id: string) =>
      [...(chip(id)?.querySelectorAll('[data-widget-row] > span') ?? [])].map(
        (s) => s.className,
      );
    expect(
      chip('limits')?.querySelector('[data-widget-strip]')?.className,
    ).toContain('bg-green');
    expect(rows('limits')).toEqual(['5h 19/85', 'wk 16/95']);
    for (const cls of rowClasses('limits')) {
      expect(cls).toContain('text-fg/70');
      expect(cls).not.toContain('text-green');
    }
    expect(rowClasses('garbled')[0]).toContain('text-red/80');
  });

  it('pads the output to `lines` rows, and cuts it there', async () => {
    const out = run(1_000, { stdout: 'one\ntwo\nthree\nfour\nfive' });
    await showing(
      widgetsOf(
        local([
          widget('short', { lines: 3 }),
          widget('long', { lines: 2, lastRun: out, lastOk: out }),
        ]),
      ),
      'long',
    );
    expect(rows('short')).toEqual(['load 0.42', ' ', ' ']);
    expect(rows('long')).toEqual(['one', 'two']);
  });
});

describe('the popover', () => {
  const ONE = widgetsOf(
    local([
      widget('disk', {
        lines: 1,
        lastRun: failedRun(1_000, { stderrTail: 'volume gone' }),
        lastOk: run(9_000, { stdout: 'disk 61%\n/ 40%\n/home 80%' }),
      }),
    ]),
  );

  it('opens on Space as a dialog named for its widget, holding focus, every line and why it failed', async () => {
    await showing(ONE, 'disk');
    const t = trigger('disk');
    expect(t.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => t.focus());
    fireEvent.keyDown(t, { key: ' ', code: 'Space' });
    fireEvent.keyUp(t, { key: ' ', code: 'Space' });
    fireEvent.click(t, { detail: 0 });
    const dialog = await screen.findByRole('dialog', { name: 'disk widget' });
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.querySelector('[data-widget-lines]')?.children).toHaveLength(
      3,
    );
    expect(dialog.querySelector('[data-widget-note]')?.textContent).toContain(
      'Last run failed: exit 7: volume gone',
    );
    expect(dialog.querySelector('[data-widget-timing]')?.textContent).toBe(
      'ran 9s ago, in 12ms, next in 50s',
    );
    // Its refresh is the one control inside, so Tab reaches it.
    expect(
      dialog.querySelectorAll('button, [tabindex]:not([tabindex="-1"])'),
    ).toHaveLength(1);
    expect(
      dialog.querySelector('[data-widget-refresh]')?.getAttribute('aria-label'),
    ).toBe('Refresh disk');
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'Escape',
      code: 'Escape',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(t));
  });
});

describe('the runs the page asks for', () => {
  it('asks serve to run every widget once when the sidebar opens, and reads as watching', async () => {
    await showing(widgetsOf(local([widget('load')])), 'load');
    await settle();
    expect(opened()).toBe(1);
    expect(serve.widgetReads.length).toBeGreaterThan(0);
    expect(new Set(serve.widgetReads)).toEqual(new Set(['?watching=true']));
  });

  it('runs every widget again on Ctrl+R', async () => {
    await showing(widgetsOf(local([widget('load')])), 'load');
    await settle();
    const was = opened();
    await reread();
    await waitFor(() => expect(opened()).toBe(was + 1));
  });

  it('runs no widget on Ctrl+R with the sidebar shut', async () => {
    serve.widgets = widgetsOf(local([widget('load')]));
    await mounted();
    expect(aside()).toBeNull();
    await reread();
    await settle();
    expect(opened()).toBe(0);
  });

  it('runs one widget from its refresh, and reads again', async () => {
    await showing(widgetsOf(local([widget('load')])), 'load');
    await settle();
    const reads = serve.widgetReads.length;
    fireEvent.click(refresh('load'));
    await waitFor(() =>
      expect(serve.widgetPosts.at(-1)).toEqual({
        path: '/api/widgets/run',
        body: { id: 'load' },
      }),
    );
    await waitFor(() =>
      expect(serve.widgetReads.length).toBeGreaterThan(reads),
    );
    // Its refresh opens no popover.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a refresh serve refused, aloud and in the popover, and reads again', async () => {
    await showing(widgetsOf(local([widget('load')])), 'load');
    await settle();
    const announce = chip('load')?.querySelector('[data-widget-announce]');
    // In the page before anything is said, so the change is heard.
    expect(announce?.tagName).toBe('OUTPUT');
    expect(announce?.getAttribute('aria-live')).toBe('polite');
    expect(announce?.textContent).toBe('');
    serve.widgetRun = () =>
      json({ _tag: 'WidgetNotFound', message: 'No widget load here.' }, 404);
    const reads = serve.widgetReads.length;
    fireEvent.click(refresh('load'));
    await waitFor(() =>
      expect(announce?.textContent).toBe(
        'Refresh load failed: No widget load here.',
      ),
    );
    await waitFor(() =>
      expect(serve.widgetReads.length).toBeGreaterThan(reads),
    );
    const t = trigger('load');
    act(() => t.focus());
    fireEvent.keyDown(t, { key: ' ', code: 'Space' });
    fireEvent.keyUp(t, { key: ' ', code: 'Space' });
    fireEvent.click(t, { detail: 0 });
    const dialog = await screen.findByRole('dialog', { name: 'load widget' });
    expect(dialog.querySelector('[data-widget-note]')?.textContent).toContain(
      'Refresh failed: No widget load here.',
    );
    // A refresh serve takes clears it.
    serve.widgetRun = undefined;
    fireEvent.click(refresh('load'));
    await waitFor(() => expect(announce?.textContent).toBe(''));
  });
});

describe('where the widgets sit', () => {
  const LOCAL_A = { ...VIEW_A, awaitingAgent: [], processed: [] };
  const GROVE = { ...VIEW_M, label: 'grove' };
  const UP = {
    inboxes: [summary(LOCAL_A), summary(GROVE)],
    totalAwaitingOperator: 4,
    views: [LOCAL_A, GROVE],
    machines: [
      LOCAL,
      { status: 'reachable', ...LAPTOP, port: 3010, awaitingOperator: 2 },
    ],
  };
  const DOWN = {
    inboxes: [summary(LOCAL_A)],
    totalAwaitingOperator: 2,
    views: [LOCAL_A],
    machines: [
      LOCAL,
      {
        status: 'unreachable',
        ...LAPTOP,
        port: 3010,
        reason: 'tunnel-down',
        detail: 'nothing answered on port 3010',
      },
    ],
  };
  const TWO = widgetsOf(
    local([widget('load')]),
    machine('3010', 'laptop', 'reachable', [widget('queue')]),
  );
  const TWO_DOWN = widgetsOf(
    local([widget('load')]),
    machine('3010', 'laptop', 'unreachable', [], {
      reason: 'tunnel-down',
      detail: 'nothing answered on port 3010',
    }),
  );

  const section = (label: string): HTMLElement =>
    document.querySelector<HTMLElement>(
      `[data-machine-section="${label}"]`,
    ) as HTMLElement;

  it('puts one machine’s widgets under the search, above All', async () => {
    serve.board = BOARD;
    await showing(widgetsOf(local([widget('load')])), 'load');
    const widgets = nav().querySelector('[data-widgets]') as HTMLElement;
    const all = nav().querySelector('[data-rail-inbox=""]') as HTMLElement;
    expect(widgets.compareDocumentPosition(all)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(nav().firstElementChild).toBe(widgets);
  });

  it('puts each machine’s widgets in its own fold, before its Inboxes', async () => {
    serve.board = UP;
    await showing(TWO, 'queue');
    expect(section('Local').contains(chip('load'))).toBe(true);
    expect(section('laptop').contains(chip('queue'))).toBe(true);
    const grove = section('laptop').querySelector(
      `[data-rail-inbox="${GROVE.inboxId}"]`,
    ) as HTMLElement;
    expect((chip('queue') as HTMLElement).compareDocumentPosition(grove)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('keeps a greyed machine’s widgets, stale, with refresh disabled', async () => {
    serve.board = UP;
    await showing(TWO, 'queue');
    serve.widgets = TWO_DOWN;
    await reread(DOWN);
    await waitFor(() =>
      expect(chip('queue')?.dataset.widgetGreyed).toBeDefined(),
    );
    expect(chip('queue')?.dataset.widgetPhase).toBe('stale');
    expect(refresh('queue').disabled).toBe(true);
    expect(refresh('load').disabled).toBe(false);
  });

  it('draws nothing for a machine with no widgets, and no note', async () => {
    serve.board = UP;
    serve.widgets = widgetsOf(
      local([widget('load')]),
      machine('3010', 'laptop', 'reachable', []),
    );
    await mounted();
    await openRail();
    await waitFor(() => expect(chip('load')).not.toBeNull());
    expect(section('laptop').querySelector('[data-widgets]')).toBeNull();
    expect(nav().querySelectorAll('[data-widgets]')).toHaveLength(1);
  });

  it('draws nothing with no widgets at all', async () => {
    await mounted();
    await openRail();
    await settle();
    expect(document.querySelector('[data-widgets]')).toBeNull();
  });

  it('says a widgets file with problems in one quiet line', async () => {
    serve.widgets = widgetsOf(
      local([widget('load')], {
        problems: [
          'widgets.1.intervalSeconds — at least 5',
          'widgets.2.lines — at most 4',
        ],
      }),
    );
    await mounted();
    await openRail();
    const line = await waitFor(() => {
      const p = document.querySelector<HTMLElement>('[data-widgets-problems]');
      expect(p).not.toBeNull();
      return p as HTMLElement;
    });
    expect(line.textContent).toMatch(/^widgets\.json: 2 problems:/);
    expect(line.title).toBe(
      'widgets.1.intervalSeconds — at least 5\nwidgets.2.lines — at most 4',
    );
  });
});
