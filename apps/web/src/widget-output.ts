import {
  WIDGET_TONES,
  type WidgetFormat,
  type WidgetTone,
} from '@operator-inbox/core/api';

// A widget run's stdout, read in the widget's format as lines of styled spans.
// Every style is a Tailwind class from the theme, never a colour the command
// chose, and the output is text, never HTML.
//
// - `text`: ANSI SGR honoured (bold, dim, italic, underline, and the sixteen
//   foreground colours mapped onto the theme's own); every other escape (256
//   and true colour, backgrounds, cursor movement, OSC links) and every other
//   control character dropped.
// - `json`: the envelope `{ "text": "…", "tone"?: "ok|warn|bad|info|muted",
//   "detail"?: "…" }`, its text and its detail each read as `text`. An
//   envelope that is not one is shown as plain text, with a note saying why.

export interface Span {
  readonly text: string;
  readonly cls: string;
}
export type Line = ReadonlyArray<Span>;

export interface WidgetOutput {
  // The output's own lines: for `json`, its text's and then its detail's.
  readonly lines: ReadonlyArray<Line>;
  readonly tone: WidgetTone | undefined;
  // Why the output is not what its format expects.
  readonly note: string | undefined;
}

// The sixteen colours, foreground only, onto the theme. Black is the faint
// foreground and white the foreground itself, so both schemes read; cyan has
// no colour of its own in the theme and takes blue.
const COLOUR: Readonly<Record<number, string>> = {
  30: 'text-fg/40',
  31: 'text-red',
  32: 'text-green',
  33: 'text-yellow',
  34: 'text-blue',
  35: 'text-purple',
  36: 'text-blue',
  37: 'text-fg',
};

interface Sgr {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  colour: string | undefined;
}

const plain = (): Sgr => ({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  colour: undefined,
});

const clsOf = (s: Sgr): string =>
  [
    s.colour,
    s.bold ? 'font-bold' : undefined,
    s.dim ? 'opacity-60' : undefined,
    s.italic ? 'italic' : undefined,
    s.underline ? 'underline' : undefined,
  ]
    .filter((c) => c !== undefined)
    .join(' ');

// One SGR sequence's parameters, in order. A parameter with sub-parameters
// (`38:5:208`, the colon form) is extended colour, which is dropped whole.
const applySgr = (s: Sgr, params: ReadonlyArray<string>): void => {
  for (let i = 0; i < params.length; i++) {
    const param = params[i] ?? '';
    if (param.includes(':')) continue;
    const p = param === '' ? 0 : Number(param);
    if (p === 0) Object.assign(s, plain());
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) Object.assign(s, { bold: false, dim: false });
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 39) s.colour = undefined;
    else if (p >= 30 && p <= 37) s.colour = COLOUR[p];
    else if (p >= 90 && p <= 97) s.colour = COLOUR[p - 60];
    // 38/48;5;n and 38/48;2;r;g;b: their arguments are skipped, and no
    // colour is kept.
    else if (p === 38 || p === 48) i += params[i + 1] === '5' ? 2 : 4;
  }
};

// A CSI sequence (parameters, intermediates, a final byte), an OSC sequence
// ended by BEL or ST, or any other escape: its intermediates (`ESC ( B`,
// which `tput sgr0` prints) and its final byte.
const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escapes are what this reads.
  /\x1b\[([0-9:;<=>?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]?/g;

// What is left of the control characters once the escapes are read: all but
// the tab, which `whitespace-pre` draws.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this drops.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

const linesOf = (text: string): ReadonlyArray<string> =>
  text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');

/** Text with ANSI SGR, as lines of spans in the theme's classes. */
export const ansiLines = (text: string): ReadonlyArray<Line> => {
  const s = plain();
  return linesOf(text).map((raw) => {
    const spans: Array<Span> = [];
    const push = (part: string) => {
      const clean = part.replace(CONTROL, '');
      if (clean !== '') spans.push({ text: clean, cls: clsOf(s) });
    };
    let at = 0;
    for (const m of raw.matchAll(ESCAPE)) {
      push(raw.slice(at, m.index));
      if (m[2] === 'm') applySgr(s, (m[1] ?? '').split(';'));
      at = m.index + m[0].length;
    }
    push(raw.slice(at));
    return spans;
  });
};

/** Text with every escape and control character dropped, unstyled. */
export const plainLines = (text: string): ReadonlyArray<Line> =>
  linesOf(text).map((raw) => {
    const clean = raw.replace(ESCAPE, '').replace(CONTROL, '');
    return clean === '' ? [] : [{ text: clean, cls: '' }];
  });

const isTone = (value: unknown): value is WidgetTone =>
  WIDGET_TONES.some((t) => t === value);

const asPlain = (stdout: string, note: string): WidgetOutput => ({
  lines: plainLines(stdout),
  tone: 'bad',
  note,
});

const readEnvelope = (stdout: string): WidgetOutput => {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return asPlain(stdout, 'not JSON: shown as plain text');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return asPlain(stdout, 'not a JSON object: shown as plain text');
  const o = json as Readonly<Record<string, unknown>>;
  if (typeof o.text !== 'string')
    return asPlain(stdout, 'no "text": shown as plain text');
  const notes: Array<string> = [];
  if (o.tone !== undefined && !isTone(o.tone))
    notes.push(`unknown tone ${JSON.stringify(o.tone)}`);
  if (o.detail !== undefined && typeof o.detail !== 'string')
    notes.push('"detail" is not text, so it is left out');
  return {
    lines: [
      ...ansiLines(o.text),
      ...(typeof o.detail === 'string' ? ansiLines(o.detail) : []),
    ],
    tone: isTone(o.tone) ? o.tone : undefined,
    note: notes.length === 0 ? undefined : notes.join('; '),
  };
};

/** A run's stdout, read in its widget's format. */
export const readWidgetOutput = (
  stdout: string,
  format: WidgetFormat,
): WidgetOutput =>
  format === 'json'
    ? readEnvelope(stdout)
    : { lines: ansiLines(stdout), tone: undefined, note: undefined };

/** A tone's colour as a fill (the chip's strip, the popover's dot). */
export const toneFill: Readonly<Record<WidgetTone, string>> = {
  ok: 'bg-green',
  warn: 'bg-orange',
  bad: 'bg-red',
  info: 'bg-blue',
  muted: 'bg-fg/30',
};

/** A tone's colour as text (the first line of output). */
export const toneText: Readonly<Record<WidgetTone, string>> = {
  ok: 'text-green',
  warn: 'text-orange',
  bad: 'text-red',
  info: 'text-blue',
  muted: 'text-fg/40',
};
