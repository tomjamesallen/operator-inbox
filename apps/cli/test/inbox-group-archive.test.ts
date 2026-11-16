import { describe, expect, it } from '@effect/vitest';
import { InboxId, inboxState } from '@operator-inbox/core';
import { Effect, Option } from 'effect';
import {
  dispatchAsk,
  dispatchGroupArchive,
  dispatchOpen,
} from '../src/commands/inbox';
import { InboxLog, InboxLogInMemory } from '../src/inbox-store';

// `operator-inbox group archive` and `group unarchive`, against kairos-es's
// in-memory store: a group is put away on its Inbox, its questions keep their
// `group` key, and a new question asked into it brings it back.

const A = InboxId.make('01GROUPSAAAAAAAAAAAAAAAAAA');

const provide = <X, E>(effect: Effect.Effect<X, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

const stateOf = Effect.gen(function* () {
  const log = yield* InboxLog;
  return inboxState((yield* log.read(A)).events);
});

const seed = Effect.gen(function* () {
  yield* dispatchOpen({
    session: Option.none(),
    inbox: Option.none(),
    label: Option.some('Grouped work'),
    freshId: A,
    cwd: '/w',
  });
  yield* dispatchAsk({
    inboxId: A,
    title: 'In store',
    body: '',
    metadata: { group: 'store' },
  });
});

describe('group archive', () => {
  it.effect('archives a group and says how it comes back', () =>
    provide(
      Effect.gen(function* () {
        yield* seed;
        const said = yield* dispatchGroupArchive({
          inboxId: A,
          group: ' store ',
          archived: true,
        });
        expect(said).toBe(
          `archived group "store" in inbox ${A} — Grouped work\nasking a question into it brings it back; so does \`operator-inbox group unarchive store --inbox ${A}\``,
        );
        const state = yield* stateOf;
        expect(state.archivedGroups).toEqual(['store']);
        expect(state.questions[0]?.metadata).toEqual({ group: 'store' });
      }),
    ),
  );

  it.effect('refuses what changes nothing, and a group no question is in', () =>
    provide(
      Effect.gen(function* () {
        yield* seed;
        const not = yield* Effect.flip(
          dispatchGroupArchive({ inboxId: A, group: 'store', archived: false }),
        );
        expect(not.message).toBe('inbox: group "store" is not archived');
        const unknown = yield* Effect.flip(
          dispatchGroupArchive({ inboxId: A, group: 'stor', archived: true }),
        );
        expect(unknown.message).toBe(
          'inbox: no question in this inbox is in group "stor"',
        );
        yield* dispatchGroupArchive({
          inboxId: A,
          group: 'store',
          archived: true,
        });
        const again = yield* Effect.flip(
          dispatchGroupArchive({ inboxId: A, group: 'store', archived: true }),
        );
        expect(again.message).toBe('inbox: group "store" is already archived');
      }),
    ),
  );

  it.effect('unarchives a group', () =>
    provide(
      Effect.gen(function* () {
        yield* seed;
        yield* dispatchGroupArchive({
          inboxId: A,
          group: 'store',
          archived: true,
        });
        expect(
          yield* dispatchGroupArchive({
            inboxId: A,
            group: 'store',
            archived: false,
          }),
        ).toBe(`unarchived group "store" in inbox ${A} — Grouped work`);
        expect((yield* stateOf).archivedGroups).toEqual([]);
      }),
    ),
  );

  it.effect('a question asked into an archived group brings it back', () =>
    provide(
      Effect.gen(function* () {
        yield* seed;
        yield* dispatchGroupArchive({
          inboxId: A,
          group: 'store',
          archived: true,
        });
        yield* dispatchAsk({
          inboxId: A,
          title: 'Elsewhere',
          body: '',
          metadata: { group: 'ui' },
        });
        expect((yield* stateOf).archivedGroups).toEqual(['store']);
        yield* dispatchAsk({
          inboxId: A,
          title: 'Back in store',
          body: '',
          metadata: { group: 'store' },
        });
        expect((yield* stateOf).archivedGroups).toEqual([]);
      }),
    ),
  );
});
