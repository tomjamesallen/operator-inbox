import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  A,
  box,
  mounted,
  onQueue,
  press,
  serve,
  type,
  useInboxPage,
} from './inbox-page-harness';

// Which key sends from the boxes that send text: config.json's `sendKey`.
// Unset, Send's keybinding (⌘↩ / Ctrl+↩) sends and Enter is a new line, as
// it always has. Under `"enter"`, Enter sends, and ⌘↩ and Ctrl+↩ put in a
// new line instead; ⇧↩ stays the browser's new line. A key pressed while an
// input method composes never sends, and a macro card keeps Enter as a new
// line. Each mode is held in each box: the answer, the ask and the
// follow-up.

useInboxPage();

/** A keydown on the box, as the browser would fire it, and whether it was taken. */
const key = (init: KeyboardEventInit, target: Element = box()): boolean => {
  const e = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  fireEvent(target, e);
  return e.defaultPrevented;
};

// The Inbox the ask's list has lit.
const choice = () =>
  document.querySelector('[data-zen-choice]')?.textContent ?? undefined;

const sendButton = (name: 'Send' | 'Ask') =>
  screen.getByRole('button', { name });

const withSendKey = (sendKey: 'enter' | 'mod+enter') => {
  serve.config = { ...(serve.config as object), sendKey };
};

// The config is read beside the board: the Send button's shortcut says which
// mode is in force once it is.
const inForce = async (name: 'Send' | 'Ask', aria: string) =>
  waitFor(() =>
    expect(sendButton(name).getAttribute('aria-keyshortcuts')).toBe(aria),
  );

const CHORDS = 'Meta+Enter Control+Enter';

// Each box, opened and holding a draft, with what its send posts to.
const BOXES = {
  answer: {
    button: 'Send',
    open: async () => {
      await mounted(`/inbox/${A}`);
      await waitFor(() => expect(box().placeholder).toBe('Write your answer'));
    },
  },
  ask: {
    button: 'Ask',
    open: async () => {
      await mounted(`/inbox/${A}`);
      press({ key: 'a', code: 'KeyA', ctrlKey: true });
      await screen.findByText(/In orchard/);
      await waitFor(() =>
        expect(box().placeholder).toBe('What do you want to ask?'),
      );
    },
  },
  'follow-up': {
    button: 'Send',
    open: async () => {
      await mounted(`/inbox/${A}`);
      await onQueue(/With the agent/);
      await waitFor(() => expect(box().placeholder).toBe('Add a follow-up'));
    },
  },
} as const;

describe.each(Object.entries(BOXES))('the %s box', (_, b) => {
  describe('with sendKey unset (the default)', () => {
    it('sends on ⌘↩ and Ctrl+↩, and leaves Enter to the browser', async () => {
      await b.open();
      await inForce(b.button, CHORDS);
      type('First line');
      expect(key({})).toBe(false);
      expect(key({ shiftKey: true })).toBe(false);
      expect(serve.posts).toHaveLength(0);
      key({ metaKey: true });
      await waitFor(() => expect(serve.posts).toHaveLength(1));
    });

    it('sends on Ctrl+↩ too', async () => {
      await b.open();
      type('Off a Mac');
      key({ ctrlKey: true });
      await waitFor(() => expect(serve.posts).toHaveLength(1));
    });

    it('says "mod+enter" is the same as unset', async () => {
      withSendKey('mod+enter');
      await b.open();
      await inForce(b.button, CHORDS);
      type('Line');
      expect(key({})).toBe(false);
      key({ metaKey: true });
      await waitFor(() => expect(serve.posts).toHaveLength(1));
    });
  });

  describe('with sendKey "enter"', () => {
    it('sends on Enter, and names Enter on the button', async () => {
      withSendKey('enter');
      await b.open();
      await inForce(b.button, 'Enter');
      type('Go ahead');
      expect(key({})).toBe(true);
      await waitFor(() => expect(serve.posts).toHaveLength(1));
    });

    it('puts a new line in on ⌘↩ and Ctrl+↩, and sends nothing', async () => {
      withSendKey('enter');
      await b.open();
      await inForce(b.button, 'Enter');
      type('One');
      box().setSelectionRange(3, 3);
      expect(key({ metaKey: true })).toBe(true);
      await waitFor(() => expect(box().value).toBe('One\n'));
      expect(key({ ctrlKey: true })).toBe(true);
      await waitFor(() => expect(box().value).toBe('One\n\n'));
      expect(serve.posts).toHaveLength(0);
    });

    it('leaves ⇧↩ to the browser, as a new line', async () => {
      withSendKey('enter');
      await b.open();
      await inForce(b.button, 'Enter');
      type('One');
      expect(key({ shiftKey: true })).toBe(false);
      expect(serve.posts).toHaveLength(0);
    });

    it('never sends on an Enter an input method is composing', async () => {
      withSendKey('enter');
      await b.open();
      await inForce(b.button, 'Enter');
      type('にほん');
      expect(key({ isComposing: true })).toBe(false);
      // Safari's Enter that ends a composition.
      expect(key({ keyCode: 229 })).toBe(false);
      expect(key({ isComposing: true, metaKey: true })).toBe(false);
      expect(serve.posts).toHaveLength(0);
    });
  });
});

describe('sendKey "enter" and the rest of the page', () => {
  it('leaves Enter to the macro menu while it is open', async () => {
    withSendKey('enter');
    serve.macros = JSON.stringify({
      macros: [
        {
          name: 'park',
          description: 'Park this thread',
          instruction: 'Stop work on this thread until asked.',
          params: [],
        },
      ],
    });
    await BOXES.answer.open();
    await inForce('Send', 'Enter');
    fireEvent.change(box(), { target: { value: '/park' } });
    box().setSelectionRange(5, 5);
    fireEvent.select(box());
    await screen.findByRole('option', { name: /\/park/ });
    key({});
    await waitFor(() =>
      expect(document.querySelector('[data-macro-card]')).not.toBeNull(),
    );
    expect(serve.posts).toHaveLength(0);
  });

  it('keeps Enter a new line in a macro card, and Send’s chord sends from it', async () => {
    withSendKey('enter');
    serve.macros = JSON.stringify({
      macros: [
        {
          name: 'todo',
          description: 'Add a to-do',
          instruction: 'Add this to the to-do list.',
          params: [{ name: 'text', type: 'text' }],
        },
      ],
    });
    await BOXES.answer.open();
    await inForce('Send', 'Enter');
    fireEvent.change(box(), { target: { value: '/todo' } });
    box().setSelectionRange(5, 5);
    fireEvent.select(box());
    await screen.findByRole('option', { name: /\/todo/ });
    key({});
    const field = await screen.findByRole('textbox', { name: 'text' });
    fireEvent.change(field, { target: { value: 'Buy milk' } });
    expect(key({}, field)).toBe(false);
    expect(serve.posts).toHaveLength(0);
    key({ metaKey: true }, field);
    await waitFor(() => expect(serve.posts).toHaveLength(1));
  });

  it('leaves Enter in the inbox picker to pick', async () => {
    withSendKey('enter');
    await BOXES.ask.open();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(box().placeholder).toBe('Which inbox?'));
    await waitFor(() => expect(choice()).toBe('orchard'));
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    await waitFor(() => expect(choice()).toBe('quarry'));
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText(/In quarry/);
    expect(serve.posts).toHaveLength(0);
  });

  // So Enter pressed in the first moments after a reload does what it did
  // before it: until config.json is read, or when it cannot be, the setting
  // last read stands.
  it('keeps the setting last read while the config cannot be read', async () => {
    withSendKey('enter');
    await BOXES.answer.open();
    await inForce('Send', 'Enter');
    cleanup();
    serve.config = { metadata: 'not rules' };
    await BOXES.answer.open();
    await inForce('Send', 'Enter');
    type('Still Enter');
    expect(key({})).toBe(true);
    await waitFor(() => expect(serve.posts).toHaveLength(1));
  });

  it('tells the key help that Enter sends', async () => {
    withSendKey('enter');
    await BOXES.answer.open();
    await inForce('Send', 'Enter');
    press({ key: ' ', code: 'Space', ctrlKey: true });
    press({ key: '?', code: 'Slash', shiftKey: true });
    const help = await screen.findByTestId('keymap-help');
    expect(help.textContent).toContain(
      'Send · a new line (config.json’s sendKey)',
    );
    expect(
      help.querySelector('[data-action="send_response"]')?.textContent,
    ).toContain('Enter sends and this is a new line');
  });
});
