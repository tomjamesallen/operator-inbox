import type { QuestionBodyPartDto } from '@operator-inbox/core/api';

// A Question's speech script: what the voice says, in order, as segments.
// Prose, headings and list items are read as they are drawn; a table, a code
// block, an image, a Mermaid diagram and a drawing are described in one short
// sentence instead, by a local rule over the block itself, never a model call.
// Each segment names the block it came from, so the page can draw the cursor
// on it and a tap on the block can seek to it.
//
// The blocks are found by one walk (`unitsOf`), run on the body's HTML parsed
// off screen to make the script and on the live body to draw and to seek, so
// a block's index means the same element in both. The page makes the script
// and sends it to serve, which makes the audio (ADR-0005): no second walk, on
// another parser, has to agree with this one.

export type Described = 'table' | 'code' | 'image' | 'diagram' | 'drawing';

export interface Segment {
  readonly id: string;
  readonly kind: 'title' | 'read' | 'described';
  // The body part, and the unit inside an html part; a diagram or a drawing
  // is a whole part, and the title is neither.
  readonly part?: number;
  readonly unit?: number;
  readonly what?: Described;
  readonly text: string;
  // Seconds of silence after it, so a described block stands apart.
  readonly pauseAfter: number;
}

export interface Script {
  readonly segments: ReadonlyArray<Segment>;
  // The page's own name for this script, to tell one from another; serve
  // keys the audio by its own hash, which also covers the voice.
  readonly key: string;
}

/** Silence after a read segment, and after the title or a description. */
export const PAUSE_READ = 0.3;
export const PAUSE_APART = 0.5;

// --- the walk -------------------------------------------------------------------

const READABLE = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'DT',
  'DD',
  'FIGCAPTION',
]);
const DESCRIBED: Readonly<Record<string, Described>> = {
  TABLE: 'table',
  PRE: 'code',
  IMG: 'image',
};

export type ReadUnit = {
  readonly kind: 'read';
  readonly el: Element;
  readonly nodes: ReadonlyArray<Text>;
};
export type DescribedUnit = {
  readonly kind: 'described';
  readonly el: Element;
  readonly what: Described;
};
export type Unit = ReadUnit | DescribedUnit;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * The units of an html part, in reading order: each readable block with the
 * text nodes it owns (those not inside a nested readable or described block),
 * and each described block. A readable block that owns no words is dropped.
 */
export const unitsOf = (root: Element): ReadonlyArray<Unit> => {
  const out: Array<{ kind: 'read'; el: Element; nodes: Text[] } | Unit> = [];
  const walk = (node: Node, owner: { nodes: Text[] } | undefined) => {
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        owner?.nodes.push(child as Text);
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as Element;
      const what = DESCRIBED[el.tagName];
      if (what !== undefined) {
        out.push({ kind: 'described', el, what });
        continue;
      }
      if (READABLE.has(el.tagName)) {
        const unit = { kind: 'read' as const, el, nodes: [] as Text[] };
        out.push(unit);
        walk(el, unit);
        continue;
      }
      walk(el, owner);
    }
  };
  walk(root, undefined);
  return out.filter(
    (u) => u.kind === 'described' || u.nodes.some((n) => /\w/.test(n.data)),
  );
};

// --- inline code ------------------------------------------------------------------

/**
 * Inline code, said as its gist, never character by character: a name's
 * words (`downloadNow` → "download now"), a file's name and its type
 * (`report-<date>.csv` → "report date CSV"), and anything longer than five
 * words just "some code". The page has the text for a closer look.
 */
export const gistOfCode = (code: string): string => {
  const file = /^([\w./<>{}-]+?)\.([A-Za-z]{1,5})$/.exec(code.trim());
  const parts = (file?.[1] ?? code).match(/[A-Za-z]+|\d+/g) ?? [];
  const said = parts
    .flatMap((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '))
    .map((w) => w.toLowerCase());
  if (said.length === 0) return 'code';
  if (said.length > 5) return 'some code';
  const ext = file?.[2];
  return [...said, ...(ext === undefined ? [] : [ext.toUpperCase()])].join(' ');
};

const isInlineCode = (node: Text) => {
  const code = node.parentElement?.closest('code');
  return code !== null && code !== undefined && code.closest('pre') === null;
};

/**
 * A read unit's words as one string, whitespace collapsed, and where each of
 * its characters sits in the DOM, so an offset into the spoken text is a
 * place in the body, and back. Inline code is said as its gist, each of its
 * characters mapped back into the code's own text in proportion, so the
 * cursor and a tap still land on it.
 */
export const spokenOf = (
  nodes: ReadonlyArray<Text>,
): {
  readonly text: string;
  readonly at: ReadonlyArray<readonly [Text, number]>;
} => {
  let text = '';
  const at: Array<readonly [Text, number]> = [];
  let space = true;
  for (const node of nodes) {
    const gist = isInlineCode(node) ? gistOfCode(node.data) : undefined;
    const data = gist ?? node.data;
    const back = (i: number) =>
      gist === undefined
        ? i
        : // The gist's last character ends on the code's, so a word that
          // ends the gist is drawn under all of it.
          i === gist.length - 1
          ? node.data.length - 1
          : Math.min(
              node.data.length - 1,
              Math.floor((i / Math.max(1, gist.length)) * node.data.length),
            );
    for (let i = 0; i < data.length; i++) {
      const c = data[i] ?? '';
      if (/\s/.test(c)) {
        if (space) continue;
        space = true;
        text += ' ';
      } else {
        space = false;
        text += c;
      }
      at.push([node, back(i)]);
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    at.pop();
  }
  return { text, at };
};

// --- the descriptions -------------------------------------------------------------

const SMALL = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const count = (n: number) => SMALL[n] ?? String(n);
const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;

// "a, b and c"
const listed = (xs: ReadonlyArray<string>) =>
  xs.length <= 1
    ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
// A full stop, unless the last label already ends the sentence.
const ended = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);
// `exportRows` → `export rows`, `STREAM_THRESHOLD` → `stream threshold`.
const wordsOf = (id: string) =>
  id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  javascript: 'JavaScript',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  py: 'Python',
  python: 'Python',
  json: 'JSON',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  rust: 'Rust',
  go: 'Go',
  css: 'CSS',
  html: 'HTML',
  diff: 'diff',
  text: 'plain text',
};

/** A table: its rows, what each row is, its other headings, and the rows' names when few. */
export const describeTable = (el: Element): string => {
  const heads = [...el.querySelectorAll('thead th')].map((th) =>
    clean(th.textContent ?? ''),
  );
  const rows = [...el.querySelectorAll('tbody tr')];
  const firsts = rows
    .map((tr) => clean(tr.querySelector('td, th')?.textContent ?? ''))
    .filter((s) => s !== '');
  const by = heads.length > 1 ? `, by ${listed(heads.slice(1))}` : '';
  const per =
    heads[0] === undefined || heads[0] === ''
      ? ''
      : `, one per ${heads[0].toLowerCase()}`;
  const named =
    firsts.length > 0 && firsts.length <= 5
      ? ` The rows are ${listed(firsts)}.`
      : '';
  return `A table of ${plural(rows.length, 'row')}${per}${by}.${named}`;
};

// Words that are followed by `(` without being calls a listener cares about.
const NOT_CALLS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'function',
  'catch',
]);

/**
 * A code block: what it is, what it defines, and up to three plain calls it
 * makes (a method on something, `.pipe(`, is plumbing and left out). The
 * block is on the page for the detail.
 */
export const describeCode = (el: Element): string => {
  const code = el.querySelector('code');
  const lang = /language-(\w+)/.exec(code?.className ?? '')?.[1];
  const language = lang === undefined ? undefined : (LANGUAGES[lang] ?? lang);
  const source = code?.textContent ?? el.textContent ?? '';
  const lines = source.replace(/\n$/, '').split('\n').length;
  const name =
    /\b(?:const|let|var|function|class|def|type|interface|fn)\s+([A-Za-z_]\w*)/.exec(
      source,
    )?.[1];
  const calls = [
    ...new Set(
      [...source.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)]
        .map((m) => m[1] ?? '')
        .filter((c) => c !== name && !NOT_CALLS.has(c)),
    ),
  ].slice(0, 3);
  const what = `A ${language === undefined ? '' : `${language} `}${lines <= 3 ? 'snippet' : `block of ${plural(lines, 'line')}`}`;
  const defines = name === undefined ? '' : `, defining ${wordsOf(name)}`;
  const calling =
    calls.length === 0
      ? ''
      : `${name === undefined ? ', which' : '; it'} calls ${listed(calls.map(wordsOf))}`;
  return `${what}${defines}${calling}.`;
};

const DIAGRAMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(flowchart|graph)\b/, 'flow chart'],
  [/^sequenceDiagram\b/, 'sequence diagram'],
  [/^stateDiagram/, 'state diagram'],
  [/^classDiagram\b/, 'class diagram'],
  [/^erDiagram\b/, 'entity diagram'],
  [/^gantt\b/, 'timeline'],
  [/^pie\b/, 'pie chart'],
  [/^mindmap\b/, 'mind map'],
];

/** A Mermaid diagram: its kind, and its steps' labels (or a sequence's participants). */
export const describeMermaid = (source: string): string => {
  const first =
    source
      .trim()
      .split('\n')
      .find((l) => !l.trim().startsWith('%%'))
      ?.trim() ?? '';
  const kind = DIAGRAMS.find(([re]) => re.test(first))?.[1] ?? 'diagram';
  if (kind === 'sequence diagram') {
    const who = [
      ...new Set(
        [...source.matchAll(/^\s*(?:participant|actor)\s+(\S+)/gm)].map(
          (m) => m[1] ?? '',
        ),
      ),
    ];
    return who.length === 0
      ? 'A sequence diagram.'
      : `A sequence diagram between ${listed(who)}.`;
  }
  const labels = [
    ...new Set(
      [
        ...source.matchAll(/\w+\s*(?:\[\(?|\{|\(\(?)"?([^\]})"]+)"?[\]})]/g),
      ].map((m) => clean(m[1] ?? '')),
    ),
  ].filter((l) => l !== '');
  if (labels.length === 0) return `A ${kind}.`;
  const shown =
    labels.length <= 5
      ? `: ${listed(labels)}`
      : `, from ${labels[0]} to ${labels[labels.length - 1]}`;
  return ended(`A ${kind} of ${plural(labels.length, 'step')}${shown}`);
};

interface SceneElement {
  readonly type?: string;
  readonly text?: string;
  readonly isDeleted?: boolean;
  // The skeleton form the CLI stores: a shape's label rides on the shape.
  readonly label?: { readonly text?: string };
}

/** A drawing: its boxes, their labels, and its arrows. */
export const describeDrawing = (scene: string | undefined): string => {
  if (scene === undefined) return 'A drawing.';
  let elements: ReadonlyArray<SceneElement>;
  try {
    const parsed = JSON.parse(scene) as { elements?: SceneElement[] };
    elements = (parsed.elements ?? []).filter((e) => e.isDeleted !== true);
  } catch {
    return 'A drawing.';
  }
  const shapes = elements.filter((e) =>
    ['rectangle', 'ellipse', 'diamond'].includes(e.type ?? ''),
  ).length;
  const arrows = elements.filter((e) => e.type === 'arrow').length;
  const texts = elements
    .map((e) =>
      clean(e.type === 'text' ? (e.text ?? '') : (e.label?.text ?? '')),
    )
    .filter((t) => t !== '');
  const labelled =
    texts.length > 0 && texts.length <= 6
      ? `, labelled ${listed(texts)}`
      : texts.length > 6
        ? `, among them ${listed(texts.slice(0, 4))}`
        : '';
  const joined = arrows > 0 ? `, joined by ${plural(arrows, 'arrow')}` : '';
  return ended(
    `A drawing of ${plural(shapes, 'box', 'boxes')}${labelled}${joined}`,
  );
};

const describeImage = (el: Element) => {
  const alt = clean(el.getAttribute('alt') ?? '');
  return alt === '' ? 'An image.' : `An image: ${alt}.`;
};

const describe = (u: DescribedUnit) =>
  u.what === 'table'
    ? describeTable(u.el)
    : u.what === 'code'
      ? describeCode(u.el)
      : describeImage(u.el);

// --- the script --------------------------------------------------------------------

/** FNV-1a, enough to tell one script from another on the page. */
const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

export interface ScriptSource {
  readonly title: string;
  readonly bodyHtml: string;
  readonly bodyParts?: ReadonlyArray<QuestionBodyPartDto> | undefined;
  readonly drawings?:
    | Readonly<Record<string, { readonly scene: string }>>
    | undefined;
}

const parseHtml = (html: string): Element => {
  const doc = new DOMParser().parseFromString(
    `<div>${html}</div>`,
    'text/html',
  );
  return doc.body.firstElementChild ?? doc.createElement('div');
};

/** The speech script of a Question, from the HTML the page draws its body with. */
export const scriptOf = (q: ScriptSource): Script => {
  const segments: Segment[] = [];
  const title = clean(q.title);
  if (title !== '')
    segments.push({
      id: 'title',
      kind: 'title',
      text: title,
      pauseAfter: PAUSE_APART,
    });
  const parts: ReadonlyArray<QuestionBodyPartDto> = q.bodyParts ?? [
    { kind: 'html', html: q.bodyHtml },
  ];
  parts.forEach((part, p) => {
    if (part.kind === 'mermaid') {
      segments.push({
        id: `p${p}`,
        kind: 'described',
        part: p,
        what: 'diagram',
        text: describeMermaid(part.source),
        pauseAfter: PAUSE_APART,
      });
      return;
    }
    if (part.kind === 'excalidraw') {
      segments.push({
        id: `p${p}`,
        kind: 'described',
        part: p,
        what: 'drawing',
        text: describeDrawing(q.drawings?.[part.id]?.scene),
        pauseAfter: PAUSE_APART,
      });
      return;
    }
    if (part.kind === 'html-block') {
      // An HTML block runs; nothing in it can be read out, so it is named.
      segments.push({
        id: `p${p}`,
        kind: 'described',
        part: p,
        what: 'diagram',
        text: `An interactive block, ${part.id}.`,
        pauseAfter: PAUSE_APART,
      });
      return;
    }
    unitsOf(parseHtml(part.html)).forEach((u, i) => {
      const text =
        u.kind === 'described' ? describe(u) : spokenOf(u.nodes).text;
      if (text === '') return;
      segments.push(
        u.kind === 'described'
          ? {
              id: `p${p}u${i}`,
              kind: 'described',
              part: p,
              unit: i,
              what: u.what,
              text,
              pauseAfter: PAUSE_APART,
            }
          : {
              id: `p${p}u${i}`,
              kind: 'read',
              part: p,
              unit: i,
              text,
              pauseAfter: PAUSE_READ,
            },
      );
    });
  });
  return {
    segments,
    key: fnv(JSON.stringify(segments.map((s) => [s.id, s.text, s.pauseAfter]))),
  };
};
