import {
  InboxId,
  InboxMachineKey,
  type InboxViewDto,
} from '@operator-inbox/core/api';
import { describe, expect, it } from 'vitest';
import {
  FRESH_MS,
  freshAt,
  queuesOf,
  seenAfter,
  spentAfter,
} from '../src/inbox-queues';

// The queues as the zen page reads them, and the fold that says what is new.
// All names are invented.

const LOCAL = InboxMachineKey.make('local');
const DESKTOP = InboxMachineKey.make('7101');
const BUILD_BOX = InboxMachineKey.make('7102');

const inbox = (name: string) => InboxId.make(`inbox-${name}`);

const asked = (number: number, askedSeq: number, askedAt?: string) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: '',
  askedSeq,
  ...(askedAt === undefined ? {} : { askedAt }),
});

const answered = (
  number: number,
  answeredSeq: number,
  answeredAt?: string,
) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: '',
  response: 'Yes',
  answeredSeq,
  ...(answeredAt === undefined ? {} : { answeredAt }),
});

const processed = (
  number: number,
  processedSeq: number,
  processedAt?: string,
) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: '',
  response: 'Yes',
  processedSeq,
  ...(processedAt === undefined ? {} : { processedAt }),
});

interface ViewParts {
  readonly awaitingOperator?: ReadonlyArray<ReturnType<typeof asked>>;
  readonly awaitingAgent?: ReadonlyArray<ReturnType<typeof answered>>;
  readonly processed?: ReadonlyArray<ReturnType<typeof processed>>;
}

const view = (
  name: string,
  machine: InboxMachineKey,
  parts: ViewParts,
): InboxViewDto =>
  ({
    inboxId: inbox(name),
    label: name,
    metadata: {},
    archived: false,
    pinnedGroups: [],
    awaitingOperator: [],
    awaitingAgent: [],
    processed: [],
    ...parts,
    ...(machine === LOCAL ? {} : { machine: { key: machine, label: name } }),
  }) as unknown as InboxViewDto;

const at = (hour: number) =>
  `2026-11-05T${String(hour).padStart(2, '0')}:00:00.000Z`;

describe('the queues', () => {
  it('orders Your inbox oldest asked first, across machines, whatever the seqs', () => {
    // The seqs are places in each machine's own log: 900 on desktop says
    // nothing against 3 on build-box.
    const views = [
      view('desktop-notes', DESKTOP, {
        awaitingOperator: [asked(1, 900, at(11))],
      }),
      view('nightly', BUILD_BOX, {
        awaitingOperator: [asked(1, 3, at(12)), asked(2, 4, at(9))],
      }),
      view('grove', LOCAL, { awaitingOperator: [asked(1, 50, at(10))] }),
    ];

    expect(queuesOf(views).inbox.map((i) => i.key)).toEqual([
      'inbox-nightly/2',
      'inbox-grove/1',
      'inbox-desktop-notes/1',
      'inbox-nightly/1',
    ]);
  });

  it('keeps a highlighted question in its place in time', () => {
    const highlighted = {
      ...asked(2, 2, at(12)),
      highlight: { seq: 9 },
    };
    const views = [
      view('grove', LOCAL, {
        awaitingOperator: [asked(1, 1, at(10)), highlighted],
      }),
    ];

    expect(queuesOf(views).inbox.map((i) => i.question.number)).toEqual([1, 2]);
  });

  it('orders With the agent and Processed most recent first, across machines', () => {
    const views = [
      view('desktop-notes', DESKTOP, {
        awaitingAgent: [answered(1, 900, at(9))],
        processed: [processed(4, 901, at(9))],
      }),
      view('nightly', BUILD_BOX, {
        awaitingAgent: [answered(2, 3, at(11))],
        processed: [processed(5, 4, at(11))],
      }),
    ];

    const queues = queuesOf(views);
    expect(queues.agent.map((i) => i.question.number)).toEqual([2, 1]);
    expect(queues.processed.map((i) => i.question.number)).toEqual([5, 4]);
  });

  it('breaks a tie with the seq only on one machine', () => {
    const views = [
      view('grove', LOCAL, {
        awaitingOperator: [asked(2, 8, at(10)), asked(1, 7, at(10))],
      }),
    ];

    expect(queuesOf(views).inbox.map((i) => i.question.number)).toEqual([1, 2]);
  });

  it('orders a tie across machines by machine, not by seq or list order', () => {
    const one = view('nightly', BUILD_BOX, {
      awaitingOperator: [asked(1, 1, at(10))],
    });
    const other = view('desktop-notes', DESKTOP, {
      awaitingOperator: [asked(1, 900, at(10))],
    });

    const expected = [inbox('desktop-notes'), inbox('nightly')];
    expect(queuesOf([one, other]).inbox.map((i) => i.inboxId)).toEqual(
      expected,
    );
    expect(queuesOf([other, one]).inbox.map((i) => i.inboxId)).toEqual(
      expected,
    );
  });

  it('reads a question with no stamp, or a bad one, as the oldest', () => {
    const views = [
      view('grove', LOCAL, {
        awaitingOperator: [
          asked(1, 1, at(10)),
          asked(2, 2),
          asked(3, 3, 'not a time'),
        ],
        awaitingAgent: [answered(4, 4), answered(5, 5, at(10))],
      }),
    ];

    const queues = queuesOf(views);
    expect(queues.inbox.map((i) => i.question.number)).toEqual([2, 3, 1]);
    expect(queues.agent.map((i) => i.question.number)).toEqual([5, 4]);
  });

  it('carries each question’s key, Inbox and machine', () => {
    const [item] = queuesOf([
      view('nightly', BUILD_BOX, { awaitingOperator: [asked(7, 1, at(10))] }),
    ]).inbox;

    expect(item).toMatchObject({
      key: 'inbox-nightly/7',
      inboxId: inbox('nightly'),
      inboxLabel: 'nightly',
      machine: BUILD_BOX,
    });
  });
});

describe('what is new', () => {
  const one = view('grove', LOCAL, { awaitingOperator: [asked(1, 1, at(9))] });
  const two = view('grove', LOCAL, {
    awaitingOperator: [asked(1, 1, at(9)), asked(2, 2, at(10))],
  });
  const away = view('nightly', BUILD_BOX, {
    awaitingOperator: [asked(1, 1, at(8))],
  });

  it('lights nothing on the first board', () => {
    const seen = seenAfter(undefined, [one, away], [LOCAL, BUILD_BOX], 0);

    expect(seen.fresh).toEqual([]);
    expect(seen.known.size).toBe(2);
  });

  it('lights a question the board did not hold, at the read’s time', () => {
    const first = seenAfter(undefined, [one], [LOCAL], 0);
    const seen = seenAfter(first, [two], [LOCAL], 5_000);

    expect(seen.fresh).toEqual([
      { key: 'inbox-grove/2', inboxId: inbox('grove'), at: 5_000 },
    ]);
  });

  it('never lights a question again when its machine comes back', () => {
    const first = seenAfter(undefined, [one, away], [LOCAL, BUILD_BOX], 0);
    const gone = seenAfter(first, [one], [LOCAL], 5_000);
    const back = seenAfter(gone, [one, away], [LOCAL, BUILD_BOX], 10_000);

    expect(gone.known.has('inbox-nightly/1')).toBe(true);
    expect(back.fresh).toEqual([]);
  });

  it('seeds a machine down at load when it first answers', () => {
    // Its questions are old news, not arrivals: this page just never read it.
    const first = seenAfter(undefined, [one], [LOCAL], 0);
    const joined = seenAfter(first, [one, away], [LOCAL, BUILD_BOX], 5_000);

    expect(joined.fresh).toEqual([]);
    expect(joined.known.has('inbox-nightly/1')).toBe(true);
  });

  it('lights what a machine asks after its first read, an empty one included', () => {
    const empty = view('nightly', BUILD_BOX, {});
    const first = seenAfter(undefined, [one, empty], [LOCAL, BUILD_BOX], 0);
    const seen = seenAfter(first, [one, away], [LOCAL, BUILD_BOX], 5_000);

    expect(seen.fresh.map((f) => f.key)).toEqual(['inbox-nightly/1']);
  });

  it('drops a mark once it has run its time', () => {
    const first = seenAfter(undefined, [one], [LOCAL], 0);
    const lit = seenAfter(first, [two], [LOCAL], 1_000);

    expect(freshAt(lit, 1_000 + FRESH_MS - 1)).toHaveLength(1);
    expect(freshAt(lit, 1_000 + FRESH_MS)).toHaveLength(0);
    expect(seenAfter(lit, [two], [LOCAL], 1_000 + FRESH_MS).fresh).toEqual([]);
  });
});

describe('a dot whose question stops waiting', () => {
  const mark = (key: string, at = 0) => ({ key, inboxId: inbox('a'), at });

  it('is spent from the moment it stops, and only it', () => {
    const fresh = [mark('one'), mark('two')];
    const spent = spentAfter(new Map(), fresh, new Set(['two']), 5_000);
    expect([...spent]).toEqual([['one', 5_000]]);
  });

  it('keeps the moment it stopped across later reads', () => {
    const first = spentAfter(new Map(), [mark('one')], new Set(), 5_000);
    const later = spentAfter(first, [mark('one')], new Set(), 9_000);
    expect(later.get('one')).toBe(5_000);
  });

  it('is lit again when the question waits again, a refused answer', () => {
    const first = spentAfter(new Map(), [mark('one')], new Set(), 5_000);
    const back = spentAfter(first, [mark('one')], new Set(['one']), 9_000);
    expect(back.size).toBe(0);
  });
});
