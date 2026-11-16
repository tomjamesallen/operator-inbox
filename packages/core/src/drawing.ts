import { Result } from 'effect';

// Drawings in a Question: Excalidraw scenes the agent puts beside a body,
// which names each with an `<Excalidraw id="…"/>` line of its own. A scene is
// held as JSON text, never decoded into the event, because a scene has nulls
// and arrays of arrays that metadata refuses, and the server never needs to
// look inside it beyond the checks here.
//
// Three forms come in, and this module tells them apart (`drawingFormat`):
// - the compact form, one element per line, which agents write (it is short,
//   and a script lays it out: `compactToScene`);
// - Excalidraw's skeleton form, `{type, id, x, y, width, height, label}`
//   with arrows bound by `start`/`end` ids, which the page fills out with
//   Excalidraw's own `convertToExcalidrawElements`, keeping the ids;
// - a full scene, every element with its `version`, as Excalidraw saves it
//   and as the operator's edit comes back.
//
// And one form goes out to an agent reading a drawing back: the summary
// (`summariseScene`), one line per element, about a twentieth of the scene's
// size.
//
// BROWSER-SAFE and pure: `effect` only, no clock, no platform.

/** A drawing's id: the `id` of its tag in the body. */
export const DRAWING_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The most bytes one scene may take, as UTF-8 JSON text. */
export const DRAWING_MAX_BYTES = 200 * 1024;

/** The most drawings one Question may carry. */
export const DRAWINGS_MAX = 8;

// --- what an element looks like, as far as this module reads it -------------------

interface Binding {
  readonly elementId?: string;
}

interface SceneElement {
  readonly id?: string;
  readonly type?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly points?: ReadonlyArray<ReadonlyArray<number>>;
  readonly isDeleted?: boolean;
  readonly text?: string;
  readonly originalText?: string;
  readonly fontSize?: number;
  readonly containerId?: string | null;
  readonly startBinding?: Binding | null;
  readonly endBinding?: Binding | null;
  readonly backgroundColor?: string;
  readonly strokeStyle?: string;
  readonly roundness?: unknown;
  readonly version?: number;
  // The skeleton form's.
  readonly label?: { readonly text?: string; readonly fontSize?: number };
  readonly start?: { readonly id?: string };
  readonly end?: { readonly id?: string };
}

interface SceneShape {
  readonly elements: ReadonlyArray<SceneElement>;
  readonly files?: unknown;
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const sceneOf = (parsed: unknown): SceneShape | undefined => {
  if (Array.isArray(parsed)) return { elements: parsed as never };
  if (isRecord(parsed) && Array.isArray(parsed.elements))
    return parsed as unknown as SceneShape;
  return undefined;
};

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

// --- the forms ---------------------------------------------------------------------

export type DrawingFormat = 'compact' | 'skeleton' | 'scene';

/**
 * Which form a drawing file is in: JSON whose every element has a `version`
 * is a full scene, other JSON with elements (or a bare array of them) is a
 * skeleton, and anything that is not JSON is the compact form.
 */
export const drawingFormat = (text: string): DrawingFormat => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'compact';
  const scene = sceneOf(parseJson(trimmed));
  if (scene === undefined) return 'compact';
  return scene.elements.length > 0 &&
    scene.elements.every((e) => isRecord(e) && typeof e.version === 'number')
    ? 'scene'
    : 'skeleton';
};

/**
 * A scene as the Question or the answer stores it, or why it cannot be one:
 * JSON with an `elements` array of elements that each have a `type`, no
 * images, no `files`, and no more than `DRAWING_MAX_BYTES`. A bare array of
 * elements is wrapped as a scene. The text kept is the JSON as given, in one
 * line.
 */
export const checkScene = (
  id: string,
  text: string,
): Result.Result<string, string> => {
  if (!DRAWING_ID.test(id))
    return Result.fail(
      `a drawing's id is lower-case letters, digits and hyphens, starting with a letter or digit, at most 40 characters; got "${id}"`,
    );
  const parsed = parseJson(text);
  const scene = sceneOf(parsed);
  if (scene === undefined)
    return Result.fail(
      `drawing "${id}" is not an Excalidraw scene: JSON with an "elements" array`,
    );
  if (
    scene.files !== undefined &&
    scene.files !== null &&
    !(isRecord(scene.files) && Object.keys(scene.files).length === 0)
  )
    return Result.fail(
      `drawing "${id}" carries files; images are not allowed in a drawing`,
    );
  for (const e of scene.elements) {
    if (!isRecord(e) || typeof e.type !== 'string')
      return Result.fail(
        `drawing "${id}" has an element with no "type"; every element needs one`,
      );
    if (e.type === 'image')
      return Result.fail(
        `drawing "${id}" has an image element; images are not allowed in a drawing`,
      );
  }
  const kept = JSON.stringify(
    Array.isArray(parsed)
      ? { type: 'excalidraw', version: 2, elements: parsed }
      : parsed,
  );
  const bytes = utf8Bytes(kept);
  if (bytes > DRAWING_MAX_BYTES)
    return Result.fail(
      `drawing "${id}" is ${Math.ceil(bytes / 1024)} KiB; a drawing may be at most ${DRAWING_MAX_BYTES / 1024} KiB`,
    );
  return Result.succeed(kept);
};

/**
 * Every drawing of a set checked (`checkScene`), and the set no larger than
 * `DRAWINGS_MAX`: the set as kept, or the first reason it cannot be.
 */
export const checkDrawings = (
  drawings: Readonly<Record<string, string>>,
): Result.Result<Readonly<Record<string, string>>, string> => {
  const ids = Object.keys(drawings);
  if (ids.length > DRAWINGS_MAX)
    return Result.fail(
      `a question may carry at most ${DRAWINGS_MAX} drawings; this one would have ${ids.length}`,
    );
  const out: Record<string, string> = {};
  for (const id of ids.sort()) {
    const checked = checkScene(id, drawings[id] ?? '');
    if (Result.isFailure(checked)) return Result.fail(checked.failure);
    out[id] = checked.success;
  }
  return Result.succeed(out);
};

/** The number of elements a scene draws: its live ones, deleted left out. */
export const sceneElementCount = (text: string): number =>
  (sceneOf(parseJson(text))?.elements ?? []).filter(
    (e) => isRecord(e) && e.isDeleted !== true,
  ).length;

// --- the compact form --------------------------------------------------------------
//
//   rect    <id> <x> <y> <w> <h> ["label"] [options]
//   ellipse <id> <x> <y> <w> <h> ["label"] [options]
//   diamond <id> <x> <y> <w> <h> ["label"] [options]
//   text    <id> <x> <y> "text" [size=N]
//   arrow   <id> <fromId> -> <toId> ["label"] [dashed]
//   line    <id> <x1> <y1> <x2> <y2> [dashed]
//
// Options: fill=#hex, dashed, dotted, rounded, size=N (a label's font size,
// default 16), align=left. `#` starts a comment line. `\n` in a label breaks
// it. A shape grows taller when its label needs the room. An arrow is drawn
// straight, edge to edge.

const FLAGS = new Set(['dashed', 'dotted', 'rounded', 'bold']);
const KINDS = new Set(['rect', 'ellipse', 'diamond', 'text', 'arrow', 'line']);

type Token = string | { readonly quoted: string };

const tokenise = (line: string): ReadonlyArray<Token> => {
  const out: Array<Token> = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line))
    out.push(
      m[1] === undefined
        ? (m[2] ?? '')
        : { quoted: m[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') },
    );
  return out;
};

interface Box {
  readonly kind: 'rect' | 'ellipse' | 'diamond';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// Where the segment from a box's centre towards `p` leaves the box.
const edgePoint = (b: Box, p: { x: number; y: number }) => {
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t =
    b.kind === 'ellipse'
      ? 1 / Math.sqrt((dx * dx) / (b.w / 2) ** 2 + (dy * dy) / (b.h / 2) ** 2)
      : b.kind === 'diamond'
        ? 1 / (Math.abs(dx) / (b.w / 2) + Math.abs(dy) / (b.h / 2))
        : Math.min(
            dx === 0 ? Number.POSITIVE_INFINITY : b.w / 2 / Math.abs(dx),
            dy === 0 ? Number.POSITIVE_INFINITY : b.h / 2 / Math.abs(dy),
          );
  return { x: c.x + dx * t, y: c.y + dy * t };
};

// Text in Excalidraw's hand-drawn face runs about 0.6 × its size wide per
// character and 1.25 × its size tall per line: near enough to size a box
// before the page measures it.
const CHAR_WIDTH = 0.6;
const LINE_HEIGHT = 1.25;

const textBox = (text: string, size: number) => {
  const lines = text.split('\n');
  return {
    width: Math.max(...lines.map((l) => l.length)) * size * CHAR_WIDTH,
    height: lines.length * size * LINE_HEIGHT,
  };
};

// How tall a shape must be for its label, wrapped to its width, with the
// room an ellipse or a diamond loses to its curve.
const labelHeight = (box: Box, text: string, size: number): number => {
  const perLine = Math.max(1, Math.floor((box.w - 10) / (size * CHAR_WIDTH)));
  const lines = text
    .split('\n')
    .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const factor = box.kind === 'rect' ? 1 : box.kind === 'ellipse' ? 1.42 : 2;
  return lines * size * LINE_HEIGHT * factor + 10;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The compact form as an Excalidraw scene in skeleton form, or every line it
 * could not read. Deterministic: the same text gives the same scene, ids as
 * written.
 */
export const compactToScene = (
  source: string,
): Result.Result<string, ReadonlyArray<string>> => {
  const errors: Array<string> = [];
  const elements: Array<Record<string, unknown>> = [];
  const boxes = new Map<string, Box>();
  const arrows: Array<{
    line: number;
    id: string;
    from: string;
    to: string;
    label: string | undefined;
    stroke: string;
  }> = [];
  const ids = new Set<string>();
  source.split('\n').forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const tokens = tokenise(line);
    const kind = tokens[0];
    const flags: Record<string, string | true> = {};
    let label: string | undefined;
    const plain: Array<string> = [];
    for (const t of tokens.slice(1)) {
      if (typeof t !== 'string') label = t.quoted;
      else if (t.includes('=')) {
        const at = t.indexOf('=');
        flags[t.slice(0, at)] = t.slice(at + 1);
      } else if (FLAGS.has(t)) flags[t] = true;
      else plain.push(t);
    }
    const stroke =
      flags.dashed === true
        ? 'dashed'
        : flags.dotted === true
          ? 'dotted'
          : 'solid';
    const size = Number(flags.size ?? 16);
    const id = plain[0];
    if (typeof kind !== 'string') return;
    if (!KINDS.has(kind)) {
      errors.push(
        `line ${n}: "${kind}" is not rect, ellipse, diamond, text, arrow or line`,
      );
      return;
    }
    if (id === undefined) {
      errors.push(`line ${n}: ${kind} needs an id`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`line ${n}: the id "${id}" is used twice`);
      return;
    }
    ids.add(id);
    if (!Number.isFinite(size) || size <= 0) {
      errors.push(`line ${n}: size is a positive number`);
      return;
    }
    const numbers = (from: number, count: number) => {
      const got = plain.slice(from, from + count).map(Number);
      return got.length === count && got.every(Number.isFinite)
        ? got
        : undefined;
    };
    switch (kind) {
      case 'rect':
      case 'ellipse':
      case 'diamond': {
        const v = numbers(1, 4);
        if (v === undefined) {
          errors.push(`line ${n}: ${kind} needs <id> <x> <y> <w> <h>`);
          return;
        }
        const [x = 0, y = 0, w = 0, h0 = 0] = v;
        const box0: Box = { kind, x, y, w, h: h0 };
        const h =
          label === undefined
            ? h0
            : Math.max(h0, round2(labelHeight(box0, label, size)));
        boxes.set(id, { ...box0, h });
        elements.push({
          type: kind === 'rect' ? 'rectangle' : kind,
          id,
          x,
          y,
          width: w,
          height: h,
          strokeStyle: stroke,
          ...(typeof flags.fill === 'string'
            ? { backgroundColor: flags.fill, fillStyle: 'solid' }
            : {}),
          ...(flags.rounded === true ? { roundness: { type: 3 } } : {}),
          ...(label === undefined
            ? {}
            : {
                label: {
                  text: label,
                  fontSize: size,
                  ...(typeof flags.align === 'string'
                    ? { textAlign: flags.align }
                    : {}),
                },
              }),
        });
        return;
      }
      case 'text': {
        const v = numbers(1, 2);
        if (v === undefined || label === undefined) {
          errors.push(`line ${n}: text needs <id> <x> <y> "text"`);
          return;
        }
        const [x = 0, y = 0] = v;
        elements.push({ type: 'text', id, x, y, text: label, fontSize: size });
        return;
      }
      case 'arrow': {
        const [, from, arrow, to] = plain;
        if (from === undefined || arrow !== '->' || to === undefined) {
          errors.push(`line ${n}: arrow needs <id> <fromId> -> <toId>`);
          return;
        }
        arrows.push({ line: n, id, from, to, label, stroke });
        return;
      }
      case 'line': {
        const v = numbers(1, 4);
        if (v === undefined) {
          errors.push(`line ${n}: line needs <id> <x1> <y1> <x2> <y2>`);
          return;
        }
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = v;
        elements.push({
          type: 'line',
          id,
          x: x1,
          y: y1,
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          points: [
            [0, 0],
            [x2 - x1, y2 - y1],
          ],
          strokeStyle: stroke,
        });
        return;
      }
      default:
        errors.push(
          `line ${n}: "${kind}" is not rect, ellipse, diamond, text, arrow or line`,
        );
    }
  });
  // Arrows last, so an arrow may name a shape written after it.
  for (const a of arrows) {
    const from = boxes.get(a.from);
    const to = boxes.get(a.to);
    if (from === undefined || to === undefined) {
      errors.push(
        `line ${a.line}: arrow ${a.id} joins "${from === undefined ? a.from : a.to}", which is not a rect, ellipse or diamond here`,
      );
      continue;
    }
    const p1 = edgePoint(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 });
    const p2 = edgePoint(to, {
      x: from.x + from.w / 2,
      y: from.y + from.h / 2,
    });
    const dx = round2(p2.x - p1.x);
    const dy = round2(p2.y - p1.y);
    elements.push({
      type: 'arrow',
      id: a.id,
      x: round2(p1.x),
      y: round2(p1.y),
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [
        [0, 0],
        [dx, dy],
      ],
      strokeStyle: a.stroke,
      start: { id: a.from },
      end: { id: a.to },
      ...(a.label === undefined
        ? {}
        : { label: { text: a.label, fontSize: 14 } }),
    });
  }
  if (errors.length > 0) return Result.fail(errors);
  if (elements.length === 0)
    return Result.fail(['the drawing has no elements']);
  return Result.succeed(
    JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'operator-inbox',
      elements,
      appState: {},
    }),
  );
};

/**
 * A drawing file as a scene: the compact form converted, a skeleton or a full
 * scene as it is. Then `checkScene` decides whether it may be kept.
 */
export const drawingFileToScene = (
  text: string,
): Result.Result<string, ReadonlyArray<string>> =>
  drawingFormat(text) === 'compact'
    ? compactToScene(text)
    : Result.succeed(text.trim());

// --- the box a drawing takes ------------------------------------------------------

/** The padding Excalidraw's export puts round a drawing, in scene units. */
export const DRAWING_EXPORT_PADDING = 12;

const live = (scene: SceneShape): ReadonlyArray<SceneElement> =>
  scene.elements.filter((e) => isRecord(e) && e.isDeleted !== true);

const boundsOf = (e: SceneElement) => {
  const x = e.x ?? 0;
  const y = e.y ?? 0;
  if (Array.isArray(e.points) && e.points.length > 0) {
    const xs = e.points.map((p) => x + (p[0] ?? 0));
    const ys = e.points.map((p) => y + (p[1] ?? 0));
    return {
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys),
    };
  }
  const est =
    e.type === 'text' && (e.width === undefined || e.height === undefined)
      ? textBox(e.text ?? '', e.fontSize ?? 20)
      : { width: e.width ?? 0, height: e.height ?? 0 };
  return { x1: x, y1: y, x2: x + est.width, y2: y + est.height };
};

/**
 * The box a drawing's picture takes, in scene units, with the export's
 * padding round it: read from the elements' own positions and sizes, so the
 * page can reserve it before Excalidraw has loaded. Undefined for a scene
 * with nothing to draw, or text that is not one.
 */
export const drawingBox = (
  text: string,
): { readonly width: number; readonly height: number } | undefined => {
  const scene = sceneOf(parseJson(text));
  if (scene === undefined) return undefined;
  const els = live(scene);
  if (els.length === 0) return undefined;
  const all = els.map(boundsOf);
  const width =
    Math.max(...all.map((b) => b.x2)) - Math.min(...all.map((b) => b.x1));
  const height =
    Math.max(...all.map((b) => b.y2)) - Math.min(...all.map((b) => b.y1));
  return {
    width: width + 2 * DRAWING_EXPORT_PADDING,
    height: height + 2 * DRAWING_EXPORT_PADDING,
  };
};

// --- the summary an agent reads back ------------------------------------------------

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond', 'frame']);
const r = (n: number | undefined) => Math.round(n ?? 0);
const q = (s: string) => JSON.stringify(s.replace(/\n/g, ' '));

/**
 * A scene as one line per element, for an agent to read: shapes nested in
 * the shapes that hold them, each with its label, position, size and style;
 * free text; lines; then the arrows, by what they join. Bound text is folded
 * into its container, deleted elements are dropped. Reads a skeleton (labels
 * and `start`/`end` on the element) as well as a full scene. Deterministic:
 * the same scene gives the same text.
 */
export const summariseScene = (text: string): string => {
  const scene = sceneOf(parseJson(text));
  if (scene === undefined) return 'not a scene\n';
  const els = live(scene);
  const byId = new Map(els.map((e) => [e.id ?? '', e]));
  // An agent's ids are short and read as they are; Excalidraw's own are long
  // and random, so they are cut to the shortest prefix that stays unique.
  const short = new Map<string, string>();
  const taken = new Set<string>();
  for (const e of els) {
    const id = e.id ?? '';
    let s = id;
    if (id.length > 16) {
      let n = 6;
      while (n < id.length && taken.has(id.slice(0, n))) n += 1;
      s = id.slice(0, n);
    }
    taken.add(s);
    short.set(id, s);
  }
  const ref = (e: SceneElement) => `[${short.get(e.id ?? '') ?? ''}]`;
  const labelOf = (e: SceneElement): string | undefined => {
    if (e.label?.text !== undefined) return e.label.text;
    const t = els.find((x) => x.type === 'text' && x.containerId === e.id);
    return t === undefined ? undefined : (t.originalText ?? t.text);
  };
  const nodes = els.filter(
    (e) =>
      SHAPES.has(e.type ?? '') ||
      (e.type === 'text' && (e.containerId ?? null) === null) ||
      e.type === 'line',
  );
  const boxOf = (e: SceneElement) =>
    e.type === 'line'
      ? { x1: e.x ?? 0, y1: e.y ?? 0, x2: e.x ?? 0, y2: e.y ?? 0 }
      : boundsOf(e);
  const area = (e: SceneElement) => (e.width ?? 0) * (e.height ?? 0);
  const within = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
    b.x1 >= a.x1 - 1 &&
    b.y1 >= a.y1 - 1 &&
    b.x2 <= a.x2 + 1 &&
    b.y2 <= a.y2 + 1;
  const parent = new Map<SceneElement, SceneElement>();
  for (const n of nodes) {
    const nb = boxOf(n);
    const holders = nodes
      .filter(
        (h) =>
          h !== n &&
          SHAPES.has(h.type ?? '') &&
          h.type !== 'diamond' &&
          within(boxOf(h), nb) &&
          !(within(nb, boxOf(h)) && area(h) <= area(n)),
      )
      .sort((a, b) => area(a) - area(b));
    const holder = holders[0];
    if (holder !== undefined) parent.set(n, holder);
  }
  const style = (e: SceneElement) => {
    const s: Array<string> = [];
    if (e.backgroundColor !== undefined && e.backgroundColor !== 'transparent')
      s.push(`fill ${e.backgroundColor}`);
    if (e.strokeStyle !== undefined && e.strokeStyle !== 'solid')
      s.push(e.strokeStyle);
    if (
      e.roundness !== undefined &&
      e.roundness !== null &&
      SHAPES.has(e.type ?? '')
    )
      s.push('rounded');
    return s.length > 0 ? ` (${s.join(', ')})` : '';
  };
  const lineOf = (e: SceneElement) => {
    if (e.type === 'text')
      return `text ${q(e.originalText ?? e.text ?? '')} ${ref(e)} at ${r(e.x)},${r(e.y)} size ${e.fontSize ?? 20}`;
    if (e.type === 'line') {
      const end = e.points?.at(-1) ?? [0, 0];
      return `line ${ref(e)} ${r(e.x)},${r(e.y)} to ${r((e.x ?? 0) + (end[0] ?? 0))},${r((e.y ?? 0) + (end[1] ?? 0))}${style(e)}`;
    }
    const name = e.type === 'rectangle' ? 'box' : (e.type ?? 'shape');
    const l = labelOf(e);
    return `${name}${l === undefined ? '' : ` ${q(l)}`} ${ref(e)} at ${r(e.x)},${r(e.y)} size ${r(e.width)}×${r(e.height)}${style(e)}`;
  };
  const order = (a: SceneElement, b: SceneElement) =>
    (a.y ?? 0) - (b.y ?? 0) ||
    (a.x ?? 0) - (b.x ?? 0) ||
    (a.id ?? '').localeCompare(b.id ?? '');
  const out: Array<string> = [];
  const walk = (holder: SceneElement | undefined, depth: number) => {
    for (const n of nodes.filter((x) => parent.get(x) === holder).sort(order)) {
      out.push(`${'  '.repeat(depth)}- ${lineOf(n)}`);
      walk(n, depth + 1);
    }
  };
  walk(undefined, 0);
  const nameOf = (id: string | undefined) => {
    const e = id === undefined ? undefined : byId.get(id);
    if (e === undefined) return '(nothing)';
    const l = labelOf(e) ?? (e.type === 'text' ? e.text : undefined);
    return l === undefined ? ref(e) : q(l);
  };
  const arrows = els.filter((e) => e.type === 'arrow').sort(order);
  if (arrows.length > 0) {
    out.push('arrows:');
    for (const a of arrows) {
      const l = labelOf(a);
      const end = a.points?.at(-1) ?? [a.width ?? 0, a.height ?? 0];
      const where = `${r(a.x)},${r(a.y)} to ${r((a.x ?? 0) + (end[0] ?? 0))},${r((a.y ?? 0) + (end[1] ?? 0))}`;
      out.push(
        `- ${nameOf(a.startBinding?.elementId ?? a.start?.id)} → ${nameOf(a.endBinding?.elementId ?? a.end?.id)}${l === undefined ? '' : ` labelled ${q(l)}`} ${ref(a)} ${where}${style(a)}`,
      );
    }
  }
  if (els.length === 0) return 'scene: 0 elements\n';
  const all = els.map(boundsOf);
  const span = `${r(Math.min(...all.map((b) => b.x1)))},${r(Math.min(...all.map((b) => b.y1)))} to ${r(Math.max(...all.map((b) => b.x2)))},${r(Math.max(...all.map((b) => b.y2)))}`;
  return `scene: ${els.length} elements, spanning ${span} (x right, y down; positions are top-left corners)\n${out.join('\n')}\n`;
};

// --- ids through a duplicate --------------------------------------------------------
//
// Excalidraw duplicates a selection in three ways. ⌘D and copy-and-paste
// leave the original where it was and give the copy a new id. Alt-drag does
// the opposite: the original element is the one dragged away, and a clone
// with a new id is left where it stood, with any arrow bound to the
// original moved onto the clone. An agent reads the drawing back by the ids
// it wrote, so after an Alt-drag its box seems to have moved, and a stranger
// sits in its place. `keepIdsThroughDuplicates` gives the ids back to the
// shapes that stayed.

// How far apart, in scene units, two positions or sizes may be and still be
// the same: a scene laid out again rounds a little.
const NEAR = 1;

const near = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= NEAR;

type RawElement = Record<string, unknown>;

const idOf = (e: RawElement): string | undefined =>
  typeof e.id === 'string' ? e.id : undefined;

const containerOf = (e: RawElement): string | undefined =>
  typeof e.containerId === 'string' ? e.containerId : undefined;

const isLive = (e: RawElement): boolean => e.isDeleted !== true;

// The text bound inside `e`: a full scene's, which names its container.
const boundTextIn = (
  els: ReadonlyArray<RawElement>,
  e: RawElement,
): RawElement | undefined =>
  els.find(
    (x) =>
      x.type === 'text' &&
      isLive(x) &&
      containerOf(x) !== undefined &&
      containerOf(x) === idOf(e),
  );

const textOf = (e: RawElement): string | undefined =>
  typeof e.originalText === 'string'
    ? e.originalText
    : typeof e.text === 'string'
      ? e.text
      : undefined;

// What an element reads as: a skeleton's label, its bound text, or a text
// element's own text.
const wordsOf = (
  els: ReadonlyArray<RawElement>,
  e: RawElement,
): string | undefined => {
  const label = e.label;
  if (isRecord(label) && typeof label.text === 'string') return label.text;
  if (e.type === 'text') return textOf(e);
  const bound = boundTextIn(els, e);
  return bound === undefined ? undefined : textOf(bound);
};

// The style an element carries, and what Excalidraw fills in for the few a
// skeleton leaves out (the ones the compact form sets). A key the earlier
// element does not carry, and has no stand-in for, is not compared.
const STYLE_KEYS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'roundness',
  'fontSize',
  'fontFamily',
  'textAlign',
] as const;
const STYLE_STAND_INS: Readonly<Record<string, unknown>> = {
  backgroundColor: 'transparent',
  strokeStyle: 'solid',
  roundness: null,
};

const sameStyle = (before: RawElement, after: RawElement): boolean =>
  STYLE_KEYS.every((key) => {
    const was = before[key] ?? STYLE_STAND_INS[key];
    if (was === undefined) return true;
    const now = after[key] ?? STYLE_STAND_INS[key];
    return JSON.stringify(was) === JSON.stringify(now);
  });

// Whether `after` stands where `before` stood, the same size: a size the
// earlier element leaves out (a skeleton's text) is not compared.
const samePlace = (before: RawElement, after: RawElement): boolean =>
  near(before.x, after.x) &&
  near(before.y, after.y) &&
  (before.width === undefined || near(before.width, after.width)) &&
  (before.height === undefined || near(before.height, after.height));

// Renames: each id to the one it swaps with, both ways.
const addSwap = (map: Map<string, string>, a: string, b: string): boolean => {
  if (a === b) return true;
  const known = map.get(a) ?? map.get(b);
  if (known !== undefined) return map.get(a) === b;
  map.set(a, b);
  map.set(b, a);
  return true;
};

const renamed = (
  e: RawElement,
  ids: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, string>,
): RawElement => {
  const id = (v: unknown) =>
    typeof v === 'string' ? (ids.get(v) ?? v) : (v as never);
  const binding = (v: unknown) =>
    isRecord(v) && typeof v.elementId === 'string'
      ? { ...v, elementId: id(v.elementId) }
      : v;
  return {
    ...e,
    ...(e.id === undefined ? {} : { id: id(e.id) }),
    ...(typeof e.containerId === 'string'
      ? { containerId: id(e.containerId) }
      : {}),
    ...(typeof e.frameId === 'string' ? { frameId: id(e.frameId) } : {}),
    ...(e.startBinding === undefined
      ? {}
      : { startBinding: binding(e.startBinding) }),
    ...(e.endBinding === undefined
      ? {}
      : { endBinding: binding(e.endBinding) }),
    ...(Array.isArray(e.boundElements)
      ? {
          boundElements: e.boundElements.map((b: unknown) =>
            isRecord(b) && typeof b.id === 'string'
              ? { ...b, id: id(b.id) }
              : b,
          ),
        }
      : {}),
    ...(Array.isArray(e.groupIds)
      ? {
          groupIds: e.groupIds.map((g: unknown) =>
            typeof g === 'string' ? (groups.get(g) ?? g) : g,
          ),
        }
      : {}),
  };
};

/**
 * The edited scene with each Alt-drag duplicate's ids put back: the shape
 * left in place takes the id it had in `before` (the agent's scene, or the
 * scene the editor opened on), and the copy dragged away takes the clone's
 * new id. A swap is made only when it is unambiguous: an element of `before`
 * whose id now sits somewhere else, and exactly one element with an id
 * `before` lacks standing where it stood, the same type, size, words and
 * style, claimed by no other. Every reference follows the ids: bound text
 * (swapped with its container's), `containerId`, `boundElements`, arrow
 * bindings, `frameId`, and the group ids the clone was given. Anything else,
 * ⌘D and paste included (their copy is never where the original was), is
 * left as it is, and so is text that is not two scenes: the same string
 * comes back. Pure and idempotent.
 */
export const keepIdsThroughDuplicates = (
  before: string,
  edited: string,
): string => {
  const was = sceneOf(parseJson(before));
  const parsed = parseJson(edited);
  const now = sceneOf(parsed);
  if (was === undefined || now === undefined) return edited;
  const wasEls = was.elements.filter(isRecord) as ReadonlyArray<RawElement>;
  const nowEls = now.elements.filter(isRecord) as ReadonlyArray<RawElement>;
  const wasIds = new Set(wasEls.map(idOf));
  const liveNow = nowEls.filter(isLive);
  const nowById = new Map(liveNow.map((e) => [idOf(e), e]));
  // Bound text moves with its container, so only free elements are matched.
  const free = (e: RawElement) => containerOf(e) === undefined;
  const proposals: Array<{ moved: RawElement; stayed: RawElement }> = [];
  for (const old of wasEls.filter((e) => isLive(e) && free(e))) {
    const id = idOf(old);
    const moved = id === undefined ? undefined : nowById.get(id);
    if (moved === undefined) continue;
    if (near(moved.x, old.x) && near(moved.y, old.y)) continue;
    const words = wordsOf(wasEls, old);
    const stayed = liveNow.filter(
      (e) =>
        idOf(e) !== undefined &&
        !wasIds.has(idOf(e)) &&
        free(e) &&
        e.type === old.type &&
        samePlace(old, e) &&
        wordsOf(nowEls, e) === words &&
        sameStyle(old, e),
    );
    const only = stayed[0];
    if (stayed.length === 1 && only !== undefined)
      proposals.push({ moved, stayed: only });
  }
  // A clone two of the earlier elements could each claim is ambiguous.
  const claims = new Map<RawElement, number>();
  for (const p of proposals)
    claims.set(p.stayed, (claims.get(p.stayed) ?? 0) + 1);
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  let groupsAgree = true;
  for (const { moved, stayed } of proposals) {
    if (claims.get(stayed) !== 1) continue;
    const a = idOf(moved);
    const b = idOf(stayed);
    if (a === undefined || b === undefined || !addSwap(ids, a, b)) continue;
    const ta = boundTextIn(nowEls, moved);
    const tb = boundTextIn(nowEls, stayed);
    const tia = ta === undefined ? undefined : idOf(ta);
    const tib = tb === undefined ? undefined : idOf(tb);
    if (tia !== undefined && tib !== undefined) addSwap(ids, tia, tib);
    const ga = Array.isArray(moved.groupIds) ? moved.groupIds : [];
    const gb = Array.isArray(stayed.groupIds) ? stayed.groupIds : [];
    if (ga.length !== gb.length) groupsAgree = false;
    else
      ga.forEach((g: unknown, i: number) => {
        const h: unknown = gb[i];
        if (typeof g !== 'string' || typeof h !== 'string') return;
        if (!addSwap(groups, g, h)) groupsAgree = false;
      });
  }
  if (ids.size === 0) return edited;
  const noGroups = new Map<string, string>();
  const elements = now.elements.map((e) =>
    isRecord(e) ? renamed(e, ids, groupsAgree ? groups : noGroups) : e,
  );
  return JSON.stringify(
    Array.isArray(parsed) ? elements : { ...(parsed as object), elements },
  );
};
