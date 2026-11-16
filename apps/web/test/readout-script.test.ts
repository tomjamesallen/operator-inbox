import { renderedQuestionBody } from '@operator-inbox/core';
import { describe, expect, it } from 'vitest';
import {
  describeCode,
  describeDrawing,
  describeMermaid,
  describeTable,
  gistOfCode,
  PAUSE_APART,
  PAUSE_READ,
  type Script,
  scriptOf,
  spokenOf,
  unitsOf,
} from '../src/readout/script';

// The speech script, made from the HTML core renders a body to, as the page
// draws it. All names are invented.

const scriptFor = (title: string, body: string, drawings = {}): Script =>
  scriptOf({ title, ...renderedQuestionBody(body), drawings });

const texts = (s: Script) => s.segments.map((x) => [x.kind, x.text]);

const fragment = (html: string): Element => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('the speech script', () => {
  it('reads the title, then each paragraph, heading and list item as drawn', () => {
    const s = scriptFor(
      'Ship the export redesign?',
      '## Where it stands\n\nThe draft keeps the  old order.\n\n- one\n- two, with *emphasis*\n',
    );
    expect(texts(s)).toEqual([
      ['title', 'Ship the export redesign?'],
      ['read', 'Where it stands'],
      ['read', 'The draft keeps the old order.'],
      ['read', 'one'],
      ['read', 'two, with emphasis'],
    ]);
    expect(s.segments[0]?.pauseAfter).toBe(PAUSE_APART);
    expect(s.segments[2]?.pauseAfter).toBe(PAUSE_READ);
    // Each read segment names the unit it came from, in the one html part.
    expect(s.segments.slice(1).map((x) => [x.part, x.unit])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
  });

  it('reads a list item’s own words, then each nested item', () => {
    const s = scriptFor('T', '- parent\n  - child one\n  - child two\n');
    expect(texts(s).slice(1)).toEqual([
      ['read', 'parent'],
      ['read', 'child one'],
      ['read', 'child two'],
    ]);
  });

  it('describes a table, a code block, a diagram and a drawing, never reads them', () => {
    const scene = JSON.stringify({
      elements: [
        { type: 'rectangle', label: { text: 'Menu' } },
        { type: 'rectangle', label: { text: 'Form' } },
        { type: 'arrow' },
        { type: 'text', text: 'gone', isDeleted: true },
      ],
    });
    const s = scriptFor(
      'T',
      [
        '| Option | Risk |',
        '| :-- | :-- |',
        '| Keep | low |',
        '| Change | high |',
        '',
        '```ts',
        'const exportRows = (rows) => {',
        '  queueStreamedExport(rows).pipe(retry());',
        '  return downloadNow(rows);',
        '};',
        '```',
        '',
        '```mermaid',
        'flowchart LR',
        '  a[Click export] --> b{Over 50k?}',
        '```',
        '',
        '<Excalidraw id="layout"/>',
      ].join('\n'),
      { layout: { scene, revision: 1 } },
    );
    expect(texts(s).slice(1)).toEqual([
      [
        'described',
        'A table of two rows, one per option, by Risk. The rows are Keep and Change.',
      ],
      [
        'described',
        'A TypeScript block of four lines, defining export rows; it calls queue streamed export, retry and download now.',
      ],
      ['described', 'A flow chart of two steps: Click export and Over 50k?'],
      [
        'described',
        'A drawing of two boxes, labelled Menu and Form, joined by one arrow.',
      ],
    ]);
    expect(s.segments.slice(1).map((x) => x.what)).toEqual([
      'table',
      'code',
      'diagram',
      'drawing',
    ]);
    expect(
      s.segments.every(
        (x) => x.kind !== 'described' || x.pauseAfter === PAUSE_APART,
      ),
    ).toBe(true);
  });

  it('says inline code as its gist, and maps it back onto the code', () => {
    const el = fragment(
      '<p>Run <code>downloadNow(report)</code> on <code>report-&lt;date&gt;.csv</code>.</p>',
    );
    const [unit] = unitsOf(el);
    expect(unit?.kind).toBe('read');
    if (unit?.kind !== 'read') return;
    const { text, at } = spokenOf(unit.nodes);
    expect(text).toBe('Run download now report on report date CSV.');
    // Every spoken character lands inside the text node it was said for.
    for (const [node, offset] of at)
      expect(offset).toBeLessThan(node.data.length);
    const said = text.indexOf('download');
    expect(at[said]?.[0].data).toBe('downloadNow(report)');
  });

  it('drops a block with no words, and keeps the key while the words do', () => {
    const a = scriptFor('T', 'One.\n\n<p> </p>\n\nTwo.');
    expect(texts(a).slice(1)).toEqual([
      ['read', 'One.'],
      ['read', 'Two.'],
    ]);
    expect(scriptFor('T', 'One.\n\nTwo.').key).toBe(
      scriptFor('T', 'One.\n\nTwo.').key,
    );
    expect(scriptFor('T', 'One.\n\nTwo!').key).not.toBe(
      scriptFor('T', 'One.\n\nTwo.').key,
    );
  });
});

describe('the gist of inline code', () => {
  it('says a name’s words, a file’s name and type, and long code as some code', () => {
    expect(gistOfCode('downloadNow')).toBe('download now');
    expect(gistOfCode('STREAM_THRESHOLD')).toBe('stream threshold');
    expect(gistOfCode('report-<date>.csv')).toBe('report date CSV');
    expect(gistOfCode('a.b.c.d.e.f.g')).toBe('some code');
    expect(gistOfCode('=>')).toBe('code');
  });
});

describe('the descriptions', () => {
  it('names a table’s rows only when there are few', () => {
    const rows = Array.from(
      { length: 7 },
      (_, i) => `<tr><td>r${i}</td></tr>`,
    ).join('');
    expect(
      describeTable(
        fragment(
          `<table><thead><tr><th>Name</th></tr></thead><tbody>${rows}</tbody></table>`,
        ).firstElementChild as Element,
      ),
    ).toBe('A table of seven rows, one per name.');
  });

  it('calls a short block a snippet, and names what it calls', () => {
    expect(
      describeCode(
        fragment('<pre><code class="language-sh">pnpm verify\n</code></pre>')
          .firstElementChild as Element,
      ),
    ).toBe('A shell snippet.');
    expect(
      describeCode(
        fragment('<pre><code>run(task)\n</code></pre>')
          .firstElementChild as Element,
      ),
    ).toBe('A snippet, which calls run.');
  });

  it('says a sequence diagram’s participants, and a long flow’s ends', () => {
    expect(
      describeMermaid(
        'sequenceDiagram\n  participant Page\n  participant Serve\n  Page->>Serve: ask',
      ),
    ).toBe('A sequence diagram between Page and Serve.');
    expect(
      describeMermaid(
        'graph TD\n a[One] --> b[Two] --> c[Three] --> d[Four] --> e[Five] --> f[Six]',
      ),
    ).toBe('A flow chart of six steps, from One to Six.');
  });

  it('falls back to a plain word for a drawing it cannot read', () => {
    expect(describeDrawing(undefined)).toBe('A drawing.');
    expect(describeDrawing('{not json')).toBe('A drawing.');
  });
});
