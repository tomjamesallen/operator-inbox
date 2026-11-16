import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE,
  DEFAULT_INBOX_METADATA,
  InboxId,
  type InboxMetadataRules,
  METADATA_FILE,
  type Metadata,
  SessionId,
  withBuiltInKeys,
} from '@operator-inbox/core';
import { ConfigProvider, Effect, Option } from 'effect';
import { TestConsole } from 'effect/testing';
import {
  dispatchAsk,
  dispatchKeys,
  dispatchMeta,
  dispatchOpen,
  expectedKeysWarning,
  type InboxSession,
  readMetadataRules,
  renderMetadata,
} from '../src/commands/inbox';
import { envProvider } from '../src/env-config';
import { type InboxLog, InboxLogInMemory } from '../src/inbox-store';

// The Inbox's metadata rules at the CLI: `required` refuses before anything is
// written, `expected` warns on stderr, values are checked as given and never as
// stored, and nothing reads `prs` as `pr`. The warning is read
// off the TestConsole that `@effect/vitest` provides.

const SESSION: InboxSession = {
  sessionId: SessionId.make('session-a'),
  cwd: '/work/my-app',
};
const ID = InboxId.make('01PRIORAAAAAAAAAAAAAAAAAAA');
const EXPECTED = [
  'repo',
  'branch',
  'pr',
  'session',
  'sessionLink',
  'sessionTitle',
];

const RULES: InboxMetadataRules = {
  extras: 'allow',
  keys: [
    {
      key: 'team',
      type: 'string',
      description: 'The team slug',
      presence: 'required',
    },
    {
      key: 'repo',
      type: 'string',
      description: 'owner/repo',
      presence: 'expected',
      pattern: '^[^/]+/[^/]+$',
    },
    {
      key: 'model',
      type: 'object',
      description: 'Where this sits',
      presence: 'optional',
      keys: [
        {
          key: 'chapter',
          type: 'string',
          description: 'Chapter id',
          presence: 'required',
        },
      ],
    },
  ],
};

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

const open = (
  extra: {
    readonly metadata?: Metadata;
    readonly rules?: InboxMetadataRules;
  } = {},
) =>
  dispatchOpen({
    session: Option.some(SESSION),
    inbox: Option.none(),
    label: Option.some('my-app'),
    freshId: ID,
    cwd: '/plain/shell',
    ...extra,
  });

const ask = (
  extra: {
    readonly metadata?: Metadata;
    readonly rules?: InboxMetadataRules;
  } = {},
) => dispatchAsk({ inboxId: ID, title: 'Which?', body: '- a', ...extra });

const said = Effect.map(TestConsole.errorLines, (lines) => lines.map(String));

describe('inbox open', () => {
  it.effect('warns for each expected key a new inbox lacks, and opens it', () =>
    provide(
      Effect.gen(function* () {
        const out = yield* open({ rules: DEFAULT_INBOX_METADATA });
        expect(out).toContain('(opened)');
        expect(yield* said).toEqual([expectedKeysWarning(EXPECTED)]);
      }),
    ),
  );

  it.effect('says nothing when every key is set, or no rules are given', () =>
    provide(
      Effect.gen(function* () {
        yield* open({
          rules: DEFAULT_INBOX_METADATA,
          metadata: {
            team: 'a',
            repo: 'r',
            branch: 'b',
            pr: '1',
            session: 's',
            sessionLink: 'claude://claude.ai/epitaxy/local_a',
            sessionTitle: 'Port the store',
          },
        });
        yield* open();
        expect(yield* said).toEqual([]);
      }),
    ),
  );

  it.effect('does not read prs as pr: a near miss is still missing', () =>
    provide(
      Effect.gen(function* () {
        yield* open({
          rules: DEFAULT_INBOX_METADATA,
          metadata: { prs: 'https://github.com/o/r/pull/1' },
        });
        expect(yield* said).toEqual([expectedKeysWarning(EXPECTED)]);
      }),
    ),
  );

  it.effect('refuses a new inbox without a required key, writing nothing', () =>
    provide(
      Effect.gen(function* () {
        const refused = yield* Effect.flip(open({ rules: RULES }));
        expect(refused.message).toContain('required metadata not set: team');
        const opened = yield* open({
          rules: RULES,
          metadata: { team: 'a', repo: 'o/r' },
        });
        expect(opened).toContain('(opened)');
      }),
    ),
  );

  it.effect('refuses a value the rules do not allow', () =>
    provide(
      Effect.gen(function* () {
        const refused = yield* Effect.flip(
          open({ rules: RULES, metadata: { team: 'a', repo: 'nope' } }),
        );
        expect(refused.message).toContain('repo');
      }),
    ),
  );

  it.effect(
    'never refuses an inbox from before the rules: it warns on a repeat open',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open();
          const again = yield* open({ rules: RULES });
          expect(again).toContain("this session's");
          expect(yield* said).toEqual([expectedKeysWarning(['team', 'repo'])]);
        }),
      ),
  );
});

describe('inbox ask', () => {
  it.effect('refuses without a required key, recording no question', () =>
    provide(
      Effect.gen(function* () {
        yield* open();
        const refused = yield* Effect.flip(ask({ rules: RULES }));
        expect(refused.message).toContain('required metadata not set: team');
        expect(yield* ask({ metadata: { team: 'a' }, rules: RULES })).toBe(
          '#1',
        );
      }),
    ),
  );

  it.effect('counts a key on the Inbox as present, nested keys too', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ metadata: { team: 'a', model: { chapter: 'C02' } } });
        expect(
          yield* ask({ metadata: { model: { other: 'x' } }, rules: RULES }),
        ).toBe('#1');
        expect(yield* said).toEqual([expectedKeysWarning(['repo'])]);
      }),
    ),
  );

  it.effect('refuses a nested object without its required key', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ metadata: { team: 'a' } });
        const refused = yield* Effect.flip(
          ask({ metadata: { model: {} }, rules: RULES }),
        );
        expect(refused.message).toContain('model.chapter');
      }),
    ),
  );

  it.effect('checks the values given, not the ones already stored', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ metadata: { team: 'a', repo: 'no-slash' } });
        expect(yield* ask({ rules: RULES })).toBe('#1');
      }),
    ),
  );
});

describe('inbox meta', () => {
  it.effect('changes one key of an inbox without its required keys', () =>
    provide(
      Effect.gen(function* () {
        yield* open();
        const out = yield* dispatchMeta({
          inboxId: ID,
          set: { other: 'x' },
          unset: [],
          json: false,
          rules: RULES,
        });
        expect(out).toBe('other=x');
      }),
    ),
  );

  it.effect('refuses a value the rules do not allow', () =>
    provide(
      Effect.gen(function* () {
        yield* open();
        const refused = yield* Effect.flip(
          dispatchMeta({
            inboxId: ID,
            set: { repo: 'nope' },
            unset: [],
            json: false,
            rules: RULES,
          }),
        );
        expect(refused.message).toContain('repo');
      }),
    ),
  );

  it.effect('merges into an object and removes by a dotted path', () =>
    provide(
      Effect.gen(function* () {
        yield* open({ metadata: { model: { chapter: 'C02' } } });
        const merged = yield* dispatchMeta({
          inboxId: ID,
          set: { model: { slice: 's' } },
          unset: [],
          json: true,
        });
        expect(JSON.parse(merged)).toEqual({
          model: { chapter: 'C02', slice: 's' },
        });
        const removed = yield* dispatchMeta({
          inboxId: ID,
          set: {},
          unset: ['model.slice'],
          json: true,
        });
        expect(JSON.parse(removed)).toEqual({ model: { chapter: 'C02' } });
      }),
    ),
  );
});

describe('rendering', () => {
  it('prints a nested value as JSON', () => {
    expect(renderMetadata({ a: 'x', b: { c: [1] }, d: true })).toEqual([
      'a=x',
      'b={"c":[1]}',
      'd=true',
    ]);
  });
});

describe('this machine’s own metadata.json decides the rules', () => {
  // `config` is the metadata.json to write, or none.
  const underConfig = <A, E, R>(
    config: string | undefined,
    effect: Effect.Effect<A, E, R>,
  ) => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'operator-inbox-inbox-rules-'));
    if (config !== undefined) {
      mkdirSync(path.join(xdg, CONFIG_DIR_NAME));
      writeFileSync(path.join(xdg, CONFIG_DIR_NAME, METADATA_FILE), config);
    }
    return effect.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        envProvider({ XDG_CONFIG_HOME: xdg }),
      ),
      Effect.provide(NodeServices.layer),
    );
  };
  const configured = JSON.stringify(RULES);

  it.effect(
    'reads the default with no config, and the rules from the file',
    () =>
      Effect.gen(function* () {
        expect(yield* underConfig(undefined, readMetadataRules)).toEqual(
          DEFAULT_INBOX_METADATA,
        );
        expect(yield* underConfig(configured, readMetadataRules)).toEqual(
          withBuiltInKeys(RULES),
        );
      }),
  );

  it.effect('says why, on stderr, and applies none, for unusable rules', () =>
    Effect.gen(function* () {
      const rules = yield* underConfig(
        '{"keys":3,"extras":"allow"}',
        readMetadataRules,
      );
      expect(rules).toBeUndefined();
      expect((yield* said)[0]).toContain('metadata rules not applied');
      expect((yield* said)[0]).toContain('metadata.json');
    }),
  );

  it.effect('a config.json that does not load leaves the rules alone', () =>
    Effect.gen(function* () {
      const xdg = mkdtempSync(
        path.join(tmpdir(), 'operator-inbox-inbox-rules-'),
      );
      mkdirSync(path.join(xdg, CONFIG_DIR_NAME));
      writeFileSync(
        path.join(xdg, CONFIG_DIR_NAME, CONFIG_FILE),
        '{"serve":{"tailnet":3}}',
      );
      const rules = yield* readMetadataRules.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          envProvider({ XDG_CONFIG_HOME: xdg }),
        ),
        Effect.provide(NodeServices.layer),
      );
      expect(rules).toEqual(DEFAULT_INBOX_METADATA);
      expect(yield* said).toEqual([]);
    }),
  );

  it.effect('`inbox keys` prints a key to a line, or the rules as JSON', () =>
    Effect.gen(function* () {
      const text = yield* underConfig(
        configured,
        dispatchKeys({ json: false }),
      );
      expect(text.split('\n')).toEqual([
        'team  string  required  both  The team slug',
        'repo  string  expected  both  owner/repo',
        'model  object  optional  both  Where this sits',
        '  chapter  string  required  Chapter id',
        'session  string  expected  inbox  The Claude session id',
        'sessionLink  string  expected  inbox  The link that opens the session working this Inbox; the CLI fills it in a desktop session',
        'sessionTitle  string  expected  inbox  The title of the desktop session working this Inbox; the CLI fills it in a desktop session',
        'extras: allow',
      ]);
      expect(
        JSON.parse(
          yield* underConfig(configured, dispatchKeys({ json: true })),
        ),
      ).toEqual(withBuiltInKeys(RULES));
      expect(
        (yield* underConfig(undefined, dispatchKeys({ json: false }))).split(
          '\n',
        )[0],
      ).toContain('repo');
    }),
  );
});
