import { describe, expect, it } from '@effect/vitest';
import {
  derivedCodeSuffixes,
  type InboxEvent,
  InboxId,
  inboxCodeOf,
  inboxState,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import { Effect, Option, Ref } from 'effect';
import {
  dispatchAnswers,
  dispatchAsk,
  dispatchDone,
  dispatchList,
  dispatchOpen,
  dispatchRename,
  type InboxSession,
  resolveInbox,
  resolveQuestions,
} from '../src/commands/inbox';
import { assignMissingCodes, BACKFILL_ATTEMPTS } from '../src/inbox-codes';
import { InboxLog, InboxLogInMemory } from '../src/inbox-store';

// Question codes at the store edge: a new Inbox gets its code in the same
// append as its open, the CLI prints and takes `ab-xyz#n`, and serve's
// start-up gives the Inboxes opened before codes theirs. Every suffix is a
// fixed value: the draw is the command handler's, never these dispatchers'.

const SESSION: InboxSession = {
  sessionId: SessionId.make('session-a'),
  cwd: '/work/my-app',
};
const A = InboxId.make('01INBOXAAAAAAAAAAAAAAAAAAA');
const B = InboxId.make('01INBOXBBBBBBBBBBBBBBBBBBB');
const C = InboxId.make('01INBOXCCCCCCCCCCCCCCCCCCC');

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

const openCoded = (
  freshId: InboxId,
  label: string,
  codeSuffixes: ReadonlyArray<string>,
  session: Option.Option<InboxSession> = Option.none(),
) =>
  dispatchOpen({
    session,
    inbox: Option.none(),
    label: Option.some(label),
    freshId,
    cwd: '/plain/shell',
    codeSuffixes,
  });

const stateOf = (inboxId: InboxId) =>
  Effect.flatMap(InboxLog, (log) =>
    Effect.map(log.read(inboxId), ({ events }) => inboxState(events)),
  );

const failure = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  Effect.map(Effect.flip(effect), (e) =>
    e instanceof Error ? e.message : String(e),
  );

// Events appended as they stand, the way every Inbox was opened before codes.
const appendRaw = (events: ReadonlyArray<InboxEvent>) =>
  Effect.gen(function* () {
    const log = yield* InboxLog;
    for (const event of events) {
      const { head } = yield* log.read(event.inboxId);
      yield* log.append([event], { after: head });
    }
  });

describe('a new inbox', () => {
  it.effect('gets its code in the same append as its open', () =>
    provide(
      Effect.gen(function* () {
        const out = yield* openCoded(A, 'Operator inbox', ['asv']);
        expect(out).toBe(
          `inbox ${A} — Operator inbox [op-asv] (opened)\nhttp://127.0.0.1:7184/inbox/${A}`,
        );
        const log = yield* InboxLog;
        const { events } = yield* log.read(A);
        expect(events.map((e) => e._tag)).toStrictEqual([
          'InboxOpened',
          'InboxCodeAssigned',
        ]);
        expect(
          Option.getOrUndefined(
            yield* log.findByCode(inboxCodeOf('op', 'asv')),
          ),
        ).toBe(A);
      }),
    ),
  );

  it.effect('draws again when its first suffix is taken', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv']);
        yield* openCoded(B, 'Operations', ['asv', 'bcd']);
        expect((yield* stateOf(B)).code).toBe('op-bcd');
      }),
    ),
  );

  it.effect('opens without a code when every suffix drawn is taken', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv']);
        yield* openCoded(B, 'Operations', ['asv']);
        const state = yield* stateOf(B);
        expect(state.opened).toBe(true);
        expect(state.code).toBeUndefined();
      }),
    ),
  );

  it.effect('keeps its code through a rename', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv']);
        yield* dispatchRename({ inboxId: A, label: 'Something else' });
        expect((yield* stateOf(A)).code).toBe('op-asv');
      }),
    ),
  );

  it.effect('of two racing for one code, the second draws again', () =>
    provide(
      Effect.gen(function* () {
        // B's first read is overtaken by A taking `op-asv`, so B's append,
        // conditioned on that code's tag, fails, and its second read moves
        // it on to the next suffix.
        const base = yield* InboxLog;
        const first = yield* Ref.make(true);
        const overtaken = InboxLog.of({
          ...base,
          readNamed: (inboxId, label, codes) =>
            Effect.gen(function* () {
              const read = yield* base.readNamed(inboxId, label, codes);
              if (yield* Ref.getAndSet(first, false))
                yield* openCoded(A, 'Operator inbox', ['asv']).pipe(
                  Effect.provideService(InboxLog, base),
                  Effect.orDie,
                );
              return read;
            }),
        });
        yield* openCoded(B, 'Operations', ['asv', 'bcd']).pipe(
          Effect.provideService(InboxLog, overtaken),
        );
        expect((yield* stateOf(A)).code).toBe('op-asv');
        expect((yield* stateOf(B)).code).toBe('op-bcd');
      }),
    ),
  );
});

describe('the CLI names questions by code', () => {
  it.effect('ask, answers, done and list show the code', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv']);
        expect(yield* dispatchAsk({ inboxId: A, title: 'One', body: '' })).toBe(
          'op-asv#1',
        );
        yield* appendRaw([
          {
            _tag: 'QuestionAnswered',
            inboxId: A,
            number: QuestionNumber.make(1),
            response: 'go',
          },
        ]);
        expect(yield* dispatchAnswers({ inboxId: A, json: false })).toBe(
          'op-asv#1 One\n  go',
        );
        const json = JSON.parse(
          yield* dispatchAnswers({ inboxId: A, json: true }),
        );
        expect(json[0]).toMatchObject({ number: 1, code: 'op-asv#1' });
        expect(yield* dispatchList()).toBe(
          `${A}  op-asv  Operator inbox  0 awaiting you, 1 with the agent`,
        );
        expect(yield* dispatchDone({ inboxId: A, numbers: [1] })).toBe(
          'processed op-asv#1',
        );
      }),
    ),
  );

  it.effect('a code resolves its inbox with no session and no --inbox', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv']);
        yield* openCoded(B, 'Billing', ['xyz']);
        expect(
          yield* resolveQuestions(
            'done',
            ['op-asv#3', 'OP-ASV#4'],
            Option.none(),
            Option.none(),
          ),
        ).toStrictEqual({ inboxId: A, numbers: [3, 4] });
        // --inbox takes a code too, and must agree with the codes given.
        expect(
          yield* resolveQuestions(
            'done',
            ['bi-xyz#1'],
            Option.some('bi-xyz'),
            Option.none(),
          ),
        ).toStrictEqual({ inboxId: B, numbers: [1] });
        expect(yield* resolveInbox(Option.some('op-asv'), Option.none())).toBe(
          A,
        );
      }),
    ),
  );

  it.effect('plain numbers stay in this session’s inbox', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv'], Option.some(SESSION));
        expect(
          yield* resolveQuestions(
            'done',
            ['2', '3'],
            Option.none(),
            Option.some(SESSION),
          ),
        ).toStrictEqual({ inboxId: A, numbers: [2, 3] });
      }),
    ),
  );

  it.effect('refuses what it cannot place', () =>
    provide(
      Effect.gen(function* () {
        yield* openCoded(A, 'Operator inbox', ['asv']);
        yield* openCoded(B, 'Billing', ['xyz']);
        const refused = (
          given: ReadonlyArray<string>,
          inbox = Option.none<string>(),
        ) => failure(resolveQuestions('done', given, inbox, Option.none()));
        expect(yield* refused(['op-asv#1', 'bi-xyz#2'])).toContain(
          'name the questions of one inbox at a time',
        );
        expect(yield* refused(['op-asv#1', '2'])).toContain('not both');
        expect(yield* refused(['zz-zzz#1'])).toContain(
          'no inbox has the code zz-zzz',
        );
        expect(yield* refused(['three'])).toContain(
          'neither a question number',
        );
        expect(yield* refused(['op-asv#1'], Option.some(B))).toContain(
          `not the --inbox ${B} given`,
        );
      }),
    ),
  );
});

describe('the inboxes opened before codes', () => {
  const legacy: ReadonlyArray<InboxEvent> = [
    { _tag: 'InboxOpened', inboxId: A, label: 'Operator inbox' },
    { _tag: 'InboxOpened', inboxId: B, label: 'Operations' },
    { _tag: 'InboxOpened', inboxId: C, label: '42' },
  ];

  it.effect('get a code each, derived from their id, and keep it', () =>
    provide(
      Effect.gen(function* () {
        yield* appendRaw(legacy);
        const { assigned, skipped } = yield* assignMissingCodes;
        expect(skipped).toStrictEqual([]);
        expect(assigned.map((a) => a.inboxId)).toStrictEqual([A, B, C]);
        expect(assigned[0]?.code).toBe(`op-${derivedCodeSuffixes(A, 1)[0]}`);
        expect(assigned[2]?.code).toMatch(/^ib-[a-z]{3}$/);
        // A second run finds nothing to do and writes nothing.
        const log = yield* InboxLog;
        const before = (yield* log.listAll()).length;
        expect(yield* assignMissingCodes).toStrictEqual({
          assigned: [],
          skipped: [],
        });
        expect((yield* log.listAll()).length).toBe(before);
        expect(
          (yield* log.read(A)).events.filter(
            (e) => e._tag === 'InboxCodeAssigned',
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect('the same log always gets the same codes', () =>
    Effect.gen(function* () {
      const run = provide(
        Effect.andThen(appendRaw(legacy), assignMissingCodes),
      );
      const first = yield* run;
      const second = yield* run;
      expect(second).toStrictEqual(first);
    }),
  );

  it.effect('a derived suffix another inbox holds moves on to the next', () =>
    provide(
      Effect.gen(function* () {
        const [taken, next] = derivedCodeSuffixes(B, BACKFILL_ATTEMPTS);
        yield* openCoded(A, 'Operator inbox', [taken ?? 'aaa']);
        yield* appendRaw([
          { _tag: 'InboxOpened', inboxId: B, label: 'Operations' },
        ]);
        const { assigned } = yield* assignMissingCodes;
        expect(assigned).toStrictEqual([{ inboxId: B, code: `op-${next}` }]);
      }),
    ),
  );
});
