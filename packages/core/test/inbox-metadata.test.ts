import { describe, expect, it } from '@effect/vitest';
import { Result, Schema } from 'effect';
import { decideInboxMetadata, type InboxEvent, inboxState } from '../src/inbox';
import {
  DEFAULT_INBOX_METADATA,
  desktopSessionOfFile,
  type InboxMetadataRules,
  isSessionLink,
  keysAtLevel,
  Metadata,
  mergeMetadata,
  metadataEquals,
  metadataFromFlags,
  metadataPatch,
  metadataRulesProblems,
  metadataText,
  metadataValueProblem,
  missingMetadata,
  SESSION_LINK_PATTERN,
  SessionLink,
  withSessionLink,
} from '../src/inbox-metadata';
import { InboxId, SessionId } from '../src/schema/identifiers';

const linkOf = (content: string, id: SessionId) =>
  desktopSessionOfFile(content, id)?.link;

// A worked example: keys of every type, a nested
// object and a list of objects.
const RULES: InboxMetadataRules = {
  extras: 'allow',
  keys: [
    {
      key: 'team',
      type: 'string',
      description: 'The team name',
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
      key: 'urgent',
      type: 'boolean',
      description: 'Needs an answer today',
      presence: 'optional',
    },
    {
      key: 'attempt',
      type: 'number',
      description: 'Which try this is',
      presence: 'optional',
    },
    {
      key: 'reviewers',
      type: 'array',
      of: 'string',
      description: 'Who should look',
      presence: 'optional',
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
        {
          key: 'slice',
          type: 'string',
          description: 'Slice id',
          presence: 'optional',
        },
      ],
    },
    {
      key: 'links',
      type: 'array',
      of: 'object',
      description: 'Related resources',
      presence: 'optional',
      keys: [
        {
          key: 'url',
          type: 'string',
          description: 'Where it is',
          presence: 'required',
        },
      ],
    },
  ],
};

const EXAMPLE = {
  team: 'example-team',
  repo: 'example-owner/example-repo',
  urgent: true,
  attempt: 2,
  reviewers: ['Alex'],
  model: { chapter: 'C02', slice: 'terms-edit' },
  links: [{ url: 'https://example.com/spec', title: 'Spec' }],
  scratch: { anything: [1, 'two', false] },
};

describe('the Metadata value', () => {
  const decode = Schema.decodeUnknownResult(Metadata);

  it('holds every shape the operator set out, and an old flat dictionary', () => {
    expect(Result.isSuccess(decode(EXAMPLE))).toBe(true);
    expect(Result.isSuccess(decode({ team: 'a', pr: '1' }))).toBe(true);
    expect(Result.isSuccess(decode({ a: [{ b: [{ c: 1 }] }] }))).toBe(true);
  });

  it('refuses what the shape leaves out', () => {
    expect(Result.isFailure(decode({ a: null }))).toBe(true);
    expect(Result.isFailure(decode({ a: [[1]] }))).toBe(true);
    expect(Result.isFailure(decode({ a: [1, { b: 2 }] }))).toBe(true);
    expect(Result.isFailure(decode({ a: Number.NaN }))).toBe(true);
  });

  it('replays through the log: a nested change folds whole', () => {
    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeSync(Metadata)(EXAMPLE)),
    );
    expect(Schema.decodeUnknownSync(Metadata)(encoded)).toEqual(EXAMPLE);
  });
});

describe('the compiled rules', () => {
  it('passes the example, extras included', () => {
    expect(metadataValueProblem(RULES, EXAMPLE)).toBeUndefined();
  });

  it('names a value of the wrong type, at any depth', () => {
    expect(metadataValueProblem(RULES, { attempt: 'two' })).toContain(
      'attempt',
    );
    expect(metadataValueProblem(RULES, { model: { slice: 1 } })).toContain(
      'slice',
    );
    expect(metadataValueProblem(RULES, { links: [{ url: 1 }] })).toContain(
      'url',
    );
    expect(metadataValueProblem(RULES, { reviewers: 'Alex' })).toContain(
      'reviewers',
    );
  });

  it('applies a pattern', () => {
    expect(metadataValueProblem(RULES, { repo: 'nope' })).toContain('repo');
    expect(metadataValueProblem(RULES, { repo: 'o/r' })).toBeUndefined();
  });

  it('refuses extras only when told to, at every depth', () => {
    const closed: InboxMetadataRules = { ...RULES, extras: 'refuse' };
    expect(metadataValueProblem(closed, { scratch: 'x' })).toContain('scratch');
    expect(
      metadataValueProblem(closed, { model: { chapter: 'C', other: 'x' } }),
    ).toContain('other');
    expect(metadataValueProblem(RULES, { scratch: 'x' })).toBeUndefined();
  });

  it('does not ask for presence: an older Inbox can change one key', () => {
    expect(metadataValueProblem(RULES, { urgent: true })).toBeUndefined();
  });
});

describe('missingMetadata', () => {
  it('names top-level keys by presence, in the rules’ order', () => {
    expect(missingMetadata(RULES.keys, {}, 'required')).toEqual(['team']);
    expect(missingMetadata(RULES.keys, {}, 'expected')).toEqual(['repo']);
  });

  it('asks for a nested key only where its parent is there', () => {
    expect(missingMetadata(RULES.keys, { team: 'a' }, 'required')).toEqual([]);
    expect(
      missingMetadata(RULES.keys, { team: 'a', model: {} }, 'required'),
    ).toEqual(['model.chapter']);
  });

  it('names a list’s object key once, however many items lack it', () => {
    expect(
      missingMetadata(
        RULES.keys,
        { team: 'a', links: [{ title: 'x' }, { title: 'y' }] },
        'required',
      ),
    ).toEqual(['links[].url']);
  });

  it('counts a blank value as not set, and a near miss as no match', () => {
    expect(missingMetadata(RULES.keys, { team: '  ' }, 'required')).toEqual([
      'team',
    ]);
    expect(missingMetadata(RULES.keys, { teams: 'a' }, 'required')).toEqual([
      'team',
    ]);
  });
});

describe('metadataRulesProblems', () => {
  const key = {
    key: 'k',
    type: 'string',
    description: 'd',
    presence: 'optional',
  } as const;
  const problems = (keys: InboxMetadataRules['keys']) =>
    metadataRulesProblems({ keys, extras: 'allow' });

  it('passes the example', () => {
    expect(metadataRulesProblems(RULES)).toEqual([]);
  });

  it('names a key listed twice, a dot, and a bad pattern', () => {
    expect(problems([key, key])[0]).toContain('k is listed twice');
    expect(problems([{ ...key, key: 'a.b' }])[0]).toContain('a.b');
    expect(problems([{ ...key, pattern: '(' }])[0]).toContain('pattern');
  });

  it('names a shape that does not hang together, by its full path', () => {
    expect(problems([{ ...key, type: 'array' }])[0]).toContain('`of`');
    expect(problems([{ ...key, of: 'string' }])[0]).toContain('`of`');
    expect(problems([{ ...key, type: 'object' }])[0]).toContain('`keys`');
    expect(problems([{ ...key, keys: [] }])[0]).toContain('`keys`');
    expect(problems([{ ...key, type: 'number', pattern: 'a' }])[0]).toContain(
      '`pattern`',
    );
    expect(
      problems([{ ...key, type: 'object', keys: [key, key] }])[0],
    ).toContain('k.k is listed twice');
  });

  it('keeps `group` a string, at the top level only', () => {
    expect(problems([{ ...key, key: 'group', type: 'number' }])[0]).toContain(
      'group',
    );
    expect(
      problems([
        {
          ...key,
          type: 'object',
          keys: [{ ...key, key: 'group', type: 'number' }],
        },
      ]),
    ).toEqual([]);
  });
});

describe('metadataFromFlags', () => {
  const parsed = (
    text: Record<string, string>,
    json: Record<string, string> = {},
  ) => metadataFromFlags(text, json, RULES);

  it('lets the rules type text, and leaves undeclared text alone', () => {
    expect(
      parsed({ attempt: '2', urgent: 'true', reviewers: 'Alex', other: '2' }),
    ).toEqual(
      Result.succeed({
        attempt: 2,
        urgent: true,
        reviewers: ['Alex'],
        other: '2',
      }),
    );
  });

  it('leaves text that cannot be the type for the rules to name', () => {
    expect(parsed({ attempt: 'two' })).toEqual(
      Result.succeed({ attempt: 'two' }),
    );
  });

  it('reaches into objects with dots, and keeps every value text with no rules', () => {
    expect(parsed({ 'model.chapter': 'C02', 'model.slice': 's' })).toEqual(
      Result.succeed({ model: { chapter: 'C02', slice: 's' } }),
    );
    expect(metadataFromFlags({ attempt: '2' }, {})).toEqual(
      Result.succeed({ attempt: '2' }),
    );
  });

  it('takes JSON for a list or an object', () => {
    expect(parsed({}, { links: '[{"url":"https://x?a=1"}]' })).toEqual(
      Result.succeed({ links: [{ url: 'https://x?a=1' }] }),
    );
  });

  it('refuses bad JSON, null, an empty step and overlapping paths', () => {
    expect(Result.isFailure(parsed({}, { a: '{' }))).toBe(true);
    expect(Result.isFailure(parsed({}, { a: 'null' }))).toBe(true);
    expect(Result.isFailure(parsed({ 'a..b': 'x' }))).toBe(true);
    expect(Result.isFailure(parsed({ a: 'x', 'a.b': 'y' }))).toBe(true);
  });
});

describe('metadataPatch', () => {
  it('merges into an object and records the whole top-level key', () => {
    expect(
      metadataPatch({ model: { chapter: 'C' } }, { model: { slice: 's' } }, []),
    ).toEqual(
      Result.succeed({
        set: { model: { chapter: 'C', slice: 's' } },
        unset: [],
      }),
    );
  });

  it('takes a nested key out, and a parent it empties', () => {
    expect(
      metadataPatch({ model: { chapter: 'C', slice: 's' } }, {}, [
        'model.slice',
      ]),
    ).toEqual(Result.succeed({ set: { model: { chapter: 'C' } }, unset: [] }));
    expect(
      metadataPatch({ model: { slice: 's' } }, {}, ['model.slice']),
    ).toEqual(Result.succeed({ set: {}, unset: ['model'] }));
  });

  it('keeps a key written with a dot before nesting', () => {
    expect(metadataPatch({ 'a.b': 'x' }, {}, ['a.b'])).toEqual(
      Result.succeed({ set: {}, unset: ['a.b'] }),
    );
  });

  it('refuses a path both set and removed, and drops what does not change', () => {
    expect(
      Result.isFailure(metadataPatch({}, { model: { a: '1' } }, ['model.a'])),
    ).toBe(true);
    expect(metadataPatch({ a: ['x'] }, { a: ['x'] }, ['gone'])).toEqual(
      Result.succeed({ set: {}, unset: [] }),
    );
  });
});

describe('the decisions on nested metadata', () => {
  const inboxId = InboxId.make('01METADATAAAAAAAAAAAAAAAAA');
  const OPENED: InboxEvent = { _tag: 'InboxOpened', inboxId, label: 'x' };
  const opened = inboxState([OPENED]);

  it('refuses a `group` that is not a string', () => {
    const decided = decideInboxMetadata(opened, {
      inboxId,
      set: { group: 1 },
      unset: [],
    });
    expect(Result.isFailure(decided)).toBe(true);
  });

  it('refuses a nested change that changes nothing', () => {
    const changed = decideInboxMetadata(opened, {
      inboxId,
      set: { model: { b: 1, a: 2 } },
      unset: [],
    });
    if (Result.isFailure(changed)) throw changed.failure;
    const state = inboxState([OPENED, changed.success]);
    expect(state.metadata).toEqual({ model: { b: 1, a: 2 } });
    const again = decideInboxMetadata(state, {
      inboxId,
      set: { model: { a: 2, b: 1 } },
      unset: [],
    });
    expect(Result.isFailure(again) && again.failure.reason).toBe('unchanged');
  });
});

describe('helpers', () => {
  it('compares whatever the key order, and tells lists from objects', () => {
    expect(metadataEquals({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(metadataEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(metadataEquals(['a'], { 0: 'a' })).toBe(false);
  });

  it('merges objects and replaces anything else', () => {
    expect(
      mergeMetadata({ a: { b: 1 }, c: [1] }, { a: { d: 2 }, c: [2] }),
    ).toEqual({ a: { b: 1, d: 2 }, c: [2] });
  });

  it('writes a value as text', () => {
    expect(metadataText('a')).toBe('a');
    expect(metadataText(2)).toBe('2');
    expect(metadataText({ a: [1] })).toBe('{"a":[1]}');
    expect(metadataText(undefined)).toBe('');
  });
});

describe('the session link', () => {
  const LINK = 'claude://claude.ai/epitaxy/local_0a1b-2c3d';
  const CLI = SessionId.make('5864bf61-865e-4e99-a732-06c14e89bb50');
  const file = (more: object = {}) =>
    JSON.stringify({
      sessionId: 'local_0a1b-2c3d',
      cliSessionId: CLI,
      ...more,
    });

  it('takes a whole link and nothing near one', () => {
    expect(isSessionLink(LINK)).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'claude://claude.ai/epitaxy/0a1b',
      'claude://evil.ai/epitaxy/local_0a1b',
      'claude://claudeXai/epitaxy/local_0a1b',
      'claude://claude.ai/code/local_0a1b',
      `${LINK}/more`,
      `${LINK}?x=1`,
      `${LINK}#x`,
      `${LINK}\n`,
      ` ${LINK}`,
      'claude://claude.ai/epitaxy/local_',
      `claude://claude.ai/epitaxy/local_${'a'.repeat(65)}`,
      'https://claude.ai/epitaxy/local_0a1b',
      7,
    ])
      expect(isSessionLink(bad)).toBe(false);
  });

  it('is the operator’s regex, which a rule’s pattern can hold', () => {
    expect(SESSION_LINK_PATTERN).toBe(
      String.raw`^claude://claude\.ai/epitaxy/local_[A-Za-z0-9-]{1,64}$`,
    );
    const rule = DEFAULT_INBOX_METADATA.keys.find(
      (k) => k.key === 'sessionLink',
    );
    expect(rule).toMatchObject({
      pattern: SESSION_LINK_PATTERN,
      presence: 'expected',
      level: 'inbox',
    });
    expect(metadataRulesProblems(DEFAULT_INBOX_METADATA)).toEqual([]);
  });

  it('reads the link out of the file of this session', () => {
    expect(linkOf(file(), CLI)).toBe(LINK);
  });

  it('reads the title beside the link, and a bad one costs only the title', () => {
    const read = (title: unknown) => desktopSessionOfFile(file({ title }), CLI);
    expect(read('Inbox fixes')).toEqual({ link: LINK, title: 'Inbox fixes' });
    expect(read('  ')).toEqual({ link: LINK });
    expect(read(7)).toEqual({ link: LINK });
  });

  it('says nothing of another session’s file, or of one it cannot read', () => {
    expect(linkOf(file(), SessionId.make('other'))).toBeUndefined();
    expect(linkOf('{not json', CLI)).toBeUndefined();
    expect(linkOf(file({ cliSessionId: null }), CLI)).toBeUndefined();
    expect(linkOf(JSON.stringify({ cliSessionId: CLI }), CLI)).toBeUndefined();
  });

  it('makes no link of an id that would not be one', () => {
    for (const sessionId of ['0a1b', 'local_a/b', 'local_a?b=c'])
      expect(linkOf(file({ sessionId }), CLI)).toBeUndefined();
  });

  it('fills the key, and a value the agent passed wins', () => {
    const link = SessionLink.make(LINK);
    expect(withSessionLink(undefined, link)).toEqual({ sessionLink: LINK });
    expect(withSessionLink({ team: 'a' }, link)).toEqual({
      team: 'a',
      sessionLink: LINK,
    });
    const own = { sessionLink: 'claude://claude.ai/epitaxy/local_mine' };
    expect(withSessionLink(own, link)).toEqual(own);
    expect(withSessionLink(undefined, undefined)).toBeUndefined();
    expect(withSessionLink({ team: 'a' }, undefined)).toEqual({ team: 'a' });
  });
});

describe('a key’s level', () => {
  const key = (name: string, level?: 'inbox' | 'question') => ({
    key: name,
    type: 'string' as const,
    description: name,
    presence: 'required' as const,
    ...(level === undefined ? {} : { level }),
  });
  const keys = [key('both'), key('i', 'inbox'), key('q', 'question')];

  it('counts a key at its level, and unset at both', () => {
    const names = (level: 'inbox' | 'question') =>
      keysAtLevel(keys, level).map((k) => k.key);
    expect(names('inbox')).toEqual(['both', 'i']);
    expect(names('question')).toEqual(['both', 'q']);
  });

  it('is refused on a nested key, and only there', () => {
    const nested = {
      ...key('model'),
      type: 'object' as const,
      keys: [key('chapter', 'inbox')],
    };
    expect(metadataRulesProblems({ keys: [nested], extras: 'allow' })).toEqual([
      'model.chapter has `level`, which only a top-level key takes',
    ]);
    expect(metadataRulesProblems({ keys, extras: 'allow' })).toEqual([]);
  });

  it('never decides where a value may be written', () => {
    const rules = { keys, extras: 'refuse' as const };
    expect(metadataValueProblem(rules, { i: 'x', q: 'y' })).toBeUndefined();
    expect(metadataValueProblem(rules, { i: 7 })).toBeDefined();
  });
});
