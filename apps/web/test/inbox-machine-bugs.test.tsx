import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { json } from './fixture';
import {
  A,
  answered,
  asked,
  box,
  footNote,
  items,
  LAPTOP,
  LOCAL,
  lit,
  litKey,
  M,
  MACHINE_BOARD,
  mount,
  mounted,
  note,
  onQueue,
  openRail,
  prefix,
  press,
  queueTab,
  reread,
  send,
  serve,
  settle,
  stubClipboard,
  summary,
  type,
  useInboxPage,
  VIEW_A,
  VIEW_M,
} from './inbox-page-harness';

// Regressions across Inbox machines, one `describe` each, on the real page. Local holds orchard; laptop holds an Inbox also named orchard.

useInboxPage();

const LOCAL_A = { ...VIEW_A, awaitingAgent: [], processed: [] };
const REACHABLE = {
  status: 'reachable',
  ...LAPTOP,
  port: 3010,
  awaitingOperator: 2,
};
const up = (local: object = LOCAL_A, remote: typeof VIEW_M = VIEW_M) => ({
  inboxes: [summary(local as never), summary(remote)],
  totalAwaitingOperator: 4,
  views: [local, remote],
  machines: [LOCAL, REACHABLE],
});
const down = (reason = 'tunnel-down') => ({
  inboxes: [summary(LOCAL_A)],
  totalAwaitingOperator: 2,
  views: [LOCAL_A],
  machines: [
    LOCAL,
    {
      status: 'unreachable',
      ...LAPTOP,
      port: 3010,
      reason,
      detail: 'nothing answered on port 3010',
    },
  ],
});

const greyedLine = () => screen.getByTestId('inbox-greyed');

const greyThenFold = async (): Promise<void> => {
  await reread(down());
  await waitFor(() => expect(greyedLine().textContent).not.toBe(''));
  await reread(down());
  await waitFor(() => expect(greyedLine().textContent).toBe(''));
};

const next = (): void =>
  press({ key: ']', code: 'BracketRight', ctrlKey: true });

const previous = (): void =>
  press({ key: '[', code: 'BracketLeft', ctrlKey: true });

const eyebrow = (): string =>
  lit().closest('[data-zen-item]')?.querySelector('[data-zen-eyebrow]')
    ?.textContent ?? '';

beforeEach(() => {
  serve.board = up();
});

describe('time order across machines', () => {
  // Each log's places say nothing of the other's: laptop's are far ahead of Local's
  // though its questions were asked, answered and processed in between.
  const at = (minute: number) =>
    `2026-10-09T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const on = <Q extends object>(q: Q, seq: object, time: object) => ({
    ...q,
    ...seq,
    ...time,
  });
  const q = (n: number, title: string, seq: number, minute: number) =>
    on(asked(n, title, seq), { askedSeq: seq }, { askedAt: at(minute) });

  it('reads the waiting oldest first by the time asked, not by a log’s place', async () => {
    serve.board = up(
      { ...LOCAL_A, awaitingOperator: [q(1, 'L1', 2, 10), q(3, 'L3', 3, 30)] },
      {
        ...VIEW_M,
        awaitingOperator: [q(1, 'R1', 900, 5), q(2, 'R2', 901, 20)],
      },
    );
    await mounted('/inbox');
    expect(items()).toEqual([`${M}/1`, `${A}/1`, `${M}/2`, `${A}/3`]);
  });

  it('reads the settled queues most recent first, by the time answered', async () => {
    const done = (n: number, title: string, seq: number, minute: number) =>
      on(
        answered(n, title, seq, 'Yes.'),
        { answeredSeq: seq },
        { answeredAt: at(minute) },
      );
    serve.board = up(
      {
        ...LOCAL_A,
        awaitingAgent: [done(6, 'L6', 2, 10), done(7, 'L7', 3, 30)],
      },
      {
        ...VIEW_M,
        awaitingAgent: [done(8, 'R8', 900, 5), done(9, 'R9', 901, 20)],
      },
    );
    await mounted('/inbox');
    fireEvent.click(queueTab(/With the agent/));
    await waitFor(() =>
      expect(items()).toEqual([`${A}/7`, `${M}/9`, `${A}/6`, `${M}/8`]),
    );
  });
});

describe('a fold under the reader', () => {
  it('keeps the question lit, its draft, a red foot note, and Send off', async () => {
    await mounted(`/inbox/${M}`);
    type('Half a thought');
    await greyThenFold();
    expect(litKey()).toBe(`${M}/1`);
    expect(box().value).toBe('Half a thought');
    expect(footNote()).toBe(
      'laptop cannot be reached. Your draft is kept for when it is back.',
    );
    expect(
      document
        .querySelector('[data-zen-foot-note]')
        ?.outerHTML.includes('text-red'),
    ).toBe(true);
    const held = screen.getByRole('button', { name: /^Held|^Send/ });
    expect((held as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Leave it to the agent' }),
    ).toBeNull();
    // Typing stays on: it is a draft.
    type('A whole thought');
    await waitFor(() => expect(box().value).toBe('A whole thought'));
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await settle();
    expect(serve.posts).toEqual([]);
  });

  it('lets go when the reader moves, not before', async () => {
    await mounted('/inbox');
    next();
    next();
    await waitFor(() => expect(litKey()).toBe(`${M}/1`));
    await greyThenFold();
    expect(litKey()).toBe(`${M}/1`);
    previous();
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    await settle();
    expect(items()).toEqual([`${A}/1`, `${A}/3`]);
  });
});

describe('focus by key, never by position', () => {
  it('leaves the question being read when a failed answer comes back', async () => {
    let reply: (r: Response) => void = () => undefined;
    serve.post = () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      });
    await mounted(`/inbox/${A}`);
    type('Yes');
    send();
    await waitFor(() => expect(litKey()).toBe(`${A}/3`));
    box().focus();
    type('Mine, on the third');
    reply(json({ _tag: 'AnswerRefused', message: 'too late' }, 409));
    await settle();
    await waitFor(() =>
      expect(queueTab(/Your inbox/).textContent).toContain('2'),
    );
    expect(litKey()).toBe(`${A}/3`);
    expect(box().value).toBe('Mine, on the third');
    expect(document.activeElement).toBe(box());
    expect(footNote()).toBe('');
  });
});

describe('a returning machine lights nothing as new', () => {
  const fresh = () => document.querySelectorAll('[data-zen-fresh]').length;

  it('brings its questions back as they were, and still marks a new one', async () => {
    await mounted('/inbox');
    await greyThenFold();
    await reread(up());
    await waitFor(() => expect(items()).toHaveLength(4));
    await settle();
    expect(fresh()).toBe(0);
    await reread({
      ...up(LOCAL_A, {
        ...VIEW_M,
        awaitingOperator: [
          ...VIEW_M.awaitingOperator,
          asked(3, 'Remote three', 40),
        ],
      }),
    });
    await waitFor(() => expect(items()).toHaveLength(5));
    await waitFor(() => expect(fresh()).toBeGreaterThan(0));
  });

  // Answer every new question before its dot has faded, and the dot fades
  // fast.
  it('fades a new question’s dot fast once the question stops waiting', async () => {
    await mounted('/inbox');
    await reread(up());
    await waitFor(() => expect(items()).toHaveLength(4));
    await settle();
    await reread({
      ...up(LOCAL_A, {
        ...VIEW_M,
        awaitingOperator: [
          ...VIEW_M.awaitingOperator,
          asked(3, 'Remote three', 40),
        ],
      }),
    });
    await waitFor(() => expect(items()).toHaveLength(5));
    await waitFor(() => expect(fresh()).toBeGreaterThan(0));
    const fading = () => document.querySelectorAll('.animate-fresh-out').length;
    expect(fading()).toBe(0);
    await reread(up());
    await waitFor(() => expect(items()).toHaveLength(4));
    await waitFor(() => expect(fading()).toBeGreaterThan(0));
    expect(document.querySelectorAll('.animate-fresh').length).toBe(0);
  });

  it('brings them back as they were after a change of view while it was down', async () => {
    await mounted('/inbox');
    await greyThenFold();
    await openRail();
    fireEvent.click(
      within(document.querySelector('nav[aria-label="Inboxes"]') as HTMLElement)
        .getAllByRole('link')
        .find((l) => l.textContent?.includes('orchard')) as HTMLElement,
    );
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${A}`));
    history.pushState(null, '', '/inbox');
    fireEvent.popState(window);
    await waitFor(() => expect(location.pathname).toBe('/inbox'));
    await reread(up());
    await waitFor(() => expect(items()).toHaveLength(4));
    await settle();
    expect(fresh()).toBe(0);
  });
});

describe('Inboxes that share a name', () => {
  it('tells them apart in the eyebrow', async () => {
    await mounted('/inbox');
    expect(eyebrow()).not.toContain('laptop');
    next();
    next();
    await waitFor(() => expect(litKey()).toBe(`${M}/1`));
    expect(eyebrow()).toContain('laptop');
  });

  it('offers both to the ask, by id, naming the machine', async () => {
    await mounted('/inbox');
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-zen-choice]')?.textContent,
      ).toContain('orchard'),
    );
    const choice = () =>
      document.querySelector('[data-zen-choice]')?.textContent ?? '';
    // The cursor starts on Local's, and one step lands on laptop's, though the two
    // read the same but for the machine.
    expect(choice()).not.toContain('laptop');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    await waitFor(() => expect(choice()).toContain('laptop'));
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText(/In orchard on laptop/);
    type('Why?');
    serve.post = () => json(VIEW_M);
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(serve.posts[0]?.path).toBe(`/api/inbox/${M}/questions`),
    );
  });
});

describe('search reads the board on screen', () => {
  it('finds a greyed question by Ctrl+P', async () => {
    await mounted('/inbox');
    await reread(down());
    await waitFor(() => expect(greyedLine().textContent).not.toBe(''));
    press({ key: 'p', code: 'KeyP', ctrlKey: true });
    fireEvent.change(await screen.findByTestId('search-field'), {
      target: { value: 'Remote' },
    });
    await waitFor(() =>
      expect(
        screen.queryAllByTestId('search-hit').map((h) => h.dataset.key),
      ).toEqual([`${M}#1`, `${M}#2`]),
    );
    // It was searched, as it is drawn.
    expect(document.querySelector('[data-search-not-searched]')).toBeNull();
  });

  it('says a folded machine was not searched', async () => {
    await mounted('/inbox');
    await greyThenFold();
    press({ key: 'p', code: 'KeyP', ctrlKey: true });
    await screen.findByTestId('search-field');
    await waitFor(() =>
      expect(
        document.querySelector('[data-search-not-searched]')?.textContent,
      ).toContain('laptop'),
    );
  });

  it('says a folded machine was not searched, in the sidebar too', async () => {
    await mounted('/inbox');
    await greyThenFold();
    await openRail();
    fireEvent.change(screen.getByLabelText('Search inboxes and groups'), {
      target: { value: 'orch' },
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-sidebar-not-searched]')?.textContent,
      ).toContain('laptop'),
    );
  });
});

describe('“Nothing waiting on you.” does not lie', () => {
  it('says nothing of the kind for an Inbox on an unreachable machine, before the first board', async () => {
    serve.read = () => new Promise<Response>(() => undefined);
    mount(`/inbox/${M}`);
    await settle();
    expect(screen.queryByText('Nothing waiting on you.')).toBeNull();
  });

  it('says what may be there on All, while a machine is down', async () => {
    serve.board = {
      ...down(),
      inboxes: [summary({ ...LOCAL_A, awaitingOperator: [] })],
      views: [{ ...LOCAL_A, awaitingOperator: [] }],
      totalAwaitingOperator: 0,
    };
    mount('/inbox');
    await screen.findByText('Nothing waiting on you.');
    await screen.findByText(
      'laptop cannot be reached, so there may be more there.',
    );
  });

  it('never says it of an Inbox whose machine is folded', async () => {
    await mounted(`/inbox/${M}`);
    await greyThenFold();
    await onQueue(/With the agent/);
    await onQueue(/Your inbox/);
    await screen.findByText('orchard is on laptop, which cannot be reached.');
    expect(screen.queryByText('Nothing waiting on you.')).toBeNull();
  });
});

describe('the machine surfaces the page keeps', () => {
  it('keeps the missing-inbox notice', async () => {
    mount('/inbox/inbox-nowhere');
    await screen.findByText('No inbox here.');
  });

  it('keeps the serve failure, and the last view that loaded', async () => {
    await mounted('/inbox');
    await openRail();
    serve.read = async () => new Response('nope', { status: 500 });
    await reread();
    await waitFor(() =>
      expect(note('serve')?.textContent).toContain(
        'Showing the last view that loaded.',
      ),
    );
    expect(items()).toHaveLength(4);
  });

  it('keeps the tunnel hint, with a copy, the status for a screen reader, and the port in a title', async () => {
    serve.board = MACHINE_BOARD;
    await mounted('/inbox');
    await openRail();
    const desktop = document.querySelector<HTMLElement>(
      '[data-machine-section="desktop"]',
    ) as HTMLElement;
    const heading = within(desktop).getAllByRole('button')[0] as HTMLElement;
    expect(heading.getAttribute('title')).toBe(
      'desktop: 127.0.0.1:3011, unreachable',
    );
    expect(desktop.querySelector('[data-machine-status]')?.textContent).toBe(
      'unreachable',
    );
    fireEvent.click(heading);
    await within(desktop).findByText('operator-inbox tunnel desktop');
    const writeText = stubClipboard();
    fireEvent.click(
      within(desktop).getByRole('button', {
        name: 'Copy the command that opens the tunnel to desktop',
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('operator-inbox tunnel desktop'),
    );
  });

  it('keeps a stray write until it is cleared', async () => {
    serve.post = () =>
      json({ _tag: 'InboxUnavailable', message: 'nope', machine: LAPTOP }, 503);
    serve.board = up(LOCAL_A, {
      ...VIEW_M,
      awaitingOperator: [
        { ...asked(1, 'Remote one', 30), highlight: { seq: 1 } },
        asked(2, 'Remote two', 31),
      ],
    });
    await mounted(`/inbox/${M}`);
    await openRail();
    prefix();
    press({ key: 'd', code: 'KeyD' });
    await waitFor(() => expect(note('stray')).not.toBeNull());
    fireEvent.click(
      within(note('stray') as HTMLElement).getByRole('button', {
        name: 'Clear',
      }),
    );
    await waitFor(() => expect(note('stray')).toBeNull());
  });
});
