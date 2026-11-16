import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  CODE_COUNT,
  codeAt,
  codeHolders,
  decideAssignCode,
  decideProcess,
  decideShortenCode,
  derivedCodes,
  firstFreeCode,
  formerCodeHolders,
  type InboxEvent,
  InboxId,
  inboxState,
  lettersOfNamedCode,
  parseInboxCode,
  parseQuestionCode,
  QuestionNumber,
  questionCode,
  questionRef,
  summariseInbox,
} from '../src';
import { InboxCode } from '../src/schema';

// Question codes: the pure half. The letters are always handed in, so every
// test here names them.

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
const changed = (inboxId: InboxId, from: string, to: string): InboxEvent => ({
  _tag: 'InboxCodeChanged',
  inboxId,
  from: code(from),
  code: code(to),
});

describe('codeAt', () => {
  it('numbers every three-letter code, aaa first and zzz last', () => {
    expect(CODE_COUNT).toBe(17_576);
    expect(codeAt(0)).toBe('aaa');
    expect(codeAt(1)).toBe('aab');
    expect(codeAt(26)).toBe('aba');
    expect(codeAt(CODE_COUNT - 1)).toBe('zzz');
  });

  it('wraps a number outside the range', () => {
    expect(codeAt(CODE_COUNT)).toBe('aaa');
    expect(codeAt(-1)).toBe('zzz');
  });
});

describe('derivedCodes', () => {
  it('is the same every time for the same Inbox, and differs between Inboxes', () => {
    const first = derivedCodes(A, 8);
    expect(derivedCodes(A, 8)).toStrictEqual(first);
    expect(first).toHaveLength(8);
    for (const s of first) expect(s).toMatch(/^[a-z]{3}$/);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(derivedCodes(B, 8)).not.toStrictEqual(first);
  });
});

describe('question codes', () => {
  it('joins the Inbox code and the number', () => {
    expect(questionCode('toe', 14)).toBe('toe#14');
    expect(questionRef('toe', 14)).toBe('toe#14');
    expect(questionRef(undefined, 12)).toBe('#12');
  });

  it('parses a code back, in any case, and nothing else', () => {
    expect(parseQuestionCode('toe#14')).toStrictEqual({
      code: 'toe',
      number: 14,
    });
    expect(parseQuestionCode(' TOE#3 ')).toStrictEqual({
      code: 'toe',
      number: 3,
    });
    for (const bad of [
      '12',
      '#12',
      'toe',
      'toe#0',
      'toe#',
      'to#1',
      'toex#1',
      'to1#1',
      'o-toe#1',
      'op-toex#1',
      'op_toe#1',
    ])
      expect(parseQuestionCode(bad)).toBeUndefined();
    expect(parseInboxCode('Toe')).toBe('toe');
    expect(parseInboxCode('toe#1')).toBeUndefined();
    expect(parseInboxCode('to')).toBeUndefined();
    expect(parseInboxCode('01INBOXAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
  });

  it('still reads the older named form, kept as given', () => {
    expect(parseQuestionCode('OP-TOE#14')).toStrictEqual({
      code: 'op-toe',
      number: 14,
    });
    expect(parseInboxCode('op-toe')).toBe('op-toe');
    expect(lettersOfNamedCode('op-toe')).toBe('toe');
    expect(lettersOfNamedCode('toe')).toBeUndefined();
  });
});

describe('the fold', () => {
  it('keeps the first code an Inbox is given, through a rename', () => {
    const state = inboxState([
      opened(A, 'Operator inbox'),
      assigned(A, 'asv'),
      { _tag: 'InboxRenamed', inboxId: A, label: 'Something else' },
      assigned(A, 'zzz'),
    ]);
    expect(state.code).toBe('asv');
    expect(state.label).toBe('Something else');
    expect(summariseInbox(A, state, 1).code).toBe('asv');
  });

  it('leaves an Inbox with no assignment without a code', () => {
    const state = inboxState([opened(A, 'Old inbox')]);
    expect('code' in state).toBe(false);
    expect('code' in summariseInbox(A, state, 1)).toBe(false);
  });
});

describe('who holds a code', () => {
  const events = [assigned(A, 'asv'), assigned(B, 'bbb')];

  it('is the Inbox whose first assignment gave it the code', () => {
    expect(codeHolders(code('asv'), events)).toStrictEqual([A]);
    expect(codeHolders(code('ccc'), events)).toStrictEqual([]);
    // A second assignment to an Inbox never moves its code.
    expect(
      codeHolders(code('ccc'), [...events, assigned(A, 'ccc')]),
    ).toStrictEqual([]);
  });

  it('picks the first candidate no other Inbox holds', () => {
    const candidates = ['asv', 'bbb', 'ccc'].map((c) => code(c));
    const C = InboxId.make('01INBOXCCCCCCCCCCCCCCCCCCC');
    expect(firstFreeCode({ candidates, self: C, codeEvents: events })).toBe(
      'ccc',
    );
    // An Inbox's own code is not taken from it.
    expect(firstFreeCode({ candidates, self: B, codeEvents: events })).toBe(
      'bbb',
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
      code: code('asv'),
    });
    expect(decided).toStrictEqual(
      Result.succeed({
        _tag: 'InboxCodeAssigned',
        inboxId: A,
        code: 'asv',
      }),
    );
  });

  it('refuses an Inbox that has one, an Inbox that does not exist, and no free code', () => {
    const reason = (r: ReturnType<typeof decideAssignCode>) =>
      Result.isFailure(r) ? r.failure.reason : 'succeeded';
    const coded = inboxState([opened(A, 'Operator inbox'), assigned(A, 'asv')]);
    expect(
      reason(decideAssignCode(coded, { inboxId: A, code: code('bbb') })),
    ).toBe('unchanged');
    expect(
      reason(
        decideAssignCode(inboxState([]), { inboxId: A, code: code('bbb') }),
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
      refusal([opened(A, 'Operator inbox'), assigned(A, 'asv'), asked]),
    ).toBe('asv#1 has not been answered yet, so it cannot be processed');
    expect(refusal([opened(A, 'Operator inbox'), asked])).toBe(
      '#1 has not been answered yet, so it cannot be processed',
    );
  });
});

describe('moving a named code to three letters', () => {
  it('folds a change only from the code the Inbox holds', () => {
    const state = inboxState([
      opened(A, 'Operator inbox'),
      assigned(A, 'op-toe'),
      changed(A, 'xx-abc', 'abc'),
      changed(A, 'op-toe', 'toe'),
    ]);
    expect(state.code).toBe('toe');
  });

  it('frees the older code and holds the new one, read through either tag', () => {
    const asOld = [assigned(A, 'op-toe'), changed(A, 'op-toe', 'toe')];
    expect(codeHolders(code('op-toe'), asOld)).toStrictEqual([]);
    expect(formerCodeHolders(code('op-toe'), asOld)).toStrictEqual([A]);
    // The new code's tag holds only the change.
    const asNew = [changed(A, 'op-toe', 'toe')];
    expect(codeHolders(code('toe'), asNew)).toStrictEqual([A]);
    expect(formerCodeHolders(code('toe'), asNew)).toStrictEqual([]);
  });

  it('keeps the three letters, or takes the next candidate when they are held', () => {
    const fresh = inboxState([opened(B, 'Operations'), assigned(B, 'ab-toe')]);
    const codeEvents = [assigned(A, 'op-toe'), changed(A, 'op-toe', 'toe')];
    const candidates = ['toe', 'qrs'].map((c) => code(c));
    const free = firstFreeCode({ candidates, self: B, codeEvents });
    expect(free).toBe('qrs');
    expect(decideShortenCode(fresh, { inboxId: B, code: free })).toStrictEqual(
      Result.succeed({
        _tag: 'InboxCodeChanged',
        inboxId: B,
        from: 'ab-toe',
        code: 'qrs',
      }),
    );
  });

  it('leaves alone an Inbox already in the current form, or with no code', () => {
    const reason = (r: ReturnType<typeof decideShortenCode>) =>
      Result.isFailure(r) ? r.failure.reason : 'succeeded';
    const short = inboxState([opened(A, 'Operator inbox'), assigned(A, 'toe')]);
    expect(
      reason(decideShortenCode(short, { inboxId: A, code: code('abc') })),
    ).toBe('unchanged');
    const none = inboxState([opened(A, 'Operator inbox')]);
    expect(
      reason(decideShortenCode(none, { inboxId: A, code: code('abc') })),
    ).toBe('unchanged');
    const named = inboxState([
      opened(A, 'Operator inbox'),
      assigned(A, 'op-toe'),
    ]);
    expect(
      reason(decideShortenCode(named, { inboxId: A, code: undefined })),
    ).toBe('code-taken');
    expect(
      reason(
        decideShortenCode(inboxState([]), { inboxId: A, code: code('abc') }),
      ),
    ).toBe('not-found');
  });
});
