// A key trigger in Ghostty's syntax: modifiers and one key joined by `+`
// (`ctrl+shift+p`, `super+b`), and a sequence of them joined by `>`
// (`ctrl+space>n`, the way Ghostty writes a tmux-style prefix). `prefix` in a
// sequence stands for the keymap's prefix chord, so moving the prefix moves
// every binding written after it. Pure: parsing a string, matching a
// keyboard event's fields, and formatting for display.

export interface Chord {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly super: boolean;
}

/** One step of a written trigger: a chord, or the prefix placeholder. */
export type TriggerStep = Chord | 'prefix';

const MODIFIERS: Readonly<Record<string, 'ctrl' | 'alt' | 'shift' | 'super'>> =
  {
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    opt: 'alt',
    option: 'alt',
    shift: 'shift',
    super: 'super',
    cmd: 'super',
    command: 'super',
  };

// Ghostty's names for keys that cannot be written as themselves, and the
// `KeyboardEvent.key` each one arrives as.
const NAMED: Readonly<Record<string, string>> = {
  enter: 'Enter',
  escape: 'Escape',
  space: ' ',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  page_up: 'PageUp',
  page_down: 'PageDown',
  // `=`, `+` and `>` are the syntax's own separators, and `<` is written the
  // same way for its pair. A bare `>` in a trigger would end its step.
  equal: '=',
  plus: '+',
  less: '<',
  greater: '>',
};
for (let n = 1; n <= 12; n++) {
  (NAMED as Record<string, string>)[`f${n}`] = `F${n}`;
}

const ALIASES: Readonly<Record<string, string>> = {
  return: 'enter',
  esc: 'escape',
  arrow_up: 'up',
  arrow_down: 'down',
  arrow_left: 'left',
  arrow_right: 'right',
  bracket_left: '[',
  bracket_right: ']',
  slash: '/',
  comma: ',',
  period: '.',
  semicolon: ';',
  minus: '-',
  backslash: '\\',
  question: '?',
};

// The unshifted symbols, by the physical key they sit on, so `ctrl+[` matches
// whatever character a layout or a modifier turns the key into.
const SYMBOL_CODES: Readonly<Record<string, string>> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '/': 'Slash',
  ',': 'Comma',
  '.': 'Period',
  ';': 'Semicolon',
  "'": 'Quote',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  '\\': 'Backslash',
};

// What Shift makes of each of those keys, on a US layout, for a press that
// carries no `code` to name the physical key.
const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  '[': '{',
  ']': '}',
  '/': '?',
  ',': '<',
  '.': '>',
  ';': ':',
  "'": '"',
  '-': '_',
  '=': '+',
  '`': '~',
  '\\': '|',
};

// The key each shifted character sits on, on a US layout. Under Control or
// Command macOS's layouts drop Shift from the character, though not from the
// event: measured with UCKeyTranslate on the operator's Mac, Ctrl+Shift+, types
// `,`. So a press names a shifted character by that key, with Shift held.
const UNSHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(SHIFTED_SYMBOLS).map(([key, shifted]) => [shifted, key]),
  ),
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

// The character itself, or the key Shift would have made it from.
const typesShifted = (press: KeyPress, character: string): boolean =>
  press.key === character ||
  (press.shiftKey && press.key === UNSHIFTED_SYMBOLS[character]);

// Keys written by name that are themselves a shifted character: a layout may
// need Shift to type one, so Shift is not the trigger's to say, as it is not
// for `?` and `&`.
const SHIFTED_NAMES: ReadonlySet<string> = new Set(['less', 'greater', 'plus']);

// The keys `<` and `>` sit on. They match by that key, Shift or no Shift: the
// operator's prototype did, and it is the press that works on their Mac.
const ANGLE_CODES: Readonly<Record<string, string>> = {
  less: 'Comma',
  greater: 'Period',
};

const isLetterOrDigit = (k: string): boolean => /^[a-z0-9]$/.test(k);

/** A trigger string as steps, or the reason it does not parse. */
export const parseTrigger = (
  text: string,
):
  | { readonly ok: true; readonly steps: ReadonlyArray<TriggerStep> }
  | { readonly ok: false; readonly message: string } => {
  const parts = text.trim().split('>');
  const steps: TriggerStep[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === '') return { ok: false, message: `empty step in "${text}"` };
    if (part === 'prefix') {
      steps.push('prefix');
      continue;
    }
    const bits = part.split('+').map((b) => b.trim());
    const keyText = bits.pop() ?? '';
    const chord = { ctrl: false, alt: false, shift: false, super: false };
    for (const bit of bits) {
      const mod = MODIFIERS[bit.toLowerCase()];
      if (mod === undefined)
        return { ok: false, message: `unknown modifier "${bit}" in "${text}"` };
      chord[mod] = true;
    }
    const lower = keyText.toLowerCase();
    const named = ALIASES[lower] ?? lower;
    let key: string;
    if (named in NAMED) key = named;
    else if ([...keyText].length === 1) key = keyText.toLowerCase();
    else if ([...named].length === 1) key = named;
    else return { ok: false, message: `unknown key "${keyText}" in "${text}"` };
    steps.push({ key, ...chord });
  }
  return { ok: true, steps };
};

/** The steps with `prefix` replaced by the prefix chord. */
export const expandSteps = (
  steps: ReadonlyArray<TriggerStep>,
  prefix: Chord,
): ReadonlyArray<Chord> => steps.map((s) => (s === 'prefix' ? prefix : s));

export const chordEqual = (a: Chord, b: Chord): boolean =>
  a.key === b.key &&
  a.ctrl === b.ctrl &&
  a.alt === b.alt &&
  a.shift === b.shift &&
  a.super === b.super;

export const sequenceEqual = (
  a: ReadonlyArray<Chord>,
  b: ReadonlyArray<Chord>,
): boolean =>
  a.length === b.length && a.every((c, i) => chordEqual(c, b[i] as Chord));

/** The fields of a keyboard event a chord matches on. */
export interface KeyPress {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'OS',
  'CapsLock',
  'Fn',
]);

/** A press of a modifier on its own, which never ends a sequence. */
export const isModifierOnly = (press: KeyPress): boolean =>
  MODIFIER_KEYS.has(press.key);

/**
 * Whether a press is the chord. A letter or a digit matches by its physical
 * key where the event names one (so ⌥ or a layout cannot turn it into another
 * character), else by its character, and Shift must be as written. A named key
 * matches by name, Shift as written, but `less`, `greater` and `plus` match
 * their character, which Shift may already have made, and `less` and `greater`
 * also match the physical key, Shift or no Shift. An unshifted symbol
 * matches its physical key or its character, Shift as written (so
 * `ctrl+shift+[` matches the physical key, or the `{` that Shift made); a
 * shifted one (`?`, `&`) matches its character, which Shift already made. Every
 * shifted character also matches the key it sits on with Shift held, which is
 * how macOS sends it under Control or Command.
 */
export const chordMatches = (chord: Chord, press: KeyPress): boolean => {
  if (
    chord.ctrl !== press.ctrlKey ||
    chord.alt !== press.altKey ||
    chord.super !== press.metaKey
  )
    return false;
  const k = chord.key;
  if (isLetterOrDigit(k)) {
    if (chord.shift !== press.shiftKey) return false;
    const code = press.code ?? '';
    const fromCode = /^Key[A-Z]$/.test(code)
      ? code.slice(3).toLowerCase()
      : /^Digit[0-9]$/.test(code)
        ? code.slice(5)
        : undefined;
    return fromCode !== undefined
      ? fromCode === k
      : press.key.toLowerCase() === k;
  }
  const named = NAMED[k];
  if (named !== undefined) {
    if (SHIFTED_NAMES.has(k))
      return (
        (typesShifted(press, named) || press.code === ANGLE_CODES[k]) &&
        (!chord.shift || press.shiftKey)
      );
    if (chord.shift !== press.shiftKey) return false;
    return press.key === named || (k === 'space' && press.code === 'Space');
  }
  const code = SYMBOL_CODES[k];
  if (code !== undefined && !chord.shift) {
    if (press.key === k) return !press.shiftKey;
    return !press.shiftKey && press.code === code;
  }
  if (code !== undefined) {
    // Written with Shift: the press must carry it, and Shift has turned the
    // key's character into another, so the physical key or that character
    // names it.
    return (
      press.shiftKey &&
      (press.code === code ||
        press.key === k ||
        press.key === SHIFTED_SYMBOLS[k])
    );
  }
  // A shifted symbol: the character itself, whatever Shift took to make it.
  return typesShifted(press, k) && (!chord.shift || press.shiftKey);
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  enter: '↩',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  page_up: 'PgUp',
  page_down: 'PgDn',
  equal: '=',
  plus: '+',
  less: '<',
  greater: '>',
};

/** One chord as key caps for display: `⌘`, `Ctrl`, `⌥`, `⇧`, then the key. */
export const chordCaps = (chord: Chord): ReadonlyArray<string> => [
  ...(chord.ctrl ? ['Ctrl'] : []),
  ...(chord.alt ? ['⌥'] : []),
  ...(chord.shift ? ['⇧'] : []),
  ...(chord.super ? ['⌘'] : []),
  KEY_LABELS[chord.key] ?? chord.key.toUpperCase(),
];

/** One chord in Ghostty's syntax, as a config file would write it. */
export const chordText = (chord: Chord): string =>
  [
    ...(chord.ctrl ? ['ctrl'] : []),
    ...(chord.alt ? ['alt'] : []),
    ...(chord.shift ? ['shift'] : []),
    ...(chord.super ? ['super'] : []),
    chord.key,
  ].join('+');

const GLYPHS: ReadonlySet<string> = new Set(['⌘', '⌥', '⇧']);

/**
 * One chord as running text, for a title or a placeholder: a glyph modifier
 * sits against the key (`⌘J`, `⌘↩`), a named one takes a `+` (`Ctrl+J`).
 */
export const chordLabel = (chord: Chord): string => {
  const caps = chordCaps(chord);
  const key = caps[caps.length - 1] ?? '';
  const mods = caps
    .slice(0, -1)
    .map((cap) => (GLYPHS.has(cap) ? cap : `${cap}+`))
    .join('');
  return `${mods}${key}`;
};

/** A sequence as running text, its steps apart: `Ctrl+Space ?`. */
export const sequenceLabel = (sequence: ReadonlyArray<Chord>): string =>
  sequence.map(chordLabel).join(' ');

// `aria-keyshortcuts` names keys as `KeyboardEvent.key` does.
const ARIA_KEYS: Readonly<Record<string, string>> = {
  space: 'Space',
  equal: '=',
  plus: '+',
  less: '<',
  greater: '>',
};

/**
 * One chord in `aria-keyshortcuts` form (`Control+Shift+P`, `Meta+Enter`).
 * The attribute has no way to write a sequence, so it takes chords only.
 */
export const chordAria = (chord: Chord): string =>
  [
    ...(chord.ctrl ? ['Control'] : []),
    ...(chord.alt ? ['Alt'] : []),
    ...(chord.shift ? ['Shift'] : []),
    ...(chord.super ? ['Meta'] : []),
    ARIA_KEYS[chord.key] ??
      NAMED[chord.key] ??
      (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key),
  ].join('+');
