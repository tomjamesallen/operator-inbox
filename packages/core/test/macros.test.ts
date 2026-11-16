import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  decideAnswer,
  decideMove,
  type InboxEvent,
  inboxState,
  MAX_MACROS_PER_ANSWER,
  QuestionNumber,
} from '../src/inbox';
import {
  decodeMacrosFile,
  initialMacroArgs,
  type MacroConfig,
  type MacroInvoked,
  macroInvokedOf,
  missingMacroParams,
} from '../src/macros';
import { InboxId } from '../src/schema/identifiers';

const FILE = '/c/operator-inbox/macros.json';

const AGENDA: MacroConfig = {
  name: 'agenda',
  description: 'Add an item to someone’s agenda',
  instruction: 'Add the item to the named person’s agenda.',
  params: [
    { name: 'person', type: 'enum', options: ['Mira', 'Tobin'] },
    { name: 'item', type: 'text', placeholder: 'what to raise' },
  ],
};
const TODO: MacroConfig = {
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
};
const LABEL: MacroConfig = {
  name: 'label',
  description: 'Label the work',
  instruction: 'Apply these labels.',
  params: [
    {
      name: 'labels',
      type: 'enum',
      multiple: true,
      options: ['blocked', 'quick-win', 'risky'],
    },
  ],
};
const PARK: MacroConfig = {
  name: 'park',
  description: 'Park this thread',
  instruction: 'Stop work on this thread until asked.',
  params: [],
};

const text = (v: unknown) => JSON.stringify(v);
const failureOf = (r: Result.Result<unknown, string>) =>
  Result.isFailure(r) ? r.failure : undefined;

describe('decodeMacrosFile', () => {
  it('reads every kind of parameter', () => {
    const file = { macros: [AGENDA, TODO, LABEL, PARK] };
    expect(Result.getOrThrow(decodeMacrosFile(text(file), FILE))).toEqual(file);
  });

  it('reads an empty list as no macros', () => {
    expect(
      Result.getOrThrow(decodeMacrosFile('{"macros":[]}', FILE)).macros,
    ).toEqual([]);
  });

  it('says a file that is not JSON is not', () => {
    expect(failureOf(decodeMacrosFile('{ macros', FILE))).toMatch(
      /^macros\.json at \/c\/operator-inbox\/macros\.json is not valid JSON: /,
    );
  });

  it('names each key that is wrong, all at once', () => {
    const message = failureOf(
      decodeMacrosFile(
        text({
          macros: [
            { ...AGENDA, name: 'Agenda' },
            { ...TODO, params: [{ name: 'x', type: 'date' }] },
            { ...PARK, instruction: '' },
          ],
        }),
        FILE,
      ),
    );
    expect(message).toContain('macros.json at /c/operator-inbox/macros.json:');
    expect(message).toContain('macros.0.name');
    expect(message).toContain('macros.1.params.0');
    expect(message).toContain('macros.2.instruction');
  });

  it('refuses an enum with no options, which would offer nothing', () => {
    const message = failureOf(
      decodeMacrosFile(
        text({
          macros: [{ ...LABEL, params: [{ ...LABEL.params[0], options: [] }] }],
        }),
        FILE,
      ),
    );
    expect(message).toContain('macros.0.params.0');
  });

  it('refuses what the shape cannot see: twice-named, upside down', () => {
    const message = failureOf(
      decodeMacrosFile(
        text({
          macros: [
            AGENDA,
            { ...AGENDA, description: 'again' },
            {
              ...TODO,
              params: [
                { name: 'n', type: 'number', min: 5, max: 1 },
                { name: 'n', type: 'number', min: 1, max: 4, default: 9 },
                { name: 'pick', type: 'enum', options: ['a', 'a'] },
              ],
            },
          ],
        }),
        FILE,
      ),
    );
    expect(message).toContain('macros.1.name — /agenda is named twice');
    expect(message).toContain('macros.2.params.0 — min is more than max');
    expect(message).toContain('macros.2.params.1.name — /todo has two');
    expect(message).toContain('macros.2.params.1.default — outside min');
    expect(message).toContain('macros.2.params.2.options — an option');
  });
});

describe('a macro’s draft', () => {
  it('starts with each number’s default and nothing else', () => {
    expect(initialMacroArgs(TODO)).toEqual({ priority: 2 });
    expect(initialMacroArgs(AGENDA)).toEqual({});
  });

  it('names the required parameters still empty, never an optional one', () => {
    expect(missingMacroParams(AGENDA, {}).map((p) => p.name)).toEqual([
      'person',
      'item',
    ]);
    expect(
      missingMacroParams(AGENDA, { person: 'Mira', item: '  ' }).map(
        (p) => p.name,
      ),
    ).toEqual(['item']);
    expect(missingMacroParams(TODO, { text: 'x' })).toEqual([]);
    expect(missingMacroParams(LABEL, { labels: [] }).length).toBe(1);
    expect(missingMacroParams(PARK, {})).toEqual([]);
  });

  it('carries every parameter, the empty ones as null, with the instruction', () => {
    expect(macroInvokedOf(TODO, { text: '  Book the room ' })).toEqual({
      macro: 'todo',
      instruction: TODO.instruction,
      args: { text: 'Book the room', priority: null },
    });
    expect(
      macroInvokedOf(LABEL, { labels: ['risky', 'blocked', 'gone'] }).args,
    ).toEqual({ labels: ['blocked', 'risky'] });
    // An option the list no longer has is not sent as if it were chosen.
    expect(macroInvokedOf(AGENDA, { person: 'Someone' }).args).toEqual({
      person: null,
      item: null,
    });
    expect(macroInvokedOf(PARK, {})).toEqual({
      macro: 'park',
      instruction: PARK.instruction,
      args: {},
    });
  });
});

const ID = InboxId.make('01INBOX0000000000000000000');
const TO = InboxId.make('01INBOX0000000000000000001');
const n = QuestionNumber.make;
const events: ReadonlyArray<InboxEvent> = [
  { _tag: 'InboxOpened', inboxId: ID, label: 'demo' },
  { _tag: 'QuestionAsked', inboxId: ID, number: n(1), title: 'T', body: 'B' },
];
const parked: MacroInvoked = macroInvokedOf(PARK, {});
const agenda: MacroInvoked = macroInvokedOf(AGENDA, {
  person: 'Mira',
  item: 'Dates',
});

describe('an answer with macros', () => {
  const answer = (input: {
    readonly response: string;
    readonly macros?: ReadonlyArray<MacroInvoked>;
    readonly deferred?: true;
  }) =>
    decideAnswer(inboxState(events), { inboxId: ID, number: n(1), ...input });

  it('carries them in order, and the fold keeps them', () => {
    const event = Result.getOrThrow(
      answer({ response: 'Yes', macros: [agenda, parked] }),
    );
    expect(event.macros).toEqual([agenda, parked]);
    const q = inboxState([...events, event]).questions[0];
    expect(q?.state).toBe('awaiting-agent');
    expect(q?.macros).toEqual([agenda, parked]);
  });

  it('may be macros alone, with no text', () => {
    const event = Result.getOrThrow(answer({ response: '', macros: [parked] }));
    expect(event.response).toBe('');
    expect(event.macros).toEqual([parked]);
  });

  it('is still empty with no text and no macros', () => {
    const refused = answer({ response: ' ', macros: [] });
    expect(Result.isFailure(refused) && refused.failure.reason).toBe('empty');
  });

  it('leaves the key out when there are none', () => {
    const event = Result.getOrThrow(answer({ response: 'Yes', macros: [] }));
    expect(event).not.toHaveProperty('macros');
  });

  it('rides on a deferral too', () => {
    const event = Result.getOrThrow(
      answer({ response: '', deferred: true, macros: [parked] }),
    );
    expect(event.deferred).toBe(true);
    expect(event.macros).toEqual([parked]);
  });

  it('refuses a macro with no instruction, and too many', () => {
    const blank = answer({
      response: 'x',
      macros: [{ ...parked, instruction: ' ' }],
    });
    expect(Result.isFailure(blank) && blank.failure.reason).toBe('bad-macro');
    const many = answer({
      response: 'x',
      macros: Array.from({ length: MAX_MACROS_PER_ANSWER + 1 }, () => parked),
    });
    expect(Result.isFailure(many) && many.failure.reason).toBe('bad-macro');
  });

  it('moves with its question', () => {
    const answered = Result.getOrThrow(
      answer({ response: 'Yes', macros: [agenda] }),
    );
    const moved = Result.getOrThrow(
      decideMove(
        inboxState([...events, answered]),
        inboxState([{ _tag: 'InboxOpened', inboxId: TO, label: 'other' }]),
        { inboxId: ID, numbers: [n(1)], toInboxId: TO },
      ),
    );
    expect(moved[0]?.question.macros).toEqual([agenda]);
    const to = inboxState([
      { _tag: 'InboxOpened', inboxId: TO, label: 'other' },
      ...moved,
    ]);
    expect(to.questions[0]?.macros).toEqual([agenda]);
  });
});
