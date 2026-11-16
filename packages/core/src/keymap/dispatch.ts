// What one key press does to the keymap: run a binding, wait for the rest of
// a sequence, or nothing. A sequence waits for its next key as long as it
// takes, as tmux's prefix and Ghostty's sequences do; a modifier pressed on its
// own (the Shift on the way to `?`) never ends one. Where a press both ends a
// binding and starts a longer sequence, the sequence wins and waits. Pure.

import type { Binding, Keymap } from './config';
import {
  type Chord,
  chordEqual,
  chordMatches,
  isModifierOnly,
  type KeyPress,
} from './trigger';

export type KeyStep =
  // Run this binding; the sequence so far is spent.
  | { readonly _tag: 'run'; readonly binding: Binding }
  // Hold these chords and wait for the next press.
  | { readonly _tag: 'wait'; readonly pending: ReadonlyArray<Chord> }
  // A sequence was waiting and this press ends none of its bindings: it is
  // spent, and the press with it.
  | { readonly _tag: 'cancel' }
  // Nothing waiting, nothing bound: the press is not the keymap's.
  | { readonly _tag: 'pass' }
  // A modifier on its own while a sequence waits: keep waiting.
  | { readonly _tag: 'hold' };

export const stepKeymap = (
  keymap: Keymap,
  pending: ReadonlyArray<Chord>,
  press: KeyPress,
): KeyStep => {
  if (isModifierOnly(press))
    return pending.length > 0 ? { _tag: 'hold' } : { _tag: 'pass' };
  const depth = pending.length;
  const live = keymap.bindings.filter(
    (b) =>
      b.sequence.length > depth &&
      pending.every((c, i) => chordEqual(b.sequence[i] as Chord, c)) &&
      chordMatches(b.sequence[depth] as Chord, press),
  );
  const longer = live.filter((b) => b.sequence.length > depth + 1);
  const first = longer[0];
  if (first !== undefined)
    return {
      _tag: 'wait',
      pending: [...pending, first.sequence[depth] as Chord],
    };
  const done = live[0];
  if (done !== undefined) return { _tag: 'run', binding: done };
  return depth > 0 ? { _tag: 'cancel' } : { _tag: 'pass' };
};
