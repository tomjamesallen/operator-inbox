import {
  InboxId,
  InboxMachineKey,
  type InboxViewDto,
} from '@operator-inbox/core/api';
import { createEffectActor, type EffectActor, waitFor } from '@xstate/effect';
import { sendAndAwait } from '@xstate/effect/test';
import { Effect } from 'effect';
import { AsyncResult, AtomRegistry } from 'effect/reactivity';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { queuesOf } from '../src/inbox-queues';
import {
  activeQueueOf,
  askCursorOf,
  composerOf,
  inboxReaderAtoms,
  JUMP_LOCK_MS,
  litOf,
  PLACE_LOCK_MS,
  type ReaderSnapshot,
  readerMachine,
  readerQueuesOf,
} from '../src/inbox-reader-machine';

// The real machine on a real actor, driven by the events the page will send.
// `sendAndAwait` hands back the snapshot after each event. All names are
// invented.

const BUILD_BOX = InboxMachineKey.make('7102');

const GROVE = InboxId.make('inbox-grove');
const NIGHTLY = InboxId.make('inbox-nightly');

type Reader = EffectActor<typeof readerMachine>;
type Event = Parameters<Reader['send']>[0];

const at = (hour: number) =>
  `2026-11-05T${String(hour).padStart(2, '0')}:00:00.000Z`;

const base = (number: number) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: '',
});

const asked = (number: number, hour = number, highlighted = false) => ({
  ...base(number),
  askedSeq: number,
  askedAt: at(hour),
  ...(highlighted ? { highlight: { seq: number } } : {}),
});

const answered = (number: number, hour = number) => ({
  ...base(number),
  response: 'Yes',
  answeredSeq: number,
  answeredAt: at(hour),
});

interface Parts {
  readonly waiting?: ReadonlyArray<ReturnType<typeof asked>>;
  readonly agent?: ReadonlyArray<ReturnType<typeof answered>>;
}

const grove = (parts: Parts): InboxViewDto =>
  ({
    inboxId: GROVE,
    label: 'grove',
    metadata: {},
    archived: false,
    pinnedGroups: [],
    awaitingOperator: parts.waiting ?? [],
    awaitingAgent: parts.agent ?? [],
    processed: [],
  }) as unknown as InboxViewDto;

const nightly = (parts: Parts): InboxViewDto =>
  ({
    ...grove(parts),
    inboxId: NIGHTLY,
    label: 'nightly',
    machine: { key: BUILD_BOX, label: 'build-box' },
  }) as unknown as InboxViewDto;

const g = (n: number) => `${GROVE}/${n}`;
const b = (n: number) => `${NIGHTLY}/${n}`;

const read = (
  views: ReadonlyArray<InboxViewDto>,
  options: {
    readonly folded?: ReadonlyArray<InboxMachineKey>;
    readonly view?: string;
    // The whole board's, when the view shows less of it.
    readonly waiting?: ReadonlyArray<string>;
  } = {},
): Event => {
  const queues = queuesOf(views);
  return {
    type: 'ItemsChanged',
    view: options.view ?? 'all',
    queues,
    folded: options.folded ?? [],
    waiting: options.waiting ?? queues.inbox.map((i) => i.key),
  };
};

const drive = (reader: Reader, events: ReadonlyArray<Event>) =>
  Effect.gen(function* () {
    let snapshot: ReaderSnapshot = reader.getSnapshot();
    for (const event of events)
      snapshot = (yield* sendAndAwait(reader, event)) as ReaderSnapshot;
    return snapshot;
  });

const scenario = <A>(
  events: ReadonlyArray<Event>,
  check: (snapshot: ReaderSnapshot) => A,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const reader = yield* createEffectActor(readerMachine);
        return check(yield* drive(reader, events));
      }),
    ),
  );

const inboxKeys = (s: ReaderSnapshot) =>
  readerQueuesOf(s.context).inbox.map((i) => i.key);
const agentKeys = (s: ReaderSnapshot) =>
  readerQueuesOf(s.context).agent.map((i) => i.key);

const send = (key: string): Event => ({
  type: 'AnswerSent',
  key,
  response: 'Go ahead',
  deferred: false,
  macros: [],
  comments: [],
});

const failed = (key: string): Event => ({
  type: 'AnswerFailed',
  key,
  tag: 'unsent',
  text: 'Not sent',
});

const down = { folded: [BUILD_BOX] };

// grove asked at 1 and 3, nightly at 2: one queue, in time.
const mixed = [
  grove({ waiting: [asked(1), asked(3)] }),
  nightly({ waiting: [asked(2)] }),
];

describe('the focus', () => {
  it('starts on the first question of the first read', () =>
    scenario([read(mixed)], (s) => {
      expect(s.context.focus.inbox).toBe(g(1));
      expect(litOf(s)?.key).toBe(g(1));
    }));

  it('walks the queue in time, across machines', () =>
    scenario([read(mixed), { type: 'Moved', by: 1 }], (s) =>
      expect(s.context.focus.inbox).toBe(b(2)),
    ));

  it('counts five quick presses as five, and stops at the end', () =>
    scenario(
      [
        read([grove({ waiting: [1, 2, 3, 4, 5, 6].map((n) => asked(n)) })]),
        ...Array.from({ length: 5 }, (): Event => ({ type: 'Moved', by: 1 })),
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(6)),
    ).then(() =>
      scenario(
        [
          read([grove({ waiting: [asked(1), asked(2)] })]),
          { type: 'Moved', by: 1 },
          { type: 'Moved', by: 1 },
          { type: 'Moved', by: 1 },
        ],
        (s) => expect(s.context.focus.inbox).toBe(g(2)),
      ),
    ));

  it('holds its question when an older one arrives ahead of it', () =>
    scenario(
      [
        read([grove({ waiting: [asked(5), asked(6)] })]),
        { type: 'Moved', by: 1 },
        read([grove({ waiting: [asked(1), asked(5), asked(6)] })]),
      ],
      (s) => {
        expect(s.context.focus.inbox).toBe(g(6));
        expect(inboxKeys(s)).toEqual([g(1), g(5), g(6)]);
      },
    ));

  it('moves to what took the place of a question gone from the queue', () =>
    scenario(
      [
        read([grove({ waiting: [asked(1), asked(2), asked(3)] })]),
        { type: 'Moved', by: 1 },
        read([grove({ waiting: [asked(1), asked(3)] })]),
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(3)),
    ));

  it('skips a neighbour that left on the same read', () =>
    scenario(
      [
        read([grove({ waiting: [asked(1), asked(2), asked(3), asked(4)] })]),
        { type: 'Moved', by: 1 },
        read([grove({ waiting: [asked(1), asked(4)] })]),
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(4)),
    ));

  it('falls back to the one before when the last question goes', () =>
    scenario(
      [
        read([grove({ waiting: [asked(1), asked(2)] })]),
        { type: 'Moved', by: 1 },
        read([grove({ waiting: [asked(1)] })]),
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(1)),
    ));

  it('clears on an empty queue and returns with the next question', () =>
    scenario([read([grove({ waiting: [asked(1)] })]), read([grove({})])], (s) =>
      expect(s.context.focus.inbox).toBeUndefined(),
    ).then(() =>
      scenario(
        [
          read([grove({ waiting: [asked(1)] })]),
          read([grove({})]),
          read([grove({ waiting: [asked(2)] })]),
        ],
        (s) => expect(s.context.focus.inbox).toBe(g(2)),
      ),
    ));

  it('goes to the first and last in the list, whichever way the queue runs', () =>
    scenario(
      [
        read([
          grove({
            waiting: [asked(1), asked(2), asked(3)],
            agent: [answered(7), answered(8), answered(9)],
          }),
        ]),
        { type: 'MovedToEnd', end: 'last' },
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(3)),
    )
      .then(() =>
        scenario(
          [
            read([grove({ agent: [answered(7), answered(8), answered(9)] })]),
            { type: 'QueueChosen', queue: 'agent' },
            { type: 'MovedToEnd', end: 'last' },
          ],
          (s) => expect(s.context.focus.agent).toBe(g(7)),
        ),
      )
      .then(() =>
        scenario(
          [
            read([grove({ agent: [answered(7), answered(8), answered(9)] })]),
            { type: 'QueueChosen', queue: 'agent' },
            { type: 'MovedToEnd', end: 'last' },
            { type: 'MovedToEnd', end: 'first' },
          ],
          (s) => expect(s.context.focus.agent).toBe(g(9)),
        ),
      ));

  it('steps between highlighted questions', () => {
    const views = [
      grove({
        waiting: [
          asked(1),
          asked(2, 2, true),
          asked(3),
          asked(4, 4, true),
          asked(5),
        ],
      }),
    ];
    return scenario(
      [
        read(views),
        { type: 'MovedToHighlight', by: 1 },
        { type: 'MovedToHighlight', by: 1 },
        { type: 'MovedToHighlight', by: 1 },
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(4)),
    ).then(() =>
      scenario(
        [
          read(views),
          { type: 'MovedToEnd', end: 'last' },
          { type: 'MovedToHighlight', by: -1 },
        ],
        (s) => expect(s.context.focus.inbox).toBe(g(4)),
      ),
    );
  });

  it('keeps each queue’s own focus across a switch', () =>
    scenario(
      [
        read([
          grove({
            waiting: [asked(1), asked(2)],
            agent: [answered(8), answered(9)],
          }),
        ]),
        { type: 'Moved', by: 1 },
        { type: 'QueueStepped', by: 1 },
        { type: 'Moved', by: 1 },
        { type: 'QueueStepped', by: -1 },
      ],
      (s) => {
        expect(activeQueueOf(s)).toBe('inbox');
        expect(s.context.focus).toMatchObject({ inbox: g(2), agent: g(8) });
      },
    ));

  it('stops stepping at the last queue', () =>
    scenario(
      [
        read(mixed),
        { type: 'QueueChosen', queue: 'processed' },
        { type: 'QueueStepped', by: 1 },
      ],
      (s) => expect(activeQueueOf(s)).toBe('processed'),
    ));

  it('starts a new view on the first question unless the focused one is in it', () =>
    scenario(
      [
        read(mixed),
        { type: 'Moved', by: 1 },
        read([nightly({ waiting: [asked(2), asked(4)] })], { view: 'nightly' }),
      ],
      (s) => expect(s.context.focus.inbox).toBe(b(2)),
    ).then(() =>
      scenario(
        [
          read(mixed),
          read([nightly({ waiting: [asked(2), asked(4)] })], {
            view: 'nightly',
          }),
        ],
        (s) => {
          expect(s.context.focus.inbox).toBe(b(2));
          expect(s.context.jump).toMatchObject({ key: b(2), smooth: false });
        },
      ),
    ));
});

describe('a link', () => {
  const views = [grove({ waiting: [asked(1)], agent: [answered(9)] })];

  it('lands on its question in whichever queue holds it', () =>
    scenario([read(views), { type: 'MovedTo', key: g(9) }], (s) => {
      expect(activeQueueOf(s)).toBe('agent');
      expect(s.context.focus.agent).toBe(g(9));
      expect(s.context.jump).toMatchObject({ key: g(9), smooth: false });
    }));

  it('waits for a board that does not show it yet, and lands once', () =>
    scenario(
      [
        { type: 'MovedTo', key: g(9) },
        read(views),
        { type: 'QueueChosen', queue: 'inbox' },
        read(views),
      ],
      (s) => {
        expect(activeQueueOf(s)).toBe('inbox');
        expect(s.context.awaited).toBeUndefined();
        expect(s.context.focus.agent).toBe(g(9));
      },
    ));

  it('gives up when the reader moves first', () =>
    scenario(
      [
        read([grove({ waiting: [asked(1), asked(2)] })]),
        { type: 'MovedTo', key: g(9) },
        { type: 'Moved', by: 1 },
        read(views),
      ],
      (s) => {
        expect(activeQueueOf(s)).toBe('inbox');
        expect(s.context.awaited).toBeUndefined();
      },
    ));
});

describe('a question folding under the reader', () => {
  const lit = [read(mixed), { type: 'Moved', by: 1 } as Event];
  const foldedRead = read([grove({ waiting: [asked(1), asked(3)] })], down);

  it('stays lit, in its place in time, with the send off', () =>
    scenario([...lit, foldedRead], (s) => {
      expect(s.context.focus.inbox).toBe(b(2));
      expect(inboxKeys(s)).toEqual([g(1), b(2), g(3)]);
      expect(composerOf(s)).toMatchObject({
        _tag: 'Held',
        item: { key: b(2) },
      });
    }));

  it('asks for no jump, since nothing moved', () =>
    scenario([...lit, { type: 'JumpEnded', id: 2 }, foldedRead], (s) => {
      expect(s.context.jump?.id).toBe(2);
      expect(s.matches({ scroll: 'reading' })).toBe(true);
    }));

  it('stays through later reads while the machine is down', () =>
    scenario([...lit, foldedRead, foldedRead, foldedRead], (s) =>
      expect(s.context.held?.item.key).toBe(b(2)),
    ));

  it('refuses an answer to it', () =>
    scenario([...lit, foldedRead, send(b(2))], (s) => {
      expect(s.context.sends).toEqual([]);
      expect(s.context.focus.inbox).toBe(b(2));
    }));

  it('leaves when the reader moves, by key, scroll or queue', async () => {
    await scenario([...lit, foldedRead, { type: 'Moved', by: 1 }], (s) => {
      expect(s.context.held).toBeUndefined();
      expect(s.context.focus.inbox).toBe(g(3));
      expect(inboxKeys(s)).toEqual([g(1), g(3)]);
    });
    await scenario(
      [
        ...lit,
        { type: 'JumpEnded', id: 2 },
        foldedRead,
        { type: 'ScrolledTo', key: g(1) },
      ],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(s.context.focus.inbox).toBe(g(1));
      },
    );
    await scenario(
      [...lit, foldedRead, { type: 'QueueChosen', queue: 'agent' }],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(s.context.focus.inbox).toBe(g(3));
      },
    );
  });

  it('holds a question lit in the other queues too, with the send off', async () => {
    const on = [
      read([nightly({ agent: [answered(2)] })]),
      { type: 'QueueChosen', queue: 'agent' } as Event,
    ];
    await scenario([...on, read([nightly({})], down)], (s) => {
      expect(s.context.focus.agent).toBe(b(2));
      expect(agentKeys(s)).toEqual([b(2)]);
      expect(composerOf(s)).toMatchObject({
        _tag: 'FollowUp',
        held: true,
        item: { key: b(2) },
      });
    });
    await scenario(
      [
        ...on,
        read([nightly({})], down),
        { type: 'QueueChosen', queue: 'inbox' },
      ],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(agentKeys(s)).toEqual([]);
      },
    );
  });

  it('becomes an ordinary question when its machine comes back', () =>
    scenario([...lit, foldedRead, read(mixed)], (s) => {
      expect(s.context.held).toBeUndefined();
      expect(s.context.focus.inbox).toBe(b(2));
      expect(composerOf(s)._tag).toBe('Answer');
    }));

  it('goes when its machine comes back without it', () =>
    scenario(
      [
        ...lit,
        foldedRead,
        read([
          grove({ waiting: [asked(1), asked(3)] }),
          nightly({ waiting: [] }),
        ]),
      ],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(s.context.focus.inbox).toBe(g(3));
      },
    ));

  it('holds only the lit question', () =>
    scenario([read(mixed), foldedRead], (s) => {
      expect(s.context.held).toBeUndefined();
      expect(inboxKeys(s)).toEqual([g(1), g(3)]);
      expect(s.context.focus.inbox).toBe(g(1));
    }));

  it('does not hold while the greyed read still shows it', () =>
    scenario([...lit, read(mixed)], (s) =>
      expect(s.context.held).toBeUndefined(),
    ));

  it('does not hold a question that left with its machine reachable', () =>
    scenario(
      [...lit, read([grove({ waiting: [asked(1), asked(3)] })])],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(s.context.focus.inbox).toBe(g(3));
      },
    ));

  it('does not hold across a change of view', () =>
    scenario(
      [
        ...lit,
        read([grove({ waiting: [asked(1), asked(3)] })], {
          ...down,
          view: 'grove',
        }),
      ],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(s.context.focus.inbox).toBe(g(1));
      },
    ));

  it('does not hold while another queue is on screen', () =>
    scenario(
      [...lit, { type: 'QueueChosen', queue: 'agent' }, foldedRead],
      (s) => expect(s.context.held).toBeUndefined(),
    ));
});

describe('an answer', () => {
  const three = [grove({ waiting: [asked(1), asked(2), asked(3)] })];

  it('flows on at once, the next question by key', () =>
    scenario([read(three), send(g(1))], (s) => {
      expect(s.context.focus.inbox).toBe(g(2));
      expect(inboxKeys(s)).toEqual([g(2), g(3)]);
      expect(agentKeys(s)).toEqual([g(1)]);
      expect(s.context.jump).toMatchObject({ key: g(2), smooth: false });
    }));

  it('snaps to the question below it, half way down the list too', () =>
    scenario([read(three), { type: 'Moved', by: 1 }, send(g(2))], (s) => {
      expect(s.context.focus.inbox).toBe(g(3));
      expect(s.context.jump).toMatchObject({ key: g(3), smooth: false });
      expect(s.value).toMatchObject({ scroll: 'placing' });
    }));

  it('snaps back to the question above when it was the last', () =>
    scenario(
      [read(three), { type: 'MovedToEnd', end: 'last' }, send(g(3))],
      (s) => {
        expect(s.context.focus.inbox).toBe(g(2));
        expect(s.context.jump).toMatchObject({ key: g(2), smooth: false });
      },
    ));

  it('comes back to its place on failure without taking the focus', () =>
    scenario(
      [read(three), send(g(1)), { type: 'Moved', by: 1 }, failed(g(1))],
      (s) => {
        expect(s.context.focus.inbox).toBe(g(3));
        expect(inboxKeys(s)).toEqual([g(1), g(2), g(3)]);
        expect(agentKeys(s)).toEqual([]);
        expect(s.context.troubles).toMatchObject([
          { key: g(1), tag: 'unsent', text: 'Not sent' },
        ]);
      },
    ));

  it('takes the focus back only when nothing else holds it', () =>
    scenario(
      [read([grove({ waiting: [asked(1)] })]), send(g(1)), failed(g(1))],
      (s) => expect(s.context.focus.inbox).toBe(g(1)),
    ));

  it('stays out of Your inbox from landing until a read moves it', () => {
    const landed: Event = { type: 'AnswerLanded', key: g(1) };
    return scenario([read(three), send(g(1)), landed, read(three)], (s) => {
      expect(inboxKeys(s)).toEqual([g(2), g(3)]);
      expect(agentKeys(s)).toEqual([g(1)]);
    }).then(() =>
      scenario(
        [
          read(three),
          send(g(1)),
          landed,
          read([
            grove({ waiting: [asked(2), asked(3)], agent: [answered(1)] }),
          ]),
        ],
        (s) => {
          expect(s.context.sends).toEqual([]);
          expect(agentKeys(s)).toEqual([g(1)]);
        },
      ),
    );
  });

  it('keeps the focus on With the agent when the card arrives under it', () =>
    scenario(
      [
        read(three),
        send(g(1)),
        { type: 'QueueChosen', queue: 'agent' },
        { type: 'AnswerLanded', key: g(1) },
        read([grove({ waiting: [asked(2), asked(3)], agent: [answered(1)] })]),
      ],
      (s) => {
        expect(s.context.focus.agent).toBe(g(1));
        expect(composerOf(s)._tag).toBe('FollowUp');
      },
    ));

  it('shows the newest answer on its way first', () =>
    scenario([read(three), send(g(1)), send(g(2))], (s) =>
      expect(agentKeys(s)).toEqual([g(2), g(1)]),
    ));

  it('clears a trouble when it is sent again', () =>
    scenario([read(three), send(g(1)), failed(g(1)), send(g(1))], (s) =>
      expect(s.context.troubles).toEqual([]),
    ));

  it('ignores a second send of one already on its way', () =>
    scenario([read(three), send(g(1)), send(g(1))], (s) =>
      expect(s.context.sends).toHaveLength(1),
    ));

  it('leaves a failure with its question gone to the stray list', () =>
    scenario(
      [
        read(three),
        send(g(1)),
        read([grove({ waiting: [asked(2), asked(3)] })]),
        failed(g(1)),
      ],
      (s) => {
        expect(s.context.sends).toEqual([]);
        expect(s.context.troubles).toEqual([]);
      },
    ));

  it('keeps a failure whose question went with its machine', () =>
    scenario(
      [
        read(mixed),
        { type: 'Moved', by: 1 },
        send(b(2)),
        read([grove({ waiting: [asked(1), asked(3)] })], down),
        failed(b(2)),
        read([grove({ waiting: [asked(1), asked(3)] })], down),
      ],
      (s) => expect(s.context.troubles).toMatchObject([{ key: b(2) }]),
    ));

  it('keeps a trouble through a view that does not show its question', () => {
    const elsewhere = read([nightly({ waiting: [asked(2)] })], {
      view: 'other',
      waiting: [g(1), g(2), g(3), b(2)],
    });
    return scenario(
      [read(three), send(g(1)), failed(g(1)), elsewhere, elsewhere],
      (s) => expect(s.context.troubles).toMatchObject([{ key: g(1) }]),
    );
  });

  it('drops a trouble once a read shows its question has gone', () =>
    scenario(
      [
        read(three),
        send(g(1)),
        failed(g(1)),
        read([grove({ waiting: [asked(2), asked(3)], agent: [answered(1)] })]),
      ],
      (s) => expect(s.context.troubles).toEqual([]),
    ));

  it('is not held when its question leaves while on its way', () =>
    scenario(
      [
        read(mixed),
        { type: 'Moved', by: 1 },
        send(b(2)),
        read([grove({ waiting: [asked(1), asked(3)] })], down),
      ],
      (s) => {
        expect(s.context.held).toBeUndefined();
        expect(s.context.focus.inbox).toBe(g(3));
        expect(agentKeys(s)).toEqual([b(2)]);
      },
    ));
});

describe('a machine coming back', () => {
  it('moves nothing, however old the questions it brings', () =>
    scenario(
      [
        read([grove({ waiting: [asked(5), asked(6)] })]),
        { type: 'Moved', by: 1 },
        read([
          grove({ waiting: [asked(5), asked(6)] }),
          nightly({ waiting: [asked(1), asked(2)] }),
        ]),
      ],
      (s) => {
        expect(s.context.focus.inbox).toBe(g(6));
        expect(inboxKeys(s)).toEqual([b(1), b(2), g(5), g(6)]);
      },
    ));
});

describe('the composer', () => {
  const views = [grove({ waiting: [asked(1)], agent: [answered(9)] })];

  it('answers the lit question in Your inbox', () =>
    scenario([read(views)], (s) =>
      expect(composerOf(s)).toMatchObject({
        _tag: 'Answer',
        item: { key: g(1) },
      }),
    ));

  it('follows up on With the agent and Processed', () =>
    scenario([read(views), { type: 'QueueChosen', queue: 'agent' }], (s) =>
      expect(composerOf(s)).toMatchObject({
        _tag: 'FollowUp',
        item: { key: g(9) },
      }),
    ));

  it('has nothing to follow up on an answer still on its way', () =>
    scenario(
      [
        read([grove({ waiting: [asked(1)] })]),
        send(g(1)),
        { type: 'QueueChosen', queue: 'agent' },
      ],
      (s) => expect(composerOf(s)._tag).toBe('Sending'),
    ));

  it('is empty with nothing to answer', () =>
    scenario([read([])], (s) => expect(composerOf(s)._tag).toBe('Empty')));

  it('asks straight away in the Inbox it starts on', () =>
    scenario([read(views), { type: 'AskToggled', inboxId: GROVE }], (s) =>
      expect(composerOf(s)).toEqual({ _tag: 'Asking', inboxId: GROVE }),
    ));

  it('picks an Inbox first when it has none to start on', () =>
    scenario(
      [
        read(views),
        { type: 'AskToggled', inboxId: undefined },
        { type: 'AskCursorSet', inboxId: NIGHTLY },
      ],
      (s) => {
        expect(composerOf(s)._tag).toBe('Picking');
        expect(s.context.askCursor).toBe(NIGHTLY);
      },
    ));

  it('can go back to change the Inbox, the cursor on it', () =>
    scenario(
      [
        read(views),
        { type: 'AskToggled', inboxId: undefined },
        { type: 'AskInboxPicked', inboxId: NIGHTLY },
        { type: 'AskInboxCleared' },
      ],
      (s) => {
        expect(composerOf(s)._tag).toBe('Picking');
        expect(s.context.askCursor).toBe(NIGHTLY);
      },
    ));

  it('takes a pick while writing, since the list is still on the page', () =>
    scenario(
      [
        read(views),
        { type: 'AskToggled', inboxId: GROVE },
        { type: 'AskInboxPicked', inboxId: NIGHTLY },
      ],
      (s) =>
        expect(composerOf(s)).toEqual({ _tag: 'Asking', inboxId: NIGHTLY }),
    ));

  it('closes on the same key, on Close, and when the reader moves', async () => {
    const open: Event = { type: 'AskToggled', inboxId: GROVE };
    const closers: ReadonlyArray<Event> = [
      open,
      { type: 'AskClosed' },
      { type: 'Moved', by: 1 },
      { type: 'QueueChosen', queue: 'agent' },
      { type: 'MovedTo', key: g(1) },
    ];
    for (const closer of closers)
      await scenario([read(views), open, closer], (s) => {
        expect(s.matches({ composer: 'replying' })).toBe(true);
        expect(s.context.askTo).toBeUndefined();
      });
  });

  it('goes to With the agent when the question lands, and to the question', () =>
    scenario(
      [
        read(views),
        { type: 'AskToggled', inboxId: GROVE },
        { type: 'AskLanded', inboxId: GROVE, key: g(10) },
        read([
          grove({
            waiting: [asked(1)],
            agent: [answered(9), answered(10)],
          }),
        ]),
      ],
      (s) => {
        expect(s.matches({ composer: 'replying' })).toBe(true);
        expect(activeQueueOf(s)).toBe('agent');
        expect(s.context.focus.agent).toBe(g(10));
      },
    ));

  it('leaves a reader who moved on where they are when it lands', () =>
    scenario(
      [
        read(views),
        { type: 'AskToggled', inboxId: GROVE },
        { type: 'AskClosed' },
        { type: 'AskLanded', inboxId: GROVE, key: g(10) },
      ],
      (s) => {
        expect(activeQueueOf(s)).toBe('inbox');
        expect(s.context.awaited).toBeUndefined();
      },
    ));

  it('finds the ask cursor by Inbox id, two Inboxes sharing a name', () => {
    const choices = [
      { inboxId: GROVE, label: 'notes' },
      { inboxId: NIGHTLY, label: 'notes' },
    ];
    expect(askCursorOf(choices, NIGHTLY)?.inboxId).toBe(NIGHTLY);
    expect(askCursorOf(choices, undefined)?.inboxId).toBe(GROVE);
  });
});

describe('the rail', () => {
  const rail = (s: ReaderSnapshot) => (s.value as { rail: string }).rail;
  const fits: Event = { type: 'RailFitChanged', fits: true };
  const tight: Event = { type: 'RailFitChanged', fits: false };
  const toggled: Event = { type: 'RailToggled' };

  it('starts shut, and peeks on a hover until the pointer leaves', async () => {
    await scenario([], (s) => expect(rail(s)).toBe('shut'));
    await scenario([{ type: 'RailHovered' }], (s) =>
      expect(rail(s)).toBe('peeking'),
    );
    await scenario([{ type: 'RailHovered' }, { type: 'RailLeft' }], (s) =>
      expect(rail(s)).toBe('shut'),
    );
  });

  it('stays open pinned while it fits beside the column', () =>
    scenario(
      [fits, toggled, { type: 'RailLeft' }, { type: 'RailDismissed' }],
      (s) => expect(rail(s)).toBe('docked'),
    ));

  it('opens as a drawer when it does not fit', async () => {
    await scenario([tight, toggled], (s) => expect(rail(s)).toBe('drawer'));
    await scenario([tight, toggled, toggled], (s) =>
      expect(rail(s)).toBe('shut'),
    );
    await scenario([tight, toggled, { type: 'RailDismissed' }], (s) =>
      expect(rail(s)).toBe('shut'),
    );
  });

  it('pins from a peek, and a focus inside a peek keeps it open', async () => {
    await scenario([fits, { type: 'RailHovered' }, toggled], (s) =>
      expect(rail(s)).toBe('docked'),
    );
    await scenario(
      [{ type: 'RailHovered' }, { type: 'RailFocused' }, { type: 'RailLeft' }],
      (s) => expect(rail(s)).toBe('drawer'),
    );
  });

  it('remembers the pin through a narrow spell', () =>
    scenario([fits, toggled, tight], (s) => expect(rail(s)).toBe('shut')).then(
      () =>
        scenario([fits, toggled, tight, fits], (s) =>
          expect(rail(s)).toBe('docked'),
        ),
    ));

  it('forgets the pin when it is toggled off', () =>
    scenario([fits, toggled, toggled, tight, fits], (s) =>
      expect(rail(s)).toBe('shut'),
    ));

  it('opens to show a rename, and stays pinned if it was', async () => {
    const rename: Event = { type: 'RenameOpened', inboxId: GROVE };
    await scenario([rename], (s) => expect(rail(s)).toBe('drawer'));
    await scenario([fits, toggled, rename], (s) =>
      expect(rail(s)).toBe('docked'),
    );
  });
});

describe('a rename', () => {
  const open: Event = { type: 'RenameOpened', inboxId: GROVE };

  it('edits one Inbox at a time', () =>
    scenario([open, { type: 'RenameOpened', inboxId: NIGHTLY }], (s) => {
      expect(s.matches({ rename: 'editing' })).toBe(true);
      expect(s.context.renaming).toBe(NIGHTLY);
    }));

  it('closes on Close and when its write lands', async () => {
    for (const closer of [
      { type: 'RenameClosed' },
      { type: 'RenameLanded', inboxId: GROVE },
    ] as ReadonlyArray<Event>)
      await scenario([open, closer], (s) => {
        expect(s.matches({ rename: 'idle' })).toBe(true);
        expect(s.context.renaming).toBeUndefined();
      });
  });

  it('stays on another Inbox when an older rename lands', () =>
    scenario(
      [
        open,
        { type: 'RenameOpened', inboxId: NIGHTLY },
        { type: 'RenameLanded', inboxId: GROVE },
      ],
      (s) => expect(s.context.renaming).toBe(NIGHTLY),
    ));
});

describe('the scroll', () => {
  const views = [grove({ waiting: [asked(1), asked(2), asked(3)] })];
  const third: Event = { type: 'MovedTo', key: g(3) };
  // The first read places the list; a reader's scroll ends that lock early.
  const placed: ReadonlyArray<Event> = [read(views), { type: 'ScrollTaken' }];

  const timed = <A>(
    run: (reader: Reader) => Effect.Effect<A, unknown>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* createEffectActor(readerMachine);
        return yield* run(reader);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );

  it('follows the reading line, with no jump', () =>
    scenario([...placed, { type: 'ScrolledTo', key: g(2) }], (s) => {
      expect(s.context.focus.inbox).toBe(g(2));
      expect(s.context.jump?.id).toBe(1);
    }));

  it('asks for one smooth jump per move, each with its own id', () =>
    scenario([read(views), third, { type: 'MovedTo', key: g(2) }], (s) => {
      expect(s.context.jump).toEqual({ id: 3, key: g(2), smooth: true });
      expect(s.matches({ scroll: 'jumping' })).toBe(true);
    }));

  it('asks for no jump to the question already focused', () =>
    scenario([read(views), { type: 'MovedTo', key: g(1) }], (s) =>
      expect(s.context.jump?.id).toBe(1),
    ));

  it('ignores the questions a jump passes', () =>
    scenario([read(views), third, { type: 'ScrolledTo', key: g(2) }], (s) =>
      expect(s.context.focus.inbox).toBe(g(3)),
    ));

  it('follows again once the jump ends', () =>
    scenario(
      [
        read(views),
        third,
        { type: 'JumpEnded', id: 2 },
        { type: 'ScrolledTo', key: g(2) },
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(2)),
    ));

  it('keeps the lock when an overtaken jump ends', () =>
    scenario(
      [
        read(views),
        third,
        { type: 'MovedTo', key: g(2) },
        { type: 'JumpEnded', id: 2 },
        { type: 'ScrolledTo', key: g(3) },
      ],
      (s) => {
        expect(s.matches({ scroll: 'jumping' })).toBe(true);
        expect(s.context.focus.inbox).toBe(g(2));
      },
    ));

  it('hands the scroll to a reader who takes it mid-jump', () =>
    scenario(
      [
        read(views),
        third,
        { type: 'ScrollTaken' },
        { type: 'ScrolledTo', key: g(2) },
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(2)),
    ));

  it('ignores a scroll from a question this queue does not hold', () =>
    scenario([...placed, { type: 'ScrolledTo', key: g(9) }], (s) =>
      expect(s.context.focus.inbox).toBe(g(1)),
    ));

  it('ignores the scroll while asking, the list being hidden', () =>
    scenario(
      [
        ...placed,
        { type: 'AskToggled', inboxId: GROVE },
        { type: 'ScrolledTo', key: g(2) },
      ],
      (s) => expect(s.context.focus.inbox).toBe(g(1)),
    ));

  it('lets a jump go when scrollend never comes', () =>
    timed((reader) =>
      Effect.gen(function* () {
        yield* drive(reader, [read(views), third]);
        yield* TestClock.adjust(JUMP_LOCK_MS - 1);
        expect(reader.getSnapshot().matches({ scroll: 'jumping' })).toBe(true);
        yield* TestClock.adjust(1);
        yield* waitFor(reader, (s) => s.matches({ scroll: 'reading' }));
      }),
    ));

  it('restarts the lock for a jump that overtakes another', () =>
    timed((reader) =>
      Effect.gen(function* () {
        yield* drive(reader, [read(views), third]);
        yield* TestClock.adjust(JUMP_LOCK_MS - 1);
        yield* drive(reader, [{ type: 'MovedTo', key: g(2) }]);
        yield* TestClock.adjust(JUMP_LOCK_MS - 1);
        expect(reader.getSnapshot().matches({ scroll: 'jumping' })).toBe(true);
        yield* TestClock.adjust(1);
        yield* waitFor(reader, (s) => s.matches({ scroll: 'reading' }));
      }),
    ));

  it('swallows the scroll a placement causes, then follows again', () =>
    timed((reader) =>
      Effect.gen(function* () {
        const agent = [grove({ agent: [answered(8), answered(9)] })];
        yield* drive(reader, [
          read(agent),
          { type: 'QueueChosen', queue: 'agent' },
        ]);
        const swallowed = yield* drive(reader, [
          { type: 'ScrolledTo', key: g(8) },
        ]);
        expect(swallowed.context.focus.agent).toBe(g(9));
        yield* TestClock.adjust(PLACE_LOCK_MS);
        yield* waitFor(reader, (s) => s.matches({ scroll: 'reading' }));
        const after = yield* drive(reader, [{ type: 'ScrolledTo', key: g(8) }]);
        expect(after.context.focus.agent).toBe(g(8));
      }),
    ));
});

describe('a scrub down the minimap', () => {
  const views = [grove({ waiting: [1, 2, 3, 4, 5].map((n) => asked(n)) })];
  const placed: ReadonlyArray<Event> = [read(views), { type: 'ScrollTaken' }];
  const over = (n: number): Event => ({ type: 'ScrubbedTo', key: g(n) });
  const ended: Event = { type: 'ScrubEnded' };

  it('starts on the question under the finger, the focused one too', () =>
    scenario([...placed, over(1)], (s) => {
      expect(s.matches({ scroll: 'scrubbing' })).toBe(true);
      expect(s.context.focus.inbox).toBe(g(1));
      expect(s.context.jump?.id).toBe(1);
    }));

  it('places each question it passes, with no slide', () =>
    scenario([...placed, over(1), over(2), over(4)], (s) => {
      expect(s.context.focus.inbox).toBe(g(4));
      expect(s.context.jump).toEqual({ id: 3, key: g(4), smooth: false });
      expect(s.matches({ scroll: 'scrubbing' })).toBe(true);
    }));

  it('runs back up as well as down', () =>
    scenario([...placed, over(4), over(3), over(2)], (s) =>
      expect(s.context.focus.inbox).toBe(g(2)),
    ));

  it('keeps the focus from the reading line while it scrubs', () =>
    scenario([...placed, over(4), { type: 'ScrolledTo', key: g(3) }], (s) =>
      expect(s.context.focus.inbox).toBe(g(4)),
    ));

  it('holds through a scroll taken under it, until the finger lifts', () =>
    scenario(
      [
        ...placed,
        over(4),
        { type: 'ScrollTaken' },
        { type: 'ScrolledTo', key: g(3) },
      ],
      (s) => {
        expect(s.matches({ scroll: 'scrubbing' })).toBe(true);
        expect(s.context.focus.inbox).toBe(g(4));
      },
    ));

  it('leaves the reader on the last question when the finger lifts', () =>
    scenario([...placed, over(2), over(5), ended], (s) => {
      expect(s.context.focus.inbox).toBe(g(5));
      expect(s.matches({ scroll: 'placing' })).toBe(true);
    }));

  it('swallows the last placement scroll, then follows the reader again', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* createEffectActor(readerMachine);
        yield* drive(reader, [...placed, over(5), ended]);
        const swallowed = yield* drive(reader, [
          { type: 'ScrolledTo', key: g(4) },
        ]);
        expect(swallowed.context.focus.inbox).toBe(g(5));
        yield* TestClock.adjust(PLACE_LOCK_MS);
        yield* waitFor(reader, (s) => s.matches({ scroll: 'reading' }));
        const after = yield* drive(reader, [{ type: 'ScrolledTo', key: g(4) }]);
        expect(after.context.focus.inbox).toBe(g(4));
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    ));

  it('takes no notice of an end with no scrub', () =>
    scenario([...placed, ended], (s) =>
      expect(s.matches({ scroll: 'reading' })).toBe(true),
    ));

  it('ignores a question the queue on screen does not hold', () =>
    scenario([...placed, over(2), over(9)], (s) => {
      expect(s.context.focus.inbox).toBe(g(2));
      expect(s.context.jump?.key).toBe(g(2));
    }));

  it('stops the composer asking, as any move does', () =>
    scenario(
      [...placed, { type: 'AskToggled', inboxId: GROVE }, over(3)],
      (s) => expect(s.matches({ composer: 'asking' })).toBe(false),
    ));

  it('lets a held question go when it scrubs off it', () =>
    scenario(
      [
        read(mixed),
        { type: 'Moved', by: 1 },
        read([grove({ waiting: [asked(1), asked(3)] })], down),
        { type: 'ScrubbedTo', key: b(2) },
        { type: 'ScrubbedTo', key: g(3) },
      ],
      (s) => {
        expect(s.context.focus.inbox).toBe(g(3));
        expect(s.context.held).toBeUndefined();
      },
    ));
});

describe('the binding', () => {
  it('runs the machine through its Atoms', async () => {
    const registry = AtomRegistry.make();
    const lit = inboxReaderAtoms.select((s) => s.context.focus.inbox);
    const unmount = registry.mount(lit);
    try {
      const reader = await Effect.runPromise(
        AtomRegistry.getResult(registry, inboxReaderAtoms.actor),
      );
      registry.set(inboxReaderAtoms.send, read(mixed));
      await Effect.runPromise(
        waitFor(reader, (s) => s.context.focus.inbox !== undefined),
      );
      const value = registry.get(lit);
      expect(AsyncResult.isSuccess(value) && value.value).toBe(g(1));
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
