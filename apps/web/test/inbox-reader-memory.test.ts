import v8 from 'node:v8';
import vm from 'node:vm';
import { InboxId, type InboxViewDto } from '@operator-inbox/core/api';
import { createEffectActor } from '@xstate/effect';
import { sendAndAwait } from '@xstate/effect/test';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { queuesOf } from '../src/inbox-queues';
import {
  type ReaderSnapshot,
  readerMachine,
} from '../src/inbox-reader-machine';

// The page sends the reader every board it reads, one every few seconds for
// as long as the window stays open. Each snapshot carries that board's queues,
// so an actor that kept its earlier snapshots alive grew by about a board per
// poll, and a window left open for days held gigabytes. This drives the real
// machine on a real actor and checks that the snapshots it has moved past can
// be collected. All names are invented.

// A collection on demand, so the check reads what is still reachable rather
// than what the collector has not got round to yet.
v8.setFlagsFromString('--expose_gc');
const collect = vm.runInNewContext('gc') as () => void;

const GROVE = InboxId.make('inbox-grove');

const asked = (number: number) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: '',
  askedSeq: number,
  askedAt: `2026-11-05T${String(number % 24).padStart(2, '0')}:00:00.000Z`,
});

// A fresh board each time, as each poll decodes one: question 1 waits on
// every read, and each read adds one more.
const board = (read: number): ReadonlyArray<InboxViewDto> => [
  {
    inboxId: GROVE,
    label: 'grove',
    metadata: {},
    archived: false,
    pinnedGroups: [],
    awaitingOperator: Array.from({ length: 1 + (read % 5) }, (_, i) =>
      asked(i + 1),
    ),
    awaitingAgent: [],
    processed: [],
  } as unknown as InboxViewDto,
];

const READS = 60;

describe('a long-open page', () => {
  it('lets go of the snapshots the reader has moved past', async () => {
    const left = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* createEffectActor(readerMachine);
          const seen: Array<WeakRef<ReaderSnapshot>> = [];
          for (let read = 0; read < READS; read += 1) {
            const queues = queuesOf(board(read));
            const snapshot = (yield* sendAndAwait(reader, {
              type: 'ItemsChanged',
              view: 'all',
              queues,
              folded: [],
              waiting: queues.inbox.map((i) => i.key),
            })) as ReaderSnapshot;
            seen.push(new WeakRef(snapshot));
          }
          // A WeakRef made in this job holds its target until the job ends.
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 0)));
          collect();
          return seen.filter((s) => s.deref() !== undefined).length;
        }),
      ),
    );
    // The current snapshot, and at most a step or two the actor still holds.
    expect(left).toBeLessThanOrEqual(3);
  });
});
