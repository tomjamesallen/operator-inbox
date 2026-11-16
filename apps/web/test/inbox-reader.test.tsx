import {
  RegistryProvider,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect/atom-react';
import { InboxId, InboxMachineKey } from '@operator-inbox/core/api';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxPage } from '../src/components/inbox/page';
import { inboxBoardAtom, strayWritesAtom } from '../src/inbox';
import { askedTextOf, followUpText } from '../src/inbox-queues';
import {
  colophonOpenAtom,
  footNoteOf,
  INTRO_HOLD_MS,
  sendComposerAtom,
  toggleAskAtom,
} from '../src/inbox-reader';
import { inboxReaderAtoms } from '../src/inbox-reader-machine';
import { json } from './fixture';

// The reader on the real machine, real Atoms and the real client, over a fetch
// that answers as serve does. All names are invented.

const GROVE = InboxId.make('inbox-grove');
const NIGHTLY = InboxId.make('inbox-nightly');
const REMOTE = InboxMachineKey.make('7102');

const at = (hour: number) =>
  `2026-11-05T${String(hour).padStart(2, '0')}:00:00.000Z`;

const base = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: `<p>Body of ${number}</p>`,
  ...over,
});

const waiting = (number: number, over: Record<string, unknown> = {}) =>
  base(number, {
    askedSeq: number,
    askedAt: at(number),
    ...over,
  });

const withAgent = (number: number, over: Record<string, unknown> = {}) =>
  base(number, {
    response: 'Yes',
    answeredSeq: number,
    answeredAt: at(number),
    askedAt: at(number),
    ...over,
  });

const processed = (number: number, over: Record<string, unknown> = {}) =>
  base(number, {
    response: 'Yes',
    withdrawn: false,
    processedSeq: number,
    processedAt: at(number),
    answeredAt: at(number),
    askedAt: at(number),
    ...over,
  });

const view = (over: Record<string, unknown> = {}) => ({
  inboxId: GROVE,
  label: 'grove',
  metadata: {},
  archived: false,
  pinnedGroups: [],
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
  ...over,
});

type View = ReturnType<typeof view>;

const row = (v: View) => ({
  inboxId: v.inboxId,
  label: v.label,
  archived: v.archived,
  pinned: false,
  awaitingOperator: (v.awaitingOperator as Array<unknown>).length,
  awaitingAgent: (v.awaitingAgent as Array<unknown>).length,
  processed: (v.processed as Array<unknown>).length,
  ...('machine' in v ? { machine: v.machine } : {}),
});

const boardOf = (views: ReadonlyArray<View>, more: object = {}) => ({
  inboxes: views.map(row),
  totalAwaitingOperator: views.reduce(
    (n, v) => n + (v.awaitingOperator as Array<unknown>).length,
    0,
  ),
  views,
  ...more,
});

let board: unknown = boardOf([]);
let config: Response | undefined;
const writes: Array<{ path: string; body: unknown }> = [];
let answerResponse: () => Response | Promise<Response> = () => json(view());
let askResponse: () => Response = () => json(view());

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  board = boardOf([]);
  config = undefined;
  writes.length = 0;
  answerResponse = () => json(view());
  askResponse = () => json(view());
  sessionStorage.clear();
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), 'http://x');
    const method = request?.method ?? init?.method ?? 'GET';
    if (method === 'POST') {
      const text =
        request === undefined
          ? await new Response(init?.body ?? null).text()
          : await request.clone().text();
      writes.push({
        path: url.pathname,
        body: text === '' ? undefined : JSON.parse(text),
      });
      return url.pathname.endsWith('/answer')
        ? answerResponse()
        : askResponse();
    }
    if (url.pathname === '/api/inbox-config')
      return (
        config ??
        json({
          metadata: {
            extras: 'allow',
            keys: [
              {
                key: 'repo',
                description: 'r',
                presence: 'optional',
                type: 'string',
              },
              {
                key: 'pr',
                description: 'p',
                presence: 'optional',
                type: 'string',
              },
            ],
          },
        })
      );
    if (url.pathname === '/api/macros')
      return json({ path: '/c/operator-inbox/macros.json', text: null });
    if (url.pathname === '/api/keybindings') return json({ text: '' });
    return json(board);
  });
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (path = '/inbox') => {
  history.replaceState(null, '', path);
  return render(
    <RegistryProvider>
      <InboxPage />
    </RegistryProvider>,
  );
};

// The lit question's `<>` sits over the box, not on the question.
const metaCard = async (_lit: HTMLElement) => {
  const overBox = document.querySelector<HTMLElement>('[data-zen-answer]');
  fireEvent.click(
    await within(overBox ?? document.body).findByRole('button', {
      name: 'Metadata',
    }),
  );
  return screen.findByRole('dialog');
};

const litArticle = async () =>
  waitFor(() => {
    const lit = document.querySelector<HTMLElement>('[data-zen-lit]');
    expect(lit).not.toBeNull();
    return lit as HTMLElement;
  });

const box = () =>
  document.querySelector<HTMLTextAreaElement>(
    '[data-zen-box]',
  ) as HTMLTextAreaElement;

const footNote = () =>
  document.querySelector('[data-zen-foot-note]')?.textContent ?? '';

const queueTab = (name: RegExp) => screen.getByRole('tab', { name });

const type = (text: string) =>
  fireEvent.change(box(), { target: { value: text } });

const twoWaiting = () =>
  boardOf([view({ awaitingOperator: [waiting(1), waiting(2)] })]);

describe('the states before a question', () => {
  it('says it is loading to a screen reader while the board is out', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    mount();
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('says the board could not be read, in the question’s place', async () => {
    fetchMock.mockImplementation(async () =>
      json({ _tag: 'InboxUnavailable', message: 'the store is locked' }, 503),
    );
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The inbox store is unavailable');
  });

  it('says there are no inboxes yet', async () => {
    mount();
    expect(await screen.findByText(/No inboxes yet/)).toBeDefined();
  });

  it('says nothing waits on a board with an empty queue', async () => {
    board = boardOf([view()]);
    mount();
    expect(await screen.findByText('Nothing waiting on you.')).toBeDefined();
    expect(document.querySelector('[data-zen-owl]')).not.toBeNull();
    fireEvent.click(queueTab(/Processed/));
    expect(await screen.findByText('Nothing here.')).toBeDefined();
    expect(document.querySelector('[data-zen-owl]')).not.toBeNull();
  });

  it('never says nothing waits while a machine may hold more', async () => {
    board = boardOf([view()], {
      machines: [
        { status: 'local', key: 'local', label: 'Local', awaitingOperator: 0 },
        {
          status: 'unreachable',
          key: REMOTE,
          label: 'build-box',
          port: 7102,
          reason: 'tunnel-down',
          detail: 'connect ECONNREFUSED 127.0.0.1:7102',
        },
      ],
    });
    mount();
    expect(
      await screen.findByText(
        'build-box cannot be reached, so there may be more there.',
      ),
    ).toBeDefined();
  });

  it('says an Inbox on no machine is not here', async () => {
    board = boardOf([view()]);
    mount(`/inbox/${NIGHTLY}`);
    expect(await screen.findByText('No inbox here.')).toBeDefined();
    expect(box().disabled).toBe(true);
  });

  it('says a refused Inbox is claimed, in the question’s place', async () => {
    board = boardOf([view()], {
      clashes: [
        {
          inboxId: NIGHTLY,
          outcome: 'refused',
          claims: [
            { machine: { key: 'local', label: 'Local' }, label: 'nightly' },
            { machine: { key: REMOTE, label: 'build-box' }, label: 'late' },
          ],
        },
      ],
    });
    mount(`/inbox/${NIGHTLY}`);
    expect(await screen.findByText(/build-box calls it “late”/)).toBeDefined();
  });
});

describe('the queues', () => {
  it('lights the oldest question and counts each queue', async () => {
    board = boardOf([
      view({
        awaitingOperator: [waiting(2), waiting(1)],
        awaitingAgent: [withAgent(3)],
      }),
    ]);
    mount();
    expect((await litArticle()).textContent).toContain('Question 1');
    expect(queueTab(/Your inbox/).textContent).toContain('2');
    expect(queueTab(/With the agent/).textContent).toContain('1');
    await waitFor(() => expect(document.title).toBeDefined());
  });

  it('shows a queue’s questions on its tab, most recent first', async () => {
    board = boardOf([view({ awaitingAgent: [withAgent(3), withAgent(4)] })]);
    mount();
    await screen.findByText('Nothing waiting on you.');
    fireEvent.click(queueTab(/With the agent/));
    expect((await litArticle()).textContent).toContain('Question 4');
    expect(screen.getAllByText('You answered:')).toHaveLength(2);
  });

  it('says who said what over a question’s text', async () => {
    board = boardOf([
      view({
        processed: [
          processed(1, {
            withdrawn: true,
            reason: '',
            response: undefined,
          }),
          processed(2, { deferred: true, response: '' }),
        ],
      }),
    ]);
    mount();
    await screen.findByText('Nothing waiting on you.');
    fireEvent.click(queueTab(/Processed/));
    expect(await screen.findByText('Withdrawn by the agent:')).toBeDefined();
    expect(screen.getByText('(no reason recorded)')).toBeDefined();
    expect(screen.getByText('You deferred to the agent:')).toBeDefined();
    expect(screen.getByText('No note: the agent decides.')).toBeDefined();
  });

  it('moves by the minimap, and the title line follows', async () => {
    board = twoWaiting();
    mount();
    await litArticle();
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Question 2' }));
    await waitFor(async () =>
      expect((await litArticle()).textContent).toContain('Question 2'),
    );
    expect(screen.getByText('2 of 2')).toBeDefined();
  });

  it('marks a highlighted question and a linked one', async () => {
    board = boardOf([
      view({
        awaitingOperator: [
          waiting(1, { highlight: { seq: 1, note: 'look here' } }),
          waiting(2),
        ],
      }),
    ]);
    mount(`/inbox#q=2`);
    await screen.findByText('· look here');
    expect(
      document.querySelector('[data-zen-item] [data-zen-mark="highlight"]')
        ?.className,
    ).toContain('bg-yellow');
  });

  it('brings up the question a link names', async () => {
    board = twoWaiting();
    mount(`/inbox/${GROVE}#q=2`);
    await waitFor(async () =>
      expect((await litArticle()).textContent).toContain('Question 2'),
    );
    expect(
      document.querySelector('[data-zen-item] [data-zen-mark="selected"]')
        ?.className,
    ).toContain('bg-blue');
  });
});

describe('the eyebrow and the colophon', () => {
  const machines = [
    { status: 'local', key: 'local', label: 'Local', awaitingOperator: 1 },
    {
      status: 'reachable',
      key: REMOTE,
      label: 'build-box',
      port: 7102,
      awaitingOperator: 1,
    },
  ];
  const remote = { key: REMOTE, label: 'build-box' };

  it('names no machine on a board of one', async () => {
    board = twoWaiting();
    mount();
    const lit = await litArticle();
    expect(lit.querySelector('[data-zen-machine]')).toBeNull();
    expect((await metaCard(lit)).textContent).not.toContain('machine');
  });

  it('names a remote machine in the eyebrow, and any in the colophon', async () => {
    board = boardOf(
      [
        view({
          inboxId: NIGHTLY,
          label: 'nightly',
          machine: remote,
          awaitingOperator: [waiting(1)],
        }),
      ],
      { machines },
    );
    mount();
    const lit = await litArticle();
    expect(lit.querySelector('[data-zen-machine]')?.textContent).toBe(
      'build-box',
    );
    expect((await metaCard(lit)).textContent).toContain('machine build-box');
  });

  it('keeps Local out of the eyebrow but names it in the colophon', async () => {
    board = boardOf([view({ awaitingOperator: [waiting(1)] })], { machines });
    mount();
    const lit = await litArticle();
    expect(lit.querySelector('[data-zen-machine]')).toBeNull();
    expect((await metaCard(lit)).textContent).toContain('machine Local');
  });

  it('keeps every key out of the page, in the card by level', async () => {
    board = boardOf([
      view({
        metadata: { repo: 'o/r', note: 'folded' },
        awaitingOperator: [
          waiting(1, { metadata: { repo: 'o/r', pr: '7', extra: 'more' } }),
        ],
      }),
    ]);
    mount();
    const lit = await litArticle();
    expect(lit.querySelector('[data-zen-meta-key]')).toBeNull();
    const card = await metaCard(lit);
    const inbox = card.querySelector('[data-zen-meta-level="inbox"]');
    const question = card.querySelector('[data-zen-meta-level="question"]');
    expect(inbox?.textContent).toContain('repo o/r');
    expect(inbox?.textContent).toContain('note folded');
    expect(question?.textContent).toContain('pr 7');
    expect(question?.textContent).toContain('extra more');
    expect(question?.textContent).not.toContain('repo');
  });

  it('draws a link at every depth in the card', async () => {
    const url = 'https://example.test/spec';
    board = boardOf([
      view({
        awaitingOperator: [
          waiting(1, {
            metadata: {
              pr: url,
              links: [{ title: 'Spec', url }],
              deep: { at: url },
              list: [url],
            },
          }),
        ],
      }),
    ]);
    mount();
    const card = await metaCard(await litArticle());
    expect(
      within(card).getByRole('link', { name: 'Spec' }).getAttribute('href'),
    ).toBe(url);
    expect(within(card).getAllByRole('link', { name: url })).toHaveLength(3);
  });

  it('shuts the card on Escape, and the keys open it', async () => {
    board = boardOf([
      view({ awaitingOperator: [waiting(1, { metadata: { more: 'one' } })] }),
    ]);
    mount();
    await litArticle();
    await waitFor(() =>
      expect(document.querySelector('[data-zen-meta-more]')).not.toBeNull(),
    );
    fireEvent.keyDown(document, { key: 'm', ctrlKey: true });
    await screen.findByText('one');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('one')).toBeNull());
  });

  it('keeps the times in the colophon', async () => {
    board = twoWaiting();
    mount();
    const lit = await litArticle();
    expect(lit.querySelector('[data-zen-when]')?.textContent).toContain(
      'Asked',
    );
  });
});

describe('answering', () => {
  it('sends the draft, flows on, and clears it once it has landed', async () => {
    board = twoWaiting();
    mount();
    await litArticle();
    type('My answer');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(async () =>
      expect((await litArticle()).textContent).toContain('Question 2'),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: `/api/inbox/${GROVE}/questions/1/answer`,
      body: { response: 'My answer', seenRevision: 1 },
    });
    expect(queueTab(/With the agent/).textContent).toContain('1');
    await waitFor(() =>
      expect(
        sessionStorage.getItem('operator-inbox:inbox-response-drafts'),
      ).toBe('[]'),
    );
  });

  it('will not send an empty answer, but will defer one', async () => {
    board = twoWaiting();
    mount();
    await litArticle();
    expect(
      (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Leave it to the agent' }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({
      response: '',
      seenRevision: 1,
      deferred: true,
    });
  });

  it('brings a refused answer back with its draft, leaving the focus', async () => {
    board = twoWaiting();
    answerResponse = () =>
      json({ _tag: 'AnswerRefused', message: 'the question changed' }, 409);
    mount();
    await litArticle();
    type('My answer');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(queueTab(/Your inbox/).textContent).toContain('2'),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(async () =>
      expect((await litArticle()).textContent).toContain('Question 2'),
    );
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Question 1' }));
    await waitFor(() => expect(box().value).toBe('My answer'));
    expect(footNote()).toContain('Not sent: the question changed');
  });

  it('files a failure as a stray once its question has gone', async () => {
    board = twoWaiting();
    let fail: (r: Response) => void = () => undefined;
    answerResponse = () =>
      new Promise<Response>((resolve) => {
        fail = resolve;
      });
    const Strays = () => {
      const refresh = useAtomRefresh(inboxBoardAtom);
      const stray = useAtomValue(strayWritesAtom);
      return (
        <>
          <button type="button" onClick={refresh}>
            read
          </button>
          <ul aria-label="strays">
            {stray.map((w) => (
              <li key={w.id}>{w.text}</li>
            ))}
          </ul>
        </>
      );
    };
    history.replaceState(null, '', '/inbox');
    render(
      <RegistryProvider>
        <InboxPage />
        <Strays />
      </RegistryProvider>,
    );
    await litArticle();
    type('My answer');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    board = boardOf([view({ awaitingOperator: [waiting(2)] })]);
    fireEvent.click(screen.getByRole('button', { name: 'read' }));
    await waitFor(() =>
      expect(queueTab(/With the agent/).textContent).toContain('1'),
    );
    await act(async () => {
      fail(json({ _tag: 'AnswerRefused', message: 'it changed' }, 409));
    });
    const strays = screen.getByRole('list', { name: 'strays' });
    await waitFor(() =>
      expect(strays.textContent).toContain(
        'Your answer to #1 in grove — Not sent: it changed.',
      ),
    );
    expect(strays.querySelectorAll('li')).toHaveLength(1);
    expect(footNote()).not.toContain('it changed');
  });

  it('files no stray for a failure its question can say', async () => {
    board = twoWaiting();
    answerResponse = () =>
      json({ _tag: 'AnswerRefused', message: 'it changed' }, 409);
    const Strays = () => (
      <output aria-label="strays">
        {useAtomValue(strayWritesAtom).length}
      </output>
    );
    history.replaceState(null, '', '/inbox');
    render(
      <RegistryProvider>
        <InboxPage />
        <Strays />
      </RegistryProvider>,
    );
    await litArticle();
    type('My answer');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(queueTab(/Your inbox/).textContent).toContain('2'),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByLabelText('strays').textContent).toBe('0');
  });

  it('keeps a draft per question as the reader moves', async () => {
    board = twoWaiting();
    mount();
    await litArticle();
    type('For one');
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Question 2' }));
    await waitFor(() => expect(box().value).toBe(''));
    fireEvent.click(within(nav).getByRole('button', { name: 'Question 1' }));
    await waitFor(() => expect(box().value).toBe('For one'));
  });
});

describe('the foot note', () => {
  const words = {
    greyed: new Set([REMOTE]),
    labelOf: () => 'build-box',
    machined: true,
  };
  const item = {
    key: 'k',
    inboxId: GROVE,
    inboxLabel: 'grove',
    machine: REMOTE,
    question: waiting(1),
  } as never;

  it('warns of a greyed machine', () => {
    expect(footNoteOf({ _tag: 'Answer', item }, [], words, undefined)).toEqual({
      tone: 'orange',
      text: 'build-box missed the last read: a send may not reach it.',
    });
  });

  it('says what became of a failed answer, over a greyed machine', () => {
    const trouble = {
      key: 'k',
      inboxId: GROVE,
      number: 1,
      machine: REMOTE,
      tag: 'unsent',
      text: 'Not sent: no reply.',
    } as const;
    expect(
      footNoteOf({ _tag: 'Answer', item }, [trouble], words, undefined),
    ).toEqual({ tone: 'red', text: 'Not sent: no reply.' });
  });

  it('says a follow-up on its way, and keeps a held one’s draft', () => {
    const composer = { _tag: 'FollowUp', item, held: false } as const;
    const note = (progress?: 'sending' | 'sent', held = false) =>
      footNoteOf({ ...composer, held }, [], words, undefined, progress);
    expect(note('sending')).toEqual({
      tone: 'quiet',
      text: 'Sending to build-box…',
    });
    expect(note('sent')).toEqual({ tone: 'quiet', text: 'Sent' });
    expect(note('sending', true)?.tone).toBe('red');
    expect(note(undefined, true)?.text).toBe(
      'build-box cannot be reached. Your draft is kept for when it is back.',
    );
  });

  it('says an ask on its way', () => {
    expect(
      footNoteOf(
        { _tag: 'Asking', inboxId: GROVE },
        [],
        words,
        REMOTE,
        'sending',
      ),
    ).toEqual({ tone: 'quiet', text: 'Sending to build-box…' });
  });

  it('keeps the draft of a held question', () => {
    expect(footNoteOf({ _tag: 'Held', item }, [], words, undefined)?.text).toBe(
      'build-box cannot be reached. Your draft is kept for when it is back.',
    );
  });

  it('says sending and sent', () => {
    const sending = (landed: boolean) =>
      ({
        _tag: 'Sending',
        item: {
          key: 'k',
          machine: REMOTE,
          sending: { landed },
        },
      }) as never;
    expect(footNoteOf(sending(false), [], words, undefined)?.text).toBe(
      'Sending to build-box…',
    );
    expect(
      footNoteOf(sending(false), [], { ...words, machined: false }, undefined)
        ?.text,
    ).toBe('Sending…');
    expect(footNoteOf(sending(true), [], words, undefined)?.text).toBe('Sent');
  });

  it('warns an ask for a greyed machine, and says nothing otherwise', () => {
    expect(
      footNoteOf({ _tag: 'Asking', inboxId: GROVE }, [], words, REMOTE)?.text,
    ).toBe('build-box missed the last read: this may not reach it.');
    expect(
      footNoteOf({ _tag: 'Asking', inboxId: GROVE }, [], words, undefined),
    ).toBeUndefined();
    expect(footNoteOf({ _tag: 'Empty' }, [], words, undefined)).toBeUndefined();
  });
});

describe('asking the agent', () => {
  it('asks in the Inbox on screen, and lands in With the agent', async () => {
    board = boardOf([view({ awaitingOperator: [waiting(1)] })]);
    askResponse = () =>
      json(
        view({
          awaitingAgent: [
            withAgent(9, { operatorQuestion: true, response: 'Why?' }),
          ],
        }),
      );
    mount(`/inbox/${GROVE}`);
    await litArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    expect(await screen.findByText('In grove')).toBeDefined();
    type('Why?');
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: `/api/inbox/${GROVE}/questions`,
      body: { text: 'Why?' },
    });
    await waitFor(() =>
      expect(
        screen.queryByText('Ask the agent', { selector: 'h1' }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(queueTab(/With the agent/).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });

  it('picks an Inbox from All, matching by id, naming the machine', async () => {
    const twin = view({
      inboxId: NIGHTLY,
      label: 'grove',
      machine: { key: REMOTE, label: 'build-box' },
    });
    board = boardOf([view(), twin], {
      machines: [
        { status: 'local', key: 'local', label: 'Local', awaitingOperator: 0 },
        {
          status: 'reachable',
          key: REMOTE,
          label: 'build-box',
          port: 7102,
          awaitingOperator: 0,
        },
      ],
    });
    mount();
    await screen.findByText('Nothing waiting on you.');
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await screen.findByText('Which inbox?');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    await waitFor(() =>
      expect(
        document.querySelector('[data-zen-choice]')?.textContent,
      ).toContain('build-box'),
    );
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText(/In grove on build-box/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await screen.findByText('Which inbox?');
  });

  it('says a failed ask at the box, and keeps the draft', async () => {
    board = boardOf([view()]);
    askResponse = () =>
      json({ _tag: 'AskRefused', message: 'no such inbox' }, 409);
    mount(`/inbox/${GROVE}`);
    await screen.findByText('Nothing waiting on you.');
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    await screen.findByText('In grove');
    type('Why?');
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Not sent: no such inbox',
    );
    expect(box().value).toBe('Why?');
  });
});

describe('a follow-up', () => {
  it('reads back what it wrote', () => {
    const text = followUpText('And then?\n', 7, '/inbox/x#q=7');
    expect(text).toBe('And then?\n\nFollow-up to #7: /inbox/x#q=7');
    expect(askedTextOf(text)).toEqual({ text: 'And then?', followsUp: 7 });
    expect(askedTextOf('Plain')).toEqual({ text: 'Plain' });
  });

  it('is an ask with a link to the question', async () => {
    board = boardOf([view({ awaitingAgent: [withAgent(3)] })]);
    mount();
    await screen.findByText('Nothing waiting on you.');
    fireEvent.click(queueTab(/With the agent/));
    await litArticle();
    await waitFor(() => expect(box().placeholder).toBe('Add a follow-up'));
    type('And then?');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: `/api/inbox/${GROVE}/questions`,
      body: {
        text: `And then?\n\nFollow-up to #3: /inbox/${GROVE}#q=3`,
      },
    });
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('shows under its question, and links back from its own row', async () => {
    board = boardOf([
      view({
        awaitingAgent: [
          withAgent(3),
          withAgent(4, {
            operatorQuestion: true,
            title: 'And then?',
            response: `And then?\n\nFollow-up to #3: /inbox/${GROVE}#q=3`,
          }),
        ],
      }),
    ]);
    mount();
    await screen.findByText('Nothing waiting on you.');
    fireEvent.click(queueTab(/With the agent/));
    const lit = await litArticle();
    expect(lit.textContent).toContain('You asked:');
    expect(lit.textContent).not.toContain('/inbox/');
    fireEvent.click(
      within(lit).getByRole('button', { name: 'Follow-up to #3' }),
    );
    await waitFor(async () =>
      expect((await litArticle()).textContent).toContain('You followed up:'),
    );
  });
});

describe('the Atoms the keys will drive', () => {
  const Keys = () => {
    const send = useAtomSet(sendComposerAtom);
    const ask = useAtomSet(toggleAskAtom);
    const meta = useAtomSet(colophonOpenAtom);
    const dispatch = useAtomSet(inboxReaderAtoms.send);
    return (
      <>
        <button type="button" onClick={() => send(false)}>
          key send
        </button>
        <button type="button" onClick={() => ask()}>
          key ask
        </button>
        <button type="button" onClick={() => meta(true)}>
          key meta
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'Moved', by: 1 })}
        >
          key next
        </button>
      </>
    );
  };
  const mountKeys = () => {
    history.replaceState(null, '', '/inbox');
    return render(
      <RegistryProvider>
        <InboxPage />
        <Keys />
      </RegistryProvider>,
    );
  };

  it('moves and sends once for a double press', async () => {
    board = twoWaiting();
    mountKeys();
    await litArticle();
    fireEvent.click(screen.getByRole('button', { name: 'key next' }));
    await waitFor(async () =>
      expect((await litArticle()).textContent).toContain('Question 2'),
    );
    await waitFor(() => expect(box().placeholder).toBe('Write your answer'));
    type('Done');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'key send' }));
      fireEvent.click(screen.getByRole('button', { name: 'key send' }));
    });
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toHaveLength(1);
  });

  it('opens and shuts the ask by the same key', async () => {
    board = twoWaiting();
    mountKeys();
    await litArticle();
    fireEvent.click(screen.getByRole('button', { name: 'key ask' }));
    await screen.findByText('Ask the agent', { selector: 'h1' });
    fireEvent.click(screen.getByRole('button', { name: 'key ask' }));
    await waitFor(() =>
      expect(
        screen.queryByText('Ask the agent', { selector: 'h1' }),
      ).toBeNull(),
    );
  });
});

describe('the first load', () => {
  it('holds the question, the answer box and the minimap back until the wordmark has been read', async () => {
    board = twoWaiting();
    mount();
    await litArticle();
    const questions = document.querySelector('[data-zen-questions]');
    const answer = document.querySelector('[data-zen-answer]');
    const minimap = document.querySelector('[data-zen-minimap]');
    expect(questions?.className).toContain('opacity-0');
    expect(answer?.className).toContain('opacity-0');
    expect(answer?.querySelector('textarea')).not.toBeNull();
    expect(minimap?.className).toContain('opacity-0');
    expect(minimap?.hasAttribute('inert')).toBe(true);
    expect(
      document
        .querySelector('[data-zen-queues]')
        ?.getAttribute('data-zen-queues'),
    ).toBe('hidden');
    await waitFor(() => expect(questions?.className).toContain('opacity-100'), {
      timeout: INTRO_HOLD_MS + 1_000,
    });
    expect(answer?.className).toContain('opacity-100');
    expect(minimap?.className).toContain('opacity-100');
    expect(minimap?.hasAttribute('inert')).toBe(false);
    expect(
      document
        .querySelector('[data-zen-queues]')
        ?.getAttribute('data-zen-queues'),
    ).toBe('shown');
  });
});
