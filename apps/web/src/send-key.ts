import type { SendKey } from '@operator-inbox/core/api';

// The key that sends from a box that sends text (an answer, a follow-up, a
// question for the agent), as config.json's `sendKey` says. Under
// `mod+enter`, the default, the box leaves every key alone: Send's
// keybinding (`send_response`) is the keymap's, and Enter is the browser's
// new line. Under `enter`, Enter sends, and ⌘↩ and Ctrl+↩ are a new line in
// its place; ⇧↩ stays the browser's new line, and ⌘⇧↩ stays Defer's.

/** What the box does with a press: send, put in a new line, or leave it. */
export type SendKeyStep = 'send' | 'newline' | 'pass';

export interface SendKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
}

/**
 * A key pressed while an input method is composing is the input method's:
 * Enter then commits the word, and never sends. Safari reports the Enter
 * that ends a composition with `isComposing` false and `keyCode` 229, so
 * both are read.
 */
export const isComposingPress = (
  e: Pick<SendKeyPress, 'isComposing' | 'keyCode'>,
): boolean => e.isComposing || e.keyCode === 229;

export const sendKeyStepOf = (
  sendKey: SendKey,
  e: SendKeyPress,
): SendKeyStep => {
  if (sendKey !== 'enter' || e.key !== 'Enter' || isComposingPress(e))
    return 'pass';
  if (e.altKey) return 'pass';
  const chord = e.metaKey || e.ctrlKey;
  if (!chord && !e.shiftKey) return 'send';
  if (chord && !e.shiftKey) return 'newline';
  return 'pass';
};

/**
 * A new line at the caret, replacing any selection, as Enter would put it
 * there. `insertText` keeps the field's own undo; where the browser does not
 * run it, the text is set in place and an `input` event tells React.
 */
export const insertNewline = (el: HTMLTextAreaElement): void => {
  if (document.execCommand?.('insertText', false, '\n') === true) return;
  el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/** The key that sends under `sendKey`, as the Send button's hint names it. */
export const ENTER_HINT = { label: '↩', aria: 'Enter' } as const;
