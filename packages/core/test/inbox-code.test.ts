import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  CODE_SUFFIX_COUNT,
  codeHolders,
  codeSuffixAt,
  decideAssignCode,
  decideProcess,
  derivedCodeSuffixes,
  FALLBACK_CODE_PREFIX,
  firstFreeCode,
  type InboxEvent,
  InboxId,
  inboxCodeOf,
  inboxCodePrefix,
  inboxState,
  parseInboxCode,
  parseQuestionCode,
  QuestionNumber,
  questionCode,
  questionRef,
  summariseInbox,
} from '../src';
import { InboxCode } from '../src/schema';

// Question codes: the pure half. The suffix is always handed in, so every
// test here names it.

const A = InboxId.make('01INBOXAAAAAAAAAAAAAAAAAAA');
const B = InboxId.make('01INBOXBBBBBBBBBBBBBBBBBBB');
const code = InboxCode.make;

const opened = (inboxId: InboxId, label: string): InboxEvent => ({
  _tag: 'InboxOpened',
  inboxId,
  label,
});
const assigned = (inboxId: InboxId, c: string): InboxEvent => ({
  _tag: 'InboxCodeAssigned',
  inboxId,
  code: code(c),
});

describe('inboxCodePrefix', () => {
  it('takes the first two ASCII letters of the name, lower-cased', () => {
    expect(inboxCodePrefix('Operator inbox')).toBe('op');
    expect(inboxCodePrefix('  3D Printer queue')).toBe('dp');
    expect(inboxCodePrefix('a-b')).toBe('ab');
  });

  it('takes accents off before it looks', () => {
    expect(inboxCodePrefix('Écrire la doc')).toBe('ec');
  });

  it('falls back when the name has fewer than two letters', () => {
    expect(FALLBACK_CODE_PREFIX).toBe('ib');
    expect(inboxCodePrefix('X 2026')).toBe('ib');
    expect(inboxCodePrefix('2026')).toBe('ib');
    expect(inboxCodePrefix('测试')).toBe('ib');
  });
});

describe('codeSuffixAt', () => {
  it('numbers every three-letter suffix, aaa first and zzz last', () => {
    expect(CODE_SUFFIX_COUNT).toBe(17_576);
    expect(codeSuffixAt(0)).toBe('aaa');
    expect(codeSuffixAt(1)).toBe('aab');
    expect(codeSuffixAt(26)).toBe('aba');
    expect(codeSuffixAt(CODE_SUFFIX_COUNT - 1)).toBe('zzz');
  });

  it('wraps a number outside the range', () => {
    expect(codeSuffixAt(CODE_SUFFIX_COUNT)).toBe('aaa');
    expect(codeSuffixAt(-1)).toBe('zzz');
  });
});

describe('derivedCodeSuffixes', () => {
  it('is the same every time for the same Inbox, and differs between Inboxes', () => {
    const first = derivedCodeSuffixes(A, 8);
    expect(derivedCodeSuffixes(A, 8)).toStrictEqual(first);
    expect(first).toHaveLength(8);
    for (const s of first) expect(s).toMatch(/^[a-z]{3}$/);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(derivedCodeSuffixes(B, 8)).not.toStrictEqual(first);
  });
});

describe('question codes', () => {
  it('joins the Inbox code and the number', () => {
    expect(questionCode('op-asv', 12)).toBe('op-asv#12');
    expect(questionRef('op-asv', 12)).toBe('op-asv#12');
    expect(questionRef(undefined, 12)).toBe('#12');
  });

  it('parses a code back, in any case, and nothing else', () => {
    expect(parseQuestionCode('op-asv#12')).toStrictEqual({
      code: 'op-asv',
      number: 12,
    });
    expect(parseQuestionCode(' OP-ASV#3 ')).toStrictEqual({
      code: 'op-asv',
      number: 3,
    });
    for (const bad of [
      '12',
      '#12',
      'op-asv',
      'op-asv#0',
      'op-asv#',
      'o-asv#1',
      'op-asvx#1',
      'op-as1#1',
    ])
      expect(parseQuestionCode(bad)).toBeUndefined();
    expect(parseInboxCode('Op-Asv')).toBe('op-asv');
    expect(parseInboxCode('op-asv#1')).toBeUndefined();
    expect(parseInboxCode('01INBOXAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
  });
});

describe('the fold', () => {
  it('keeps the first code an Inbox is given, through a rename', () => {
    const state = inboxState([
      opened(A, 'Operator inbox'),
      assigned(A, 'op-asv'),
      { _tag: 'InboxRenamed', inboxId: A, label: 'Something else' },
      assigned(A, 'op-zzz'),
    ]);
    expect(state.code).toBe('op-asv');
    expect(state.label).toBe('Something else');
    expect(summariseInbox(A, state, 1).code).toBe('op-asv');
  });

  it('leaves an Inbox with no assignment without a code', () => {
    const state = inboxState([opened(A, 'Old inbox')]);
    expect('code' in state).toBe(false);
    expect('code' in summariseInbox(A, state, 1)).toBe(false);
  });
});

describe('who holds a code', () => {
  const events = [assigned(A, 'op-asv'), assigned(B, 'op-bbb')];

  it('is the Inbox whose first assignment gave it the code', () => {
    expect(codeHolders(code('op-asv'), events)).toStrictEqual([A]);
    expect(codeHolders(code('op-ccc'), events)).toStrictEqual([]);
    // A second assignment to an Inbox never moves its code.
    expect(
      codeHolders(code('op-ccc'), [...events, assigned(A, 'op-ccc')]),
    ).toStrictEqual([]);
  });

  it('picks the first candidate no other Inbox holds', () => {
    const candidates = ['op-asv', 'op-bbb', 'op-ccc'].map((c) => code(c));
    const C = InboxId.make('01INBOXCCCCCCCCCCCCCCCCCCC');
    expect(firstFreeCode({ candidates, self: C, codeEvents: events })).toBe(
      'op-ccc',
    );
    // An Inbox's own code is not taken from it.
    expect(firstFreeCode({ candidates, self: B, codeEvents: events })).toBe(
      'op-bbb',
    );
    expect(
      firstFreeCode({
        candidates: candidates.slice(0, 2),
        self: C,
        codeEvents: events,
      }),
    ).toBeUndefined();
  });
});

describe('decideAssignCode', () => {
  const fresh = inboxState([opened(A, 'Operator inbox')]);

  it('assigns the code it is given', () => {
    const decided = decideAssignCode(fresh, {
      inboxId: A,
      code: inboxCodeOf('op', 'asv'),
    });
    expect(decided).toStrictEqual(
      Result.succeed({
        _tag: 'InboxCodeAssigned',
        inboxId: A,
        code: 'op-asv',
      }),
    );
  });

  it('refuses an Inbox that has one, an Inbox that does not exist, and no free code', () => {
    const reason = (r: ReturnType<typeof decideAssignCode>) =>
      Result.isFailure(r) ? r.failure.reason : 'succeeded';
    const coded = inboxState([
      opened(A, 'Operator inbox'),
      assigned(A, 'op-asv'),
    ]);
    expect(
      reason(decideAssignCode(coded, { inboxId: A, code: code('op-bbb') })),
    ).toBe('unchanged');
    expect(
      reason(
        decideAssignCode(inboxState([]), { inboxId: A, code: code('op-bbb') }),
      ),
    ).toBe('not-found');
    expect(
      reason(decideAssignCode(fresh, { inboxId: A, code: undefined })),
    ).toBe('code-taken');
  });
});

describe('a refusal', () => {
  it('names the question by its code once its Inbox has one', () => {
    const asked: InboxEvent = {
      _tag: 'QuestionAsked',
      inboxId: A,
      number: QuestionNumber.make(1),
      title: 'One',
      body: '',
    };
    const refusal = (events: ReadonlyArray<InboxEvent>) => {
      const r = decideProcess(inboxState(events), {
        inboxId: A,
        number: QuestionNumber.make(1),
      });
      return Result.isFailure(r) ? r.failure.message : '';
    };
    expect(
      refusal([opened(A, 'Operator inbox'), assigned(A, 'op-asv'), asked]),
    ).toBe('op-asv#1 has not been answered yet, so it cannot be processed');
    expect(refusal([opened(A, 'Operator inbox'), asked])).toBe(
      '#1 has not been answered yet, so it cannot be processed',
    );
  });
});
