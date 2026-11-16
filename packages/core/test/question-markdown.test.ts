import { describe, expect, it } from '@effect/vitest';
import { Marked } from 'marked';
import {
  renderQuestionMarkdown,
  renderQuestionParts,
} from '../src/question-markdown';

// The inbox question renderer: one case per GFM construct a question may use,
// and the safety rules that let the page inject the HTML it returns.

const r = renderQuestionMarkdown;

describe('renderQuestionMarkdown — constructs', () => {
  it('renders every heading level, h5 and h6 included', () => {
    expect(r('# One\n##### Five\n###### Six')).toBe(
      '<h1>One</h1>\n<h5>Five</h5>\n<h6>Six</h6>\n',
    );
  });

  it('renders bold, italic, inline code and strikethrough', () => {
    expect(r('**b** *i* `c` ~~s~~')).toBe(
      '<p><strong>b</strong> <em>i</em> <code>c</code> <del>s</del></p>\n',
    );
  });

  it('renders nested lists', () => {
    expect(r('- one\n  - nested\n- two')).toBe(
      '<ul>\n<li>one<ul>\n<li>nested</li>\n</ul>\n</li>\n<li>two</li>\n</ul>\n',
    );
  });

  it('renders task list items with disabled checkboxes', () => {
    const html = r('- [ ] open\n- [x] done');
    expect(html).toContain('<li><input type="checkbox" disabled> open</li>');
    expect(html).toContain(
      '<li><input type="checkbox" disabled checked> done</li>',
    );
  });

  it('renders quotes, tables and rules', () => {
    expect(r('> q')).toBe('<blockquote>\n<p>q</p>\n</blockquote>\n');
    const table = r('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(table).toContain('<th>a</th>');
    expect(table).toContain('<td>2</td>');
    expect(r('---')).toBe('<hr>\n');
  });

  // The page scrolls a wide table sideways in this div; its text, which a
  // comment's place is counted in, is what marked's bare table gives.
  it('wraps a table in a scroll box that adds no text', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\nafter';
    const html = r(md);
    expect(html).toMatch(
      /^<div data-table-scroll><table>[\s\S]*<\/table><\/div>\n<p>after<\/p>\n$/,
    );
    const bare = new Marked({ gfm: true, async: false }).parse(md) as string;
    const text = (h: string) => h.replace(/<[^>]*>/g, '');
    expect(text(html)).toBe(text(bare));
  });

  it('keeps a fence language as class="language-x"', () => {
    expect(r('```python\nx = 1\n```')).toBe(
      '<pre><code class="language-python">x = 1\n</code></pre>\n',
    );
  });

  it('colours a fence in a language it knows, keeping its class', () => {
    expect(r('```diff\n-a\n+b <i>\n```')).toBe(
      '<pre><code class="language-diff"><span class="hljs-deletion">-a</span>\n<span class="hljs-addition">+b &lt;i&gt;</span>\n</code></pre>\n',
    );
  });

  it('leaves a mermaid fence as code', () => {
    expect(r('```mermaid\ngraph TD\n```')).toBe(
      '<pre><code class="language-mermaid">graph TD\n</code></pre>\n',
    );
  });
});

describe('renderQuestionMarkdown — links and images', () => {
  it('opens an http(s) link in a new tab, with no referrer', () => {
    expect(r('[x](https://example.com)')).toBe(
      '<p><a href="https://example.com" rel="noreferrer" target="_blank">x</a></p>\n',
    );
  });

  it('keeps a mailto link', () => {
    expect(r('[m](mailto:a@b.c)')).toContain('<a href="mailto:a@b.c"');
  });

  it('renders a javascript: link as its text, not a link', () => {
    const html = r('[bad](javascript:alert(1))');
    expect(html).toBe('<p>bad</p>\n');
    expect(html).not.toContain('<a');
  });

  it('renders an http(s) image lazily, with its alt text', () => {
    expect(r('![alt](https://placehold.co/1x1)')).toBe(
      '<p><img src="https://placehold.co/1x1" alt="alt" loading="lazy"></p>\n',
    );
  });

  it('renders a data: image as its alt text, not an image', () => {
    const html = r('![pic](data:image/png;base64,AAAA)');
    expect(html).toBe('<p>pic</p>\n');
    expect(html).not.toContain('<img');
  });
});

describe('renderQuestionMarkdown — raw HTML', () => {
  it('escapes a raw <script> block', () => {
    const html = r('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes inline raw HTML', () => {
    expect(r('a <b onclick="x">b</b>')).toBe(
      '<p>a &lt;b onclick=&quot;x&quot;&gt;b&lt;/b&gt;</p>\n',
    );
  });

  it('escapes a raw inline <svg>', () => {
    expect(r('<svg><circle r="1"/></svg>')).not.toContain('<svg');
  });
});

describe('renderQuestionMarkdown — <small>', () => {
  it('renders an inline pair as a small element, with markdown inside', () => {
    expect(r('a <small>b **c** `d`</small> e')).toBe(
      '<p>a <small>b <strong>c</strong> <code>d</code></small> e</p>\n',
    );
  });

  it('takes the tag in any case, and writes it in lower case', () => {
    expect(r('<SMALL>x</Small>')).toBe('<p><small>x</small></p>\n');
  });

  it('renders inside emphasis, a list item, a table cell and a link', () => {
    expect(r('*<small>x</small>*')).toBe('<p><em><small>x</small></em></p>\n');
    expect(r('- <small>x</small>')).toBe(
      '<ul>\n<li><small>x</small></li>\n</ul>\n',
    );
    expect(r('| a |\n|---|\n| <small>y</small> |')).toContain(
      '<td><small>y</small></td>',
    );
    expect(r('[<small>x</small>](https://example.com)')).toContain(
      '<a href="https://example.com" rel="noreferrer" target="_blank"><small>x</small></a>',
    );
  });

  it('renders a block pair round markdown, blank lines and all', () => {
    expect(r('<small>\n\nSome *text*.\n\n- one\n\n</small>')).toBe(
      '<small><p>Some <em>text</em>.</p>\n<ul>\n<li>one</li>\n</ul>\n</small>',
    );
  });

  it('reads the inside of a <small> HTML block as markdown', () => {
    expect(r('<small>\nSome **text**\n</small>')).toBe(
      '<small><p>Some <strong>text</strong></p>\n</small>',
    );
  });

  it('renders a block pair inside a list item and a quote', () => {
    expect(r('- item\n\n  <small>\n\n  note\n\n  </small>')).toContain(
      '<small><p>note</p>\n</small>',
    );
    expect(r('> <small>\n>\n> q\n>\n> </small>')).toBe(
      '<blockquote>\n<small><p>q</p>\n</small></blockquote>\n',
    );
  });

  it('leaves an unpaired tag as text', () => {
    expect(r('a <small>b')).toBe('<p>a &lt;small&gt;b</p>\n');
    expect(r('a </small>b')).toBe('<p>a &lt;/small&gt;b</p>\n');
    // Split across paragraphs, the tags are not siblings.
    expect(r('<small>a\n\nb</small>')).not.toContain('<small>');
    // Split across a link's text and the text after it.
    expect(r('[<small>a](https://example.com) b</small>')).not.toContain(
      '<small>',
    );
  });

  it('leaves a <small> with an attribute as text, and its close with it', () => {
    expect(r('<small class="x" onclick="y">a</small>')).toBe(
      '<p>&lt;small class=&quot;x&quot; onclick=&quot;y&quot;&gt;a&lt;/small&gt;</p>\n',
    );
  });

  it('still escapes every other tag beside a rendered <small>', () => {
    expect(
      r(
        '<small>s</small> <b>b</b> <div>d</div> <script>x</script> <smaller>z</smaller>',
      ),
    ).toBe(
      '<p><small>s</small> &lt;b&gt;b&lt;/b&gt; &lt;div&gt;d&lt;/div&gt; &lt;script&gt;x&lt;/script&gt; &lt;smaller&gt;z&lt;/smaller&gt;</p>\n',
    );
    expect(r('<script>\n<small>x</small>\n</script>')).not.toContain('<small>');
    expect(r('<div>\n\n<small>x</small>\n\n</div>')).toBe(
      '&lt;div&gt;<p><small>x</small></p>\n&lt;/div&gt;',
    );
  });

  it('leaves a <small> inside code as code', () => {
    expect(r('`<small>x</small>`')).toBe(
      '<p><code>&lt;small&gt;x&lt;/small&gt;</code></p>\n',
    );
    expect(r('```\n<small>x</small>\n```')).toBe(
      '<pre><code>&lt;small&gt;x&lt;/small&gt;\n</code></pre>\n',
    );
  });
});

describe('renderQuestionMarkdown — svg fences', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

  it('renders an svg fence as a diagram image with a data URL', () => {
    const html = r(`\`\`\`svg\n${svg}\n\`\`\``);
    const b64 = Buffer.from(svg, 'utf8').toString('base64');
    expect(html).toBe(
      `<p><img src="data:image/svg+xml;base64,${b64}" alt="diagram" loading="lazy"></p>\n`,
    );
  });

  it('accepts an <?xml?> prolog before the svg', () => {
    const html = r(`\`\`\`svg\n<?xml version="1.0"?>\n${svg}\n\`\`\``);
    expect(html).toContain('src="data:image/svg+xml;base64,');
  });

  it('keeps a <script> inside the svg out of the page', () => {
    const html = r(
      '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n```',
    );
    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<script');
  });

  it('leaves an svg fence whose body is not svg as code', () => {
    expect(r('```svg\nnot a diagram\n```')).toBe(
      '<pre><code class="language-svg">not a diagram\n</code></pre>\n',
    );
  });

  it('leaves an svg past the size cap as code', () => {
    const big = `<svg>${'x'.repeat(200 * 1024)}</svg>`;
    const html = r(`\`\`\`svg\n${big}\n\`\`\``);
    expect(html).toContain('<pre><code class="language-svg">&lt;svg&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('renderQuestionParts — mermaid fences', () => {
  it('splits the body at each mermaid fence, keeping its source as text', () => {
    const parts = renderQuestionParts(
      [
        'Before [the docs][d].',
        '',
        '```mermaid',
        'graph TD; A-->B',
        '```',
        '',
        'Between.',
        '',
        '```Mermaid',
        'sequenceDiagram',
        '```',
        '',
        '[d]: https://example.com',
      ].join('\n'),
    );
    expect(parts.map((p) => p.kind)).toEqual([
      'html',
      'mermaid',
      'html',
      'mermaid',
    ]);
    // A reference link defined at the end still resolves in the first part.
    expect(parts[0]).toEqual({
      kind: 'html',
      html: '<p>Before <a href="https://example.com" rel="noreferrer" target="_blank">the docs</a>.</p>\n',
    });
    expect(parts[1]).toEqual({ kind: 'mermaid', source: 'graph TD; A-->B' });
    expect(parts[3]).toEqual({ kind: 'mermaid', source: 'sequenceDiagram' });
  });

  it('renders the parts around a fence as safely as the whole body', () => {
    const parts = renderQuestionParts(
      '<script>x</script>\n\n```mermaid\ngraph TD; A-->B\n```',
    );
    expect(parts[0]).toEqual({
      kind: 'html',
      html: renderQuestionMarkdown('<script>x</script>'),
    });
  });

  it('renders <small> in a part, and leaves a pair split by a fence as text', () => {
    expect(
      renderQuestionParts(
        'a <small>b</small>\n\n<small>\n\n```mermaid\ngraph TD; A-->B\n```\n\n</small>',
      ),
    ).toEqual([
      { kind: 'html', html: '<p>a <small>b</small></p>\n&lt;small&gt;' },
      { kind: 'mermaid', source: 'graph TD; A-->B' },
      { kind: 'html', html: '&lt;/small&gt;' },
    ]);
  });

  it('is one html part without a fence, and none for an empty body', () => {
    expect(renderQuestionParts('Just **text**.')).toEqual([
      { kind: 'html', html: renderQuestionMarkdown('Just **text**.') },
    ]);
    expect(renderQuestionParts('')).toEqual([]);
  });
});
