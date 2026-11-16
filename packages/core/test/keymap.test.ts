import { describe, expect, it } from '@effect/vitest';
import {
  bindingsOf,
  chordMatches,
  DEFAULT_BINDINGS,
  KEYMAP_ACTIONS,
  type KeyPress,
  keysAria,
  keysLabel,
  parseTrigger,
  remainingLabel,
  resolveKeymap,
  sequenceText,
  stepKeymap,
} from '../src/keymap';

const press = (
  over: Partial<KeyPress> & { readonly key: string },
): KeyPress => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

const chord = (text: string) => {
  const parsed = parseTrigger(text);
  if (!parsed.ok) throw new Error(parsed.message);
  const [first] = parsed.steps;
  if (first === undefined || first === 'prefix') throw new Error('no chord');
  return first;
};

const triggersOf = (text: string | undefined, id: string): string[] =>
  bindingsOf(resolveKeymap(text), id).map((b) => sequenceText(b.sequence));

describe('the keymap triggers', () => {
  it('parses modifiers, named keys, symbols and sequences', () => {
    expect(chord('ctrl+shift+P')).toEqual({
      key: 'p',
      ctrl: true,
      alt: false,
      shift: true,
      super: false,
    });
    expect(chord('cmd+enter').super).toBe(true);
    expect(chord('ctrl+bracket_left').key).toBe('[');
    expect(parseTrigger('prefix>?')).toEqual({
      ok: true,
      steps: ['prefix', expect.objectContaining({ key: '?' })],
    });
    expect(parseTrigger('hyper+a').ok).toBe(false);
    expect(parseTrigger('ctrl+nope').ok).toBe(false);
    expect(parseTrigger('ctrl+a>').ok).toBe(false);
  });

  it('matches a letter by its physical key, and Shift as written', () => {
    const ctrlN = chord('ctrl+n');
    expect(chordMatches(ctrlN, press({ key: 'n', ctrlKey: true }))).toBe(true);
    expect(chordMatches(ctrlN, press({ key: 'N', ctrlKey: true }))).toBe(true);
    expect(
      chordMatches(ctrlN, press({ key: 'n', ctrlKey: true, shiftKey: true })),
    ).toBe(false);
    expect(chordMatches(ctrlN, press({ key: 'n', metaKey: true }))).toBe(false);
    // ⌥ turns the character into another; the physical key still names it.
    expect(
      chordMatches(
        chord('alt+n'),
        press({ key: '˜', code: 'KeyN', altKey: true }),
      ),
    ).toBe(true);
  });

  it('matches a shifted symbol by its character, an unshifted one by its key too', () => {
    expect(chordMatches(chord('?'), press({ key: '?', shiftKey: true }))).toBe(
      true,
    );
    expect(chordMatches(chord('&'), press({ key: '&', shiftKey: true }))).toBe(
      true,
    );
    const ctrlBracket = chord('ctrl+[');
    expect(
      chordMatches(
        ctrlBracket,
        press({ key: 'Dead', code: 'BracketLeft', ctrlKey: true }),
      ),
    ).toBe(true);
    expect(chordMatches(ctrlBracket, press({ key: '[', ctrlKey: true }))).toBe(
      true,
    );
    expect(
      chordMatches(chord('space'), press({ key: ' ', code: 'Space' })),
    ).toBe(true);
  });
});

describe('the keys that Shift or the syntax get in the way of', () => {
  // Shift turns `[` into `{`, and `>` is the sequence separator.
  it('matches ctrl+shift+[ by its physical key or by the character Shift made', () => {
    const chord_ = chord('ctrl+shift+[');
    expect(
      chordMatches(
        chord_,
        press({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    // An event with no `code` (a synthetic one) still carries the character.
    expect(
      chordMatches(chord_, press({ key: '{', ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(
      chordMatches(
        chord('ctrl+shift+]'),
        press({
          key: '}',
          code: 'BracketRight',
          ctrlKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(true);
  });

  it('keeps ctrl+[ and ctrl+shift+[ apart, and ctrl+alt+[ from both', () => {
    const plain = chord('ctrl+[');
    const shifted = chord('ctrl+shift+[');
    const alt = chord('ctrl+alt+[');
    const typed = press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    const withShift = press({
      key: '{',
      code: 'BracketLeft',
      ctrlKey: true,
      shiftKey: true,
    });
    // ⌥ turns `[` into “ on a Mac; the physical key still names it.
    const withAlt = press({
      key: '“',
      code: 'BracketLeft',
      ctrlKey: true,
      altKey: true,
    });
    expect([plain, shifted, alt].map((c) => chordMatches(c, typed))).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      [plain, shifted, alt].map((c) => chordMatches(c, withShift)),
    ).toEqual([false, true, false]);
    expect([plain, shifted, alt].map((c) => chordMatches(c, withAlt))).toEqual([
      false,
      false,
      true,
    ]);
  });

  // Measured on a Mac with UCKeyTranslate: under
  // Control or Command the layout's Shift does nothing, so Ctrl+Shift+, types
  // `,`, and a real press arrives as that with `shiftKey` set.
  it('matches a shifted character from the key Shift stayed on, as macOS sends it', () => {
    const mac = (key: string, code: string) =>
      press({ key, code, ctrlKey: true, shiftKey: true });
    expect(chordMatches(chord('ctrl+less'), mac(',', 'Comma'))).toBe(true);
    expect(chordMatches(chord('ctrl+greater'), mac('.', 'Period'))).toBe(true);
    expect(chordMatches(chord('ctrl+greater'), mac(',', 'Comma'))).toBe(false);
    expect(chordMatches(chord('ctrl+?'), mac('/', 'Slash'))).toBe(true);
    expect(chordMatches(chord('ctrl+&'), mac('7', 'Digit7'))).toBe(true);
    expect(chordMatches(chord('ctrl+plus'), mac('=', 'Equal'))).toBe(true);
    expect(
      chordMatches(
        chord('super+less'),
        press({ key: ',', code: 'Comma', metaKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it('matches less and greater on the physical key, Shift or no Shift', () => {
    const plain = (key: string, code: string) =>
      press({ key, code, ctrlKey: true });
    expect(chordMatches(chord('ctrl+less'), plain(',', 'Comma'))).toBe(true);
    expect(chordMatches(chord('ctrl+greater'), plain('.', 'Period'))).toBe(
      true,
    );
    expect(chordMatches(chord('ctrl+greater'), plain(',', 'Comma'))).toBe(
      false,
    );
    expect(chordMatches(chord('ctrl+less'), plain('m', 'KeyM'))).toBe(false);
  });

  it('keeps an unshifted press off a shifted character', () => {
    const plain = press({ key: '/', code: 'Slash', ctrlKey: true });
    expect(chordMatches(chord('ctrl+?'), plain)).toBe(false);
    expect(
      chordMatches(
        chord('ctrl+,'),
        press({ key: ',', code: 'Comma', ctrlKey: true }),
      ),
    ).toBe(true);
    expect(
      chordMatches(
        chord('ctrl+,'),
        press({ key: ',', code: 'Comma', ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });

  it('matches plus from the + Shift made, as less and greater do', () => {
    expect(
      chordMatches(
        chord('ctrl+plus'),
        press({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it('writes < and > as less and greater, and matches the character Shift made', () => {
    expect(chord('ctrl+less')).toMatchObject({ key: 'less', ctrl: true });
    expect(chord('ctrl+greater')).toMatchObject({ key: 'greater', ctrl: true });
    // A bare `>` is the separator, so it cannot be written.
    expect(parseTrigger('ctrl+>').ok).toBe(false);
    const less = chord('ctrl+less');
    const greater = chord('ctrl+greater');
    const lessPress = press({
      key: '<',
      code: 'Comma',
      ctrlKey: true,
      shiftKey: true,
    });
    const greaterPress = press({
      key: '>',
      code: 'Period',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(chordMatches(less, lessPress)).toBe(true);
    expect(chordMatches(greater, greaterPress)).toBe(true);
    expect(chordMatches(less, greaterPress)).toBe(false);
    expect(chordMatches(greater, lessPress)).toBe(false);
    // Another modifier still has to be as written.
    expect(chordMatches(greater, { ...greaterPress, ctrlKey: false })).toBe(
      false,
    );
    // Written with its Shift, as before, it still matches.
    expect(chordMatches(chord('ctrl+shift+greater'), greaterPress)).toBe(true);
  });

  it('binds the new actions to those exact keys by default, and each press runs one action', () => {
    expect(triggersOf(undefined, 'previous_highlighted')).toEqual([
      'ctrl+shift+[',
    ]);
    expect(triggersOf(undefined, 'next_highlighted')).toEqual(['ctrl+shift+]']);
    expect(triggersOf(undefined, 'first_question')).toEqual(['super+up']);
    expect(triggersOf(undefined, 'last_question')).toEqual(['super+down']);
    expect(triggersOf(undefined, 'scroll_up')).toEqual(['ctrl+alt+[']);
    expect(triggersOf(undefined, 'scroll_down')).toEqual(['ctrl+alt+]']);
    expect(triggersOf(undefined, 'previous_queue')).toEqual(['ctrl+less']);
    expect(triggersOf(undefined, 'next_queue')).toEqual(['ctrl+greater']);
    expect(triggersOf(undefined, 'toggle_metadata')).toEqual(['ctrl+m']);
    const keymap = resolveKeymap(undefined);
    const actionOf = (p: KeyPress) => {
      const step = stepKeymap(keymap, [], p);
      return step._tag === 'run' ? step.binding.action.id : step._tag;
    };
    const ctrl = { ctrlKey: true };
    expect(actionOf(press({ key: '[', code: 'BracketLeft', ...ctrl }))).toBe(
      'previous_question',
    );
    expect(
      actionOf(
        press({ key: '{', code: 'BracketLeft', shiftKey: true, ...ctrl }),
      ),
    ).toBe('previous_highlighted');
    expect(
      actionOf(press({ key: '“', code: 'BracketLeft', altKey: true, ...ctrl })),
    ).toBe('scroll_up');
    expect(
      actionOf(
        press({ key: '}', code: 'BracketRight', shiftKey: true, ...ctrl }),
      ),
    ).toBe('next_highlighted');
    expect(
      actionOf(press({ key: '<', code: 'Comma', shiftKey: true, ...ctrl })),
    ).toBe('previous_queue');
    expect(
      actionOf(press({ key: '>', code: 'Period', shiftKey: true, ...ctrl })),
    ).toBe('next_queue');
    expect(actionOf(press({ key: 'm', code: 'KeyM', ...ctrl }))).toBe(
      'toggle_metadata',
    );
  });

  it('shows less and greater as the characters, and reads them back from a file', () => {
    expect(keysLabel(resolveKeymap(undefined), 'previous_queue')).toBe(
      'Ctrl+<',
    );
    expect(keysAria(resolveKeymap(undefined), 'next_queue')).toBe('Control+>');
    const keymap = resolveKeymap(
      'keybind = ctrl+space>greater=next_queue\nkeybind = ctrl+less=unbind',
    );
    expect(keymap.issues).toEqual([]);
    expect(triggersOf('keybind = ctrl+less=unbind', 'previous_queue')).toEqual(
      [],
    );
    expect(
      bindingsOf(keymap, 'next_queue').map((b) => sequenceText(b.sequence)),
    ).toEqual(['ctrl+greater', 'ctrl+space>greater']);
  });
});

describe('the highlight-reply and inbox-picker keys', () => {
  it('binds h to highlight the reply, b to the sidebar, and i and s to the picker', () => {
    expect(triggersOf(undefined, 'toggle_highlight_reply')).toEqual([
      'ctrl+space>h',
    ]);
    expect(triggersOf(undefined, 'focus_sidebar')).toEqual(['ctrl+space>b']);
    expect(triggersOf(undefined, 'focus_inbox_column')).toEqual([
      'ctrl+space>j',
    ]);
    expect(triggersOf(undefined, 'go_to_session')).toEqual([
      'ctrl+space>i',
      'ctrl+space>s',
    ]);
  });

  it('binds no trigger twice among the defaults', () => {
    const seen = resolveKeymap(undefined).bindings.map((b) =>
      sequenceText(b.sequence),
    );
    expect(seen.filter((t, i) => seen.indexOf(t) !== i)).toEqual([]);
  });
});

describe('the keybindings file', () => {
  it('gives every action in the defaults a known name', () => {
    const ids = new Set(KEYMAP_ACTIONS.map((a) => a.id));
    const keymap = resolveKeymap(undefined);
    expect(keymap.issues).toEqual([]);
    expect(keymap.bindings).toHaveLength(DEFAULT_BINDINGS.length);
    for (const b of keymap.bindings) expect(ids.has(b.action.id)).toBe(true);
  });

  it('keeps the chords the screen had before the keymap as the defaults', () => {
    expect(triggersOf(undefined, 'toggle_sidebar')).toEqual([
      'super+b',
      'ctrl+b',
    ]);
    expect(triggersOf(undefined, 'refresh')).toEqual(['ctrl+r']);
    expect(triggersOf(undefined, 'defer_to_agent')).toEqual([
      'shift+super+enter',
      'ctrl+shift+enter',
      'ctrl+space>u',
    ]);
    expect(triggersOf(undefined, 'ask_agent')).toEqual([
      'ctrl+a',
      'ctrl+space>a',
    ]);
    expect(triggersOf(undefined, 'search_questions')).toEqual([
      'super+p',
      'ctrl+p',
    ]);
    expect(triggersOf(undefined, 'previous_question')).toEqual(['ctrl+[']);
    expect(triggersOf(undefined, 'next_question')).toEqual(['ctrl+]']);
    expect(triggersOf(undefined, 'clear_selection')).toEqual(['ctrl+c']);
    expect(triggersOf(undefined, 'show_help')).toEqual(['ctrl+space>?']);
  });

  it('binds, rebinds, unbinds and clears in the order the lines run', () => {
    const text = [
      '# mine',
      'keybind = ctrl+k=toggle_sidebar',
      'keybind = ctrl+b=unbind',
      'keybind = super+b=next_inbox',
    ].join('\n');
    expect(triggersOf(text, 'toggle_sidebar')).toEqual(['ctrl+k']);
    expect(triggersOf(text, 'next_inbox')).toEqual(['ctrl+space>n', 'super+b']);
    const cleared = resolveKeymap(
      'keybind = clear\nkeybind = ctrl+h=show_help',
    );
    expect(cleared.bindings.map((b) => b.action.id)).toEqual(['show_help']);
    expect(cleared.bindings[0]?.source).toBe('config');
  });

  it('moves every prefix binding with the prefix, wherever the line sits', () => {
    const text = 'keybind = prefix>g=goto_inbox:2\nprefix = ctrl+a';
    expect(triggersOf(text, 'show_help')).toEqual(['ctrl+a>?']);
    expect(
      bindingsOf(resolveKeymap(text), 'goto_inbox').map((b) => [
        sequenceText(b.sequence),
        b.action.param,
      ]),
    ).toContainEqual(['ctrl+a>g', 2]);
  });

  it('reports a line that does not parse, by number, and keeps the rest', () => {
    const keymap = resolveKeymap(
      [
        'keybind = ctrl+k=toggle_sidebar',
        'keybind = ctrl+q=launch_rockets',
        'keybind ctrl+q',
        'colour = blue',
        'keybind = prefix>x=goto_inbox',
        'prefix = ctrl+a>b',
      ].join('\n'),
    );
    expect(keymap.issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6]);
    expect(keymap.issues[0]?.message).toContain('launch_rockets');
    expect(bindingsOf(keymap, 'toggle_sidebar').length).toBe(3);
  });
});

describe('a press through the keymap', () => {
  const keymap = resolveKeymap(undefined);
  const ctrlSpace = press({ key: ' ', code: 'Space', ctrlKey: true });

  it('runs a chord, waits on a prefix, and runs the sequence it ends', () => {
    const run = stepKeymap(keymap, [], press({ key: 'b', metaKey: true }));
    expect(run._tag === 'run' && run.binding.action.id).toBe('toggle_sidebar');
    const wait = stepKeymap(keymap, [], ctrlSpace);
    if (wait._tag !== 'wait') throw new Error(wait._tag);
    // The Shift on the way to `?` keeps it waiting.
    expect(
      stepKeymap(keymap, wait.pending, press({ key: 'Shift', shiftKey: true }))
        ._tag,
    ).toBe('hold');
    const help = stepKeymap(
      keymap,
      wait.pending,
      press({ key: '?', shiftKey: true }),
    );
    expect(help._tag === 'run' && help.binding.action.id).toBe('show_help');
    const nth = stepKeymap(
      keymap,
      wait.pending,
      press({ key: '3', code: 'Digit3' }),
    );
    expect(nth._tag === 'run' && nth.binding.action).toEqual({
      id: 'goto_inbox',
      param: 3,
    });
  });

  it('spends a waiting prefix on an unbound key, and passes what is not bound', () => {
    const wait = stepKeymap(keymap, [], ctrlSpace);
    if (wait._tag !== 'wait') throw new Error(wait._tag);
    expect(stepKeymap(keymap, wait.pending, press({ key: 'q' }))._tag).toBe(
      'cancel',
    );
    expect(stepKeymap(keymap, [], press({ key: 'q' }))._tag).toBe('pass');
  });
});

describe('an action’s keys as a hint', () => {
  it('writes the live keys as running text, and as aria-keyshortcuts', () => {
    const defaults = resolveKeymap(undefined);
    expect(keysLabel(defaults, 'toggle_sidebar')).toBe('⌘B / Ctrl+B');
    expect(keysLabel(defaults, 'send_response', 1)).toBe('⌘↩');
    expect(keysLabel(defaults, 'show_help')).toBe('Ctrl+Space ?');
    expect(keysAria(defaults, 'toggle_sidebar')).toBe('Meta+B Control+B');
    expect(keysAria(defaults, 'toggle_group')).toBe('Space');
    // A sequence has no aria-keyshortcuts form.
    expect(keysAria(defaults, 'show_help')).toBeUndefined();
  });

  it('follows a rebind, and names nothing for an unbound action', () => {
    const keymap = resolveKeymap(
      [
        'keybind = super+b=unbind',
        'keybind = ctrl+b=unbind',
        'keybind = ctrl+shift+k=toggle_sidebar',
        'keybind = ctrl+a=unbind',
        'keybind = prefix>a=unbind',
      ].join('\n'),
    );
    expect(keysLabel(keymap, 'toggle_sidebar')).toBe('Ctrl+⇧K');
    expect(keysAria(keymap, 'toggle_sidebar')).toBe('Control+Shift+K');
    expect(keysLabel(keymap, 'ask_agent')).toBeUndefined();
    expect(keysAria(keymap, 'ask_agent')).toBeUndefined();
  });
});

describe('what is left to press', () => {
  it('names the rest of a sequence once its start is typed, and nothing before', () => {
    const keymap = resolveKeymap('prefix = ctrl+a');
    const prefix = keymap.prefix;
    expect(remainingLabel(keymap, [], { id: 'all_inboxes' })).toBeUndefined();
    expect(remainingLabel(keymap, [prefix], { id: 'all_inboxes' })).toBe('0');
    expect(
      remainingLabel(keymap, [prefix], { id: 'goto_inbox', param: 3 }),
    ).toBe('3');
    expect(remainingLabel(keymap, [prefix], { id: 'rename_inbox' })).toBe(',');
    // A chord binding never shows: nothing is left after a sequence's start.
    expect(
      remainingLabel(keymap, [prefix], { id: 'toggle_sidebar' }),
    ).toBeUndefined();
  });
});
