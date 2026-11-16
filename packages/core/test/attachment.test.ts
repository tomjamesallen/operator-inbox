import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  type Attachment,
  checkAttachments,
  decideAnswer,
  decideMove,
  decideOperatorAsk,
  type InboxEvent,
  InboxId,
  inboxState,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  QuestionNumber,
  safeAttachmentName,
} from '../src';

// The operator's files on an answer or a question: the name they are kept
// under, the checks an event's set passes, and how the decisions and the
// fold carry them.

const A = InboxId.make('01INBOXATTACHAAAAAAAAAAAAA');
const B = InboxId.make('01INBOXATTACHBBBBBBBBBBBBB');
const n = QuestionNumber.make;

const file = (name: string, bytes = 10): Attachment => ({
  path: `/state/attachments/${A}/0123456789abcdef/${name}`,
  name,
  type: 'image/png',
  bytes,
});

const opened = (inboxId: InboxId): InboxEvent => ({
  _tag: 'InboxOpened',
  inboxId,
  label: inboxId === A ? 'one' : 'two',
});
const asked: InboxEvent = {
  _tag: 'QuestionAsked',
  inboxId: A,
  number: n(1),
  title: 'Which?',
  body: 'Pick one.',
};

const ok = <V, E>(r: Result.Result<V, E>): V => {
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  return r.success;
};

describe('the name a file is kept under', () => {
  it.each([
    ['screenshot.png', 'screenshot.png'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['.env', 'env'],
    ['  spaced   out .txt ', 'spaced out .txt'],
    ['a:b*c?.log', 'a-b-c-.log'],
    ['line\nbreak.txt', 'line-break.txt'],
    ['', 'file'],
    ['...', 'file'],
  ])('%j is kept as %j', (given, kept) => {
    expect(safeAttachmentName(given)).toBe(kept);
  });

  it('cuts a long name and keeps its extension', () => {
    const kept = safeAttachmentName(`${'x'.repeat(300)}.png`);
    expect(kept.length).toBe(120);
    expect(kept.endsWith('.png')).toBe(true);
  });
});

describe('the files an event may carry', () => {
  it('takes a set within the caps', () => {
    expect(ok(checkAttachments([file('a.png'), file('b.png')]))).toHaveLength(
      2,
    );
  });

  it.each([
    [
      'too many',
      Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`${i}.png`)),
    ],
    ['too large', [file('big.png', MAX_ATTACHMENT_BYTES + 1)]],
    ['a relative path', [{ ...file('a.png'), path: 'attachments/a.png' }]],
    ['a path not ending in its name', [{ ...file('a.png'), path: '/x/b.png' }]],
    ['an unsafe name', [{ ...file('a.png'), name: '../a.png' }]],
    ['no size', [{ ...file('a.png'), bytes: -1 }]],
  ])('refuses %s', (_, set) => {
    expect(Result.isFailure(checkAttachments(set))).toBe(true);
  });
});

describe('an answer that carries files', () => {
  const state = inboxState([opened(A), asked]);

  it('may be files alone, and the fold holds them on the Question', () => {
    const event = ok(
      decideAnswer(state, {
        inboxId: A,
        number: n(1),
        response: '',
        attachments: [file('a.png')],
      }),
    );
    expect(event.attachments).toStrictEqual([file('a.png')]);
    const q = inboxState([opened(A), asked, event]).questions[0];
    expect(q?.state).toBe('awaiting-agent');
    expect(q?.attachments).toStrictEqual([file('a.png')]);
  });

  it('with none carries no key, and an empty one is still refused', () => {
    const event = ok(
      decideAnswer(state, { inboxId: A, number: n(1), response: 'Yes' }),
    );
    expect(event).not.toHaveProperty('attachments');
    const empty = decideAnswer(state, {
      inboxId: A,
      number: n(1),
      response: ' ',
      attachments: [],
    });
    expect(Result.isFailure(empty) && empty.failure.reason).toBe('empty');
  });

  it('is refused for a set over the caps', () => {
    const r = decideAnswer(state, {
      inboxId: A,
      number: n(1),
      response: 'See',
      attachments: [file('big.png', MAX_ATTACHMENT_BYTES + 1)],
    });
    expect(Result.isFailure(r) && r.failure.reason).toBe('bad-attachment');
  });
});

describe('an operator’s question that carries files', () => {
  it('holds them, and a move carries them to the other Inbox', () => {
    const ask = ok(
      decideOperatorAsk(inboxState([opened(A)]), {
        inboxId: A,
        text: 'Why does this fail?',
        attachments: [file('build.log')],
      }),
    );
    expect(ask.attachments).toStrictEqual([file('build.log')]);
    const from = inboxState([opened(A), ask]);
    expect(from.questions[0]?.attachments).toStrictEqual([file('build.log')]);
    const [moved] = ok(
      decideMove(from, inboxState([opened(B)]), {
        inboxId: A,
        numbers: [n(1)],
        toInboxId: B,
      }),
    );
    if (moved === undefined) throw new Error('nothing moved');
    expect(moved.question.attachments).toStrictEqual([file('build.log')]);
    const to = inboxState([opened(B), moved]);
    expect(to.questions[0]?.attachments).toStrictEqual([file('build.log')]);
  });
});
