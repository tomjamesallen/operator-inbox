import { Data, Result } from 'effect';

// The templates a `json` widget maps its command's output through: logic-less
// and Mustache-style, and they make plain text, never HTML, so nothing they
// print needs escaping beyond what any text does.
//
//   {{a.b}}          the value at a dotted path; array indexes too ({{list.0.name}})
//   {{.}}            the current item, inside a section
//   {{#a}}…{{/a}}    a list: once per item; anything else truthy: once, with an
//                    object pushed as the scope; falsy, empty or missing: never
//   {{^a}}…{{/a}}    once when a is falsy, empty or missing: with {{#a}}, an if/else
//
// A path missing where a value prints is an error naming it, so a renamed
// field shows as the widget's error rather than as a blank; so is an object or
// a list printed as a value. A path missing in a section is falsy, so an
// optional field needs no guard.
//
// A tone comes from the data with no logic in a template: a dotted path, then
// either a map of its values to tones, or number thresholds, the highest one
// the value is at or above winning.
//
// BROWSER-SAFE and pure: it imports only `effect`.

/** Why a template could not be parsed, or could not be filled from the data. */
export class TemplateError extends Data.TaggedError('TemplateError')<{
  readonly message: string;
}> {}

/** The tones a widget's output may take. */
export const WIDGET_TONES = ['ok', 'warn', 'bad', 'info', 'muted'] as const;
export type WidgetTone = (typeof WIDGET_TONES)[number];

/**
 * Where a widget's tone comes from: the value at `from`, looked up in `map`,
 * or compared with the thresholds of `above` (each key a number).
 */
export type WidgetToneRule =
  | {
      readonly from: string;
      readonly map: Readonly<Record<string, WidgetTone>>;
    }
  | {
      readonly from: string;
      readonly above: Readonly<Record<string, WidgetTone>>;
    };

type Node =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'value'; readonly path: string }
  | {
      readonly kind: 'section';
      readonly path: string;
      readonly inverted: boolean;
      readonly body: ReadonlyArray<Node>;
    };

const TAG = /\{\{\s*([#^/]?)\s*([^}\s]+)\s*\}\}/g;

// The parse and the fill throw a TemplateError internally and the exported
// functions catch it into a Result, so a caller never meets a throw.
const fail = (message: string): never => {
  throw new TemplateError({ message });
};

const opener = (section: { inverted: boolean; path: string }): string =>
  `{{${section.inverted ? '^' : '#'}${section.path}}}`;

const parse = (template: string): ReadonlyArray<Node> => {
  const root: Array<Node> = [];
  const open: Array<{ path: string; inverted: boolean; body: Array<Node> }> =
    [];
  const into = () => open.at(-1)?.body ?? root;
  let at = 0;
  for (const m of template.matchAll(TAG)) {
    if (m.index > at)
      into().push({ kind: 'text', text: template.slice(at, m.index) });
    const [, sigil, path = ''] = m;
    if (sigil === '#' || sigil === '^')
      open.push({ path, inverted: sigil === '^', body: [] });
    else if (sigil === '/') {
      const closed = open.pop();
      if (closed === undefined) return fail(`{{/${path}}} closes nothing open`);
      if (closed.path !== path)
        return fail(`{{/${path}}} closes ${opener(closed)}`);
      into().push({ kind: 'section', ...closed });
    } else into().push({ kind: 'value', path });
    at = m.index + m[0].length;
  }
  const unclosed = open.at(-1);
  if (unclosed !== undefined)
    return fail(`${opener(unclosed)} is never closed`);
  if (at < template.length)
    into().push({ kind: 'text', text: template.slice(at) });
  return root;
};

const MISSING = Symbol('missing');

// Own keys only, so a path never reaches what every object inherits
// (`constructor`, `__proto__`); an array's `length` is its own.
const walk = (from: unknown, path: string): unknown => {
  if (path === '.') return from;
  let v: unknown = from;
  for (const key of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key))
      return MISSING;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
};

// Innermost scope first, so a section's item shadows the data around it.
const lookup = (scopes: ReadonlyArray<unknown>, path: string): unknown => {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const v = walk(scopes[i], path);
    if (v !== MISSING) return v;
  }
  return MISSING;
};

const truthy = (v: unknown): boolean =>
  v !== MISSING &&
  v !== null &&
  v !== undefined &&
  v !== false &&
  v !== '' &&
  v !== 0 &&
  !(Array.isArray(v) && v.length === 0);

const fill = (
  nodes: ReadonlyArray<Node>,
  scopes: ReadonlyArray<unknown>,
): string =>
  nodes
    .map((n) => {
      if (n.kind === 'text') return n.text;
      const v = lookup(scopes, n.path);
      if (n.kind === 'value') {
        if (v === MISSING) return fail(`no value at ${n.path}`);
        if (v !== null && typeof v === 'object')
          return fail(`${n.path} is a list or an object, not a value`);
        return String(v ?? '');
      }
      if (n.inverted) return truthy(v) ? '' : fill(n.body, scopes);
      if (!truthy(v)) return '';
      if (Array.isArray(v))
        return v.map((item) => fill(n.body, [...scopes, item])).join('');
      return fill(n.body, typeof v === 'object' ? [...scopes, v] : scopes);
    })
    .join('');

const attempt = <A>(f: () => A): Result.Result<A, TemplateError> => {
  try {
    return Result.succeed(f());
  } catch (cause) {
    if (cause instanceof TemplateError) return Result.fail(cause);
    throw cause;
  }
};

/**
 * Whether a template parses: every section closed, and closed by its own
 * name. The config's decode runs it, so a broken template is a config problem
 * rather than a failed run.
 */
export const checkTemplate = (
  template: string,
): Result.Result<void, TemplateError> =>
  attempt(() => {
    parse(template);
  });

/** A template filled from the data, as plain text, or why it could not be. */
export const render = (
  template: string,
  data: unknown,
): Result.Result<string, TemplateError> =>
  attempt(() => fill(parse(template), [data]));

/**
 * The tone a rule gives the data: `map`'s tone for the value (none when the
 * map has no entry for it), or `above`'s, the highest threshold the value is
 * at or above, `ok` when it meets none. A missing path, or a value `above`
 * cannot compare, is an error naming it.
 */
export const toneOf = (
  rule: WidgetToneRule,
  data: unknown,
): Result.Result<WidgetTone | undefined, TemplateError> =>
  attempt(() => {
    const v = walk(data, rule.from);
    if (v === MISSING) return fail(`no value at ${rule.from} for the tone`);
    if ('map' in rule)
      return Object.hasOwn(rule.map, String(v))
        ? rule.map[String(v)]
        : undefined;
    if (typeof v !== 'number' || !Number.isFinite(v))
      return fail(`${rule.from} is not a number, so above cannot compare it`);
    let best: { readonly at: number; readonly tone: WidgetTone } | undefined;
    for (const [at, tone] of Object.entries(rule.above)) {
      const threshold = Number(at);
      if (v >= threshold && (best === undefined || threshold > best.at))
        best = { at: threshold, tone };
    }
    return best?.tone ?? 'ok';
  });
