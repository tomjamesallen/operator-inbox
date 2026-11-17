import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  checkTemplate,
  render,
  toneOf,
  type WidgetToneRule,
} from '../src/widget-template';

const ok = <A>(r: Result.Result<A, { readonly message: string }>): A =>
  Result.getOrThrowWith(r, (e) => new Error(e.message));
const failure = (r: Result.Result<unknown, { readonly message: string }>) =>
  Result.isFailure(r) ? r.failure.message : undefined;

const QUOTA = {
  used: 41,
  of: 100,
  name: 'storage',
  note: null,
  full: false,
  disks: [
    { mount: '/', pct: 72 },
    { mount: '/data', pct: 18 },
  ],
  tags: ['fast', 'local'],
  owner: { name: 'ops', team: { name: 'infra' } },
  empty: [],
};

describe('render', () => {
  it('prints a value at a dotted path, and leaves the text around it', () => {
    expect(
      ok(render('{{used}} of {{ of }} ({{owner.team.name}})', QUOTA)),
    ).toBe('41 of 100 (infra)');
  });

  it('prints an array item by its index, and a list’s length', () => {
    expect(
      ok(render('{{disks.1.mount}} {{tags.0}} {{tags.length}}', QUOTA)),
    ).toBe('/data fast 2');
  });

  it('prints null as nothing and a boolean as its word', () => {
    expect(ok(render('[{{note}}] {{full}}', QUOTA))).toBe('[] false');
  });

  it('repeats a section once per item of a list, the item as its scope', () => {
    expect(ok(render('{{#disks}}{{mount}} {{pct}}%; {{/disks}}', QUOTA))).toBe(
      '/ 72%; /data 18%; ',
    );
  });

  it('prints the current item with {{.}}', () => {
    expect(ok(render('{{#tags}}<{{.}}>{{/tags}}', QUOTA))).toBe(
      '<fast><local>',
    );
  });

  it('reaches the data around a section from inside it', () => {
    expect(ok(render('{{#disks}}{{name}}{{mount}} {{/disks}}', QUOTA))).toBe(
      'storage/ storage/data ',
    );
  });

  it('shows a section over an object once, with the object as its scope', () => {
    expect(
      ok(render('{{#owner}}{{name}}/{{team.name}}{{/owner}}', QUOTA)),
    ).toBe('ops/infra');
  });

  it('shows a section over a truthy value once, and never over a falsy one', () => {
    expect(ok(render('{{#used}}some{{/used}}', QUOTA))).toBe('some');
    for (const path of ['full', 'note', 'empty', 'missing'])
      expect(ok(render(`{{#${path}}}x{{/${path}}}`, QUOTA))).toBe('');
    expect(ok(render('{{#n}}x{{/n}}{{#s}}y{{/s}}', { n: 0, s: '' }))).toBe('');
  });

  it('shows an inverted section only when the value is falsy, empty or missing', () => {
    expect(
      ok(
        render(
          '{{^full}}room{{/full}}{{^empty}} none{{/empty}}{{^missing}} gone{{/missing}}{{^used}} never{{/used}}',
          QUOTA,
        ),
      ),
    ).toBe('room none gone');
  });

  it('makes an if and an else of a section and its inverse', () => {
    const t = '{{#full}}full{{/full}}{{^full}}has room{{/full}}';
    expect(ok(render(t, { full: true }))).toBe('full');
    expect(ok(render(t, { full: false }))).toBe('has room');
  });

  it('nests sections', () => {
    expect(
      ok(
        render('{{#rows}}{{#cells}}{{.}},{{/cells}}|{{/rows}}', {
          rows: [{ cells: [1, 2] }, { cells: [3] }],
        }),
      ),
    ).toBe('1,2,|3,|');
  });

  it('names a path missing where a value prints', () => {
    expect(failure(render('{{used}} {{quota.left}}', QUOTA))).toBe(
      'no value at quota.left',
    );
    expect(failure(render('{{disks.5.mount}}', QUOTA))).toBe(
      'no value at disks.5.mount',
    );
  });

  it('never reaches what an object inherits', () => {
    expect(failure(render('{{owner.constructor}}', QUOTA))).toBe(
      'no value at owner.constructor',
    );
  });

  it('refuses an object or a list printed as a value', () => {
    expect(failure(render('{{owner}}', QUOTA))).toBe(
      'owner is a list or an object, not a value',
    );
    expect(failure(render('{{disks}}', QUOTA))).toBe(
      'disks is a list or an object, not a value',
    );
    expect(failure(render('{{#owner}}{{.}}{{/owner}}', QUOTA))).toBe(
      '. is a list or an object, not a value',
    );
  });

  it('makes text, never markup: what the data holds prints as it is', () => {
    expect(ok(render('{{v}}', { v: '<img src=x onerror=alert(1)>' }))).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
});

describe('checkTemplate', () => {
  it('passes a template whose sections all close', () => {
    expect(
      Result.isSuccess(checkTemplate('{{#a}}{{^b}}x{{/b}}{{/a}} {{c}}')),
    ).toBe(true);
  });

  it('names a section never closed', () => {
    expect(failure(checkTemplate('{{#a}}x'))).toBe('{{#a}} is never closed');
    expect(failure(checkTemplate('{{^a}}x'))).toBe('{{^a}} is never closed');
  });

  it('names a close that matches nothing open', () => {
    expect(failure(checkTemplate('x{{/a}}'))).toBe(
      '{{/a}} closes nothing open',
    );
  });

  it('names a close of another section than the one open', () => {
    expect(failure(checkTemplate('{{#a}}{{#b}}{{/a}}{{/b}}'))).toBe(
      '{{/a}} closes {{#b}}',
    );
  });

  it('fails a render of a broken template before reading any data', () => {
    expect(failure(render('{{#a}}', {}))).toBe('{{#a}} is never closed');
  });
});

describe('toneOf', () => {
  const map: WidgetToneRule = {
    from: 'state',
    map: { green: 'ok', amber: 'warn', red: 'bad' },
  };
  const above: WidgetToneRule = {
    from: 'disks.0.pct',
    above: { '70': 'warn', '85': 'bad' },
  };

  it('maps a value to its tone', () => {
    expect(ok(toneOf(map, { state: 'amber' }))).toBe('warn');
  });

  it('gives no tone for a value the map does not list', () => {
    expect(ok(toneOf(map, { state: 'blue' }))).toBeUndefined();
    expect(ok(toneOf(map, { state: 'constructor' }))).toBeUndefined();
  });

  it('maps a number or a boolean by its text', () => {
    expect(
      ok(
        toneOf(
          { from: 'up', map: { true: 'ok', false: 'bad' } },
          { up: false },
        ),
      ),
    ).toBe('bad');
  });

  it('takes the highest threshold met, whatever order they are in', () => {
    const at = (pct: number) => ok(toneOf(above, { disks: [{ pct }] }));
    expect(at(72)).toBe('warn');
    expect(at(85)).toBe('bad');
    expect(at(99)).toBe('bad');
    expect(
      ok(
        toneOf({ from: 'n', above: { '85': 'bad', '70': 'warn' } }, { n: 90 }),
      ),
    ).toBe('bad');
  });

  it('is ok when no threshold is met', () => {
    expect(ok(toneOf(above, { disks: [{ pct: 18 }] }))).toBe('ok');
  });

  it('names a missing path', () => {
    expect(failure(toneOf(map, {}))).toBe('no value at state for the tone');
  });

  it('refuses a value above cannot compare', () => {
    expect(failure(toneOf(above, { disks: [{ pct: '72' }] }))).toBe(
      'disks.0.pct is not a number, so above cannot compare it',
    );
  });
});
