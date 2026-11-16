import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  checkHtmlBlocks,
  checkHtmlDocument,
  decideAsk,
  decideEdit,
  decideMove,
  HTML_BLOCK_CSP,
  HTML_BLOCK_MAX_BYTES,
  HTML_BLOCKS_MAX,
  htmlBlockFailure,
  htmlBlockLibrariesOf,
  htmlBlockMetaOf,
  htmlBlockSrcdoc,
  type InboxEvent,
  InboxId,
  inboxState,
  QuestionNumber,
  renderQuestionParts,
} from '../src';

const A = InboxId.make('01J00000000000000000000IA1');
const B = InboxId.make('01J00000000000000000000IB1');
const n = QuestionNumber.make;
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

const opened: InboxEvent = { _tag: 'InboxOpened', inboxId: A, label: 'one' };

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  return r.success;
};

const refusal = <A, E>(r: Result.Result<A, E>): E => {
  if (Result.isSuccess(r)) throw new Error('expected a refusal');
  return r.failure;
};

describe('HTML block tags in the body', () => {
  it('splits a tag on a line of its own into a block part, its width kept', () => {
    expect(
      renderQuestionParts(
        'The runs.\n\n<Html id="chart"/>\n\n<Html id="scene" width="full"/>\n\n<Html id="flow" width="wide"/>\n\nWhich?',
      ),
    ).toStrictEqual([
      { kind: 'html', html: '<p>The runs.</p>\n' },
      { kind: 'html-block', id: 'chart' },
      { kind: 'html-block', id: 'scene', width: 'full' },
      { kind: 'html-block', id: 'flow', width: 'wide' },
      { kind: 'html', html: '<p>Which?</p>\n' },
    ]);
  });

  it('reads width="constrain" as the default, with no width on the part', () => {
    expect(
      renderQuestionParts('<Html id="chart" width="constrain"/>'),
    ).toStrictEqual([{ kind: 'html-block', id: 'chart' }]);
  });

  it('leaves a tag inline, with another attribute, a bad width or a bad id as escaped text', () => {
    for (const body of [
      'See <Html id="chart"/> here.',
      '<Html id="chart" height="3"/>',
      '<Html id="chart" width="huge"/>',
      '<Html width="wide" id="chart"/>',
      '<Html id="Bad_Id"/>',
    ]) {
      const parts = renderQuestionParts(body);
      expect(parts.some((p) => p.kind === 'html-block')).toBe(false);
      expect(
        parts.map((p) => (p.kind === 'html' ? p.html : '')).join(''),
      ).toContain('&lt;Html');
    }
  });
});

describe('the oi-block meta', () => {
  it('reads width, height, aspect and the title', () => {
    expect(
      ok(
        htmlBlockMetaOf(
          '<title> Two runs </title><meta name="oi-block" content="width=760; height=420px; aspect=16/9">',
        ),
      ),
    ).toStrictEqual({
      title: 'Two runs',
      width: 760,
      height: 420,
      aspect: 16 / 9,
    });
  });

  it('takes the attributes in either order, and a decimal aspect', () => {
    expect(
      ok(htmlBlockMetaOf("<meta content='aspect=1.5' name='oi-block'>")),
    ).toStrictEqual({ aspect: 1.5 });
  });

  it('declares nothing with no meta', () => {
    expect(ok(htmlBlockMetaOf('<p>hi</p>'))).toStrictEqual({});
  });

  it('refuses an unknown key, a bad value, and two metas', () => {
    for (const doc of [
      '<meta name="oi-block" content="depth=3">',
      '<meta name="oi-block" content="height=tall">',
      '<meta name="oi-block" content="height=9000">',
      '<meta name="oi-block" content="aspect=0/9">',
      '<meta name="oi-block" content="width=1"><meta name="oi-block" content="width=2">',
    ])
      expect(Result.isFailure(htmlBlockMetaOf(doc))).toBe(true);
  });
});

describe('checkHtmlDocument', () => {
  it('keeps a document within the cap whose meta parses', () => {
    expect(
      ok(
        checkHtmlDocument(
          'chart',
          '<meta name="oi-block" content="height=300"><svg></svg>',
          60,
        ),
      ),
    ).toStrictEqual({ height: 300 });
  });

  it('refuses a document over the size cap', () => {
    expect(
      refusal(checkHtmlDocument('chart', '<p>x</p>', HTML_BLOCK_MAX_BYTES + 1)),
    ).toContain('at most 512 KiB');
  });

  it('refuses an empty document, a bad id and a bad meta, naming the block', () => {
    expect(refusal(checkHtmlDocument('chart', '  ', 2))).toContain('empty');
    expect(refusal(checkHtmlDocument('Chart', '<p>x</p>', 8))).toContain('id');
    expect(
      refusal(
        checkHtmlDocument('chart', '<meta name="oi-block" content="x=1">', 36),
      ),
    ).toContain('HTML block "chart"');
  });
});

describe('checkHtmlBlocks', () => {
  it('refuses a hash that is not a SHA-256, a size past the cap, and too many', () => {
    expect(
      Result.isFailure(checkHtmlBlocks({ chart: { sha: 'abc', bytes: 3 } })),
    ).toBe(true);
    expect(
      Result.isFailure(
        checkHtmlBlocks({
          chart: { sha: SHA, bytes: HTML_BLOCK_MAX_BYTES + 1 },
        }),
      ),
    ).toBe(true);
    const many = Object.fromEntries(
      Array.from({ length: HTML_BLOCKS_MAX + 1 }, (_, i) => [
        `b${i}`,
        { sha: SHA, bytes: 1 },
      ]),
    );
    expect(refusal(checkHtmlBlocks(many))).toContain(
      `at most ${HTML_BLOCKS_MAX}`,
    );
  });
});

describe('HTML blocks on a Question', () => {
  it('asks with blocks, and the fold holds their hashes', () => {
    const asked = ok(
      decideAsk(inboxState([opened]), {
        inboxId: A,
        title: 'T',
        body: '<Html id="chart"/>',
        htmls: { chart: { sha: SHA, bytes: 10 } },
      }),
    );
    expect(asked.htmls).toStrictEqual({ chart: { sha: SHA, bytes: 10 } });
    expect(inboxState([opened, asked]).questions[0]?.htmls).toStrictEqual({
      chart: { sha: SHA, bytes: 10 },
    });
  });

  it('refuses a bad block as bad-html', () => {
    const refused = refusal(
      decideAsk(inboxState([opened]), {
        inboxId: A,
        title: 'T',
        body: '',
        htmls: { chart: { sha: 'nope', bytes: 10 } },
      }),
    );
    expect(refused.reason).toBe('bad-html');
  });

  it('edits by id, the event carrying the whole new set, and refuses a block that changes nothing', () => {
    const asked = ok(
      decideAsk(inboxState([opened]), {
        inboxId: A,
        title: 'T',
        body: 'b',
        htmls: { chart: { sha: SHA, bytes: 10 } },
      }),
    );
    const state = inboxState([opened, asked]);
    const edited = ok(
      decideEdit(state, {
        inboxId: A,
        number: n(1),
        htmls: { scene: { sha: SHA2, bytes: 20 } },
      }),
    );
    expect(edited.htmls).toStrictEqual({
      chart: { sha: SHA, bytes: 10 },
      scene: { sha: SHA2, bytes: 20 },
    });
    const after = inboxState([opened, asked, edited]).questions[0];
    expect(after?.htmls).toStrictEqual(edited.htmls);
    expect(after?.revision).toBe(2);
    expect(
      refusal(
        decideEdit(state, {
          inboxId: A,
          number: n(1),
          htmls: { chart: { sha: SHA, bytes: 10 } },
        }),
      ).reason,
    ).toBe('unchanged');
  });

  it('keeps the blocks through an edit that leaves them out, and through a move', () => {
    const asked = ok(
      decideAsk(inboxState([opened]), {
        inboxId: A,
        title: 'T',
        body: 'b',
        htmls: { chart: { sha: SHA, bytes: 10 } },
      }),
    );
    const edited = ok(
      decideEdit(inboxState([opened, asked]), {
        inboxId: A,
        number: n(1),
        body: 'b2',
      }),
    );
    expect(edited).not.toHaveProperty('htmls');
    const events = [opened, asked, edited];
    expect(inboxState(events).questions[0]?.htmls).toStrictEqual({
      chart: { sha: SHA, bytes: 10 },
    });
    const other: InboxEvent = { _tag: 'InboxOpened', inboxId: B, label: 'two' };
    const moved = ok(
      decideMove(inboxState(events), inboxState([other]), {
        inboxId: A,
        numbers: [n(1)],
        toInboxId: B,
      }),
    );
    expect(inboxState([other, ...moved]).questions[0]?.htmls).toStrictEqual({
      chart: { sha: SHA, bytes: 10 },
    });
  });
});

describe('the frame', () => {
  it('writes a policy that lets no request leave, and scripts run only inline or from blob: URLs', () => {
    expect(HTML_BLOCK_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it('names no http(s) source and no host in its policy', () => {
    expect(HTML_BLOCK_CSP).not.toMatch(/https?:|\/\/|\*|'self'/);
    const doc = htmlBlockSrcdoc('<p>x</p>', { scheme: 'light', tokens: {} });
    const policy =
      /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1];
    expect(policy).toBe(HTML_BLOCK_CSP);
  });

  it('reads which vendored files a document uses from the specifiers it names', () => {
    expect(htmlBlockLibrariesOf('<p>no scripts</p>')).toStrictEqual([]);
    expect(
      htmlBlockLibrariesOf('<script type="module">import "d3";</script>'),
    ).toStrictEqual(['d3.min.js']);
    expect(
      htmlBlockLibrariesOf("import * as THREE from 'three';"),
    ).toStrictEqual(['three.module.js', 'three.core.js']);
    expect(
      htmlBlockLibrariesOf(
        "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
      ),
    ).toStrictEqual([
      'three.module.js',
      'three.core.js',
      'three-addons/controls/OrbitControls.js',
    ]);
    // A word in the prose is not a specifier.
    expect(htmlBlockLibrariesOf('<p>three d3</p>')).toStrictEqual([]);
  });

  const LIBRARIES = {
    'three.module.js':
      "import { A } from './three.core.js';\nexport { B } from './three.core.js';",
    'three.core.js': 'export const A = 1; // </script><!--',
    'three-addons/controls/OrbitControls.js': "import { A } from 'three';",
    'd3.min.js': 'globalThis.d3 = {};',
  } as const;

  it('hands the frame only the libraries the document uses, with no script tag closable from inside them', () => {
    const d3Only = htmlBlockSrcdoc(
      '<script type="module">import "d3";</script>',
      { scheme: 'light', tokens: {}, libraries: LIBRARIES },
    );
    expect(d3Only).toContain('globalThis.d3 = {};');
    expect(d3Only).not.toContain('export const A');
    const none = htmlBlockSrcdoc('<p>x</p>', {
      scheme: 'light',
      tokens: {},
      libraries: LIBRARIES,
    });
    expect(none).not.toContain('createObjectURL');
    const three = htmlBlockSrcdoc(
      "<script type=module>import 'three';</script>",
      {
        scheme: 'light',
        tokens: {},
        libraries: LIBRARIES,
      },
    );
    // Its text is carried as JSON, its `<` escaped: one `</script` per script
    // the app wrote (the loader, the style-free bootstrap) and the document's.
    expect(three).not.toContain('</script><!--');
    expect(three).toContain('\\u003c/script>\\u003c!--');
    expect(three.match(/<\/script/gi)).toHaveLength(3);
  });

  it('puts the policy first, then the loader, and drops the document’s own head tags', () => {
    const doc = htmlBlockSrcdoc(
      '<!doctype html><html><head><title>x</title></head><body><p>hi</p><script type="module">import "three";</script></body></html>',
      {
        scheme: 'dark',
        tokens: { fg: 'white', bg: 'black' },
        libraries: LIBRARIES,
      },
    );
    const csp = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(0);
    expect(doc.indexOf('<script')).toBeGreaterThan(csp);
    expect(doc.indexOf('createObjectURL')).toBeLessThan(
      doc.indexOf('<script type="module">'),
    );
    expect(doc).toContain('--fg: white;');
    expect(doc.match(/<head>/g)).toHaveLength(1);
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc).toContain('<title>x</title>');
  });

  it('posts a script’s error, but never the ResizeObserver loop notice', () => {
    const doc = htmlBlockSrcdoc('<p>x</p>', { scheme: 'light', tokens: {} });
    const bootstrap = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1] ?? '')
      .find((script) => script.includes("oi: 'error'"));
    const on: Record<
      string,
      (e: { message?: string; reason?: unknown }) => void
    > = {};
    const posted: Array<unknown> = [];
    const window = {
      addEventListener: (type: string, f: (typeof on)[string]) => {
        on[type] = f;
      },
    };
    new Function('window', 'parent', 'document', bootstrap ?? '')(
      window,
      { postMessage: (m: unknown) => posted.push(m) },
      {
        addEventListener: () => undefined,
        documentElement: { addEventListener: () => undefined },
      },
    );
    on.error?.({
      message: 'ResizeObserver loop completed with undelivered notifications.',
    });
    on.error?.({ message: 'ResizeObserver loop limit exceeded' });
    expect(posted).toStrictEqual([]);
    on.error?.({ message: 'x is not defined' });
    expect(posted).toStrictEqual([
      { oi: 'error', message: 'x is not defined' },
    ]);
  });

  // The bootstrap, run against a stand-in window: its listeners by type, and
  // what it posts to the page.
  const runBootstrap = (wheel?: 'page' | 'block') => {
    const doc = htmlBlockSrcdoc('<p>x</p>', {
      scheme: 'light',
      tokens: {},
      ...(wheel === undefined ? {} : { wheel }),
    });
    const script = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1] ?? '')
      .find((text) => text.includes("oi: 'error'"));
    const on: Record<string, (e: object) => void> = {};
    const listen = (type: string, f: (e: object) => void) => {
      const before = on[type];
      on[type] = (e) => {
        before?.(e);
        f(e);
      };
    };
    const posted: Array<unknown> = [];
    const root: Record<string, string> = {};
    const parent = { postMessage: (m: unknown) => posted.push(m) };
    new Function('window', 'parent', 'document', script ?? '')(
      { addEventListener: listen },
      parent,
      {
        addEventListener: () => undefined,
        documentElement: {
          addEventListener: (type: string, f: (e: object) => void) =>
            listen(`root:${type}`, f),
          style: {
            setProperty: (name: string, value: string) => {
              root[name] = value;
            },
          },
        },
      },
    );
    const wheelEvent = (more: object = {}) => {
      const e = {
        deltaX: 0,
        deltaY: 3,
        deltaMode: 1,
        ctrlKey: false,
        prevented: false,
        stopped: false,
        preventDefault() {
          e.prevented = true;
        },
        stopImmediatePropagation() {
          e.stopped = true;
        },
        ...more,
      };
      on.wheel?.(e);
      return e;
    };
    return { on, posted, parent, root, wheelEvent };
  };

  it('takes a wheel from the document and hands it to the page, until the block is clicked into', () => {
    const { on, posted, wheelEvent } = runBootstrap();
    const first = wheelEvent();
    expect(first.prevented && first.stopped).toBe(true);
    expect(posted).toStrictEqual([{ oi: 'wheel', dx: 0, dy: 3, mode: 1 }]);
    on.pointerdown?.({});
    expect(posted.at(-1)).toStrictEqual({ oi: 'engaged', on: true });
    const engaged = wheelEvent();
    expect(engaged.prevented || engaged.stopped).toBe(false);
    expect(posted).toHaveLength(2);
  });

  it('sets the text column’s place as CSS variables, from the page alone, full screen too', () => {
    for (const wheel of ['page', 'block'] as const) {
      const { on, parent, root } = runBootstrap(wheel);
      on.message?.({ source: {}, data: { oi: 'column', left: 9, width: 9 } });
      expect(root).toStrictEqual({});
      on.message?.({
        source: parent,
        data: { oi: 'column', left: 120, width: 640 },
      });
      expect(root).toStrictEqual({
        '--oi-column-left': '120px',
        '--oi-column-width': '640px',
      });
      on.message?.({
        source: parent,
        data: { oi: 'column', left: -4, width: 'wide' },
      });
      expect(root['--oi-column-left']).toBe('120px');
    }
    expect(
      htmlBlockSrcdoc('<p>x</p>', { scheme: 'light', tokens: {} }),
    ).toContain('--oi-column-left: 0px; --oi-column-width: 100%;');
  });

  it('always lets a ctrl+wheel (a pinch) through to the document', () => {
    const { posted, wheelEvent } = runBootstrap();
    const pinch = wheelEvent({ ctrlKey: true });
    expect(pinch.prevented || pinch.stopped).toBe(false);
    expect(posted).toStrictEqual([]);
  });

  it('disengages on leaving the block, on Escape, and on the page’s word alone', () => {
    const { on, posted, parent, wheelEvent } = runBootstrap();
    const engaged = () => (posted.at(-1) as { on?: boolean } | undefined)?.on;
    on.pointerdown?.({});
    on['root:pointerleave']?.({});
    expect(engaged()).toBe(false);
    expect(wheelEvent().prevented).toBe(true);
    on.pointerdown?.({});
    on.keydown?.({ key: 'Enter' });
    expect(engaged()).toBe(true);
    on.keydown?.({ key: 'Escape' });
    expect(engaged()).toBe(false);
    on.pointerdown?.({});
    on.message?.({ source: {}, data: { oi: 'disengage' } });
    expect(engaged()).toBe(true);
    on.message?.({ source: parent, data: { oi: 'disengage' } });
    expect(engaged()).toBe(false);
  });

  it('leaves every wheel to the document where the page has none to scroll', () => {
    const { on, posted } = runBootstrap('block');
    expect(on.wheel).toBeUndefined();
    expect(on.pointerdown).toBeUndefined();
    expect(posted).toStrictEqual([]);
  });

  it('says a muted error is hidden, and gives a real one', () => {
    expect(htmlBlockFailure('Script error.')).toBe(
      'A script in this block failed (the browser hides the message).',
    );
    expect(htmlBlockFailure('x is not defined')).toBe(
      'A script in this block failed: x is not defined',
    );
  });
});
