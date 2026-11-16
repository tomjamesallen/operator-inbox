import { describe, expect, it } from '@effect/vitest';
import { Result, Schema } from 'effect';
import {
  askEvents,
  awaitingAgent,
  awaitingOperator,
  decideAdopt,
  decideAnswer,
  decideArchive,
  decideAsk,
  decideDismissHighlight,
  decideEdit,
  decideGroupArchive,
  decideHighlight,
  decideInboxMetadata,
  decideMove,
  decideMute,
  decideOpen,
  decideOperatorAsk,
  decidePin,
  decideProcess,
  decideQuestionMetadata,
  decideRename,
  decideUnarchive,
  decideWithdraw,
  InboxEvent,
  type InboxRefusalReason,
  type InboxSummary,
  inboxState,
  inboxStateStamped,
  labelHolders,
  nameHolder,
  normaliseInboxLabel,
  OPERATOR_QUESTION_TITLE_LIMIT,
  operatorQuestionTitle,
  orderInboxes,
  PROCESSED_VIEW_CAP,
  QuestionNumber,
  QuestionRevision,
  recentlyProcessed,
  summariseInbox,
  totalAwaitingOperator,
} from '../src/inbox';
import { InboxId, SessionId } from '../src/schema/identifiers';

// The Inbox's pure half: the fold and its three decisions, over hand-built
// event lists. No store, no clock, no ids minted here.

const ID = InboxId.make('01INBOX0000000000000000000');
const n = (x: number) => QuestionNumber.make(x);

const opened: InboxEvent = { _tag: 'InboxOpened', inboxId: ID, label: 'demo' };
const asked = (x: number, title = `question ${x}`): InboxEvent => ({
  _tag: 'QuestionAsked',
  inboxId: ID,
  number: n(x),
  title,
  body: `body ${x}`,
});
const answered = (x: number, response = `answer ${x}`): InboxEvent => ({
  _tag: 'QuestionAnswered',
  inboxId: ID,
  number: n(x),
  response,
});
const processed = (x: number): InboxEvent => ({
  _tag: 'AnswerProcessed',
  inboxId: ID,
  number: n(x),
});

const edited = (x: number, title: string, body = `body ${x}`): InboxEvent => ({
  _tag: 'QuestionEdited',
  inboxId: ID,
  number: n(x),
  title,
  body,
});
const withdrawn = (x: number, reason = `moot ${x}`): InboxEvent => ({
  _tag: 'QuestionWithdrawn',
  inboxId: ID,
  number: n(x),
  reason,
});

const refusalOf = (
  result: Result.Result<unknown, { reason: InboxRefusalReason }>,
): InboxRefusalReason | undefined =>
  Result.isFailure(result) ? result.failure.reason : undefined;

describe('inboxState', () => {
  it('derives each question’s state from the events', () => {
    const state = inboxState([
      opened,
      asked(1),
      asked(2),
      asked(3),
      answered(2),
      answered(3),
      processed(3),
    ]);
    expect(state.opened).toBe(true);
    expect(state.label).toBe('demo');
    expect(awaitingOperator(state).map((q) => q.number)).toEqual([1]);
    expect(awaitingAgent(state).map((q) => [q.number, q.response])).toEqual([
      [2, 'answer 2'],
    ]);
  });

  it('drops a processed question from both columns', () => {
    const state = inboxState([opened, asked(1), answered(1), processed(1)]);
    expect(awaitingOperator(state)).toEqual([]);
    expect(awaitingAgent(state)).toEqual([]);
  });

  it('an adoption changes nothing a view shows', () => {
    const adopted: InboxEvent = {
      _tag: 'InboxAdopted',
      inboxId: ID,
      sessionId: SessionId.make('s'),
    };
    expect(inboxState([opened, asked(1), adopted])).toEqual(
      inboxState([opened, asked(1)]),
    );
  });

  it('counts a revision per edit, starting at 1', () => {
    const state = inboxState([
      opened,
      asked(1),
      asked(2),
      edited(1, 'once'),
      edited(1, 'twice', 'new body'),
    ]);
    expect(
      state.questions.map((q) => [q.number, q.revision, q.title, q.body]),
    ).toEqual([
      [1, 3, 'twice', 'new body'],
      [2, 1, 'question 2', 'body 2'],
    ]);
  });

  it('marks a withdrawn question processed, with its reason', () => {
    const state = inboxState([
      opened,
      asked(1),
      asked(2),
      withdrawn(1, 'no longer needed'),
    ]);
    expect(awaitingOperator(state).map((q) => q.number)).toEqual([2]);
    expect(awaitingAgent(state)).toEqual([]);
    expect(
      recentlyProcessed(state).map((q) => [
        q.number,
        q.state,
        q.withdrawn,
        q.reason,
      ]),
    ).toEqual([[1, 'processed', true, 'no longer needed']]);
  });

  it('shows processed questions newest processed first, not by number', () => {
    const state = inboxState([
      opened,
      asked(1),
      asked(2),
      asked(3),
      answered(2),
      processed(2),
      withdrawn(3),
      answered(1),
      processed(1),
    ]);
    expect(
      recentlyProcessed(state).map((q) => [q.number, q.withdrawn]),
    ).toEqual([
      [1, false],
      [3, true],
      [2, false],
    ]);
    expect(recentlyProcessed(state)[0]?.response).toBe('answer 1');
  });

  it('caps the processed questions it shows at the most recent 30', () => {
    const count = PROCESSED_VIEW_CAP + 5;
    const events: Array<InboxEvent> = [opened];
    for (let x = 1; x <= count; x++) events.push(asked(x), withdrawn(x));
    const shown = recentlyProcessed(inboxState(events));
    expect(PROCESSED_VIEW_CAP).toBe(30);
    expect(shown).toHaveLength(30);
    expect(shown[0]?.number).toBe(count);
    expect(shown.at(-1)?.number).toBe(count - 29);
  });

  it('decodes a withdrawal written before it carried a reason', () => {
    const old = Schema.decodeUnknownSync(InboxEvent)({
      _tag: 'QuestionWithdrawn',
      inboxId: ID,
      number: 1,
    });
    expect(old).toEqual(withdrawn(1, ''));
    const state = inboxState([opened, asked(1), old]);
    expect(recentlyProcessed(state)[0]?.reason).toBe('');
  });

  it('an empty log is not an opened inbox', () => {
    expect(inboxState([]).opened).toBe(false);
  });

  it('round-trips every event through its Schema', () => {
    const events = [
      opened,
      asked(1),
      edited(1, 'new'),
      answered(1),
      processed(1),
      asked(2),
      withdrawn(2),
    ];
    const json = Schema.encodeSync(
      Schema.fromJsonString(Schema.Array(InboxEvent)),
    )(events);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(InboxEvent)))(
        json,
      ),
    ).toEqual(events);
  });
});

describe('decideAsk', () => {
  const ask = (events: ReadonlyArray<InboxEvent>, title = 'a title') =>
    decideAsk(inboxState(events), { inboxId: ID, title, body: 'b' });

  it('numbers the first question 1', () => {
    expect(ask([opened])).toEqual(
      Result.succeed({
        _tag: 'QuestionAsked',
        inboxId: ID,
        number: 1,
        title: 'a title',
        body: 'b',
      }),
    );
  });

  it('never reuses a number, even after every question is processed', () => {
    const result = ask([
      opened,
      asked(1),
      asked(2),
      answered(1),
      answered(2),
      processed(1),
      processed(2),
    ]);
    expect(
      Result.isSuccess(result) && result.success._tag === 'QuestionAsked'
        ? result.success.number
        : undefined,
    ).toBe(3);
  });

  it('refuses an inbox nobody opened', () => {
    expect(refusalOf(ask([]))).toBe('not-found');
  });

  it('refuses an empty title', () => {
    expect(refusalOf(ask([opened], '   '))).toBe('empty');
  });
});

describe('the operator asks the agent', () => {
  const ask = (events: ReadonlyArray<InboxEvent>, text = 'Can you check X?') =>
    decideOperatorAsk(inboxState(events), { inboxId: ID, text });

  it('takes the next number, flagged, its first line the title', () => {
    expect(
      ask([opened, asked(1)], '  Check the tests\n\nThe slow ones  '),
    ).toEqual(
      Result.succeed({
        _tag: 'QuestionAsked',
        inboxId: ID,
        number: 2,
        title: 'Check the tests',
        body: 'Check the tests\n\nThe slow ones',
        operatorQuestion: true,
      }),
    );
  });

  it('carries highlightReply on the operator’s question and into the fold', () => {
    const event = Result.getOrThrow(
      decideOperatorAsk(inboxState([opened]), {
        inboxId: ID,
        text: 'Check X',
        highlightReply: true,
      }),
    );
    expect(event).toMatchObject({
      operatorQuestion: true,
      highlightReply: true,
    });
    expect(inboxState([opened, event]).questions[0]).toMatchObject({
      state: 'awaiting-agent',
      highlightReply: true,
    });
    expect(Result.getOrThrow(ask([opened]))).not.toHaveProperty(
      'highlightReply',
    );
  });

  it('cuts a long first line, with an ellipsis', () => {
    const title = operatorQuestionTitle('x'.repeat(200));
    expect(title.length).toBe(OPERATOR_QUESTION_TITLE_LIMIT);
    expect(title.endsWith('…')).toBe(true);
    expect(operatorQuestionTitle('\n\n  short  \nmore')).toBe('short');
  });

  it('refuses an empty question, and an inbox nobody opened', () => {
    expect(refusalOf(ask([opened], ' \n '))).toBe('empty');
    expect(refusalOf(ask([]))).toBe('not-found');
  });

  it('waits on the agent at once, its question as what the agent acts on', () => {
    const event = Result.getOrThrow(ask([opened]));
    const state = inboxStateStamped([
      { event: opened, stamp: { seq: 1 } },
      { event, stamp: { seq: 2, at: 't2' } },
    ]);
    expect(awaitingOperator(state)).toEqual([]);
    expect(awaitingAgent(state)).toEqual([
      {
        number: 1,
        title: 'Can you check X?',
        body: '',
        revision: 1,
        metadata: {},
        response: 'Can you check X?',
        state: 'awaiting-agent',
        withdrawn: false,
        operatorQuestion: true,
        askedStamp: { seq: 2, at: 't2' },
        answeredStamp: { seq: 2, at: 't2' },
      },
    ]);
    // The agent marks it done as it does an answer; the operator cannot
    // answer it.
    expect(
      Result.isSuccess(decideProcess(state, { inboxId: ID, number: n(1) })),
    ).toBe(true);
    expect(
      refusalOf(
        decideAnswer(state, {
          inboxId: ID,
          number: n(1),
          response: 'x',
          seenRevision: QuestionRevision.make(1),
        }),
      ),
    ).toBe('already-answered');
  });

  it('brings an archived inbox back with it', () => {
    const state = inboxState([opened, { _tag: 'InboxArchived', inboxId: ID }]);
    const event = Result.getOrThrow(
      decideOperatorAsk(state, { inboxId: ID, text: 'q' }),
    );
    expect(askEvents(state, event).map((e) => e._tag)).toEqual([
      'InboxUnarchived',
      'QuestionAsked',
    ]);
  });

  it('keeps its flag when it moves', () => {
    const TO = InboxId.make('01INBOX0000000000000000002');
    const event = Result.getOrThrow(ask([opened]));
    const [moved] = Result.getOrThrow(
      decideMove(
        inboxState([opened, event]),
        inboxState([{ _tag: 'InboxOpened', inboxId: TO, label: 'other' }]),
        { inboxId: ID, numbers: [n(1)], toInboxId: TO },
      ),
    );
    if (moved === undefined) throw new Error('no move');
    expect(moved.question.operatorQuestion).toBe(true);
    const there = inboxState([
      { _tag: 'InboxOpened', inboxId: TO, label: 'other' },
      moved,
    ]);
    expect(awaitingAgent(there)[0]?.operatorQuestion).toBe(true);
  });
});

describe('decideAnswer', () => {
  const answer = (events: ReadonlyArray<InboxEvent>, x = 1, response = 'yes') =>
    decideAnswer(inboxState(events), { inboxId: ID, number: n(x), response });

  it('answers a question awaiting the operator', () => {
    expect(answer([opened, asked(1)])).toEqual(
      Result.succeed(answered(1, 'yes')),
    );
  });

  it('refuses an inbox nobody opened', () => {
    expect(refusalOf(answer([]))).toBe('not-found');
  });

  it('refuses an unknown number', () => {
    expect(refusalOf(answer([opened, asked(1)], 2))).toBe('unknown-question');
  });

  it('refuses a second answer (the double Send)', () => {
    const result = answer([opened, asked(1), answered(1)]);
    expect(refusalOf(result)).toBe('already-answered');
    expect(Result.isFailure(result) && result.failure.message).toContain('#1');
  });

  it('refuses a processed question', () => {
    expect(
      refusalOf(answer([opened, asked(1), answered(1), processed(1)])),
    ).toBe('already-processed');
  });

  it('refuses an empty response', () => {
    expect(refusalOf(answer([opened, asked(1)], 1, ' \n'))).toBe('empty');
  });

  it('refuses a withdrawn question', () => {
    expect(refusalOf(answer([opened, asked(1), withdrawn(1)]))).toBe(
      'withdrawn',
    );
  });

  const answerSeen = (
    events: ReadonlyArray<InboxEvent>,
    seenRevision: number,
  ) =>
    decideAnswer(inboxState(events), {
      inboxId: ID,
      number: n(1),
      response: 'yes',
      seenRevision,
    });

  it('refuses an answer to a revision the agent has since edited', () => {
    const result = answerSeen([opened, asked(1), edited(1, 'new')], 1);
    expect(refusalOf(result)).toBe('changed');
    expect(Result.isFailure(result) && result.failure.message).toBe(
      '#1 changed after you opened it; read it again before answering',
    );
  });

  it('answers when the seen revision is the current one', () => {
    expect(answerSeen([opened, asked(1), edited(1, 'new')], 2)).toEqual(
      Result.succeed(answered(1, 'yes')),
    );
  });

  const defer = (events: ReadonlyArray<InboxEvent>, response = '') =>
    decideAnswer(inboxState(events), {
      inboxId: ID,
      number: n(1),
      response,
      deferred: true,
    });

  it('defers to the agent with no note, and the fold keeps the flag', () => {
    const result = defer([opened, asked(1)]);
    expect(result).toEqual(
      Result.succeed({
        _tag: 'QuestionAnswered',
        inboxId: ID,
        number: n(1),
        response: '',
        deferred: true,
      }),
    );
    const state = inboxState([opened, asked(1), Result.getOrThrow(result)]);
    expect(state.questions[0]).toMatchObject({
      state: 'awaiting-agent',
      response: '',
      deferred: true,
    });
  });

  it('defers with a note, and a plain answer carries no flag', () => {
    expect(
      Result.getOrThrow(defer([opened, asked(1)], 'lean B')),
    ).toMatchObject({ response: 'lean B', deferred: true });
    expect(Result.getOrThrow(answer([opened, asked(1)]))).not.toHaveProperty(
      'deferred',
    );
  });

  it('carries highlightReply on the answer and into the fold, and leaves it off a plain one', () => {
    const result = decideAnswer(inboxState([opened, asked(1)]), {
      inboxId: ID,
      number: n(1),
      response: 'yes',
      highlightReply: true,
    });
    expect(Result.getOrThrow(result)).toEqual({
      _tag: 'QuestionAnswered',
      inboxId: ID,
      number: n(1),
      response: 'yes',
      highlightReply: true,
    });
    const state = inboxState([opened, asked(1), Result.getOrThrow(result)]);
    expect(state.questions[0]?.highlightReply).toBe(true);
    expect(
      inboxState([opened, asked(1), answered(1)]).questions[0],
    ).not.toHaveProperty('highlightReply');
  });

  it('refuses a deferral the same way as an answer once it is answered', () => {
    expect(refusalOf(defer([opened, asked(1), answered(1)]))).toBe(
      'already-answered',
    );
  });
});

describe('decideEdit', () => {
  const edit = (
    events: ReadonlyArray<InboxEvent>,
    change: { title?: string; body?: string },
    x = 1,
  ) => decideEdit(inboxState(events), { inboxId: ID, number: n(x), ...change });

  it('edits the title and keeps the body', () => {
    expect(edit([opened, asked(1)], { title: 'better' })).toEqual(
      Result.succeed(edited(1, 'better', 'body 1')),
    );
  });

  it('edits the body and keeps the title', () => {
    expect(edit([opened, asked(1)], { body: 'new body' })).toEqual(
      Result.succeed(edited(1, 'question 1', 'new body')),
    );
  });

  it('refuses an inbox nobody opened', () => {
    expect(refusalOf(edit([], { title: 't' }))).toBe('not-found');
  });

  it('refuses an unknown number', () => {
    expect(refusalOf(edit([opened], { title: 't' }))).toBe('unknown-question');
  });

  it('refuses an answered question, and points at `inbox done`', () => {
    const result = edit([opened, asked(1), answered(1)], { title: 't' });
    expect(refusalOf(result)).toBe('already-answered');
    expect(Result.isFailure(result) && result.failure.message).toBe(
      '#1 is already answered; use `inbox done`',
    );
  });

  it('refuses a processed question', () => {
    expect(
      refusalOf(
        edit([opened, asked(1), answered(1), processed(1)], { title: 't' }),
      ),
    ).toBe('already-processed');
  });

  it('refuses a withdrawn question', () => {
    expect(
      refusalOf(edit([opened, asked(1), withdrawn(1)], { title: 't' })),
    ).toBe('withdrawn');
  });

  it('refuses an empty title, and an edit that names no field', () => {
    expect(refusalOf(edit([opened, asked(1)], { title: '  ' }))).toBe('empty');
    expect(refusalOf(edit([opened, asked(1)], {}))).toBe('empty');
  });

  it('refuses an edit that changes nothing', () => {
    expect(refusalOf(edit([opened, asked(1)], { title: 'question 1' }))).toBe(
      'unchanged',
    );
  });
});

describe('decideWithdraw', () => {
  const withdraw = (
    events: ReadonlyArray<InboxEvent>,
    x = 1,
    reason = `moot ${x}`,
  ) =>
    decideWithdraw(inboxState(events), { inboxId: ID, number: n(x), reason });

  it('withdraws a question awaiting the operator, with its reason', () => {
    expect(withdraw([opened, asked(1)])).toEqual(Result.succeed(withdrawn(1)));
  });

  it('refuses a withdrawal without a reason', () => {
    expect(refusalOf(withdraw([opened, asked(1)], 1, ''))).toBe('empty');
    expect(refusalOf(withdraw([opened, asked(1)], 1, '   '))).toBe('empty');
  });

  it('refuses an inbox nobody opened', () => {
    expect(refusalOf(withdraw([]))).toBe('not-found');
  });

  it('refuses an unknown number', () => {
    expect(refusalOf(withdraw([opened]))).toBe('unknown-question');
  });

  it('refuses an answered question, and points at `inbox done`', () => {
    const result = withdraw([opened, asked(1), answered(1)]);
    expect(refusalOf(result)).toBe('already-answered');
    expect(Result.isFailure(result) && result.failure.message).toBe(
      '#1 is already answered; use `inbox done`',
    );
  });

  it('refuses a processed question', () => {
    expect(
      refusalOf(withdraw([opened, asked(1), answered(1), processed(1)])),
    ).toBe('already-processed');
  });

  it('refuses one already withdrawn', () => {
    expect(refusalOf(withdraw([opened, asked(1), withdrawn(1)]))).toBe(
      'withdrawn',
    );
  });

  it('never lets a withdrawn number be asked again', () => {
    const result = decideAsk(inboxState([opened, asked(1), withdrawn(1)]), {
      inboxId: ID,
      title: 't',
      body: '',
    });
    expect(Result.isSuccess(result) && result.success.number).toBe(2);
  });
});

describe('decideProcess', () => {
  const markDone = (events: ReadonlyArray<InboxEvent>, x = 1) =>
    decideProcess(inboxState(events), { inboxId: ID, number: n(x) });

  it('processes an answered question', () => {
    expect(markDone([opened, asked(1), answered(1)])).toEqual(
      Result.succeed(processed(1)),
    );
  });

  it('refuses an inbox nobody opened', () => {
    expect(refusalOf(markDone([]))).toBe('not-found');
  });

  it('refuses an unknown number', () => {
    expect(refusalOf(markDone([opened], 1))).toBe('unknown-question');
  });

  it('refuses a question the operator has not answered', () => {
    expect(refusalOf(markDone([opened, asked(1)]))).toBe('not-answered');
  });

  it('refuses one already processed', () => {
    expect(
      refusalOf(markDone([opened, asked(1), answered(1), processed(1)])),
    ).toBe('already-processed');
  });
});

describe('decideAdopt', () => {
  const session = SessionId.make('s');
  it('adopts an opened inbox', () => {
    expect(
      decideAdopt(inboxState([opened]), { inboxId: ID, sessionId: session }),
    ).toEqual(
      Result.succeed({ _tag: 'InboxAdopted', inboxId: ID, sessionId: session }),
    );
  });
  it('refuses an id nobody opened', () => {
    expect(
      refusalOf(
        decideAdopt(inboxState([]), { inboxId: ID, sessionId: session }),
      ),
    ).toBe('not-found');
  });
});

const renamed = (label: string): InboxEvent => ({
  _tag: 'InboxRenamed',
  inboxId: ID,
  label,
});

describe('decideRename', () => {
  it('renames to the trimmed name, and the latest rename wins', () => {
    const decided = decideRename(inboxState([opened]), {
      inboxId: ID,
      label: '  Markdown check  ',
    });
    expect(decided).toEqual(
      Result.succeed({
        _tag: 'InboxRenamed',
        inboxId: ID,
        label: 'Markdown check',
        previousLabel: 'demo',
      }),
    );
    expect(
      inboxState([opened, renamed('first'), asked(1), renamed('second')]).label,
    ).toBe('second');
  });

  it('refuses an empty name, the same name, and an inbox nobody opened', () => {
    const state = inboxState([opened, renamed('Readable')]);
    expect(refusalOf(decideRename(state, { inboxId: ID, label: '  ' }))).toBe(
      'empty',
    );
    expect(
      refusalOf(decideRename(state, { inboxId: ID, label: ' Readable ' })),
    ).toBe('unchanged');
    expect(
      refusalOf(decideRename(inboxState([]), { inboxId: ID, label: 'x' })),
    ).toBe('not-found');
  });

  it('round-trips through the event schema', () => {
    const event = renamed('Readable');
    expect(
      Schema.decodeUnknownSync(InboxEvent)(
        Schema.encodeSync(InboxEvent)(event),
      ),
    ).toEqual(event);
  });
});

describe('the index of every inbox', () => {
  it('counts each column', () => {
    const state = inboxState([
      opened,
      asked(1),
      asked(2),
      asked(3),
      answered(2),
      answered(3),
      processed(3),
    ]);
    expect(summariseInbox(ID, state, 7)).toEqual({
      inboxId: ID,
      label: 'demo',
      archived: false,
      muted: false,
      awaitingOperator: 1,
      awaitingAgent: 1,
      processed: 1,
      lastActivity: 7,
    });
  });

  it('puts inboxes waiting on the operator first, then most recent activity', () => {
    const at = (
      id: string,
      awaiting: number,
      lastActivity: number,
      archived = false,
    ): InboxSummary => ({
      inboxId: InboxId.make(id),
      label: id,
      archived,
      muted: false,
      awaitingOperator: awaiting,
      awaitingAgent: 0,
      processed: 0,
      lastActivity,
    });
    expect(
      orderInboxes([
        at('quiet-old', 0, 1),
        at('waiting-old', 2, 2),
        at('quiet-new', 0, 9),
        at('waiting-new', 1, 5),
      ]).map((s) => s.inboxId),
    ).toEqual(['waiting-new', 'waiting-old', 'quiet-new', 'quiet-old']);
  });

  it('puts archived inboxes after the active ones, and leaves them out of the total', () => {
    const at = (
      id: string,
      awaiting: number,
      lastActivity: number,
      archived: boolean,
    ): InboxSummary => ({
      inboxId: InboxId.make(id),
      label: id,
      archived,
      muted: false,
      awaitingOperator: awaiting,
      awaitingAgent: 0,
      processed: 0,
      lastActivity,
    });
    const summaries = [
      at('archived-waiting', 5, 9, true),
      at('active-quiet', 0, 1, false),
      at('active-waiting', 2, 2, false),
    ];
    expect(orderInboxes(summaries).map((s) => s.inboxId)).toEqual([
      'active-waiting',
      'active-quiet',
      'archived-waiting',
    ]);
    expect(totalAwaitingOperator(summaries)).toBe(2);
  });
});

describe('archiving', () => {
  const archived: InboxEvent = { _tag: 'InboxArchived', inboxId: ID };
  const unarchived: InboxEvent = { _tag: 'InboxUnarchived', inboxId: ID };

  it('folds archived and back', () => {
    expect(inboxState([opened]).archived).toBe(false);
    expect(inboxState([opened, archived]).archived).toBe(true);
    expect(inboxState([opened, archived, unarchived]).archived).toBe(false);
  });

  it('archives an active inbox and refuses an archived one', () => {
    expect(decideArchive(inboxState([opened]), { inboxId: ID })).toEqual(
      Result.succeed(archived),
    );
    expect(
      refusalOf(decideArchive(inboxState([opened, archived]), { inboxId: ID })),
    ).toBe('archived');
    expect(refusalOf(decideArchive(inboxState([]), { inboxId: ID }))).toBe(
      'not-found',
    );
  });

  it('unarchives an archived inbox and refuses an active one', () => {
    expect(
      decideUnarchive(inboxState([opened, archived]), { inboxId: ID }),
    ).toEqual(Result.succeed(unarchived));
    expect(
      refusalOf(decideUnarchive(inboxState([opened]), { inboxId: ID })),
    ).toBe('not-archived');
  });

  it('takes a new question into an archived inbox, and brings the inbox back first', () => {
    const state = inboxState([opened, archived]);
    const asked = Result.getOrThrow(
      decideAsk(state, { inboxId: ID, title: 't', body: '' }),
    );
    const events = askEvents(state, asked);
    expect(events.map((e) => e._tag)).toEqual([
      'InboxUnarchived',
      'QuestionAsked',
    ]);
    expect(inboxState([opened, archived, ...events]).archived).toBe(false);
    // Into an active inbox, the question alone.
    expect(askEvents(inboxState([opened]), asked)).toEqual([asked]);
  });

  it('still takes an answer, a done, an edit and a withdrawal', () => {
    const state = inboxState([opened, asked(1), asked(2), asked(3), archived]);
    expect(
      Result.isSuccess(
        decideAnswer(state, { inboxId: ID, number: n(1), response: 'yes' }),
      ),
    ).toBe(true);
    const answeredState = inboxState([opened, asked(1), answered(1), archived]);
    expect(
      Result.isSuccess(
        decideProcess(answeredState, { inboxId: ID, number: n(1) }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decideEdit(state, { inboxId: ID, number: n(2), title: 'new' }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decideWithdraw(state, { inboxId: ID, number: n(3), reason: 'moot' }),
      ),
    ).toBe(true);
  });

  it('round-trips both events through the event schema', () => {
    for (const event of [archived, unarchived])
      expect(
        Schema.decodeUnknownSync(InboxEvent)(
          Schema.encodeSync(InboxEvent)(event),
        ),
      ).toEqual(event);
  });
});

describe('unique names', () => {
  const A = InboxId.make('01INBOXA000000000000000000');
  const B = InboxId.make('01INBOXB000000000000000000');
  const openedAs = (inboxId: InboxId, label: string): InboxEvent => ({
    _tag: 'InboxOpened',
    inboxId,
    label,
  });
  const renamedTo = (
    inboxId: InboxId,
    previousLabel: string,
    label: string,
  ): InboxEvent => ({ _tag: 'InboxRenamed', inboxId, label, previousLabel });

  it('normalises: trimmed, inner whitespace collapsed, case-folded', () => {
    expect(normaliseInboxLabel('  Markdown \t  CHECK ')).toBe('markdown check');
    expect(normaliseInboxLabel('ｍarkdown')).toBe('markdown');
  });

  it('folds who holds a name, and a rename releases the old one', () => {
    const events = [openedAs(A, 'X'), renamedTo(A, 'X', 'Y')];
    expect(labelHolders('x', events)).toEqual([]);
    expect(labelHolders(' y ', events)).toEqual([A]);
    expect(labelHolders('X', [...events, openedAs(B, 'x')])).toEqual([B]);
  });

  it('finds a legacy holder in the index, and respects its renames', () => {
    // A was opened before the label tags: no label read sees it.
    expect(
      nameHolder({
        label: 'Markdown check',
        labelEvents: [],
        index: [{ inboxId: A, label: 'markdown  check' }],
      }),
    ).toBe(A);
    // Renamed since (the index carries its current name): the old name is free.
    expect(
      nameHolder({
        label: 'Markdown check',
        labelEvents: [],
        index: [{ inboxId: A, label: 'Something else' }],
      }),
    ).toBeUndefined();
  });

  it('trusts a label-tag holder the index has not seen, not one it saw renamed away', () => {
    expect(
      nameHolder({ label: 'X', labelEvents: [openedAs(A, 'X')], index: [] }),
    ).toBe(A);
    expect(
      nameHolder({
        label: 'X',
        labelEvents: [openedAs(A, 'X')],
        index: [{ inboxId: A, label: 'Z' }],
      }),
    ).toBeUndefined();
  });

  it('does not count the inbox itself', () => {
    expect(
      nameHolder({
        label: 'x',
        self: A,
        labelEvents: [openedAs(A, 'X')],
        index: [{ inboxId: A, label: 'X' }],
      }),
    ).toBeUndefined();
  });

  it('refuses opening under a taken name, with the holder’s id', () => {
    const decided = decideOpen(inboxState([]), {
      inboxId: B,
      label: ' Markdown check ',
      holder: A,
    });
    expect(Result.isFailure(decided) && decided.failure).toMatchObject({
      reason: 'name-taken',
      conflictingInboxId: A,
      message: `an inbox named "Markdown check" already exists: ${A} — adopt it with \`operator-inbox open --inbox ${A}\`, or choose another name`,
    });
    expect(
      decideOpen(inboxState([]), {
        inboxId: B,
        label: ' Fresh ',
        holder: undefined,
        cwd: '/w',
      }),
    ).toEqual(
      Result.succeed({
        _tag: 'InboxOpened',
        inboxId: B,
        label: 'Fresh',
        cwd: '/w',
      }),
    );
    expect(
      refusalOf(
        decideOpen(inboxState([]), { inboxId: B, label: ' ', holder: A }),
      ),
    ).toBe('empty');
  });

  it('refuses renaming to a taken name, with the holder’s id', () => {
    const decided = decideRename(inboxState([opened]), {
      inboxId: ID,
      label: 'Taken',
      holder: A,
    });
    expect(
      Result.isFailure(decided) && decided.failure.conflictingInboxId,
    ).toBe(A);
    expect(refusalOf(decided)).toBe('name-taken');
  });
});

describe('inboxStateStamped', () => {
  it('carries each move’s stamp onto the question, and folds as the plain fold does', () => {
    const events = [opened, asked(1), asked(2), answered(1), processed(1)];
    const stampedEvents = events.map((event, i) => ({
      event,
      stamp: { seq: 10 + i, at: `2026-10-09T00:00:0${i}.000Z` },
    }));
    const state = inboxStateStamped(stampedEvents);
    const [one, two] = state.questions;
    expect(one?.askedStamp?.seq).toBe(11);
    expect(one?.answeredStamp?.seq).toBe(13);
    expect(one?.processedStamp).toEqual({
      seq: 14,
      at: '2026-10-09T00:00:04.000Z',
    });
    expect(two?.answeredStamp).toBeUndefined();
    // Without the stamps, the same state.
    const plain = inboxState(events);
    expect(
      state.questions.map(
        ({ askedStamp, answeredStamp, processedStamp, ...q }) => q,
      ),
    ).toEqual(plain.questions);
  });
});

describe('metadata', () => {
  const inboxMeta = (
    set: Record<string, string>,
    unset: ReadonlyArray<string> = [],
  ): InboxEvent => ({ _tag: 'InboxMetadataChanged', inboxId: ID, set, unset });
  const questionMeta = (
    x: number,
    set: Record<string, string>,
    unset: ReadonlyArray<string> = [],
  ): InboxEvent => ({
    _tag: 'QuestionMetadataChanged',
    inboxId: ID,
    number: n(x),
    set,
    unset,
  });

  it('folds the metadata set at open and ask, then each change in order', () => {
    const state = inboxState([
      {
        ...opened,
        metadata: { repo: 'orchard', branch: 'main' },
      } as InboxEvent,
      { ...asked(1), metadata: { topic: 'store' } } as InboxEvent,
      asked(2),
      inboxMeta({ branch: 'next', pr: '7' }, ['repo']),
      questionMeta(1, { topic: 'cache' }),
      questionMeta(2, { k: 'v' }),
      questionMeta(2, {}, ['k']),
    ]);
    expect(state.metadata).toEqual({ branch: 'next', pr: '7' });
    expect(state.questions.map((q) => q.metadata)).toEqual([
      { topic: 'cache' },
      {},
    ]);
  });

  it('starts empty, and an event written before metadata existed still folds', () => {
    const state = inboxState([opened, asked(1)]);
    expect(state.metadata).toEqual({});
    expect(state.questions[0]?.metadata).toEqual({});
  });

  it('does not touch the revision an answer is checked against', () => {
    const state = inboxState([opened, asked(1), questionMeta(1, { a: 'b' })]);
    expect(state.questions[0]?.revision).toBe(1);
  });

  it('records metadata on open and ask, trimming keys and dropping an empty dictionary', () => {
    const open = decideOpen(inboxState([]), {
      inboxId: ID,
      label: 'demo',
      holder: undefined,
      metadata: { ' repo ': 'orchard' },
    });
    expect(Result.getOrThrow(open)).toEqual({
      _tag: 'InboxOpened',
      inboxId: ID,
      label: 'demo',
      metadata: { repo: 'orchard' },
    });
    const ask = decideAsk(inboxState([opened]), {
      inboxId: ID,
      title: 't',
      body: 'b',
      metadata: {},
    });
    expect(Result.getOrThrow(ask)).not.toHaveProperty('metadata');
  });

  it('refuses an empty key', () => {
    expect(
      refusalOf(
        decideAsk(inboxState([opened]), {
          inboxId: ID,
          title: 't',
          body: 'b',
          metadata: { ' ': 'x' },
        }),
      ),
    ).toBe('bad-metadata');
    expect(
      refusalOf(
        decideInboxMetadata(inboxState([opened]), {
          inboxId: ID,
          set: {},
          unset: [''],
        }),
      ),
    ).toBe('bad-metadata');
  });

  it('records only what changes, and refuses a change that changes nothing', () => {
    const state = inboxState([
      { ...opened, metadata: { repo: 'orchard' } } as InboxEvent,
    ]);
    expect(
      Result.getOrThrow(
        decideInboxMetadata(state, {
          inboxId: ID,
          set: { repo: 'orchard', pr: '7' },
          unset: ['absent'],
        }),
      ),
    ).toEqual({
      _tag: 'InboxMetadataChanged',
      inboxId: ID,
      set: { pr: '7' },
      unset: [],
    });
    expect(
      refusalOf(
        decideInboxMetadata(state, {
          inboxId: ID,
          set: { repo: 'orchard' },
          unset: ['absent'],
        }),
      ),
    ).toBe('unchanged');
  });

  it('refuses a key both set and removed', () => {
    expect(
      refusalOf(
        decideInboxMetadata(inboxState([opened]), {
          inboxId: ID,
          set: { a: '1' },
          unset: ['a'],
        }),
      ),
    ).toBe('bad-metadata');
  });

  it('changes an archived inbox, and a question in any state', () => {
    const state = inboxState([
      opened,
      asked(1),
      answered(1),
      processed(1),
      { _tag: 'InboxArchived', inboxId: ID },
    ]);
    expect(
      Result.isSuccess(
        decideInboxMetadata(state, { inboxId: ID, set: { a: '1' }, unset: [] }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decideQuestionMetadata(state, {
          inboxId: ID,
          number: n(1),
          set: { a: '1' },
          unset: [],
        }),
      ),
    ).toBe(true);
  });

  it('refuses an inbox nobody opened and an unknown question', () => {
    expect(
      refusalOf(
        decideInboxMetadata(inboxState([]), {
          inboxId: ID,
          set: { a: '1' },
          unset: [],
        }),
      ),
    ).toBe('not-found');
    expect(
      refusalOf(
        decideQuestionMetadata(inboxState([opened]), {
          inboxId: ID,
          number: n(9),
          set: { a: '1' },
          unset: [],
        }),
      ),
    ).toBe('unknown-question');
  });

  it('round-trips the metadata events through their Schema', () => {
    const events = [
      { ...opened, metadata: { a: '1' } } as InboxEvent,
      inboxMeta({ b: '2' }, ['a']),
      asked(1),
      questionMeta(1, { c: '3' }),
    ];
    const codec = Schema.fromJsonString(Schema.Array(InboxEvent));
    expect(
      Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(events)),
    ).toEqual(events);
  });
});

describe('highlights', () => {
  const highlighted = (x: number, note?: string): InboxEvent => ({
    _tag: 'QuestionHighlighted',
    inboxId: ID,
    number: n(x),
    ...(note === undefined ? {} : { note }),
  });
  const base = [opened, asked(1), asked(2), asked(3), answered(3)];

  it('folds a highlight with its note and stamp, and keeps it through an answer', () => {
    const state = inboxStateStamped(
      [...base, highlighted(1, 'about the store'), answered(1)].map(
        (event, i) => ({ event, stamp: { seq: i + 1 } }),
      ),
    );
    const q1 = state.questions.find((q) => q.number === n(1));
    expect(q1?.state).toBe('awaiting-agent');
    expect(q1?.highlight).toEqual({
      note: 'about the store',
      stamp: { seq: 6 },
    });
  });

  it('folds a dismissal away', () => {
    const state = inboxState([
      ...base,
      highlighted(1),
      {
        _tag: 'QuestionHighlightDismissed',
        inboxId: ID,
        number: n(1),
        by: 'operator',
      },
    ]);
    expect(state.questions[0]?.highlight).toBeUndefined();
  });

  it('highlights waiting questions with a trimmed note, leaving others alone', () => {
    const state = inboxState([...base, highlighted(2)]);
    const decided = decideHighlight(state, {
      inboxId: ID,
      numbers: [n(1), n(1)],
      note: '  about the store ',
    });
    expect(decided).toEqual(
      Result.succeed([
        {
          _tag: 'QuestionHighlighted',
          inboxId: ID,
          number: n(1),
          note: 'about the store',
        },
      ]),
    );
  });

  it('refuses a question not waiting for the operator, an unknown one, and none', () => {
    const state = inboxState(base);
    expect(
      refusalOf(decideHighlight(state, { inboxId: ID, numbers: [n(3)] })),
    ).toBe('not-waiting');
    expect(
      refusalOf(decideHighlight(state, { inboxId: ID, numbers: [n(9)] })),
    ).toBe('unknown-question');
    expect(
      refusalOf(decideHighlight(state, { inboxId: ID, numbers: [] })),
    ).toBe('empty');
    expect(
      refusalOf(
        decideHighlight(inboxState([]), { inboxId: ID, numbers: [n(1)] }),
      ),
    ).toBe('not-found');
  });

  it('dismisses the named highlights, or every one, and refuses one not highlighted', () => {
    const state = inboxState([...base, highlighted(1), highlighted(2)]);
    const all = decideDismissHighlight(state, {
      inboxId: ID,
      numbers: [],
      by: 'agent',
    });
    expect(Result.getOrThrow(all).map((e) => [e.number, e.by])).toEqual([
      [1, 'agent'],
      [2, 'agent'],
    ]);
    expect(
      refusalOf(
        decideDismissHighlight(state, {
          inboxId: ID,
          numbers: [n(3)],
          by: 'operator',
        }),
      ),
    ).toBe('not-highlighted');
    expect(
      refusalOf(
        decideDismissHighlight(inboxState(base), {
          inboxId: ID,
          numbers: [],
          by: 'agent',
        }),
      ),
    ).toBe('unchanged');
  });
});

describe('moving a question between inboxes', () => {
  const TO = InboxId.make('01INBOX0000000000000000002');
  const openedTo: InboxEvent = {
    _tag: 'InboxOpened',
    inboxId: TO,
    label: 'other',
  };
  const askedTo = (x: number): InboxEvent => ({
    _tag: 'QuestionAsked',
    inboxId: TO,
    number: n(x),
    title: `there ${x}`,
    body: '',
  });
  const stamped = (events: ReadonlyArray<InboxEvent>) =>
    events.map((event, i) => ({
      event,
      stamp: { seq: i + 1, at: `t${i + 1}` },
    }));

  // #1 waiting and highlighted, #2 answered, #3 processed; the other inbox
  // already holds #1.
  const fromEvents: ReadonlyArray<InboxEvent> = [
    opened,
    asked(1),
    asked(2),
    asked(3),
    { _tag: 'QuestionHighlighted', inboxId: ID, number: n(1), note: 'store' },
    answered(2),
    answered(3),
    processed(3),
  ];

  const move = (numbers: ReadonlyArray<number>) =>
    decideMove(
      inboxStateStamped(stamped(fromEvents)),
      inboxState([openedTo, askedTo(1)]),
      { inboxId: ID, numbers: numbers.map(n), toInboxId: TO },
    );

  it('moves each question whole, numbered after the highest there', () => {
    const events = Result.getOrThrow(move([2, 1]));
    expect(events.map((e) => [e.number, e.toNumber])).toEqual([
      [2, 2],
      [1, 3],
    ]);
    expect(events[0]?.question).toEqual({
      title: 'question 2',
      body: 'body 2',
      revision: 1,
      metadata: {},
      state: 'awaiting-agent',
      withdrawn: false,
      response: 'answer 2',
      askedStamp: { seq: 3, at: 't3' },
      answeredStamp: { seq: 6, at: 't6' },
    });
    expect(events[1]?.question.highlight).toEqual({
      note: 'store',
      stamp: { seq: 5, at: 't5' },
    });
  });

  it('carries a deferral with the question it moves', () => {
    const events = Result.getOrThrow(
      decideMove(
        inboxState([
          opened,
          asked(1),
          {
            _tag: 'QuestionAnswered',
            inboxId: ID,
            number: n(1),
            response: '',
            deferred: true,
          },
        ]),
        inboxState([openedTo]),
        { inboxId: ID, numbers: [n(1)], toInboxId: TO },
      ),
    );
    expect(events[0]?.question.deferred).toBe(true);
    const to = inboxState([openedTo, ...events]);
    expect(to.questions[0]?.deferred).toBe(true);
  });

  it('carries highlightReply with the question it moves', () => {
    const events = Result.getOrThrow(
      decideMove(
        inboxState([
          opened,
          asked(1),
          {
            _tag: 'QuestionAnswered',
            inboxId: ID,
            number: n(1),
            response: 'yes',
            highlightReply: true,
          },
        ]),
        inboxState([openedTo]),
        { inboxId: ID, numbers: [n(1)], toInboxId: TO },
      ),
    );
    expect(events[0]?.question.highlightReply).toBe(true);
    expect(inboxState([openedTo, ...events]).questions[0]?.highlightReply).toBe(
      true,
    );
  });

  it('folds into the inbox it joins, and leaves its number moved where it was', () => {
    const events = Result.getOrThrow(move([1, 2, 3]));
    const to = inboxState([openedTo, askedTo(1), ...events]);
    expect(
      to.questions.map((q) => [q.number, q.state, q.highlight?.note]),
    ).toEqual([
      [1, 'awaiting-operator', undefined],
      [2, 'awaiting-operator', 'store'],
      [3, 'awaiting-agent', undefined],
      [4, 'processed', undefined],
    ]);
    expect(recentlyProcessed(to).map((q) => q.number)).toEqual([4]);
    const from = inboxState([...fromEvents, ...events]);
    expect(from.questions.map((q) => q.state)).toEqual([
      'moved',
      'moved',
      'moved',
    ]);
    expect(from.questions[0]?.movedTo).toEqual({ inboxId: TO, number: 2 });
    expect(from.questions[0]?.highlight).toBeUndefined();
    // A moved number is not reused.
    const next = decideAsk(from, { inboxId: ID, title: 'Next', body: '' });
    expect(Result.getOrThrow(next).number).toBe(4);
  });

  it('says where a moved question went when it is answered or moved again', () => {
    const events = Result.getOrThrow(move([1]));
    const from = inboxState([...fromEvents, ...events]);
    const answer = decideAnswer(from, {
      inboxId: ID,
      number: n(1),
      response: 'yes',
    });
    expect(Result.isFailure(answer) && answer.failure.message).toBe(
      `#1 was moved to inbox ${TO}, where it is #2`,
    );
    expect(
      refusalOf(
        decideMove(from, inboxState([openedTo]), {
          inboxId: ID,
          numbers: [n(1)],
          toInboxId: TO,
        }),
      ),
    ).toBe('moved');
  });

  it('refuses a move to the same inbox, into an archived one, or of nothing', () => {
    const from = inboxState(fromEvents);
    expect(
      refusalOf(
        decideMove(from, from, { inboxId: ID, numbers: [n(1)], toInboxId: ID }),
      ),
    ).toBe('same-inbox');
    expect(
      refusalOf(
        decideMove(
          from,
          inboxState([openedTo, { _tag: 'InboxArchived', inboxId: TO }]),
          { inboxId: ID, numbers: [n(1)], toInboxId: TO },
        ),
      ),
    ).toBe('archived');
    expect(refusalOf(move([]))).toBe('empty');
    expect(refusalOf(move([9]))).toBe('unknown-question');
    expect(
      refusalOf(
        decideMove(from, inboxState([]), {
          inboxId: ID,
          numbers: [n(1)],
          toInboxId: TO,
        }),
      ),
    ).toBe('not-found');
  });
});

describe('pins', () => {
  it('folds inbox and group pins on and off, groups in the order pinned', () => {
    const state = inboxState([
      opened,
      { _tag: 'InboxPinned', inboxId: ID },
      { _tag: 'GroupPinned', inboxId: ID, group: 'ui' },
      { _tag: 'GroupPinned', inboxId: ID, group: 'store' },
      { _tag: 'GroupUnpinned', inboxId: ID, group: 'ui' },
      { _tag: 'GroupPinned', inboxId: ID, group: 'ui' },
    ]);
    expect(state.pinned).toBe(true);
    expect(state.pinnedGroups).toEqual(['store', 'ui']);
    expect(
      inboxState([
        ...[opened],
        { _tag: 'InboxPinned', inboxId: ID },
        { _tag: 'InboxUnpinned', inboxId: ID },
      ]).pinned,
    ).toBe(false);
  });

  it('decides a pin, trims a group, and refuses one that changes nothing', () => {
    const state = inboxState([opened]);
    expect(decidePin(state, { inboxId: ID, pinned: true })).toEqual(
      Result.succeed({ _tag: 'InboxPinned', inboxId: ID }),
    );
    expect(
      decidePin(state, { inboxId: ID, pinned: true, group: ' store ' }),
    ).toEqual(
      Result.succeed({ _tag: 'GroupPinned', inboxId: ID, group: 'store' }),
    );
    expect(refusalOf(decidePin(state, { inboxId: ID, pinned: false }))).toBe(
      'unchanged',
    );
    expect(
      refusalOf(decidePin(state, { inboxId: ID, pinned: true, group: ' ' })),
    ).toBe('empty');
    expect(
      refusalOf(decidePin(inboxState([]), { inboxId: ID, pinned: true })),
    ).toBe('not-found');
  });
});

describe('group archives', () => {
  const inGroup = (x: number, group: string): InboxEvent => ({
    _tag: 'QuestionAsked',
    inboxId: ID,
    number: n(x),
    title: `question ${x}`,
    body: '',
    metadata: { group },
  });
  const archived = (group: string): InboxEvent => ({
    _tag: 'GroupArchived',
    inboxId: ID,
    group,
  });
  const unarchived = (group: string): InboxEvent => ({
    _tag: 'GroupUnarchived',
    inboxId: ID,
    group,
  });

  it('folds group archives on and off, in the order archived, the questions untouched', () => {
    const state = inboxState([
      opened,
      inGroup(1, 'ui'),
      inGroup(2, 'store'),
      archived('ui'),
      archived('store'),
      unarchived('ui'),
      archived('ui'),
      archived('ui'),
    ]);
    expect(state.archivedGroups).toEqual(['store', 'ui']);
    expect(state.questions.map((q) => q.metadata.group)).toEqual([
      'ui',
      'store',
    ]);
    expect(inboxState([opened]).archivedGroups).toEqual([]);
  });

  it('decides an archive, trims the group, and refuses what changes nothing', () => {
    const state = inboxState([opened, inGroup(1, 'store')]);
    expect(
      decideGroupArchive(state, {
        inboxId: ID,
        group: ' store ',
        archived: true,
      }),
    ).toEqual(
      Result.succeed({ _tag: 'GroupArchived', inboxId: ID, group: 'store' }),
    );
    const put = inboxState([opened, inGroup(1, 'store'), archived('store')]);
    expect(
      refusalOf(
        decideGroupArchive(put, {
          inboxId: ID,
          group: 'store',
          archived: true,
        }),
      ),
    ).toBe('archived');
    expect(
      decideGroupArchive(put, { inboxId: ID, group: 'store', archived: false }),
    ).toEqual(
      Result.succeed({ _tag: 'GroupUnarchived', inboxId: ID, group: 'store' }),
    );
    expect(
      refusalOf(
        decideGroupArchive(state, {
          inboxId: ID,
          group: 'store',
          archived: false,
        }),
      ),
    ).toBe('not-archived');
    expect(
      refusalOf(
        decideGroupArchive(state, { inboxId: ID, group: ' ', archived: true }),
      ),
    ).toBe('empty');
    expect(
      refusalOf(
        decideGroupArchive(inboxState([]), {
          inboxId: ID,
          group: 'store',
          archived: true,
        }),
      ),
    ).toBe('not-found');
  });

  it('refuses to archive a group no question in the inbox is in', () => {
    const state = inboxState([opened, inGroup(1, 'store')]);
    expect(
      refusalOf(
        decideGroupArchive(state, {
          inboxId: ID,
          group: 'stor',
          archived: true,
        }),
      ),
    ).toBe('unknown-group');
  });

  it('archives a group in an archived inbox too', () => {
    const state = inboxState([
      opened,
      inGroup(1, 'store'),
      { _tag: 'InboxArchived', inboxId: ID },
    ]);
    expect(
      Result.isSuccess(
        decideGroupArchive(state, {
          inboxId: ID,
          group: 'store',
          archived: true,
        }),
      ),
    ).toBe(true);
  });

  it('brings an archived group back when a question is asked into it', () => {
    const state = inboxState([opened, inGroup(1, 'store'), archived('store')]);
    const into = Result.getOrThrow(
      decideAsk(state, {
        inboxId: ID,
        title: 'Next',
        body: '',
        metadata: { group: ' store ' },
      }),
    );
    const events = askEvents(state, into);
    expect(events.map((e) => e._tag)).toEqual([
      'GroupUnarchived',
      'QuestionAsked',
    ]);
    expect(events[0]).toEqual({
      _tag: 'GroupUnarchived',
      inboxId: ID,
      group: 'store',
    });
    expect(
      inboxState([opened, inGroup(1, 'store'), archived('store'), ...events])
        .archivedGroups,
    ).toEqual([]);
    // Into another group, or none, it stays archived.
    for (const metadata of [{ group: 'ui' }, undefined]) {
      const other = Result.getOrThrow(
        decideAsk(state, {
          inboxId: ID,
          title: 'Other',
          body: '',
          ...(metadata === undefined ? {} : { metadata }),
        }),
      );
      expect(askEvents(state, other).map((e) => e._tag)).toEqual([
        'QuestionAsked',
      ]);
    }
  });

  it('brings the inbox back before the group, when both are archived', () => {
    const state = inboxState([
      opened,
      inGroup(1, 'store'),
      archived('store'),
      { _tag: 'InboxArchived', inboxId: ID },
    ]);
    const into = Result.getOrThrow(
      decideAsk(state, {
        inboxId: ID,
        title: 'Next',
        body: '',
        metadata: { group: 'store' },
      }),
    );
    expect(askEvents(state, into).map((e) => e._tag)).toEqual([
      'InboxUnarchived',
      'GroupUnarchived',
      'QuestionAsked',
    ]);
  });

  it('leaves an archived group’s waiting questions out of the summary’s count, and All’s', () => {
    const state = inboxState([
      opened,
      inGroup(1, 'store'),
      inGroup(2, 'ui'),
      asked(3),
      archived('store'),
    ]);
    const summary = summariseInbox(ID, state, 1);
    expect(summary.awaitingOperator).toBe(2);
    expect(totalAwaitingOperator([summary])).toBe(2);
    // The column itself still holds it: picked on its own, it shows.
    expect(awaitingOperator(state)).toHaveLength(3);
  });
});

describe('mutes', () => {
  it('folds a mute on and off', () => {
    const muted: InboxEvent = { _tag: 'InboxMuted', inboxId: ID };
    const unmuted: InboxEvent = { _tag: 'InboxUnmuted', inboxId: ID };
    expect(inboxState([opened]).muted).toBe(false);
    expect(inboxState([opened, muted]).muted).toBe(true);
    expect(inboxState([opened, muted, unmuted]).muted).toBe(false);
  });

  it('decides a mute, and refuses one that changes nothing', () => {
    const state = inboxState([opened]);
    expect(decideMute(state, { inboxId: ID, muted: true })).toEqual(
      Result.succeed({ _tag: 'InboxMuted', inboxId: ID }),
    );
    expect(refusalOf(decideMute(state, { inboxId: ID, muted: false }))).toBe(
      'unchanged',
    );
    expect(
      refusalOf(decideMute(inboxState([]), { inboxId: ID, muted: true })),
    ).toBe('not-found');
  });

  it('leaves a muted inbox out of the total', () => {
    const at = (
      id: string,
      awaiting: number,
      muted: boolean,
    ): InboxSummary => ({
      inboxId: InboxId.make(id),
      label: id,
      archived: false,
      muted,
      awaitingOperator: awaiting,
      awaitingAgent: 0,
      processed: 0,
      lastActivity: 1,
    });
    expect(
      totalAwaitingOperator([at('muted', 4, true), at('loud', 2, false)]),
    ).toBe(2);
  });
});
