import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { Duration, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockAtom } from '../src/clock';
import { BOARD_READ_BOUND, INBOX_POLL_INTERVAL_MS } from '../src/inbox';
import { json } from './fixture';
import {
  A,
  asked,
  BOARD,
  box,
  footNote,
  items,
  LAPTOP,
  LOCAL,
  litKey,
  M,
  mount,
  mounted,
  nav,
  note,
  onQueue,
  openRail,
  prefix,
  press,
  reread,
  send,
  serve,
  settle,
  summary,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_B,
  VIEW_C,
  VIEW_M,
} from './inbox-page-harness';
import { fromRowMenu } from './row-menu';

// A machine that stops answering, then answers again, and what the page says of
// it. Local holds orchard; laptop holds grove with two questions waiting, asked
// after Local's. A read that misses laptop leaves its Inbox off the board, since
// serve keeps no copy: the page's own last read is what greys.

useInboxPage();

const LOCAL_A = { ...VIEW_A, awaitingAgent: [], processed: [] };
const GROVE = { ...VIEW_M, label: 'grove' };
const up = (view: typeof GROVE = GROVE, more: object = {}) => ({
  inboxes: [summary(LOCAL_A), summary(view)],
  totalAwaitingOperator: 4,
  views: [LOCAL_A, view],
  machines: [
    LOCAL,
    { status: 'reachable', ...LAPTOP, port: 3010, awaitingOperator: 2 },
  ],
  ...more,
});
const UP = up();
const DOWN = {
  inboxes: [summary(LOCAL_A)],
  totalAwaitingOperator: 2,
  views: [LOCAL_A],
  machines: [
    LOCAL,
    {
      status: 'unreachable',
      ...LAPTOP,
      port: 3010,
      reason: 'tunnel-down',
      detail: 'nothing answered on port 3010',
    },
  ],
};

const MAY_HAVE =
  'the Inbox machine laptop did not answer within 15s; the change may have reached it — reload to check';
const mayHaveLanded = () =>
  json(
    {
      _tag: 'InboxUnavailable',
      message: MAY_HAVE,
      machine: LAPTOP,
      mayHaveLanded: true,
    },
    503,
  );

beforeEach(() => {
  serve.board = UP;
});

const section = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-machine-section="laptop"]');

const inSection = () => within(section() as HTMLElement);

const trigger = () => inSection().getAllByRole('button')[0] as HTMLElement;

const row = (inbox: string) =>
  nav().querySelector<HTMLElement>(`[data-rail-inbox="${inbox}"]`);

const greyedLine = () => screen.getByTestId('inbox-greyed');

const greyed = async (): Promise<void> => {
  await reread(DOWN);
  await waitFor(() => expect(greyedLine().textContent).not.toBe(''));
};

const folded = async (): Promise<void> => {
  await greyed();
  await reread(DOWN);
  await waitFor(() => expect(greyedLine().textContent).toBe(''));
};

const next = (): void =>
  press({ key: ']', code: 'BracketRight', ctrlKey: true });

const ALL_FOUR = [`${A}/1`, `${A}/3`, `${M}/1`, `${M}/2`];

describe('an Inbox machine that stops answering, then answers again', () => {
  it('greys a machine that misses one read, and folds it on a second in a row', async () => {
    await mounted('/inbox');
    await openRail();
    expect(items()).toEqual(ALL_FOUR);
    await greyed();
    // One miss: its questions and its row stay, its section open.
    expect(items()).toEqual(ALL_FOUR);
    expect(section()?.dataset.greyed).toBe('true');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(row(M)?.closest('[data-greyed-faded]')).not.toBeNull();
    await reread(DOWN);
    await waitFor(() => expect(items()).toEqual([`${A}/1`, `${A}/3`]));
    expect(section()?.dataset.greyed).toBeUndefined();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await reread(UP);
    await waitFor(() => expect(items()).toEqual(ALL_FOUR));
    expect(greyedLine().textContent).toBe('');
  });

  it('never fades the question in hand when its machine greys', async () => {
    await mounted(`/inbox/${M}`);
    await greyed();
    expect(litKey()).toBe(`${M}/1`);
    expect(
      document.querySelector('[data-inbox-reader] [data-greyed-faded]'),
    ).toBeNull();
  });

  it('warns at the foot of a greyed question, and of no other', async () => {
    await mounted('/inbox');
    await greyed();
    expect(footNote()).toBe('');
    next();
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    expect(footNote()).toBe('');
    next();
    await waitFor(() => expect(litKey()).toBe(`${M}/1`));
    expect(footNote()).toBe(
      'laptop missed the last read: a send may not reach it.',
    );
    expect(
      document
        .querySelector('[data-zen-foot-note]')
        ?.closest('[data-greyed-faded]'),
    ).toBeNull();
  });

  it('draws the sidebar’s greyed note at a contrast that meets AA', async () => {
    await mounted('/inbox');
    await openRail();
    await greyed();
    const greyedNote = document.querySelector('[data-machine-greyed-note]');
    expect(greyedNote?.classList.contains('text-fg/70')).toBe(true);
  });

  it('fills the live region in place, rather than mounting it full', async () => {
    await mounted('/inbox');
    const before = greyedLine();
    expect(before.tagName).toBe('OUTPUT');
    expect(before.textContent).toBe('');
    await greyed();
    expect(greyedLine()).toBe(before);
    expect(before.textContent).toBe(
      'laptop did not answer the last read, so what it held at the read before still shows, and a change sent now may not reach it.',
    );
  });

  it('describes a greyed section’s rows by its note, and says so in its status', async () => {
    await mounted('/inbox');
    await openRail();
    await greyed();
    const group = inSection().getByRole('group', { name: 'laptop' });
    const greyedNote = section()?.querySelector('[data-machine-greyed-note]');
    expect(group.getAttribute('aria-describedby')).toBe(greyedNote?.id);
    expect(section()?.querySelector('[data-machine-status]')?.textContent).toBe(
      'unreachable, showing what it held at the last read',
    );
    await reread(DOWN);
    await waitFor(() => expect(inSection().queryByRole('group')).toBeNull());
  });

  it('counts a greyed machine’s questions in All and in its row', async () => {
    await mounted('/inbox');
    await openRail();
    await greyed();
    const count = (inbox: string) =>
      row(inbox)?.closest('[data-greyed-faded]')?.textContent;
    expect(items()).toHaveLength(4);
    expect(count('')).toBe('All4');
    expect(count(M)).toBe('grove2');
    await reread(DOWN);
    await waitFor(() => expect(count('')).toBe('All2'));
  });

  it('leaves a greyed machine’s archived Inboxes out of its counts', async () => {
    const kiln = { ...VIEW_C, inboxId: 'inbox-n', machine: LAPTOP };
    serve.board = {
      ...UP,
      inboxes: [...UP.inboxes, summary(kiln)],
      views: [...UP.views, kiln],
    };
    await mounted('/inbox');
    await openRail();
    await greyed();
    expect(row('')?.closest('[data-greyed-faded]')?.textContent).toBe('All4');
  });

  it('greys again after a read it answered: misses count in a row only', async () => {
    await mounted('/inbox');
    await greyed();
    await reread(UP);
    await waitFor(() => expect(greyedLine().textContent).toBe(''));
    await greyed();
    expect(items()).toEqual(ALL_FOUR);
  });

  it('says the selected Inbox’s machine cannot be reached once it folds, never that it is gone', async () => {
    await mounted(`/inbox/${M}`);
    await greyed();
    expect(greyedLine().textContent).toBe(
      'laptop did not answer the last read, so this is what it held at the read before, and any change made here now may not reach it.',
    );
    await reread(DOWN);
    // The lit question is held until the reader moves.
    await waitFor(() =>
      expect(footNote()).toBe(
        'laptop cannot be reached. Your draft is kept for when it is back.',
      ),
    );
    await onQueue(/With the agent/);
    await onQueue(/Your inbox/);
    await screen.findByText('grove is on laptop, which cannot be reached.');
    expect(screen.getByText('operator-inbox tunnel laptop')).toBeDefined();
    expect(screen.queryByText('No inbox here.')).toBeNull();
    expect(items()).toEqual([]);
    await reread(UP);
    await waitFor(() => expect(items()).toEqual([`${M}/1`, `${M}/2`]));
    expect(screen.queryByText(/which cannot be reached/)).toBeNull();
  });

  it('says a Local Inbox gone from the board is not here, while a machine is down', async () => {
    await mounted(`/inbox/${A}`);
    const gone = {
      ...DOWN,
      inboxes: [summary(VIEW_B)],
      views: [VIEW_B],
      totalAwaitingOperator: 1,
    };
    await reread(gone);
    await reread(gone);
    await onQueue(/With the agent/);
    await onQueue(/Your inbox/);
    // Local answered, and orchard was Local's, so laptop being down is not why.
    await screen.findByText('No inbox here.');
    expect(screen.queryByText(/may be there/)).toBeNull();
  });

  it('says an Inbox it has never seen may be on a machine that is down', async () => {
    serve.board = DOWN;
    mount('/inbox/inbox-nowhere');
    await screen.findByText('This inbox is not on any machine that answered.');
    await screen.findByText('laptop cannot be reached, so it may be there.');
  });

  it('keeps a draft through the question leaving, and gives it back when it returns', async () => {
    await mounted(`/inbox/${M}`);
    next();
    await waitFor(() => expect(litKey()).toBe(`${M}/2`));
    type('Half a thought');
    await folded();
    expect(box().value).toBe('Half a thought');
    await onQueue(/With the agent/);
    await onQueue(/Your inbox/);
    await screen.findByText('grove is on laptop, which cannot be reached.');
    await reread(UP);
    await waitFor(() => expect(items()).toEqual([`${M}/1`, `${M}/2`]));
    expect(box().value).toBe('');
    next();
    await waitFor(() => expect(box().value).toBe('Half a thought'));
  });
});

describe('what a write to a machine comes to', () => {
  const answerOn = async (): Promise<void> => {
    await mounted(`/inbox/${M}`);
    type('Yes');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
  };

  // The answer flowed on, so the reader goes back to read what it came to.
  const back = async (): Promise<void> => {
    await waitFor(() => expect(litKey()).toBe(`${M}/2`));
    await settle();
    press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    await waitFor(() => expect(litKey()).toBe(`${M}/1`));
  };

  it('names the machine a refusal came from', async () => {
    const sentence = '#2 was answered already';
    serve.post = () =>
      json({ _tag: 'AnswerRefused', message: sentence, machine: LAPTOP }, 409);
    await answerOn();
    await back();
    expect(footNote()).toBe(`Not sent on laptop: ${sentence}.`);
  });

  it('says a write that may have reached the machine is unconfirmed, not unsent', async () => {
    serve.post = mayHaveLanded;
    await answerOn();
    await back();
    expect(footNote()).toBe(`Unconfirmed on laptop: ${MAY_HAVE}.`);
  });

  it('says a pin that may have reached the machine is unconfirmed, at full strength in a greyed section', async () => {
    serve.post = mayHaveLanded;
    await mounted('/inbox');
    await openRail();
    await greyed();
    await fromRowMenu('grove', 'Pin the inbox grove', section() as HTMLElement);
    const alert = await inSection().findByRole('alert');
    expect(alert.textContent).toBe(
      'Pin unconfirmed: it may have reached laptop.',
    );
    expect(alert.closest('[data-greyed-faded]')).toBeNull();
    expect(row(M)?.closest('[data-greyed-faded]')).not.toBeNull();
  });

  it('runs an answer to its end when its question folds, and says what it came to', async () => {
    let reply: (r: Response) => void = () => undefined;
    serve.post = () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      });
    await mounted(`/inbox/${M}`);
    await greyed();
    type('Yes');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await reread(DOWN);
    reply(mayHaveLanded());
    await openRail();
    // Its machine is folded, not its question gone: the sidebar says it, and
    // the question says the rest when it is back.
    await waitFor(() =>
      expect(note('answer')?.textContent).toBe(
        'Answer to #1 unconfirmedlaptop cannot be reached.',
      ),
    );
    // There is nowhere for its line to go yet, so it is no link.
    expect(
      within(note('answer') as HTMLElement).queryByRole('button'),
    ).toBeNull();
    expect(note('stray')).toBeNull();
    await reread(UP);
    await waitFor(() => expect(items()).toContain(`${M}/1`));
    await waitFor(() =>
      expect(note('answer')?.textContent).toBe('Answer to #1 unconfirmed'),
    );
    fireEvent.click(within(note('answer') as HTMLElement).getByRole('button'));
    await waitFor(() => expect(litKey()).toBe(`${M}/1`));
    expect(box().value).toBe('Yes');
    expect(footNote()).toBe(`Unconfirmed on laptop: ${MAY_HAVE}.`);
  });

  it.each([
    [
      'a pin',
      'Pinning grove',
      async () => {
        await fromRowMenu(
          'grove',
          'Pin the inbox grove',
          section() as HTMLElement,
        );
      },
    ],
    [
      'an archive',
      'Archiving grove',
      async () => {
        await fromRowMenu('grove', /Archive/, section() as HTMLElement);
      },
    ],
  ] as const)('runs %s to its end when its place folds, and says what it came to', async (_, what, write) => {
    let reply: (r: Response) => void = () => undefined;
    serve.post = () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      });
    await mounted('/inbox');
    await openRail();
    await greyed();
    await write();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await reread(DOWN);
    await waitFor(() => expect(row(M)).toBeNull());
    reply(mayHaveLanded());
    await waitFor(() =>
      expect(note('stray')?.textContent).toContain(
        `${what} — Unconfirmed on laptop: ${MAY_HAVE}.`,
      ),
    );
  });

  it('words a machine that could not be reached the same on every write', async () => {
    const sentence =
      'the Inbox machine laptop could not be reached: nothing answered on port 3010';
    serve.board = up({
      ...GROVE,
      awaitingOperator: [
        { ...asked(1, 'Remote one', 30), highlight: { seq: 1 } },
        asked(2, 'Remote two', 31),
      ],
    });
    serve.post = () =>
      json(
        { _tag: 'InboxUnavailable', message: sentence, machine: LAPTOP },
        503,
      );
    await mounted(`/inbox/${M}`);
    await openRail();
    // A dismissal has no place of its own, so it is said in the notes.
    prefix();
    press({ key: 'd', code: 'KeyD' });
    await waitFor(() =>
      expect(note('stray')?.textContent).toContain(
        `Not dismissed on laptop: ${sentence}.`,
      ),
    );
    await fromRowMenu('grove', 'Pin the inbox grove', section() as HTMLElement);
    expect((await inSection().findByRole('alert')).textContent).toBe(
      `Not pinned on laptop: ${sentence}.`,
    );
    type('Yes');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(3));
    press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    await waitFor(() =>
      expect(footNote()).toBe(`Not sent on laptop: ${sentence}.`),
    );
  });

  it('names every machine that claims an Inbox a write was refused for', async () => {
    serve.post = () =>
      json(
        {
          _tag: 'InboxUnavailable',
          message: 'refused',
          clashedOn: [LAPTOP, { key: '3011', label: 'desktop' }],
        },
        503,
      );
    await answerOn();
    await back();
    expect(footNote()).toBe(
      `Not sent: the Inbox ${M} is claimed by laptop and desktop: an Inbox lives on one machine, so it is refused on every one of them until one no longer has it.`,
    );
  });
});

describe('reads that take their time', () => {
  interface HeldRead {
    readonly release: (body: object) => void;
    readonly signal: AbortSignal | undefined;
  }

  // Board reads held until the test lets each go, each with the signal its
  // fetch was given.
  const holdReads = (): Array<HeldRead> => {
    const held: Array<HeldRead> = [];
    serve.read = (signal) =>
      new Promise<Response>((resolve) => {
        held.push({ release: (body) => resolve(json(body)), signal });
      });
    return held;
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await act(async () => {});
  };

  const tick = async (): Promise<void> => {
    act(() => vi.advanceTimersByTime(INBOX_POLL_INTERVAL_MS));
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets a read slower than the poll land, so a slow machine greys, then folds', async () => {
    await mounted('/inbox');
    const held = holdReads();
    await tick();
    expect(held).toHaveLength(1);
    await tick();
    await tick();
    expect(held).toHaveLength(1);
    expect(held[0]?.signal?.aborted).toBe(false);
    held[0]?.release(DOWN);
    await flush();
    expect(greyedLine().textContent).not.toBe('');
    // The ticks it waited through ask for one more read, which follows.
    await waitFor(() => expect(held).toHaveLength(2));
    await tick();
    expect(held[1]?.signal?.aborted).toBe(false);
    held[1]?.release(DOWN);
    await waitFor(() => expect(items()).toEqual([`${A}/1`, `${A}/3`]));
  });

  it('gives a read that never settles up at its bound, and reads again', async () => {
    const clock = Effect.runSync(TestClock.make().pipe(Effect.scoped));
    mount('/inbox', [[clockAtom, clock]]);
    await waitFor(() => expect(litKey()).toBeDefined());
    await openRail();
    const held = holdReads();
    await tick();
    await tick();
    await tick();
    expect(held).toHaveLength(1);
    const bound = Duration.toMillis(BOARD_READ_BOUND);
    await act(() => Effect.runPromise(clock.adjust(bound - 1)));
    await flush();
    expect(held).toHaveLength(1);
    expect(held[0]?.signal?.aborted).toBe(false);
    await act(() => Effect.runPromise(clock.adjust(1)));
    await flush();
    expect(held[0]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(held).toHaveLength(2));
    expect(note('serve')?.textContent).toBe(
      'Could not load the inboxes: operator-inbox serve did not answer within 30s, so the page gave the read up and reads again. Is operator-inbox serve running? Showing the last view that loaded.',
    );
    held[1]?.release(DOWN);
    await waitFor(() => expect(greyedLine().textContent).not.toBe(''));
    expect(note('serve')).toBeNull();
  });

  it('leaves a read in flight be when a write lands, and reads again after it', async () => {
    await mounted(`/inbox/${M}`);
    serve.post = () => json(GROVE);
    const held = holdReads();
    await tick();
    expect(held).toHaveLength(1);
    type('Yes');
    send();
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    await flush();
    expect(held).toHaveLength(1);
    expect(held[0]?.signal?.aborted).toBe(false);
    held[0]?.release(UP);
    await waitFor(() => expect(held).toHaveLength(2));
  });
});

describe('an Inbox id two machines claim, and machines turned off', () => {
  const DESKTOP = { key: '3011', label: 'desktop' };
  const X = 'inbox-x';
  const CLASH_BOARD = {
    ...BOARD,
    machines: [
      { ...LOCAL, awaitingOperator: 3 },
      { status: 'reachable', ...LAPTOP, port: 3010, awaitingOperator: 0 },
      { status: 'reachable', ...DESKTOP, port: 3011, awaitingOperator: 0 },
    ],
    clashes: [
      {
        inboxId: X,
        outcome: 'refused',
        claims: [
          { machine: LAPTOP, label: 'grove' },
          { machine: DESKTOP, label: 'copse' },
        ],
      },
      {
        inboxId: A,
        outcome: 'kept-on-local',
        claims: [
          { machine: { key: 'local', label: 'Local' }, label: 'orchard' },
          { machine: LAPTOP, label: 'orchard' },
        ],
      },
    ],
  };

  const clashes = () =>
    [...document.querySelectorAll<HTMLElement>('[data-note="clash"]')].map(
      (n) => n,
    );

  it('shows each clash in All, naming the machines and what each calls it, with nothing to act on', async () => {
    serve.board = CLASH_BOARD;
    await mounted('/inbox');
    await openRail();
    await waitFor(() => expect(clashes()).toHaveLength(2));
    const [refused, kept] = clashes();
    expect(refused?.textContent).toContain(
      `the Inbox ${X} is claimed by laptop and desktop: an Inbox lives on one machine, so it is refused on every one of them until one no longer has it.`,
    );
    expect(refused?.textContent).toContain(
      'laptop calls it “grove”; desktop calls it “copse”.',
    );
    expect(kept?.textContent).toContain(
      `the Inbox ${A} is Local's, and laptop claims it too: Local's is shown, and the other claim is left out.`,
    );
    for (const n of clashes()) {
      expect(within(n).queryAllByRole('button')).toEqual([]);
      expect(within(n).queryAllByRole('link')).toEqual([]);
    }
  });

  it('shows a refused Inbox’s clash in its own view, rather than that it is not here', async () => {
    serve.board = CLASH_BOARD;
    mount(`/inbox/${X}`);
    await screen.findByText(/laptop calls it/);
    expect(screen.queryByText('No inbox here.')).toBeNull();
  });

  it('notes a Local Inbox another machine claims too in its own view, and still shows it', async () => {
    serve.board = CLASH_BOARD;
    await mounted(`/inbox/${A}`);
    await openRail();
    await waitFor(() => expect(clashes()).toHaveLength(1));
    expect(clashes()[0]?.textContent).toContain(`the Inbox ${A} is Local's`);
    expect(items()).toEqual([`${A}/1`, `${A}/3`]);
  });

  it('says so when machines are off, and works as Local alone', async () => {
    const sentence =
      'config.json at /x/config.json: inboxMachines.0.port — expected an integer';
    serve.board = { ...BOARD, machines: [LOCAL], machinesOff: sentence };
    await mounted('/inbox');
    await openRail();
    await waitFor(() =>
      expect(note('machines-off')?.textContent).toBe(
        `No other machine's Inboxes are read, so this page shows Local's alone: ${sentence}`,
      ),
    );
    expect(document.querySelector('[data-machine-section]')).toBeNull();
    expect(items()).toHaveLength(3);
  });

  it('says the machines could not be read again when serve kept the last ones', async () => {
    const sentence =
      'config.json at /x/config.json: inboxMachines.0.port — expected an integer; serve keeps the 2 Inbox machines it read before';
    serve.board = { ...CLASH_BOARD, clashes: [], machinesOff: sentence };
    await mounted('/inbox');
    await openRail();
    await waitFor(() =>
      expect(note('machines-off')?.textContent).toBe(
        `The Inbox machines could not be read again: ${sentence}`,
      ),
    );
  });

  it('says nothing of it while machines are read', async () => {
    serve.board = CLASH_BOARD;
    await mounted('/inbox');
    await openRail();
    await waitFor(() => expect(clashes()).toHaveLength(2));
    expect(note('machines-off')).toBeNull();
  });
});
