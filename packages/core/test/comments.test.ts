import { describe, expect, it } from '@effect/vitest';
import { Result, Schema } from 'effect';
import {
  commentsInBodyOrder,
  MAX_COMMENTS_PER_ANSWER,
  type QuestionComment,
} from '../src/comments';
import {
  decideAnswer,
  decideMove,
  type InboxEvent,
  inboxState,
  MAX_MACROS_PER_ANSWER,
  QuestionAnswered,
  QuestionNumber,
} from '../src/inbox';
import { InboxId } from '../src/schema/identifiers';

// Comments on a Question's text ride on the answer: decided, folded, moved,
// and decoded from an answer logged before they existed.

const ID = InboxId.make('01INBOXC0MMENT000000000000');
const TO = InboxId.make('01INBOXC0MMENT000000000001');
const n = QuestionNumber.make;

const events: ReadonlyArray<InboxEvent> = [
  { _tag: 'InboxOpened', inboxId: ID, label: 'demo' },
  {
    _tag: 'QuestionAsked',
    inboxId: ID,
    number: n(1),
    title: 'T',
    body: 'The old order breaks scripts nobody could predict.',
  },
];

const comment = (
  quote: string,
  start: number,
  text: string,
  part = 0,
): QuestionComment => ({
  quote,
  prefix: '',
  suffix: '',
  at: { part, start, end: start + quote.length },
  text,
});

const early = comment('old order', 4, 'Keep it.');
const late = comment('nobody could predict', 29, 'Say which.');

const answer = (input: {
  readonly response: string;
  readonly comments?: ReadonlyArray<QuestionComment>;
  readonly deferred?: true;
}) => decideAnswer(inboxState(events), { inboxId: ID, number: n(1), ...input });

const reasonOf = (r: ReturnType<typeof answer>) =>
  Result.isFailure(r) ? r.failure.reason : undefined;

describe('an answer with comments', () => {
  it('carries them in body order, whatever order they came in, and the fold keeps them', () => {
    const event = Result.getOrThrow(
      answer({ response: 'Yes', comments: [late, early] }),
    );
    expect(event.comments).toEqual([early, late]);
    const q = inboxState([...events, event]).questions[0];
    expect(q?.comments).toEqual([early, late]);
  });

  it('may be comments alone, with no text', () => {
    const event = Result.getOrThrow(answer({ response: '', comments: [late] }));
    expect(event.response).toBe('');
    expect(event.comments).toEqual([late]);
  });

  it('rides on a deferral too', () => {
    const event = Result.getOrThrow(
      answer({ response: '', deferred: true, comments: [early] }),
    );
    expect(event.deferred).toBe(true);
    expect(event.comments).toEqual([early]);
  });

  it('leaves the key out when there are none, and is still empty with none and no text', () => {
    expect(
      Result.getOrThrow(answer({ response: 'Yes', comments: [] })),
    ).not.toHaveProperty('comments');
    expect(reasonOf(answer({ response: ' ', comments: [] }))).toBe('empty');
  });

  it('refuses a comment with no text, no quote, a backwards span, or too many', () => {
    expect(
      reasonOf(answer({ response: 'x', comments: [{ ...early, text: ' ' }] })),
    ).toBe('bad-comment');
    expect(
      reasonOf(answer({ response: 'x', comments: [{ ...early, quote: '' }] })),
    ).toBe('bad-comment');
    expect(
      reasonOf(
        answer({
          response: 'x',
          comments: [{ ...early, at: { part: 0, start: 9, end: 4 } }],
        }),
      ),
    ).toBe('bad-comment');
    expect(
      reasonOf(
        answer({
          response: 'x',
          comments: Array.from(
            { length: MAX_COMMENTS_PER_ANSWER + 1 },
            () => early,
          ),
        }),
      ),
    ).toBe('bad-comment');
  });

  it('moves with its question', () => {
    const answered = Result.getOrThrow(
      answer({ response: 'Yes', comments: [early] }),
    );
    const moved = Result.getOrThrow(
      decideMove(
        inboxState([...events, answered]),
        inboxState([{ _tag: 'InboxOpened', inboxId: TO, label: 'other' }]),
        { inboxId: ID, numbers: [n(1)], toInboxId: TO },
      ),
    );
    expect(moved[0]?.question.comments).toEqual([early]);
    const to = inboxState([
      { _tag: 'InboxOpened', inboxId: TO, label: 'other' },
      ...moved,
    ]);
    expect(to.questions[0]?.comments).toEqual([early]);
  });

  it('decodes an answer logged before comments, and one with them', () => {
    const decode = Schema.decodeUnknownSync(QuestionAnswered);
    const before = decode({
      _tag: 'QuestionAnswered',
      inboxId: ID,
      number: 1,
      response: 'Yes',
    });
    expect(before).not.toHaveProperty('comments');
    const withOne = decode({ ...before, comments: [early] });
    expect(withOne.comments).toEqual([early]);
    expect(() => decode({ ...before, comments: [] })).toThrow();
  });
});

describe('a comment with macros', () => {
  const SHOW_ME = {
    macro: 'show-me',
    instruction: 'Show the operator what this looks like.',
    args: { focus: 'the edge case' },
  };
  const PARK = { macro: 'park', instruction: 'Stop work here.', args: {} };

  it('carries them, in order, through the decision and the fold', () => {
    const withMacros = { ...late, macros: [SHOW_ME, PARK] } as const;
    const event = Result.getOrThrow(
      answer({ response: 'Yes', comments: [withMacros, early] }),
    );
    expect(event.comments).toEqual([early, withMacros]);
    const q = inboxState([...events, event]).questions[0];
    expect(q?.comments?.[1]?.macros).toEqual([SHOW_ME, PARK]);
  });

  it('may be macros alone, with no words, and then is a whole answer', () => {
    const event = Result.getOrThrow(
      answer({
        response: '',
        comments: [{ ...early, text: '', macros: [SHOW_ME] }],
      }),
    );
    expect(event.response).toBe('');
    expect(event.comments?.[0]).toEqual({
      ...early,
      text: '',
      macros: [SHOW_ME],
    });
  });

  it('refuses a macro with no instruction, or too many, on a comment', () => {
    expect(
      reasonOf(
        answer({
          response: 'x',
          comments: [{ ...early, macros: [{ ...SHOW_ME, instruction: ' ' }] }],
        }),
      ),
    ).toBe('bad-macro');
    expect(
      reasonOf(
        answer({
          response: 'x',
          comments: [
            {
              ...early,
              macros: [
                SHOW_ME,
                ...Array.from({ length: MAX_MACROS_PER_ANSWER }, () => PARK),
              ],
            },
          ],
        }),
      ),
    ).toBe('bad-macro');
  });

  it('moves with its question, macros and all', () => {
    const withMacros = { ...early, text: '', macros: [SHOW_ME] } as const;
    const answered = Result.getOrThrow(
      answer({ response: '', comments: [withMacros] }),
    );
    const moved = Result.getOrThrow(
      decideMove(
        inboxState([...events, answered]),
        inboxState([{ _tag: 'InboxOpened', inboxId: TO, label: 'other' }]),
        { inboxId: ID, numbers: [n(1)], toInboxId: TO },
      ),
    );
    const to = inboxState([
      { _tag: 'InboxOpened', inboxId: TO, label: 'other' },
      ...moved,
    ]);
    expect(to.questions[0]?.comments).toEqual([withMacros]);
  });

  it('decodes a comment logged before comments took macros, and refuses an empty list', () => {
    const decode = Schema.decodeUnknownSync(QuestionAnswered);
    const before = decode({
      _tag: 'QuestionAnswered',
      inboxId: ID,
      number: 1,
      response: '',
      comments: [early],
    });
    expect(before.comments?.[0]).not.toHaveProperty('macros');
    expect(() =>
      decode({ ...before, comments: [{ ...early, macros: [] }] }),
    ).toThrow();
  });
});

describe('commentsInBodyOrder', () => {
  it('sorts by part, then where the span starts, then where it ends', () => {
    const a = comment('a', 5, 'x', 1);
    const b = comment('bb', 0, 'x', 1);
    const c = comment('b', 0, 'x', 1);
    const d = comment('z', 40, 'x', 0);
    expect(commentsInBodyOrder([a, b, c, d])).toEqual([d, c, b, a]);
  });
});
