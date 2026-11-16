import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  A,
  answered,
  board,
  box,
  mount,
  mounted,
  onQueue,
  prefix,
  press,
  serve,
  settle,
  useInboxPage,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// Macros in the answer box: `/` opens the menu, a pick is a card under the
// box, the card's fields fill its arguments, and the answer carries each
// macro with its instruction. A send with a required field empty is held on
// it once; the same fields empty at the next send go as `null`. The "i" shows
// what the macro tells the agent, on hover, a click or ⌥I. All names are
// invented.

useInboxPage();

const MACROS = {
  macros: [
    {
      name: 'agenda',
      description: 'Add an item to someone’s agenda',
      instruction: 'Add the item to the named person’s agenda.',
      params: [
        { name: 'person', type: 'enum', options: ['Mira', 'Tobin'] },
        { name: 'item', type: 'text', placeholder: 'what to raise' },
      ],
    },
    {
      name: 'todo',
      description: 'Add a to-do',
      instruction: 'Add this to the to-do list at the given priority.',
      params: [
        { name: 'text', type: 'text' },
        {
          name: 'priority',
          type: 'number',
          min: 1,
          max: 4,
          default: 2,
          required: false,
        },
      ],
    },
    {
      name: 'park',
      description: 'Park this thread',
      instruction: 'Stop work on this thread until asked.',
      params: [],
    },
  ],
};

const menu = () => document.querySelector<HTMLElement>('#macro-menu');
const cards = () => [
  ...document.querySelectorAll<HTMLElement>('[data-macro-card]'),
];
const card = (name: string) =>
  cards().find((c) => c.getAttribute('aria-label') === `/${name}`);
const active = () => document.activeElement as HTMLElement | null;

/** Types into the box as a person does: the value, the caret at its end. */
const typeBox = (text: string) => {
  const el = box();
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.select(el);
};

const send = (target: Element = box()) =>
  press({ key: 'Enter', code: 'Enter', ctrlKey: true }, target);

/** `/name` and Enter: the macro's card. */
const invoke = async (name: string, before = '') => {
  typeBox(`${before}/${name}`);
  await waitFor(() => expect(menu()).not.toBeNull());
  press({ key: 'Enter', code: 'Enter' }, box());
  await waitFor(() => expect(card(name)).toBeDefined());
};

const withMacros = async () => {
  serve.macros = JSON.stringify(MACROS);
  await mounted(`/inbox/${A}`);
  // The file is read beside the board; wait for its first use.
  typeBox('/');
  await waitFor(() =>
    expect(screen.queryByRole('option', { name: /\/park/ })).not.toBeNull(),
  );
  typeBox('');
};

describe('the macro menu', () => {
  it('opens on / at a word’s start, filters, and Enter adds a card', async () => {
    await withMacros();
    typeBox('Go ahead /');
    await waitFor(() => expect(menu()).not.toBeNull());
    expect(
      screen
        .getAllByRole('option')
        .map((o) => o.querySelector('span')?.textContent),
    ).toEqual(['/attach', '/agenda', '/todo', '/park']);
    typeBox('Go ahead /tod');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    press({ key: 'Enter', code: 'Enter' }, box());
    await waitFor(() => expect(card('todo')).toBeDefined());
    // The `/tod` left the text, and the caret went to the card's first field.
    expect(box().value).toBe('Go ahead ');
    expect(menu()).toBeNull();
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('text'),
    );
    // The number starts at its default.
    expect(
      (
        card('todo')?.querySelector(
          'input[aria-label="priority"]',
        ) as HTMLInputElement | null
      )?.value,
    ).toBe('2');
  });

  it('is not a menu mid-word, and Esc shuts it for that slash', async () => {
    await withMacros();
    typeBox('and/or');
    await settle();
    expect(menu()).toBeNull();
    typeBox('/');
    await waitFor(() => expect(menu()).not.toBeNull());
    press({ key: 'Escape', code: 'Escape' }, box());
    await waitFor(() => expect(menu()).toBeNull());
    expect(box().value).toBe('/');
  });

  it('with no macros file, / offers /attach alone, and an unmatched word simply types', async () => {
    await mounted(`/inbox/${A}`);
    typeBox('/');
    await waitFor(() => expect(menu()).not.toBeNull());
    expect(
      screen
        .getAllByRole('option')
        .map((o) => o.querySelector('span')?.textContent),
    ).toEqual(['/attach']);
    typeBox('/usr');
    await settle();
    expect(menu()).toBeNull();
    expect(box().value).toBe('/usr');
  });

  it('a file that does not parse offers no macro, and says why', async () => {
    serve.macros = '{ "macros": [ { "name": "Bad" } ] }';
    await mounted(`/inbox/${A}`);
    typeBox('/');
    await waitFor(() =>
      expect(document.querySelector('[data-macro-failed]')).not.toBeNull(),
    );
    expect(
      screen
        .getAllByRole('option')
        .map((o) => o.querySelector('span')?.textContent),
    ).toEqual(['/attach']);
    expect(
      document.querySelector('[data-macro-failed]')?.textContent,
    ).toContain('macros.json at /c/operator-inbox/macros.json');
  });
});

describe('a macro card', () => {
  it('sends its arguments and instruction with the answer, in order', async () => {
    await withMacros();
    await invoke('agenda', 'Go ahead with the rota. ');
    fireEvent.click(screen.getByRole('radio', { name: 'Tobin' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'item' }), {
      target: { value: 'Opening date' },
    });
    await invoke('park', 'Go ahead with the rota. ');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]).toEqual({
      path: `/api/inbox/${A}/questions/1/answer`,
      body: {
        response: 'Go ahead with the rota. ',
        seenRevision: 1,
        macros: [
          {
            macro: 'agenda',
            instruction: 'Add the item to the named person’s agenda.',
            args: { person: 'Tobin', item: 'Opening date' },
          },
          {
            macro: 'park',
            instruction: 'Stop work on this thread until asked.',
            args: {},
          },
        ],
      },
    });
    // A send that lands clears the cards and their draft.
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(
      sessionStorage.getItem('operator-inbox:inbox-macro-drafts'),
    ).not.toContain('agenda');
  });

  it('may be the whole answer, with no text', async () => {
    await withMacros();
    await invoke('park');
    expect(box().value).toBe('');
    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).not.toHaveProperty('disabled', true);
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({ response: '' });
  });

  it('holds a send on an empty required field, then sends it as it is', async () => {
    await withMacros();
    await invoke('agenda', 'Yes. ');
    fireEvent.click(screen.getByRole('radio', { name: 'Mira' }));
    box().focus();
    send();
    await settle();
    expect(serve.posts).toHaveLength(0);
    // The card says so in its header, its border goes orange, and the caret
    // goes to the field.
    const held = card('agenda');
    expect(held?.dataset.macroHeld).toBe('true');
    expect(held?.className).toContain('border-orange');
    expect(held?.querySelector('output')?.textContent).toContain('needs item');
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('item'),
    );
    // The same field still empty: the next send goes, the field as null.
    send(active() ?? box());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).toMatchObject({
      macros: [{ macro: 'agenda', args: { person: 'Mira', item: null } }],
    });
  });

  it('holds again when a different field is left empty', async () => {
    await withMacros();
    await invoke('agenda', 'Yes. ');
    send();
    await waitFor(() => expect(card('agenda')?.dataset.macroHeld).toBe('true'));
    // Filling one of the two changes what is missing: the hold is new.
    fireEvent.click(screen.getByRole('radio', { name: 'Mira' }));
    await waitFor(() =>
      expect(card('agenda')?.dataset.macroHeld).toBeUndefined(),
    );
    send();
    await settle();
    expect(serve.posts).toHaveLength(0);
    expect(card('agenda')?.dataset.macroHeld).toBe('true');
  });

  it('shows no parameters line on a bare card, which is still a stop ⌘⌫ removes', async () => {
    await withMacros();
    await invoke('park', 'Fine. ');
    const bare = card('park');
    expect(bare?.textContent).not.toContain('No parameters');
    expect(bare?.querySelectorAll('input, [role="radiogroup"]')).toHaveLength(
      0,
    );
    expect(bare?.tabIndex).toBe(0);
    // Tab from the text reaches it.
    press({ key: 'Tab', code: 'Tab' }, box());
    await waitFor(() => expect(active()).toBe(card('park')));
    press({ key: 'Backspace', code: 'Backspace', metaKey: true }, card('park'));
    await waitFor(() => expect(cards()).toHaveLength(0));
    await waitFor(() => expect(active()).toBe(box()));
  });

  it('⌘⌫ in a field removes its card and the next card takes the focus', async () => {
    await withMacros();
    await invoke('todo');
    await invoke('agenda');
    const field = card('todo')?.querySelector<HTMLElement>(
      'input[aria-label="text"]',
    );
    if (field == null) throw new Error('no field');
    field.focus();
    press({ key: 'Backspace', code: 'Backspace', ctrlKey: true }, field);
    await waitFor(() => expect(card('todo')).toBeUndefined());
    await waitFor(() => expect(card('agenda')?.contains(active())).toBe(true));
  });

  it('Esc goes back to the text', async () => {
    await withMacros();
    await invoke('todo');
    await waitFor(() =>
      expect(active()?.getAttribute('aria-label')).toBe('text'),
    );
    press({ key: 'Escape', code: 'Escape' }, active() ?? document);
    await waitFor(() => expect(active()).toBe(box()));
  });
});

describe('what a macro tells the agent', () => {
  const instruction = () =>
    document.querySelector<HTMLElement>('[data-macro-instruction]');

  it('⌥I shows it, by the key’s place; the first Esc shuts it, the next goes to the text', async () => {
    await withMacros();
    await invoke('todo');
    const field = active();
    expect(field?.getAttribute('aria-label')).toBe('text');
    expect(instruction()).toBeNull();
    // A Mac's ⌥I is a dead key: it names no letter, only its place.
    press({ key: 'Dead', code: 'KeyI', altKey: true }, field ?? document);
    await waitFor(() =>
      expect(instruction()?.textContent).toContain(
        'Add this to the to-do list at the given priority.',
      ),
    );
    // The focus stays in the field.
    expect(active()).toBe(field);
    press({ key: 'Escape', code: 'Escape' }, field ?? document);
    await waitFor(() => expect(instruction()).toBeNull());
    expect(active()).toBe(field);
    press({ key: 'Escape', code: 'Escape' }, field ?? document);
    await waitFor(() => expect(active()).toBe(box()));
  });

  it('⌥I does nothing outside a card', async () => {
    await withMacros();
    await invoke('todo');
    box().focus();
    press({ key: 'Dead', code: 'KeyI', altKey: true }, box());
    await settle();
    expect(instruction()).toBeNull();
  });

  it('a rebound key toggles it instead', async () => {
    serve.keybindings =
      'keybind = alt+i=unbind\nkeybind = alt+k=toggle_macro_info\n';
    await withMacros();
    await invoke('todo');
    const field = active() ?? document;
    press({ key: 'Dead', code: 'KeyI', altKey: true }, field);
    await settle();
    expect(instruction()).toBeNull();
    press({ key: '˚', code: 'KeyK', altKey: true }, field);
    await waitFor(() => expect(instruction()).not.toBeNull());
  });

  it('opens on a click of the i', async () => {
    await withMacros();
    await invoke('park');
    fireEvent.click(
      card('park')?.querySelector('[data-macro-info]') as HTMLElement,
    );
    await waitFor(() =>
      expect(instruction()?.textContent).toContain(
        'Stop work on this thread until asked.',
      ),
    );
  });
});

describe('the cards’ drafts', () => {
  it('outlive a reload of the page, as the answer text does', async () => {
    await withMacros();
    await invoke('agenda', 'Draft. ');
    fireEvent.click(screen.getByRole('radio', { name: 'Tobin' }));
    await settle();
    cleanup();
    mount(`/inbox/${A}`);
    await waitFor(() => expect(card('agenda')).toBeDefined());
    expect(box().value).toBe('Draft. ');
    expect(
      screen.getByRole('radio', { name: 'Tobin' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('are kept per question', async () => {
    serve.board = board([
      { ...VIEW_A, awaitingAgent: [], processed: [] },
      VIEW_B,
    ]);
    await withMacros();
    await invoke('park');
    // The next question in Your inbox has its own box, with no cards.
    press({ key: ']', code: 'BracketRight', ctrlKey: true });
    await waitFor(() => expect(cards()).toHaveLength(0));
    press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    await waitFor(() => expect(card('park')).toBeDefined());
  });
});

describe('an answer that carried macros', () => {
  it('shows them under what was said, in With the agent', async () => {
    serve.board = board([
      {
        ...VIEW_A,
        awaitingAgent: [
          {
            ...answered(2, 'Second', 12, ''),
            macros: [
              {
                macro: 'agenda',
                instruction: 'Add the item to the named person’s agenda.',
                args: { person: 'Mira', item: null },
              },
            ],
          },
        ],
      },
    ]);
    await mounted(`/inbox/${A}`);
    await onQueue(/With the agent/);
    const sent = await waitFor(() => {
      const el = document.querySelector('[data-sent-macros]');
      if (el === null) throw new Error('not yet');
      return el;
    });
    expect(sent.textContent).toContain('/agenda');
    expect(sent.textContent).toContain('person Mira');
    expect(sent.textContent).toContain('item —');
  });
});

describe('the help sheet', () => {
  it('has a Macros section with the card’s keys and the file it read', async () => {
    serve.macros = JSON.stringify(MACROS);
    await mounted(`/inbox/${A}`);
    prefix();
    press({ key: '?', code: 'Slash', shiftKey: true });
    const section = await screen.findByRole('region', { name: 'Macros' });
    expect(section.textContent).toContain('Remove the card');
    expect(section.textContent).toContain('⌥I');
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="macros-source"]')?.textContent,
      ).toContain('/agenda, /todo, /park'),
    );
  });
});
