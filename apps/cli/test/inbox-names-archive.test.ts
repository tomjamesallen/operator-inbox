import { describe, expect, it } from '@effect/vitest';
import {
  DcbEventStore,
  DcbEventStoreInMemory,
  EventType,
  Tag,
} from '@kairos-es/core';
import { InboxId, SessionId } from '@operator-inbox/core';
import { Console, DateTime, Effect, Layer, Option, Ref } from 'effect';
import {
  dispatchArchive,
  dispatchAsk,
  dispatchList,
  dispatchOpen,
  dispatchRename,
  dispatchUnarchive,
  InboxNameTaken,
  type InboxSession,
  NAME_TAKEN_EXIT_CODE,
  printingHolder,
} from '../src/commands/inbox';
import { InboxLog, InboxLogInMemory, makeInboxLog } from '../src/inbox-store';
import { exitCodeOf } from '../src/runtime-teardown';

// Unique names and archiving, against
// kairos-es's in-memory store. A name is a DCB boundary across inboxes: the
// label tag carries it, and an append that takes a name is conditioned on it.

const SESSION: InboxSession = {
  sessionId: SessionId.make('session-a'),
  cwd: '/work/my-app',
};
const A = InboxId.make('01NAMESAAAAAAAAAAAAAAAAAAA');
const B = InboxId.make('01NAMESBBBBBBBBBBBBBBBBBBB');
const C = InboxId.make('01NAMESCCCCCCCCCCCCCCCCCCC');

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

/** Open a new inbox outside a session, under `label`. */
const openAs = (freshId: InboxId, label: string) =>
  dispatchOpen({
    session: Option.none(),
    inbox: Option.none(),
    label: Option.some(label),
    freshId,
    cwd: '/w',
  });

const takenBy = (failure: unknown) =>
  failure instanceof InboxNameTaken ? failure.conflictingInboxId : undefined;

describe('open needs a readable name to create an inbox', () => {
  it.effect(
    'inside a session with no inbox, open without --label says how',
    () =>
      provide(
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            dispatchOpen({
              session: Option.some(SESSION),
              inbox: Option.none(),
              label: Option.none(),
              freshId: A,
              cwd: '/w',
            }),
          );
          expect(failure.message).toBe(
            'inbox: this session has no inbox yet; open one with a readable name: `operator-inbox open --label "<what this session is doing>"`',
          );
          expect(yield* dispatchList()).toBe('no inboxes');
        }),
      ),
  );

  it.effect('a session that has an inbox gets it back without --label', () =>
    provide(
      Effect.gen(function* () {
        yield* dispatchOpen({
          session: Option.some(SESSION),
          inbox: Option.none(),
          label: Option.some('Inbox archive build'),
          freshId: A,
          cwd: '/w',
        });
        const again = yield* dispatchOpen({
          session: Option.some(SESSION),
          inbox: Option.none(),
          label: Option.none(),
          freshId: B,
          cwd: '/w',
        });
        expect(again).toContain(
          `inbox ${A} — Inbox archive build (this session's)`,
        );
      }),
    ),
  );
});

describe('unique names', () => {
  it.effect(
    'a second inbox under a taken name is refused with the holder’s id',
    () =>
      provide(
        Effect.gen(function* () {
          yield* openAs(A, 'Markdown check');
          const failure = yield* Effect.flip(openAs(B, '  markdown   CHECK '));
          expect(takenBy(failure)).toBe(A);
          expect(failure.message).toBe(
            `inbox: an inbox named "markdown   CHECK" already exists: ${A} — adopt it with \`operator-inbox open --inbox ${A}\`, or choose another name`,
          );
          expect(exitCodeOf(failure)).toBe(NAME_TAKEN_EXIT_CODE);
          expect((yield* dispatchList()).split('\n')).toHaveLength(1);
        }),
      ),
  );

  it.effect('a rename frees the old name and takes the new one', () =>
    provide(
      Effect.gen(function* () {
        yield* openAs(A, 'X');
        yield* dispatchRename({ inboxId: A, label: 'Y' });
        // "X" is free again.
        expect(yield* openAs(B, 'X')).toContain(`inbox ${B} — X (opened)`);
        // "Y" is A's: renaming anything to it is refused with A's id.
        const failure = yield* Effect.flip(
          dispatchRename({ inboxId: B, label: 'y' }),
        );
        expect(takenBy(failure)).toBe(A);
        const fresh = yield* Effect.flip(openAs(C, 'Y'));
        expect(takenBy(fresh)).toBe(A);
      }),
    ),
  );

  it.effect('an archived inbox keeps its name', () =>
    provide(
      Effect.gen(function* () {
        yield* openAs(A, 'Kept');
        yield* dispatchArchive({ inboxId: A });
        expect(takenBy(yield* Effect.flip(openAs(B, 'Kept')))).toBe(A);
      }),
    ),
  );

  it.effect('an inbox may change the case of its own name', () =>
    provide(
      Effect.gen(function* () {
        yield* openAs(A, 'markdown check');
        expect(
          yield* dispatchRename({ inboxId: A, label: 'Markdown Check' }),
        ).toContain('to "Markdown Check"');
      }),
    ),
  );

  it.effect('two sessions racing for one name: exactly one wins', () =>
    provide(
      Effect.gen(function* () {
        // A log whose FIRST named read is overtaken: another session opens an
        // inbox under the same name right after it, so the append made on it
        // fails the name's condition, and the re-read refuses.
        const base = yield* InboxLog;
        const first = yield* Ref.make(true);
        const overtaken = InboxLog.of({
          ...base,
          readNamed: (inboxId, label) =>
            Effect.gen(function* () {
              const read = yield* base.readNamed(inboxId, label);
              if (yield* Ref.getAndSet(first, false))
                yield* openAs(B, 'Race').pipe(
                  Effect.provideService(InboxLog, base),
                  Effect.orDie,
                );
              return read;
            }),
        });
        const failure = yield* Effect.flip(
          openAs(A, 'race').pipe(Effect.provideService(InboxLog, overtaken)),
        );
        expect(takenBy(failure)).toBe(B);
        const list = yield* dispatchList();
        expect(list.split('\n')).toHaveLength(1);
        expect(list).toContain(B);
      }),
    ),
  );

  it.effect(
    'the name’s condition refuses a stale append from another inbox',
    () =>
      provide(
        Effect.gen(function* () {
          const log = yield* InboxLog;
          const { head } = yield* log.readNamed(A, 'Same');
          yield* log.append(
            [{ _tag: 'InboxOpened', inboxId: B, label: 'same' }],
            {
              after: head,
              label: 'same',
            },
          );
          // A different inbox, so only the label tag can conflict.
          const failure = yield* Effect.flip(
            log.append([{ _tag: 'InboxOpened', inboxId: A, label: 'Same' }], {
              after: head,
              label: 'Same',
            }),
          );
          expect(failure._tag).toBe('AppendConditionFailed');
        }),
      ),
  );
});

describe('inboxes named before the label tags existed', () => {
  // Both the log and the raw store, so a test can write an event the way the
  // code before unique names did: tagged with its inbox only.
  const withStore = <X, E>(
    effect: Effect.Effect<X, E, InboxLog | DcbEventStore>,
  ) =>
    effect.pipe(
      Effect.provide(
        Layer.effect(InboxLog, makeInboxLog).pipe(
          Layer.provideMerge(DcbEventStoreInMemory),
        ),
      ),
    );

  let legacyCount = 0;
  const legacy = (event: {
    readonly _tag: 'InboxOpened' | 'InboxRenamed';
    readonly inboxId: InboxId;
    readonly label: string;
  }) => {
    legacyCount += 1;
    const n = legacyCount;
    return Effect.flatMap(DcbEventStore, (store) =>
      store.append(
        [
          {
            type: EventType.make(event._tag),
            data: new TextEncoder().encode(JSON.stringify(event)),
            tags: [Tag.make(`inbox:${event.inboxId}`)],
            uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            occurredAt: DateTime.makeUnsafe(0),
            metadata: {},
          },
        ],
        undefined,
      ),
    );
  };

  it.effect('a legacy inbox still holds its name', () =>
    withStore(
      Effect.gen(function* () {
        yield* legacy({
          _tag: 'InboxOpened',
          inboxId: A,
          label: 'Markdown check',
        });
        expect(takenBy(yield* Effect.flip(openAs(B, 'markdown check')))).toBe(
          A,
        );
      }),
    ),
  );

  it.effect('a legacy inbox renamed since frees its old name', () =>
    withStore(
      Effect.gen(function* () {
        yield* legacy({ _tag: 'InboxOpened', inboxId: A, label: 'Old' });
        yield* legacy({ _tag: 'InboxRenamed', inboxId: A, label: 'New' });
        expect(yield* openAs(B, 'Old')).toContain(`inbox ${B} — Old (opened)`);
        expect(takenBy(yield* Effect.flip(openAs(C, 'new')))).toBe(A);
      }),
    ),
  );

  it.effect('two legacy inboxes that share a name keep working', () =>
    withStore(
      Effect.gen(function* () {
        yield* legacy({ _tag: 'InboxOpened', inboxId: A, label: 'Twin' });
        yield* legacy({ _tag: 'InboxOpened', inboxId: B, label: 'Twin' });
        expect(yield* dispatchAsk({ inboxId: A, title: 'q', body: '' })).toBe(
          '#1',
        );
        expect(yield* dispatchAsk({ inboxId: B, title: 'q', body: '' })).toBe(
          '#1',
        );
        yield* dispatchArchive({ inboxId: B });
        // Only a NEW name is checked: renaming one of them away works.
        yield* dispatchRename({ inboxId: B, label: 'Twin two' });
      }),
    ),
  );
});

describe('archiving', () => {
  it.effect(
    'archive, a new question brings it back, archive and unarchive again',
    () =>
      provide(
        Effect.gen(function* () {
          yield* openAs(A, 'Done work');
          yield* openAs(B, 'Live work');
          expect(yield* dispatchArchive({ inboxId: A })).toContain(
            `archived inbox ${A} — Done work`,
          );
          const again = yield* Effect.flip(dispatchArchive({ inboxId: A }));
          expect(again.message).toBe(`inbox: inbox ${A} is already archived`);
          // Listed after the active one, and marked.
          const list = (yield* dispatchList()).split('\n');
          expect(list[0]).toContain(B);
          expect(list[1]).toContain(A);
          expect(list[1]).toMatch(/\(archived\)$/);
          expect(yield* dispatchUnarchive({ inboxId: A })).toContain(
            '(unarchived)',
          );
          const not = yield* Effect.flip(dispatchUnarchive({ inboxId: A }));
          expect(not.message).toBe(`inbox: inbox ${A} is not archived`);
          // A new question into an archived inbox brings it back with it.
          yield* dispatchArchive({ inboxId: A });
          expect(yield* dispatchAsk({ inboxId: A, title: 'q', body: '' })).toBe(
            '#1',
          );
          expect((yield* dispatchList()).split('\n')[0]).not.toMatch(
            /\(archived\)$/,
          );
          const active = yield* Effect.flip(dispatchUnarchive({ inboxId: A }));
          expect(active.message).toBe(`inbox: inbox ${A} is not archived`);
        }),
      ),
  );
});

describe('the command edge on a taken name', () => {
  it.effect('prints the holder’s id alone on stdout, and exits 3', () =>
    provide(
      Effect.gen(function* () {
        yield* openAs(A, 'Taken');
        const lines: Array<string> = [];
        const failure = yield* Console.consoleWith((base) => {
          const capturing: Console.Console = {
            ...base,
            log: (...args: ReadonlyArray<unknown>) => {
              lines.push(args.join(' '));
            },
          };
          return Effect.flip(
            Effect.provideService(
              printingHolder(openAs(B, 'Taken')),
              Console.Console,
              capturing,
            ),
          );
        });
        expect(lines).toEqual([A]);
        expect(exitCodeOf(failure)).toBe(3);
        expect(exitCodeOf(new Error('anything else'))).toBe(1);
        expect(exitCodeOf('a plain message')).toBe(1);
      }),
    ),
  );
});
