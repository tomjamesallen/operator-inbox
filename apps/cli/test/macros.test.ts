import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  askEvents,
  CONFIG_DIR_NAME,
  decideAnswer,
  decideOperatorAsk,
  InboxId,
  MACROS_FILE,
  type MacroInvoked,
  type QuestionComment,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import { ConfigProvider, Effect, Option, Result } from 'effect';
import { Command } from 'effect/cli';
import { TestConsole } from 'effect/testing';
import {
  dispatchAnswers,
  dispatchAsk,
  dispatchOpen,
} from '../src/commands/inbox';
import {
  macrosCommand,
  readMacros,
  renderMacros,
} from '../src/commands/macros';
import { envProvider } from '../src/env-config';
import {
  decideAndAppend,
  type InboxLog,
  InboxLogInMemory,
} from '../src/inbox-store';
import { readMacrosFile } from '../src/serve-macros-api';

// Macros through the CLI: `macros` prints and checks the file, serve hands
// its text to the page as it is, and `answers` prints each macro an answer
// carries after its response.

const FILE = {
  macros: [
    {
      name: 'agenda',
      description: 'Add an item to someone’s agenda',
      instruction:
        'Add the item to the named person’s agenda.\nDo not message them.',
      params: [
        { name: 'person', type: 'enum', options: ['Mira', 'Tobin'] },
        { name: 'item', type: 'text', placeholder: 'what to raise' },
      ],
    },
    {
      name: 'todo',
      description: 'Add a to-do',
      instruction: 'Add this to the to-do list.',
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
        {
          name: 'labels',
          type: 'enum',
          multiple: true,
          options: ['blocked', 'risky'],
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

const configHome = (text?: string) => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-macros-'));
  if (text !== undefined) {
    mkdirSync(path.join(xdg, CONFIG_DIR_NAME));
    writeFileSync(path.join(xdg, CONFIG_DIR_NAME, MACROS_FILE), text);
  }
  return xdg;
};

const under =
  (xdg: string) =>
  <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
    effect.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        envProvider({ XDG_CONFIG_HOME: xdg }),
      ),
      Effect.provide(NodeServices.layer),
    );

const printed = Effect.map(TestConsole.logLines, (lines) =>
  lines.map(String).join('\n'),
);

describe('operator-inbox macros', () => {
  it.effect(
    'prints each macro, what it tells the agent and its parameters',
    () =>
      Effect.gen(function* () {
        const xdg = configHome(JSON.stringify(FILE));
        const report = yield* under(xdg)(readMacros);
        const file = path.join(xdg, CONFIG_DIR_NAME, MACROS_FILE);
        expect(renderMacros(report)).toBe(
          [
            '/agenda — Add an item to someone’s agenda',
            '  tells the agent: Add the item to the named person’s agenda.',
            '    Do not message them.',
            '  person    one of: Mira, Tobin',
            '  item      text (what to raise)',
            '/todo — Add a to-do',
            '  tells the agent: Add this to the to-do list.',
            '  text      text',
            '  priority  number 1 to 4, default 2, optional',
            '  labels    any of: blocked, risky, optional',
            '/park — Park this thread',
            '  tells the agent: Stop work on this thread until asked.',
            '  (no parameters)',
            `3 macros in ${file}`,
          ].join('\n'),
        );
      }),
  );

  it.effect('--json prints the path and the macros as the file has them', () =>
    Effect.gen(function* () {
      const xdg = configHome(JSON.stringify(FILE));
      yield* under(xdg)(
        Command.runWith(macrosCommand, { version: '0.0.0' })(['--json']),
      );
      expect(JSON.parse(yield* printed)).toEqual({
        path: path.join(xdg, CONFIG_DIR_NAME, MACROS_FILE),
        macros: FILE.macros,
      });
    }),
  );

  it.effect('no file is no macros, and not a failure', () =>
    Effect.gen(function* () {
      const report = yield* under(configHome())(readMacros);
      expect(report.exists).toBe(false);
      expect(report.macros).toEqual([]);
      expect(renderMacros(report)).toMatch(
        /^no macros: there is no .*macros\.json, so \/ in the answer box simply types$/,
      );
    }),
  );

  it.effect('a file that does not decode fails, saying why', () =>
    Effect.gen(function* () {
      const bad = yield* Effect.flip(
        under(
          configHome(
            JSON.stringify({ macros: [FILE.macros[2], FILE.macros[2]] }),
          ),
        )(readMacros),
      );
      expect(bad.message).toContain('macros.1.name — /park is named twice');
      const notJson = yield* Effect.flip(
        under(configHome('{ macros: '))(readMacros),
      );
      expect(notJson.message).toContain('is not valid JSON');
    }),
  );
});

describe('serve’s macros file', () => {
  it.effect(
    'answers no file with its path and no text, and a file as it is',
    () =>
      Effect.gen(function* () {
        const none = configHome();
        expect(yield* under(none)(readMacrosFile())).toEqual({
          path: path.join(none, CONFIG_DIR_NAME, MACROS_FILE),
          text: null,
        });
        // Not decoded here: a bad file is the page's to report.
        const bad = configHome('{ not json');
        expect((yield* under(bad)(readMacrosFile())).text).toBe('{ not json');
      }),
  );

  it.effect('fails a file that is there and cannot be read', () =>
    Effect.gen(function* () {
      const xdg = configHome();
      mkdirSync(path.join(xdg, CONFIG_DIR_NAME, MACROS_FILE), {
        recursive: true,
      });
      const read = yield* Effect.result(under(xdg)(readMacrosFile()));
      expect(Result.isFailure(read) && read.failure._tag).toBe(
        'MacrosUnreadable',
      );
    }),
  );
});

const ID = InboxId.make('01INBOXMACROAAAAAAAAAAAAAA');

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

const opened = Effect.gen(function* () {
  yield* dispatchOpen({
    session: Option.some({ sessionId: SessionId.make('s'), cwd: '/w/app' }),
    inbox: Option.none(),
    label: Option.some('app'),
    freshId: ID,
    cwd: '/w',
  });
  yield* dispatchAsk({
    inboxId: ID,
    title: 'What next?',
    body: 'The checklist is drafted.',
  });
});

const answer = (
  response: string,
  macros: ReadonlyArray<MacroInvoked>,
  deferred?: true,
) =>
  decideAndAppend(ID, (state) =>
    Result.map(
      decideAnswer(state, {
        inboxId: ID,
        number: QuestionNumber.make(1),
        response,
        macros,
        ...(deferred === undefined ? {} : { deferred }),
      }),
      (event) => ({ events: [event], result: undefined }),
    ),
  );

const AGENDA: MacroInvoked = {
  macro: 'agenda',
  instruction:
    'Add the item to the named person’s agenda.\nDo not message them.',
  args: { person: 'Mira', item: null },
};
const LABEL: MacroInvoked = {
  macro: 'label',
  instruction: 'Apply these labels.',
  args: { labels: ['blocked', 'risky'], weight: 2 },
};
const PARK: MacroInvoked = {
  macro: 'park',
  instruction: 'Stop work on this thread until asked.',
  args: {},
};

describe('answers with macros', () => {
  it.effect('prints a block per macro after the response, in order', () =>
    provide(
      Effect.gen(function* () {
        yield* opened;
        yield* answer('Go ahead with the rota first.', [AGENDA, LABEL, PARK]);
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
          [
            '#1 What next?',
            '  Go ahead with the rota first.',
            '  MACRO 1 of 3: /agenda',
            '    instruction: Add the item to the named person’s agenda.',
            '      Do not message them.',
            '    person = "Mira"',
            '    item = null',
            '  MACRO 2 of 3: /label',
            '    instruction: Apply these labels.',
            '    labels = ["blocked","risky"]',
            '    weight = 2',
            '  MACRO 3 of 3: /park',
            '    instruction: Stop work on this thread until asked.',
            '    (no parameters)',
          ].join('\n'),
        );
        const json = JSON.parse(
          yield* dispatchAnswers({ inboxId: ID, json: true }),
        );
        expect(json[0].macros).toStrictEqual([AGENDA, LABEL, PARK]);
      }),
    ),
  );

  it.effect('an answer of macros alone prints no empty line for its text', () =>
    provide(
      Effect.gen(function* () {
        yield* opened;
        yield* answer('', [PARK]);
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
          [
            '#1 What next?',
            '  MACRO 1 of 1: /park',
            '    instruction: Stop work on this thread until asked.',
            '    (no parameters)',
          ].join('\n'),
        );
      }),
    ),
  );

  it.effect('a deferral carries its macros under its line', () =>
    provide(
      Effect.gen(function* () {
        yield* opened;
        yield* answer('', [PARK], true);
        const text = yield* dispatchAnswers({ inboxId: ID, json: false });
        expect(text.split('\n').slice(1, 3)).toEqual([
          '  DEFERRED TO AGENT: you decide. Record what you chose and why.',
          '  MACRO 1 of 1: /park',
        ]);
      }),
    ),
  );

  it.effect('an answer with no macros has no block and no key', () =>
    provide(
      Effect.gen(function* () {
        yield* opened;
        yield* answer('Yes.', []);
        expect(
          yield* dispatchAnswers({ inboxId: ID, json: false }),
        ).not.toContain('MACRO');
        expect(
          JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true }))[0],
        ).not.toHaveProperty('macros');
      }),
    ),
  );
});

describe('answers with an operator’s question that carries macros', () => {
  const askWith = (text: string, macros: ReadonlyArray<MacroInvoked>) =>
    decideAndAppend(ID, (state) =>
      Result.map(
        decideOperatorAsk(state, { inboxId: ID, text, macros }),
        (event) => ({ events: askEvents(state, event), result: undefined }),
      ),
    );

  it.effect(
    'prints a block per macro after the question, as for an answer',
    () =>
      provide(
        Effect.gen(function* () {
          yield* opened;
          yield* answer('Yes.', []);
          yield* askWith('Wrap the rota up?', [AGENDA, PARK]);
          const text = yield* dispatchAnswers({ inboxId: ID, json: false });
          expect(text.split('\n\n')[1]).toBe(
            [
              '#2 (the operator asks) Wrap the rota up?',
              '  Wrap the rota up?',
              '  MACRO 1 of 2: /agenda',
              '    instruction: Add the item to the named person’s agenda.',
              '      Do not message them.',
              '    person = "Mira"',
              '    item = null',
              '  MACRO 2 of 2: /park',
              '    instruction: Stop work on this thread until asked.',
              '    (no parameters)',
            ].join('\n'),
          );
          const json = JSON.parse(
            yield* dispatchAnswers({ inboxId: ID, json: true }),
          );
          expect(json[1]).toMatchObject({
            operatorQuestion: true,
            response: 'Wrap the rota up?',
            macros: [AGENDA, PARK],
          });
        }),
      ),
  );

  it.effect(
    'a question of macros alone is titled by them, with no empty line',
    () =>
      provide(
        Effect.gen(function* () {
          yield* opened;
          yield* answer('Yes.', []);
          yield* askWith('', [PARK]);
          const text = yield* dispatchAnswers({ inboxId: ID, json: false });
          expect(text.split('\n\n')[1]).toBe(
            [
              '#2 (the operator asks) /park',
              '  MACRO 1 of 1: /park',
              '    instruction: Stop work on this thread until asked.',
              '    (no parameters)',
            ].join('\n'),
          );
        }),
      ),
  );
});

describe('answers with comments', () => {
  const NOBODY: QuestionComment = {
    quote: 'nobody could predict',
    prefix: 'scripts ',
    suffix: '.',
    at: { part: 0, start: 12, end: 32 },
    text: 'Say which scripts break.\nThe nightly export is one.',
  };
  const CHECKLIST: QuestionComment = {
    quote: 'checklist',
    prefix: 'The ',
    suffix: ' is drafted.',
    at: { part: 0, start: 4, end: 13 },
    text: 'Add the rota to it.',
  };
  const commented = (
    response: string,
    comments: ReadonlyArray<QuestionComment>,
    macros: ReadonlyArray<MacroInvoked> = [],
  ) =>
    decideAndAppend(ID, (state) =>
      Result.map(
        decideAnswer(state, {
          inboxId: ID,
          number: QuestionNumber.make(1),
          response,
          comments,
          macros,
        }),
        (event) => ({ events: [event], result: undefined }),
      ),
    );

  it.effect(
    'prints a numbered block after the response, in body order, before the macros',
    () =>
      provide(
        Effect.gen(function* () {
          yield* opened;
          yield* commented('Ship it.', [NOBODY, CHECKLIST], [PARK]);
          expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
            [
              '#1 What next?',
              '  Ship it.',
              '  COMMENTS on the question (2):',
              '  1. On “checklist”: Add the rota to it.',
              '  2. On “nobody could predict”: Say which scripts break.',
              '     The nightly export is one.',
              '  MACRO 1 of 1: /park',
              '    instruction: Stop work on this thread until asked.',
              '    (no parameters)',
            ].join('\n'),
          );
          const json = JSON.parse(
            yield* dispatchAnswers({ inboxId: ID, json: true }),
          );
          expect(json[0].comments).toStrictEqual([CHECKLIST, NOBODY]);
        }),
      ),
  );

  it.effect(
    'an answer of comments alone prints no empty line for its text',
    () =>
      provide(
        Effect.gen(function* () {
          yield* opened;
          yield* commented('', [CHECKLIST]);
          expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
            [
              '#1 What next?',
              '  COMMENTS on the question (1):',
              '  1. On “checklist”: Add the rota to it.',
            ].join('\n'),
          );
        }),
      ),
  );

  const SHOW_ME: MacroInvoked = {
    macro: 'show-me',
    instruction: 'Show the operator what this looks like.\nUse a picture.',
    args: { focus: 'the edge case', depth: null },
  };

  it.effect(
    'nests each comment’s macros inside it, after its words, in text and json',
    () =>
      provide(
        Effect.gen(function* () {
          yield* opened;
          yield* commented(
            'Ship it.',
            [
              { ...NOBODY, macros: [SHOW_ME, PARK] },
              { ...CHECKLIST, text: '', macros: [PARK] },
            ],
            [PARK],
          );
          expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
            [
              '#1 What next?',
              '  Ship it.',
              '  COMMENTS on the question (2):',
              '  1. On “checklist”: (no words; its macros only)',
              '     MACRO 1 of 1 on comment 1: /park',
              '       applies to: the text comment 1 quotes, “checklist”, not the whole question',
              '       instruction: Stop work on this thread until asked.',
              '       (no parameters)',
              '  2. On “nobody could predict”: Say which scripts break.',
              '     The nightly export is one.',
              '     MACRO 1 of 2 on comment 2: /show-me',
              '       applies to: the text comment 2 quotes, “nobody could predict”, not the whole question',
              '       instruction: Show the operator what this looks like.',
              '         Use a picture.',
              '       focus = "the edge case"',
              '       depth = null',
              '     MACRO 2 of 2 on comment 2: /park',
              '       applies to: the text comment 2 quotes, “nobody could predict”, not the whole question',
              '       instruction: Stop work on this thread until asked.',
              '       (no parameters)',
              '  MACRO 1 of 1: /park',
              '    instruction: Stop work on this thread until asked.',
              '    (no parameters)',
            ].join('\n'),
          );
          const json = JSON.parse(
            yield* dispatchAnswers({ inboxId: ID, json: true }),
          );
          expect(json[0].comments).toStrictEqual([
            { ...CHECKLIST, text: '', macros: [PARK] },
            { ...NOBODY, macros: [SHOW_ME, PARK] },
          ]);
          expect(json[0].macros).toStrictEqual([PARK]);
        }),
      ),
  );

  it.effect('a comment of macros alone is a whole answer', () =>
    provide(
      Effect.gen(function* () {
        yield* opened;
        yield* commented('', [{ ...CHECKLIST, text: '', macros: [SHOW_ME] }]);
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
          [
            '#1 What next?',
            '  COMMENTS on the question (1):',
            '  1. On “checklist”: (no words; its macros only)',
            '     MACRO 1 of 1 on comment 1: /show-me',
            '       applies to: the text comment 1 quotes, “checklist”, not the whole question',
            '       instruction: Show the operator what this looks like.',
            '         Use a picture.',
            '       focus = "the edge case"',
            '       depth = null',
          ].join('\n'),
        );
      }),
    ),
  );

  it.effect('an answer with no comments has no block and no key', () =>
    provide(
      Effect.gen(function* () {
        yield* opened;
        yield* commented('Yes.', []);
        expect(
          yield* dispatchAnswers({ inboxId: ID, json: false }),
        ).not.toContain('COMMENTS');
        expect(
          JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true }))[0],
        ).not.toHaveProperty('comments');
      }),
    ),
  );
});
