// The keybindings file (`keybindings`), in Ghostty's config syntax:
//
//   # a comment
//   prefix = ctrl+a
//   keybind = prefix>g=goto_inbox:2
//   keybind = ctrl+j=unbind
//   keybind = clear
//
// Each `keybind` line binds a trigger to an action and replaces whatever that
// trigger was bound to; `unbind` takes the trigger away; `clear` drops every
// binding so far, the defaults included. `prefix` sets the chord `prefix` stands
// for, in the defaults too, wherever the line sits. A line that does not parse
// is reported and skipped, and never costs the rest of the file. Pure.

import {
  DEFAULT_BINDINGS,
  DEFAULT_PREFIX,
  KEYMAP_ACTIONS,
  type KeymapAction,
} from './actions';
import {
  type Chord,
  chordAria,
  chordText,
  expandSteps,
  parseTrigger,
  sequenceEqual,
  sequenceLabel,
  type TriggerStep,
} from './trigger';

export interface ActionRef {
  readonly id: string;
  readonly param?: number;
}

export interface Binding {
  readonly sequence: ReadonlyArray<Chord>;
  readonly action: ActionRef;
  readonly source: 'default' | 'config';
}

export interface KeymapIssue {
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

export interface Keymap {
  readonly prefix: Chord;
  readonly bindings: ReadonlyArray<Binding>;
  readonly issues: ReadonlyArray<KeymapIssue>;
}

const ACTIONS_BY_ID: ReadonlyMap<string, KeymapAction> = new Map(
  KEYMAP_ACTIONS.map((a) => [a.id, a]),
);

export const actionOf = (id: string): KeymapAction | undefined =>
  ACTIONS_BY_ID.get(id);

const parseAction = (
  text: string,
):
  | { readonly ok: true; readonly action: ActionRef }
  | { readonly ok: false; readonly message: string } => {
  const [id = '', param, ...rest] = text.trim().split(':');
  const action = ACTIONS_BY_ID.get(id);
  if (action === undefined || rest.length > 0)
    return { ok: false, message: `unknown action "${text.trim()}"` };
  if (action.param === undefined) {
    if (param !== undefined)
      return { ok: false, message: `${id} takes no parameter` };
    return { ok: true, action: { id } };
  }
  const n = Number(param);
  if (
    param === undefined ||
    !Number.isInteger(n) ||
    n < action.param.min ||
    n > action.param.max
  )
    return {
      ok: false,
      message: `${id} needs a whole number from ${action.param.min} to ${action.param.max}, as in ${id}:2`,
    };
  return { ok: true, action: { id, param: n } };
};

type Op =
  | { readonly _tag: 'clear' }
  | {
      readonly _tag: 'bind';
      readonly steps: ReadonlyArray<TriggerStep>;
      readonly action: ActionRef | 'unbind';
      readonly source: Binding['source'];
    };

// `trigger=action`, split at the first `=`: a trigger writes `=` as `equal`.
const parseBinding = (
  value: string,
  source: Binding['source'],
): Op | { readonly _tag: 'error'; readonly message: string } => {
  if (value.trim() === 'clear') return { _tag: 'clear' };
  const at = value.indexOf('=');
  if (at <= 0)
    return {
      _tag: 'error',
      message: 'expected trigger=action, as in ctrl+b=toggle_sidebar',
    };
  const trigger = parseTrigger(value.slice(0, at));
  if (!trigger.ok) return { _tag: 'error', message: trigger.message };
  const actionText = value.slice(at + 1).trim();
  if (actionText === 'unbind')
    return { _tag: 'bind', steps: trigger.steps, action: 'unbind', source };
  const action = parseAction(actionText);
  if (!action.ok) return { _tag: 'error', message: action.message };
  return { _tag: 'bind', steps: trigger.steps, action: action.action, source };
};

const PREFIX_FALLBACK: Chord = {
  key: 'space',
  ctrl: true,
  alt: false,
  shift: false,
  super: false,
};

const singleChord = (
  text: string,
):
  | { readonly ok: true; readonly chord: Chord }
  | { readonly ok: false; readonly message: string } => {
  const parsed = parseTrigger(text);
  if (!parsed.ok) return parsed;
  const [only, ...more] = parsed.steps;
  if (only === undefined || only === 'prefix' || more.length > 0)
    return { ok: false, message: 'the prefix is one chord, as in ctrl+a' };
  return { ok: true, chord: only };
};

/**
 * The keymap: the defaults, with the config file's lines applied in order.
 * `text` is the file's content, or `undefined` when there is no file.
 */
export const resolveKeymap = (text: string | undefined): Keymap => {
  const issues: KeymapIssue[] = [];
  const ops: Op[] = [];
  for (const line of DEFAULT_BINDINGS) {
    const op = parseBinding(line, 'default');
    if (op._tag !== 'error') ops.push(op);
  }
  const defaultPrefix = singleChord(DEFAULT_PREFIX);
  let prefix = defaultPrefix.ok ? defaultPrefix.chord : PREFIX_FALLBACK;
  // One line's outcome: its issue, when it has one.
  const readLine = (raw: string): string | undefined => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return undefined;
    const at = line.indexOf('=');
    if (at <= 0) return 'expected key = value';
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === 'prefix') {
      const chord = singleChord(value);
      if (!chord.ok) return chord.message;
      prefix = chord.chord;
      return undefined;
    }
    if (key !== 'keybind')
      return `unknown setting "${key}"; this file takes keybind and prefix`;
    const op = parseBinding(value, 'config');
    if (op._tag === 'error') return op.message;
    ops.push(op);
    return undefined;
  };
  for (const [i, raw] of (text ?? '').split(/\r?\n/).entries()) {
    const message = readLine(raw);
    if (message !== undefined) issues.push({ line: i + 1, text: raw, message });
  }
  let bindings: Binding[] = [];
  for (const op of ops) {
    if (op._tag === 'clear') {
      bindings = [];
      continue;
    }
    const sequence = expandSteps(op.steps, prefix);
    bindings = bindings.filter((b) => !sequenceEqual(b.sequence, sequence));
    if (op.action !== 'unbind')
      bindings.push({ sequence, action: op.action, source: op.source });
  }
  return { prefix, bindings, issues };
};

/** A sequence in the config file's syntax. */
export const sequenceText = (sequence: ReadonlyArray<Chord>): string =>
  sequence.map(chordText).join('>');

/** The bindings an action has, in the order the keymap holds them. */
export const bindingsOf = (
  keymap: Keymap,
  id: string,
): ReadonlyArray<Binding> => keymap.bindings.filter((b) => b.action.id === id);

/**
 * An action's keys as running text for a hint, `⌘J / Ctrl+J`, or `undefined`
 * when nothing binds it, so a hint never names a key that does nothing.
 * `limit` keeps a short hint short (a placeholder names one).
 */
export const keysLabel = (
  keymap: Keymap,
  id: string,
  limit?: number,
): string | undefined => {
  const bound = bindingsOf(keymap, id);
  if (bound.length === 0) return undefined;
  return bound
    .slice(0, limit ?? bound.length)
    .map((b) => sequenceLabel(b.sequence))
    .join(' / ');
};

/** An action's single-chord keys as an `aria-keyshortcuts` value. */
export const keysAria = (keymap: Keymap, id: string): string | undefined => {
  const chords = bindingsOf(keymap, id).flatMap((b) =>
    b.sequence.length === 1 && b.sequence[0] !== undefined
      ? [chordAria(b.sequence[0])]
      : [],
  );
  return chords.length === 0 ? undefined : chords.join(' ');
};

/**
 * What is left to press, after the chords already typed, to run an action:
 * `3` after the prefix for `goto_inbox:3`. `undefined` when nothing has been
 * typed (a badge shows only while a sequence waits) or no binding of the
 * action goes on from there.
 */
export const remainingLabel = (
  keymap: Keymap,
  pending: ReadonlyArray<Chord>,
  action: ActionRef,
): string | undefined => {
  if (pending.length === 0) return undefined;
  const next = keymap.bindings.find(
    (b) =>
      b.action.id === action.id &&
      b.action.param === action.param &&
      b.sequence.length > pending.length &&
      pending.every((c, i) => sequenceEqual([c], [b.sequence[i] as Chord])),
  );
  return next === undefined
    ? undefined
    : sequenceLabel(next.sequence.slice(pending.length));
};
