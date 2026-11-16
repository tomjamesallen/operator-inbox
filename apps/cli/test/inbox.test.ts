import { describe, expect, it } from '@effect/vitest';
import {
  decideAnswer,
  type InboxEvent,
  InboxId,
  InboxRefusal,
  inboxState,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
} from 'effect';
import { TestClock } from 'effect/testing';
import {
  DEFERRED_LINE,
  dispatchAnswers,
  dispatchAsk,
  dispatchDone,
  dispatchEdit,
  dispatchHighlight,
  dispatchList,
  dispatchMeta,
  dispatchMove,
  dispatchOpen,
  dispatchRename,
  dispatchUnhighlight,
  dispatchWait,
  dispatchWithdraw,
  HIGHLIGHT_REPLY_LINE,
  type InboxSession,
  inboxUrl,
  renderAnswers,
  resolveInbox,
} from '../src/commands/inbox';
import { InputError } from '../src/errors';
import {
  decideAndAppend,
  InboxLog,
  InboxLogInMemory,
  makeInboxLogLazy,
} from '../src/inbox-store';

// The inbox command composition and its store edge against kairos-es's
// in-memory store. The session is passed in, never located, and `wait` sleeps
// on the Effect clock, so `TestClock` drives it.

const SESSION: InboxSession = {
  sessionId: SessionId.make('session-a'),
  cwd: '/work/my-app',
};
const OTHER: InboxSession = {
  sessionId: SessionId.make('session-b'),
  cwd: '/work/other',
};
const ID = InboxId.make('01INBOXAAAAAAAAAAAAAAAAAAA');
const ID2 = InboxId.make('01INBOXBBBBBBBBBBBBBBBBBBB');

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

// A new inbox needs a readable name; the tests name one after its session's
// directory ('shell' with no session) unless told otherwise.
const open = (
  session: Option.Option<InboxSession>,
  freshId: InboxId = ID,
  inbox: Option.Option<string> = Option.none(),
  label: Option.Option<string> = Option.isSome(inbox)
    ? Option.none()
    : Option.some(
        Option.match(session, {
          onNone: () => 'shell',
          onSome: (s) => s.cwd.slice(s.cwd.lastIndexOf('/') + 1),
        }),
      ),
) =>
  dispatchOpen({
    session,
    inbox,
    label,
    freshId,
    cwd: '/plain/shell',
  });

// The operator's answer, as the serve handler records it: read, decide,
// append. A refusal fails, so a test can flip it.
const answer = (
  inboxId: InboxId,
  n: number,
  response = 'yes',
  highlightReply?: true,
) =>
  decideAndAppend(inboxId, (state) =>
    Result.map(
      decideAnswer(state, {
        inboxId,
        number: QuestionNumber.make(n),
        response,
        ...(highlightReply === undefined ? {} : { highlightReply }),
      }),
      (event) => ({ events: [event], result: undefined }),
    ),
  ).pipe(
    Effect.flatMap((decided) =>
      Result.isFailure(decided) ? Effect.fail(decided.failure) : Effect.void,
    ),
  );

describe('inbox open', () => {
  it.effect('opens an inbox under the name it is given', () =>
    provide(
      Effect.gen(function* () {
        const out = yield* open(Option.some(SESSION));
        expect(out).toBe(`inbox ${ID} — my-app (opened)\n${inboxUrl(ID)}`);
        expect(inboxUrl(ID)).toBe(`http://127.0.0.1:7184/inbox/${ID}`);
      }),
    ),
  );

  it.effect('is idempotent per session (story 2)', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION), ID);
        const again = yield* open(Option.some(SESSION), ID2);
        expect(again).toContain(`inbox ${ID} `);
        expect(again).toContain("(this session's)");
        const list = yield* dispatchList();
        expect(list.split('\n')).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    'outside a session, opens an inbox under the name it is given',
    () =>
      provide(
        Effect.gen(function* () {
          expect(yield* open(Option.none())).toContain('— shell (opened)');
        }),
      ),
  );

  it.effect('adopts another session’s inbox by id (story 3)', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(OTHER), ID);
        yield* open(Option.some(SESSION), ID2);
        const adopted = yield* open(Option.some(SESSION), ID2, Option.some(ID));
        expect(adopted).toContain(`inbox ${ID} — other (adopted)`);
        // From then on this session's verbs use the adopted inbox.
        expect(yield* resolveInbox(Option.none(), Option.some(SESSION))).toBe(
          ID,
        );
        // Adopting it again records nothing new.
        const again = yield* open(Option.some(SESSION), ID2, Option.some(ID));
        expect(again).toContain("(this session's)");
      }),
    ),
  );

  it.effect('refuses to adopt an id nobody opened', () =>
    provide(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          open(Option.some(SESSION), ID2, Option.some('nope')),
        );
        expect(failure.message).toBe('inbox: inbox nope does not exist');
      }),
    ),
  );
});

describe('inbox rename', () => {
  it.effect(
    'renames the inbox, trimmed, and refuses an empty or unchanged name',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          const out = yield* dispatchRename({
            inboxId: ID,
            label: '  Markdown check ',
          });
          expect(out).toBe(
            `renamed inbox ${ID} to "Markdown check"\n${inboxUrl(ID)}`,
          );
          expect(yield* dispatchList()).toContain('Markdown check');
          const same = yield* Effect.flip(
            dispatchRename({ inboxId: ID, label: 'Markdown check' }),
          );
          expect(same.message).toContain('already called');
          const empty = yield* Effect.flip(
            dispatchRename({ inboxId: ID, label: ' ' }),
          );
          expect(empty.message).toBe('inbox: an inbox needs a name');
        }),
      ),
  );

  it.effect(
    'open --label renames the session’s existing inbox when the name differs',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          const reopened = yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.some('Inbox index build'),
            freshId: ID2,
            cwd: '/plain/shell',
          });
          expect(reopened).toBe(
            `inbox ${ID} — Inbox index build (this session's)\n${inboxUrl(ID)}`,
          );
          // The same name again changes nothing and refuses nothing.
          const again = yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.some('Inbox index build'),
            freshId: ID2,
            cwd: '/plain/shell',
          });
          expect(again).toBe(reopened);
        }),
      ),
  );
});

describe('resolving the inbox', () => {
  it.effect('a session with no inbox is told to open one', () =>
    provide(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          resolveInbox(Option.none(), Option.some(SESSION)),
        );
        expect(failure.message).toContain('operator-inbox open');
      }),
    ),
  );

  it.effect('no session and no --inbox says how to proceed', () =>
    provide(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          resolveInbox(Option.none(), Option.none()),
        );
        expect(failure.message).toContain('--inbox');
      }),
    ),
  );
});

describe('a deferred answer', () => {
  it('opens with the deferral line, and its note follows when it has one', () => {
    const base = {
      number: QuestionNumber.make(1),
      title: 'Pick one',
      metadata: {},
      deferred: true as const,
    };
    expect(renderAnswers([{ ...base, response: '' }], false)).toBe(
      `#1 Pick one\n  ${DEFERRED_LINE}`,
    );
    expect(renderAnswers([{ ...base, response: 'lean b' }], false)).toBe(
      `#1 Pick one\n  ${DEFERRED_LINE}\n  lean b`,
    );
  });
});

describe('an answer that asks for the reply highlighted', () => {
  it('opens with the highlight line, before the answer', () => {
    expect(
      renderAnswers(
        [
          {
            number: QuestionNumber.make(1),
            title: 'Pick one',
            metadata: {},
            response: 'b',
            highlightReply: true,
          },
        ],
        false,
      ),
    ).toBe(`#1 Pick one\n  ${HIGHLIGHT_REPLY_LINE}\n  b`);
    expect(HIGHLIGHT_REPLY_LINE).toBe(
      'HIGHLIGHT YOUR RESPONSE: ask your follow-up with --highlight',
    );
  });

  it.effect(
    'carries the flag through answers, and ask --highlight highlights the reply',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          yield* dispatchAsk({ inboxId: ID, title: 'Pick one', body: '' });
          yield* answer(ID, 1, 'b', true);
          expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
            `#1 Pick one\n  ${HIGHLIGHT_REPLY_LINE}\n  b`,
          );
          expect(
            JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true })),
          ).toEqual([
            {
              number: 1,
              title: 'Pick one',
              response: 'b',
              metadata: {},
              highlightReply: true,
            },
          ]);
          expect(
            yield* dispatchAsk({
              inboxId: ID,
              title: 'Follow-up',
              body: '',
              highlight: true,
            }),
          ).toBe('#2');
          expect(
            yield* dispatchAsk({ inboxId: ID, title: 'Plain', body: '' }),
          ).toBe('#3');
          // Only the one asked with --highlight is highlighted.
          expect(yield* dispatchUnhighlight({ inboxId: ID, numbers: [] })).toBe(
            'unhighlighted #2',
          );
        }),
      ),
  );
});

describe('the question loop', () => {
  it.effect('ask → answer → answers → done → gone', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        expect(
          yield* dispatchAsk({ inboxId: ID, title: 'Pick one', body: '- a' }),
        ).toBe('#1');
        expect(
          yield* dispatchAsk({ inboxId: ID, title: 'Second', body: '' }),
        ).toBe('#2');
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
          'no answers yet',
        );
        yield* answer(ID, 1, 'a, because\nit is simpler');
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
          '#1 Pick one\n  a, because\n  it is simpler',
        );
        expect(
          JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true })),
        ).toEqual([
          {
            number: 1,
            title: 'Pick one',
            response: 'a, because\nit is simpler',
            metadata: {},
          },
        ]);
        expect(yield* dispatchDone({ inboxId: ID, numbers: [1, 1] })).toBe(
          'processed #1',
        );
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
          'no answers yet',
        );
        // The number is never reused.
        expect(
          yield* dispatchAsk({ inboxId: ID, title: 'Third', body: '' }),
        ).toBe('#3');
        expect(yield* dispatchList()).toBe(
          `${ID}  my-app  2 awaiting you, 0 with the agent`,
        );
      }),
    ),
  );

  it.effect('done refuses an unanswered question and appends nothing', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        yield* dispatchAsk({ inboxId: ID, title: 'One', body: '' });
        yield* dispatchAsk({ inboxId: ID, title: 'Two', body: '' });
        yield* answer(ID, 1);
        const failure = yield* Effect.flip(
          dispatchDone({ inboxId: ID, numbers: [1, 2] }),
        );
        expect(failure.message).toContain('#2 has not been answered');
        // #1 was not processed either: all or nothing.
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toContain(
          '#1 One',
        );
      }),
    ),
  );

  it.effect('a second answer to the same question is refused (story 10)', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        yield* dispatchAsk({ inboxId: ID, title: 'One', body: '' });
        yield* answer(ID, 1, 'first');
        const failure = yield* Effect.flip(answer(ID, 1, 'second'));
        expect(failure._tag === 'InboxRefusal' && failure.reason).toBe(
          'already-answered',
        );
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toContain(
          '  first',
        );
      }),
    ),
  );
});

describe('edit and withdraw', () => {
  it.effect(
    'edit rewrites an unanswered question and keeps what it was not given',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          yield* dispatchAsk({ inboxId: ID, title: 'Old', body: 'old body' });
          expect(
            yield* dispatchEdit({ inboxId: ID, number: 1, title: 'New' }),
          ).toBe('edited #1');
          yield* dispatchEdit({ inboxId: ID, number: 1, body: 'new body' });
          const log = yield* InboxLog;
          const { events } = yield* log.read(ID);
          expect(events.at(-1)).toEqual({
            _tag: 'QuestionEdited',
            inboxId: ID,
            number: 1,
            title: 'New',
            body: 'new body',
          });
        }),
      ),
  );

  it.effect('edit refuses an answered question and points at done', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        yield* dispatchAsk({ inboxId: ID, title: 'One', body: '' });
        yield* answer(ID, 1);
        const failure = yield* Effect.flip(
          dispatchEdit({ inboxId: ID, number: 1, title: 'Two' }),
        );
        expect(failure.message).toBe(
          'inbox: #1 is already answered; use `inbox done`',
        );
      }),
    ),
  );

  it.effect(
    'move carries questions whole to another inbox, through the store',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          yield* open(Option.some(OTHER), ID2);
          yield* dispatchAsk({ inboxId: ID, title: 'One', body: 'first' });
          yield* dispatchAsk({ inboxId: ID, title: 'Two', body: '' });
          yield* dispatchAsk({ inboxId: ID2, title: 'Theirs', body: '' });
          yield* answer(ID, 2, 'yes please');
          const out = yield* dispatchMove({
            inboxId: ID,
            numbers: [2, 1],
            toInboxId: ID2,
          });
          expect(out.split('\n').slice(0, 2)).toEqual([
            `moved #2 to inbox ${ID2} as #2`,
            `moved #1 to inbox ${ID2} as #3`,
          ]);
          const log = yield* InboxLog;
          // Each inbox's own read sees the move.
          const to = inboxState((yield* log.read(ID2)).events);
          expect(to.questions.map((q) => [q.number, q.title, q.state])).toEqual(
            [
              [1, 'Theirs', 'awaiting-operator'],
              [2, 'Two', 'awaiting-agent'],
              [3, 'One', 'awaiting-operator'],
            ],
          );
          expect(to.questions[1]?.response).toBe('yes please');
          const from = inboxState((yield* log.read(ID)).events);
          expect(from.questions.map((q) => q.state)).toEqual([
            'moved',
            'moved',
          ]);
          // The index folds the move into both inboxes.
          expect(yield* dispatchList()).toContain(
            '0 awaiting you, 0 with the agent',
          );
          expect(yield* dispatchList()).toContain(
            '2 awaiting you, 1 with the agent',
          );
          const again = yield* Effect.flip(
            dispatchMove({ inboxId: ID, numbers: [1], toInboxId: ID2 }),
          );
          expect(again.message).toContain(
            `#1 was moved to inbox ${ID2}, where it is #3`,
          );
        }),
      ),
  );

  it.effect('highlight and unhighlight, all or nothing', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        yield* dispatchAsk({ inboxId: ID, title: 'One', body: '' });
        yield* dispatchAsk({ inboxId: ID, title: 'Two', body: '' });
        yield* dispatchAsk({ inboxId: ID, title: 'Three', body: '' });
        yield* answer(ID, 3);
        const failure = yield* Effect.flip(
          dispatchHighlight({ inboxId: ID, numbers: [1, 3] }),
        );
        expect(failure.message).toContain('#3 is not waiting for the operator');
        expect(
          yield* dispatchHighlight({
            inboxId: ID,
            numbers: [1, 2],
            note: 'about the store',
          }),
        ).toBe('highlighted #1, #2');
        expect(yield* dispatchUnhighlight({ inboxId: ID, numbers: [2] })).toBe(
          'unhighlighted #2',
        );
        expect(yield* dispatchUnhighlight({ inboxId: ID, numbers: [] })).toBe(
          'unhighlighted #1',
        );
        const none = yield* Effect.flip(
          dispatchUnhighlight({ inboxId: ID, numbers: [] }),
        );
        expect(none.message).toContain(
          'no question in this inbox is highlighted',
        );
      }),
    ),
  );

  it.effect(
    'withdraw is all or nothing, and a withdrawn question cannot be answered',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          yield* dispatchAsk({ inboxId: ID, title: 'One', body: '' });
          yield* dispatchAsk({ inboxId: ID, title: 'Two', body: '' });
          yield* dispatchAsk({ inboxId: ID, title: 'Three', body: '' });
          yield* answer(ID, 3);
          const failure = yield* Effect.flip(
            dispatchWithdraw({ inboxId: ID, numbers: [1, 3], reason: 'moot' }),
          );
          expect(failure.message).toContain('#3 is already answered');
          // #1 was not withdrawn either.
          expect(yield* dispatchList()).toContain('2 awaiting you');
          const unexplained = yield* Effect.flip(
            dispatchWithdraw({ inboxId: ID, numbers: [1], reason: ' ' }),
          );
          expect(unexplained.message).toBe(
            'inbox: a withdrawal needs a reason',
          );
          expect(
            yield* dispatchWithdraw({
              inboxId: ID,
              numbers: [1, 2, 1],
              reason: 'decided elsewhere',
            }),
          ).toBe('withdrew #1, #2');
          const log = yield* InboxLog;
          const { events } = yield* log.read(ID);
          expect(events.at(-1)).toEqual({
            _tag: 'QuestionWithdrawn',
            inboxId: ID,
            number: 2,
            reason: 'decided elsewhere',
          });
          expect(yield* dispatchList()).toContain('0 awaiting you');
          const refused = yield* Effect.flip(answer(ID, 1));
          expect(refused._tag === 'InboxRefusal' && refused.reason).toBe(
            'withdrawn',
          );
          // Numbers stay spent.
          expect(
            yield* dispatchAsk({ inboxId: ID, title: 'Four', body: '' }),
          ).toBe('#4');
        }),
      ),
  );
});

describe('metadata', () => {
  it.effect(
    'records metadata on a new inbox, and sets more on one that exists',
    () =>
      provide(
        Effect.gen(function* () {
          yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.some('demo'),
            freshId: ID,
            cwd: '/plain/shell',
            metadata: { repo: 'orchard' },
          });
          // Open again: the same inbox, with the new key set and nothing
          // appended for a key that already says the same.
          yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.none(),
            freshId: ID2,
            cwd: '/plain/shell',
            metadata: { repo: 'orchard', branch: 'main' },
          });
          yield* dispatchOpen({
            session: Option.some(SESSION),
            inbox: Option.none(),
            label: Option.none(),
            freshId: ID2,
            cwd: '/plain/shell',
            metadata: { repo: 'orchard' },
          });
          expect(
            yield* dispatchMeta({
              inboxId: ID,
              set: {},
              unset: [],
              json: false,
            }),
          ).toBe('branch=main\nrepo=orchard');
          const log = yield* InboxLog;
          const { events } = yield* log.read(ID);
          expect(events.map((e) => e._tag)).toEqual([
            'InboxOpened',
            'InboxMetadataChanged',
          ]);
        }),
      ),
  );

  it.effect(
    'asks with metadata, changes it, and hands it back with the answer',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          yield* dispatchAsk({
            inboxId: ID,
            title: 'Pick one',
            body: '',
            metadata: { topic: 'store' },
          });
          expect(
            yield* dispatchMeta({
              inboxId: ID,
              number: 1,
              set: { pr: '7' },
              unset: ['topic'],
              json: true,
            }),
          ).toBe(JSON.stringify({ pr: '7' }, null, 2));
          yield* answer(ID, 1, 'a');
          expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
            '#1 Pick one\n  meta pr=7\n  a',
          );
          expect(
            JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true }))[0]
              .metadata,
          ).toEqual({ pr: '7' });
        }),
      ),
  );

  it.effect(
    'says when there is none, and refuses a change that changes nothing',
    () =>
      provide(
        Effect.gen(function* () {
          yield* open(Option.some(SESSION));
          expect(
            yield* dispatchMeta({
              inboxId: ID,
              set: {},
              unset: [],
              json: false,
            }),
          ).toBe('no metadata');
          const refused = yield* Effect.flip(
            dispatchMeta({
              inboxId: ID,
              set: {},
              unset: ['absent'],
              json: false,
            }),
          );
          expect(refused).toBeInstanceOf(InputError);
          expect(refused.message).toBe(
            'inbox: the inbox metadata already says that',
          );
          const unknown = yield* Effect.flip(
            dispatchMeta({
              inboxId: ID,
              number: 4,
              set: { a: '1' },
              unset: [],
              json: false,
            }),
          );
          expect(unknown.message).toBe('inbox: there is no question #4');
        }),
      ),
  );
});

describe('the store’s append condition', () => {
  it.effect('refuses an append made against a stale head', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        const log = yield* InboxLog;
        const { head } = yield* log.read(ID);
        const answered = (response: string): InboxEvent => ({
          _tag: 'QuestionAsked',
          inboxId: ID,
          number: QuestionNumber.make(1),
          title: response,
          body: '',
        });
        yield* log.append([answered('a')], { after: head });
        const failure = yield* Effect.flip(
          log.append([answered('b')], { after: head }),
        );
        expect(failure._tag).toBe('AppendConditionFailed');
      }),
    ),
  );

  it.effect('a conflicting write re-reads and re-decides once', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        // A log whose FIRST read is overtaken: another ask lands right after
        // it, so the decision made on it conflicts and must be re-made.
        const base = yield* InboxLog;
        const first = yield* Ref.make(true);
        const overtaken = InboxLog.of({
          ...base,
          read: (inboxId) =>
            Effect.gen(function* () {
              const read = yield* base.read(inboxId);
              if (yield* Ref.getAndSet(first, false)) {
                yield* base
                  .append(
                    [
                      {
                        _tag: 'QuestionAsked',
                        inboxId,
                        number: QuestionNumber.make(1),
                        title: 'theirs',
                        body: '',
                      },
                    ],
                    { after: read.head },
                  )
                  .pipe(Effect.orDie);
              }
              return read;
            }),
        });
        expect(
          yield* dispatchAsk({ inboxId: ID, title: 'mine', body: '' }).pipe(
            Effect.provideService(InboxLog, overtaken),
          ),
        ).toBe('#2');
      }),
    ),
  );
});

describe('inbox wait', () => {
  it.effect('wakes when an answer lands', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        yield* dispatchAsk({ inboxId: ID, title: 'One', body: '' });
        const fiber = yield* Effect.forkChild(
          dispatchWait({ inboxId: ID, timeoutMinutes: 10, json: false }),
        );
        yield* TestClock.adjust(Duration.seconds(12));
        yield* answer(ID, 1, 'go');
        yield* TestClock.adjust(Duration.seconds(5));
        expect(yield* Fiber.join(fiber)).toBe('#1 One\n  go');
      }),
    ),
  );

  it.effect('says "no answers yet" at the timeout and returns', () =>
    provide(
      Effect.gen(function* () {
        yield* open(Option.some(SESSION));
        const fiber = yield* Effect.forkChild(
          dispatchWait({ inboxId: ID, timeoutMinutes: 1, json: false }),
        );
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Fiber.join(fiber)).toBe('no answers yet');
      }),
    ),
  );

  it.effect('refuses a timeout above the bound', () =>
    provide(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          dispatchWait({ inboxId: ID, timeoutMinutes: 61, json: false }),
        );
        expect(failure).toBeInstanceOf(InputError);
      }),
    ),
  );
});

describe('the lazy log', () => {
  it.effect('retries a failed acquisition on the next call', () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const flaky = Layer.unwrap(
        Effect.map(
          Ref.updateAndGet(attempts, (n) => n + 1),
          (n) =>
            n === 1
              ? Layer.effect(
                  InboxLog,
                  Effect.fail(new InputError({ message: 'store down' })),
                )
              : InboxLogInMemory,
        ),
      );
      const ctx = yield* Layer.build(makeInboxLogLazy(flaky));
      const log = Context.get(ctx, InboxLog);
      const first = yield* Effect.flip(log.read(ID));
      expect(first.message).toBe('store down');
      // Second call: acquired, and kept.
      expect((yield* log.read(ID)).events).toEqual([]);
      yield* log.read(ID);
      expect(yield* Ref.get(attempts)).toBe(2);
    }),
  );

  // A store that fails AFTER it opened is closed and dropped, its reason kept
  // in the line, and the next call opens a new one.
  const dyingThenHealthy = Effect.gen(function* () {
    const builds = yield* Ref.make(0);
    const closed = yield* Ref.make(0);
    // Each build's store dies on read; build 2 onwards is healthy. A
    // finalizer counts the stores closed.
    const live = Layer.effect(
      InboxLog,
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(builds, (x) => x + 1);
        yield* Effect.addFinalizer(() => Ref.update(closed, (x) => x + 1));
        const healthy = Context.get(
          yield* Layer.build(InboxLogInMemory),
          InboxLog,
        );
        if (n > 1) return healthy;
        return InboxLog.of({
          ...healthy,
          read: () =>
            Effect.die(new Error('attempt to write a readonly database')),
        });
      }),
    );
    return { builds, closed, live };
  });

  it.effect(
    'closes and drops a store that dies after it opened, and reopens',
    () =>
      Effect.gen(function* () {
        const h = yield* dyingThenHealthy;
        const log = Context.get(
          yield* Layer.build(makeInboxLogLazy(h.live)),
          InboxLog,
        );
        const first = yield* Effect.flip(log.read(ID));
        expect(first.message).toContain('attempt to write a readonly database');
        expect(first.message.split('\n')).toHaveLength(1);
        expect(yield* Ref.get(h.closed)).toBe(1);
        expect((yield* log.read(ID)).events).toEqual([]);
        expect(yield* Ref.get(h.builds)).toBe(2);
        expect(yield* Ref.get(h.closed)).toBe(1);
      }),
  );

  // A defect WHILE opening (kairos-es's ensureSchema dies on a client that
  // cannot round-trip a 64-bit id) is a one-line failure, not a crash, and
  // the next call tries again.
  it.effect(
    'a defect while opening is one line, and the next call retries',
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const live = Layer.unwrap(
          Effect.map(
            Ref.updateAndGet(attempts, (n) => n + 1),
            (n) =>
              n === 1
                ? Layer.effect(
                    InboxLog,
                    Effect.die(new Error('64-bit ids do not round-trip')),
                  )
                : InboxLogInMemory,
          ),
        );
        const log = Context.get(
          yield* Layer.build(makeInboxLogLazy(live)),
          InboxLog,
        );
        const first = yield* Effect.flip(log.read(ID));
        expect(first).toBeInstanceOf(InputError);
        expect(first.message).toContain(
          'failed to open (64-bit ids do not round-trip)',
        );
        expect((yield* log.read(ID)).events).toEqual([]);
        expect(yield* Ref.get(attempts)).toBe(2);
      }),
  );

  it.live('a late failure on an OLD store does not close the new one', () =>
    Effect.gen(function* () {
      // Store 1: its first read waits for `release`, then dies; any other
      // read dies at once. Later stores are healthy.
      const release = yield* Deferred.make<void>();
      const aStarted = yield* Deferred.make<void>();
      const builds = yield* Ref.make(0);
      const closed = yield* Ref.make<Array<number>>([]);
      const live = Layer.effect(
        InboxLog,
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(builds, (x) => x + 1);
          yield* Effect.addFinalizer(() =>
            Ref.update(closed, (xs) => [...xs, n]),
          );
          const healthy = Context.get(
            yield* Layer.build(InboxLogInMemory),
            InboxLog,
          );
          if (n > 1) return healthy;
          const reads = yield* Ref.make(0);
          return InboxLog.of({
            ...healthy,
            read: () =>
              Effect.flatMap(
                Ref.getAndUpdate(reads, (x) => x + 1),
                (r) =>
                  r === 0
                    ? Deferred.succeed(aStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(
                          Effect.die(new Error('late failure on store 1')),
                        ),
                      )
                    : Effect.die(new Error('early failure on store 1')),
              ),
          });
        }),
      );
      const log = Context.get(
        yield* Layer.build(makeInboxLogLazy(live)),
        InboxLog,
      );
      // A starts on store 1 and hangs; B fails on store 1 and drops it.
      const a = yield* Effect.forkChild(Effect.flip(log.read(ID)));
      yield* Deferred.await(aStarted);
      const b = yield* Effect.flip(log.read(ID));
      expect(b.message).toContain('early failure');
      expect(yield* Ref.get(closed)).toEqual([1]);
      // C opens store 2.
      expect((yield* log.read(ID)).events).toEqual([]);
      expect(yield* Ref.get(builds)).toBe(2);
      // A now fails late, on store 1: store 2 must stay open and in use.
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(a)).message).toContain('late failure');
      expect(yield* Ref.get(closed)).toEqual([1]);
      yield* log.read(ID);
      expect(yield* Ref.get(builds)).toBe(2);
    }).pipe(Effect.scoped),
  );
});

// Keep the composition honest: `decideAndAppend` refusals come back as values.
describe('decideAndAppend', () => {
  it.effect('returns a refusal without appending', () =>
    provide(
      Effect.gen(function* () {
        const result = yield* decideAndAppend(ID, () =>
          Result.fail(new InboxRefusal({ reason: 'not-found', message: 'no' })),
        );
        expect(Result.isFailure(result)).toBe(true);
        const log = yield* InboxLog;
        expect((yield* log.read(ID)).events).toEqual([]);
      }),
    ),
  );
});
