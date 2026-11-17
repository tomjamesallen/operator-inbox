import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  type DecodedWidgets,
  decodeWidgetsFile,
  widgetIdOf,
} from '../src/widgets';

const FILE = '/c/operator-inbox/widgets.json';

const LOAD = { label: 'Load', command: 'uptime' };
const QUOTA = {
  label: 'Quota',
  command: 'quota --json',
  format: 'json',
  text: '{{used}} of {{of}}',
  detail: '{{#over}}over{{/over}}{{^over}}under{{/over}}',
  tone: { from: 'used', above: { '75': 'warn', '90': 'bad' } },
};

const decode = (file: unknown): DecodedWidgets =>
  Result.getOrThrowWith(
    decodeWidgetsFile(JSON.stringify(file), FILE),
    (e) => new Error(e),
  );
const failureOf = (text: string): string | undefined => {
  const r = decodeWidgetsFile(text, FILE);
  return Result.isFailure(r) ? r.failure : undefined;
};
// The problems of a file holding these entries, and the ids that still run.
const entries = (...widgets: ReadonlyArray<unknown>) => {
  const d = decode({ widgets });
  return { problems: d.problems, ids: d.widgets.map((w) => w.id) };
};

describe('decodeWidgetsFile: defaults', () => {
  it('fills every default in a widget that sets only its label and command', () => {
    expect(decode({ widgets: [LOAD] })).toEqual({
      path: [],
      widgets: [
        {
          id: 'load',
          label: 'Load',
          command: 'uptime',
          intervalSeconds: 60,
          timeoutSeconds: 10,
          format: 'text',
          lines: 1,
        },
      ],
      problems: [],
    });
  });

  it('times out at the interval when it is shorter than ten seconds', () => {
    const [w] = decode({ widgets: [{ ...LOAD, intervalSeconds: 6 }] }).widgets;
    expect(w?.timeoutSeconds).toBe(6);
  });

  it('keeps what a widget sets, templates and tone included', () => {
    const d = decode({
      path: ['/opt/tools/bin'],
      widgets: [
        {
          ...QUOTA,
          id: 'quota_main',
          intervalSeconds: 30,
          timeoutSeconds: 20,
          lines: 2,
        },
      ],
    });
    expect(d.path).toEqual(['/opt/tools/bin']);
    expect(d.widgets).toEqual([
      {
        id: 'quota_main',
        label: 'Quota',
        command: 'quota --json',
        intervalSeconds: 30,
        timeoutSeconds: 20,
        format: 'json',
        lines: 2,
        text: QUOTA.text,
        detail: QUOTA.detail,
        tone: QUOTA.tone,
      },
    ]);
    expect(d.problems).toEqual([]);
  });

  it('reads a json widget with no templates, whose command prints the envelope', () => {
    const [w] = decode({ widgets: [{ ...LOAD, format: 'json' }] }).widgets;
    expect(w?.format).toBe('json');
    expect(w).not.toHaveProperty('text');
  });

  it('reads a tone map', () => {
    const tone = { from: 'state', map: { up: 'ok', down: 'bad' } };
    const [w] = decode({
      widgets: [{ ...QUOTA, tone }],
    }).widgets;
    expect(w?.tone).toEqual(tone);
  });

  it('reads an empty list as no widgets', () => {
    expect(decode({ widgets: [] })).toEqual({
      path: [],
      widgets: [],
      problems: [],
    });
  });
});

describe('widgetIdOf', () => {
  it('lower-cases a label and dashes what is not a letter or digit', () => {
    expect(widgetIdOf('Disk use (/data)')).toBe('disk-use-data');
    expect(widgetIdOf('  Build queue  ')).toBe('build-queue');
    expect(widgetIdOf('%%%')).toBe('');
  });
});

describe('decodeWidgetsFile: problems, one entry at a time', () => {
  it('drops a bad entry, names its problem and keeps the rest', () => {
    expect(
      entries(LOAD, { ...LOAD, label: 'Disk', intervalSeconds: 2 }, QUOTA),
    ).toEqual({
      problems: ['widgets.1.intervalSeconds — at least 5'],
      ids: ['load', 'quota'],
    });
  });

  it('names every problem of one entry', () => {
    expect(
      entries({
        id: 'Disk Use',
        label: 'Disk',
        command: 'df',
        intervalSeconds: 4,
        timeoutSeconds: 0,
        format: 'markdown',
        lines: 5,
      }).problems,
    ).toEqual([
      'widgets.0.id — lower-case letters, digits, - and _, from a letter or digit, at most 64',
      'widgets.0.intervalSeconds — at least 5',
      'widgets.0.timeoutSeconds — at least 1',
      'widgets.0.format — Expected "text" | "json", got "markdown"',
      'widgets.0.lines — a whole number from 1 to 4',
    ]);
  });

  it('needs a label and a command, neither blank', () => {
    expect(
      entries(
        { command: 'df' },
        { label: ' ', command: 'df' },
        { label: 'Disk', command: '' },
      ).problems,
    ).toEqual([
      'widgets.0.label — is missing',
      'widgets.1.label — a non-empty string',
      'widgets.2.command — a non-empty string',
    ]);
  });

  it('takes lines as a whole number from 1 to 4 and nothing else', () => {
    for (const lines of [1, 4])
      expect(entries({ ...LOAD, lines }).problems).toEqual([]);
    for (const lines of [0, 5, 2.5, '2'])
      expect(entries({ ...LOAD, lines }).problems).toHaveLength(1);
  });

  it('names a key no widget takes, and keeps the widget', () => {
    expect(entries({ ...LOAD, interval: 30 })).toEqual({
      problems: ['widgets.0.interval — not a widget key: ignored'],
      ids: ['load'],
    });
  });

  it('names a value of the wrong type', () => {
    expect(entries({ ...LOAD, intervalSeconds: '30' }).problems).toEqual([
      'widgets.0.intervalSeconds — Expected number, actual "30"',
    ]);
  });

  it('names an entry that is not an object', () => {
    expect(entries('uptime', [LOAD], null, LOAD)).toEqual({
      problems: [
        'widgets.0 — expected an object',
        'widgets.1 — expected an object',
        'widgets.2 — expected an object',
      ],
      ids: ['load'],
    });
  });

  it('refuses templates and a tone on a text widget', () => {
    const { format: _json, ...asText } = QUOTA;
    expect(entries(asText).problems).toEqual([
      'widgets.0.text — only a json widget takes it',
      'widgets.0.detail — only a json widget takes it',
      'widgets.0.tone — only a json widget takes it',
    ]);
  });

  it('refuses a detail or a tone with no text template', () => {
    const { text: _text, ...noText } = QUOTA;
    expect(entries(noText).problems).toEqual([
      'widgets.0.detail — needs a text template beside it',
      'widgets.0.tone — needs a text template beside it',
    ]);
  });

  it('names a template that does not parse', () => {
    expect(
      entries({ ...QUOTA, text: '{{#over}}x', detail: '{{/over}}' }).problems,
    ).toEqual([
      'widgets.0.text — {{#over}} is never closed',
      'widgets.0.detail — {{/over}} closes nothing open',
    ]);
  });

  it('names a tone that is neither a map nor thresholds, or both', () => {
    for (const tone of [
      { from: 'used' },
      { from: 'used', map: {}, above: {} },
      'warn',
    ])
      expect(entries({ ...QUOTA, tone }).problems).toEqual([
        'widgets.0.tone — expected { "from", "map" } or { "from", "above" }',
      ]);
  });

  it('names an unknown tone, a blank path and a threshold that is not a number', () => {
    expect(
      entries(
        { ...QUOTA, tone: { from: 'state', map: { up: 'green' } } },
        { ...QUOTA, tone: { from: '', above: { '80': 'bad' } } },
        { ...QUOTA, tone: { from: 'used', above: { high: 'bad' } } },
      ).problems,
    ).toEqual([
      'widgets.0.tone.map.up — Expected "ok" | "warn" | "bad" | "info" | "muted", got "green"',
      'widgets.1.tone.from — a non-empty string',
      'widgets.2.tone.above — "high" is not a number',
    ]);
  });

  it('asks for an id when the label has nothing to make one from', () => {
    expect(entries({ label: '%', command: 'df' })).toEqual({
      problems: [
        'widgets.0.label — has no letter or digit to make an id from: set id',
      ],
      ids: [],
    });
    expect(entries({ id: 'pct', label: '%', command: 'df' }).ids).toEqual([
      'pct',
    ]);
  });

  it('refuses an id used twice, keeping the first', () => {
    expect(
      entries(
        LOAD,
        { label: 'load', command: 'cat /proc/loadavg' },
        { id: 'load', label: 'Other', command: 'w' },
      ),
    ).toEqual({
      problems: [
        'widgets.1 — the id load is used twice',
        'widgets.2.id — the id load is used twice',
      ],
      ids: ['load'],
    });
  });

  it('lets an id freed by a dropped entry be used by a later one', () => {
    expect(
      entries({ ...LOAD, intervalSeconds: 1 }, { ...LOAD, command: 'w' }).ids,
    ).toEqual(['load']);
  });
});

describe('decodeWidgetsFile: the file as a whole', () => {
  it('says a file that is not JSON is not', () => {
    expect(failureOf('{ widgets')).toMatch(
      /^widgets\.json at \/c\/operator-inbox\/widgets\.json is not valid JSON: /,
    );
  });

  it('fails a file that is not { "widgets": [ … ] }', () => {
    expect(failureOf('[]')).toBe(
      `widgets.json at ${FILE}: Expected object, actual []`,
    );
    expect(failureOf('{}')).toBe(
      `widgets.json at ${FILE}: widgets — is missing`,
    );
  });

  it('fails a path that is not a list of non-empty strings', () => {
    expect(failureOf('{"path":"/opt/bin","widgets":[]}')).toBe(
      `widgets.json at ${FILE}: path — Expected array, actual "/opt/bin"`,
    );
    expect(failureOf('{"path":[""],"widgets":[]}')).toBe(
      `widgets.json at ${FILE}: path.0 — a non-empty string`,
    );
  });
});
