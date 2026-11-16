import { RegistryProvider } from '@effect/atom-react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { InboxPage } from '../src/components/inbox/page';
import { json } from './fixture';

// The inbox page end to end in the DOM, for the test files split by concern:
// the real typed client decodes wire payloads through the shared contract, with
// only `fetch` stubbed. Each mount gets a fresh Atom registry. All names are
// invented.

export const A = 'inbox-a';
export const B = 'inbox-b';
export const C = 'inbox-c';

type Meta = Record<string, unknown>;

// A place in the log reads as a time, so the two orders agree on one machine.
const minute = (hour: number, seq: number) =>
  `2026-10-09T${hour}:${String(seq).padStart(2, '0')}:00.000Z`;

export const asked = (
  number: number,
  title: string,
  askedSeq: number,
  revision = 1,
) => ({
  number,
  revision,
  metadata: {} as Meta,
  title,
  body: `Body of **${title}**`,
  bodyHtml: `<p>Body of <strong>${title}</strong></p>`,
  askedSeq,
  askedAt: minute(10, askedSeq),
});

export const answered = (
  number: number,
  title: string,
  answeredSeq: number,
  response: string,
) => ({
  number,
  revision: 1,
  metadata: {} as Meta,
  title,
  body: `Body of **${title}**`,
  bodyHtml: `<p>Body of <strong>${title}</strong></p>`,
  response,
  answeredSeq,
  answeredAt: minute(11, answeredSeq),
  askedAt: minute(10, 0),
});

export interface WireView {
  readonly inboxId: string;
  readonly label: string;
  readonly code?: string;
  readonly metadata: Meta;
  readonly pinnedGroups: ReadonlyArray<string>;
  readonly archived: boolean;
  readonly muted?: boolean;
  readonly awaitingOperator: ReadonlyArray<object>;
  readonly awaitingAgent: ReadonlyArray<object>;
  readonly processed: ReadonlyArray<object>;
  readonly machine?: { readonly key: string; readonly label: string };
}

export const VIEW_A = {
  inboxId: A,
  label: 'orchard',
  metadata: {} as Meta,
  pinnedGroups: [] as ReadonlyArray<string>,
  archived: false,
  awaitingOperator: [asked(1, 'First', 2), asked(3, 'Third', 9)],
  // #2 was answered after #6.
  awaitingAgent: [
    answered(6, 'Sixth', 11, 'Six.'),
    answered(2, 'Second', 12, 'Yes.\nAnd more.'),
  ],
  processed: [
    {
      ...asked(5, 'Fifth', 4),
      withdrawn: true,
      reason: 'Settled in the session instead.',
      processedSeq: 14,
      processedAt: minute(12, 14),
    },
    {
      ...asked(4, 'Fourth', 3),
      withdrawn: false,
      response: 'Use the cache.',
      processedSeq: 13,
      processedAt: minute(12, 13),
    },
  ],
} satisfies WireView;

export const VIEW_B = {
  inboxId: B,
  label: 'quarry',
  metadata: {} as Meta,
  pinnedGroups: [] as ReadonlyArray<string>,
  archived: false,
  awaitingOperator: [asked(1, 'Quarry one', 7)],
  awaitingAgent: [] as ReadonlyArray<object>,
  processed: [] as ReadonlyArray<object>,
} satisfies WireView;

// Archived, with a question still waiting.
export const VIEW_C = {
  inboxId: C,
  label: 'kiln',
  metadata: {} as Meta,
  pinnedGroups: [] as ReadonlyArray<string>,
  archived: true,
  awaitingOperator: [asked(1, 'Kiln one', 20)],
  awaitingAgent: [] as ReadonlyArray<object>,
  processed: [] as ReadonlyArray<object>,
} satisfies WireView;

export const summary = (
  view: WireView,
  lastActivityAt = '2026-10-09T12:00:00.000Z',
) => ({
  inboxId: view.inboxId,
  label: view.label,
  archived: view.archived,
  pinned: false,
  ...(view.muted === true ? { muted: true } : {}),
  awaitingOperator: view.awaitingOperator.length,
  awaitingAgent: view.awaitingAgent.length,
  processed: view.processed.length,
  lastActivityAt,
  ...(view.machine === undefined ? {} : { machine: view.machine }),
});

export const board = (views: ReadonlyArray<WireView>, more: object = {}) => ({
  inboxes: views.map((v) => summary(v)),
  totalAwaitingOperator: views
    .filter((v) => !v.archived && v.muted !== true)
    .reduce((n, v) => n + v.awaitingOperator.length, 0),
  views,
  ...more,
});

export const BOARD = board([VIEW_A, VIEW_B]);
export const BOARD_WITH_ARCHIVED = board([VIEW_A, VIEW_B, VIEW_C]);

// Local holds orchard and the archived kiln. laptop is reachable on 3010 and holds
// an Inbox also named orchard, with two questions waiting. desktop is unreachable
// on 3011; old answered with something that did not decode.
export const M = 'inbox-m';
export const LAPTOP = { key: '3010', label: 'laptop' };
export const VIEW_M = {
  ...VIEW_A,
  inboxId: M,
  machine: LAPTOP,
  awaitingOperator: [
    asked(1, 'Remote one', 30),
    asked(2, 'Remote two', 31),
  ] as ReadonlyArray<object>,
  awaitingAgent: [] as ReadonlyArray<object>,
  processed: [] as ReadonlyArray<object>,
};
export const LOCAL = {
  status: 'local',
  key: 'local',
  label: 'Local',
  awaitingOperator: 2,
} as const;
export const MACHINES = [
  LOCAL,
  { status: 'reachable', ...LAPTOP, port: 3010, awaitingOperator: 2 },
  {
    status: 'unreachable',
    key: '3011',
    label: 'desktop',
    port: 3011,
    reason: 'tunnel-down',
    detail: 'connect ECONNREFUSED 127.0.0.1:3011',
  },
  {
    status: 'incompatible',
    key: '3012',
    label: 'old',
    port: 3012,
    reason: 'undecodable',
    detail: 'its board did not decode: expected an array at inboxes',
  },
] as const;
export const MACHINE_BOARD = {
  inboxes: [summary(VIEW_A), summary(VIEW_C), summary(VIEW_M)],
  totalAwaitingOperator: 4,
  views: [VIEW_A, VIEW_C, VIEW_M],
  machines: MACHINES,
};

export interface Posted {
  readonly path: string;
  readonly body: unknown;
}

// The fixtures' answers are stamped in the past, so on the live clock every one
// would need chasing: the harness holds the chase off, and its own tests set
// the threshold back (`inbox-chase.test.tsx`).
export const NO_CHASE = {
  metadata: { extras: 'allow', keys: [] },
  chaseAfterMinutes: 1e9,
};

// What serve answers. A test moves these; each is put back before the next.
export const serve: {
  board: unknown;
  post: (path: string) => Response | Promise<Response>;
  // Answers a board read in place of `board`, to hold or fail it.
  read: ((signal: AbortSignal | undefined) => Promise<Response>) | undefined;
  keybindings: string | null;
  config: unknown;
  posts: Array<Posted>;
  reads: number;
} = {
  board: BOARD,
  post: () => json(VIEW_A),
  read: undefined,
  keybindings: null,
  config: NO_CHASE,
  posts: [],
  reads: 0,
};

const fetchStub: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input), 'http://x');
  if ((request?.method ?? init?.method ?? 'GET') === 'POST') {
    const text =
      request === undefined
        ? await new Response(init?.body ?? null).text()
        : await request.clone().text();
    serve.posts.push({
      path: url.pathname,
      body: text === '' ? undefined : JSON.parse(text),
    });
    return serve.post(url.pathname);
  }
  if (url.pathname === '/api/inbox-config') return json(serve.config);
  if (url.pathname === '/api/keybindings')
    return json({
      path: '/c/operator-inbox/keybindings',
      text: serve.keybindings,
    });
  serve.reads += 1;
  if (serve.read !== undefined)
    return serve.read(request?.signal ?? init?.signal ?? undefined);
  return json(serve.board);
};

/** Serve and a clean page for each test in the file that calls it. */
export const useInboxPage = (): void => {
  beforeEach(() => {
    Object.assign(serve, {
      board: BOARD,
      post: () => json(VIEW_A),
      read: undefined,
      keybindings: null,
      config: NO_CHASE,
      posts: [],
      reads: 0,
    });
    vi.stubGlobal('fetch', fetchStub);
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    history.replaceState(null, '', '/');
    localStorage.clear();
    sessionStorage.clear();
  });
};

export const mount = (
  path = `/inbox/${A}`,
  initialValues?: ComponentProps<typeof RegistryProvider>['initialValues'],
) => {
  history.replaceState(null, '', path);
  return render(
    <RegistryProvider
      {...(initialValues === undefined ? {} : { initialValues })}
    >
      <InboxPage />
    </RegistryProvider>,
  );
};

/** The key of the lit question, `<inbox>/<number>`. */
export const litKey = (): string | undefined =>
  document
    .querySelector('[data-zen-lit]')
    ?.closest<HTMLElement>('[data-zen-item]')?.dataset.zenItem;

export const lit = (): HTMLElement =>
  document.querySelector('[data-zen-lit]') as HTMLElement;

/** The box at the foot, with the lit question's session and `<>` over it. */
export const overBox = (): HTMLElement =>
  document.querySelector('[data-zen-answer]') as HTMLElement;

/** The questions of the queue on screen, in order. */
export const items = (): ReadonlyArray<string> =>
  [...document.querySelectorAll<HTMLElement>('[data-zen-item]')].map(
    (i) => i.dataset.zenItem ?? '',
  );

/** Mounts, and waits for a question to be lit. */
export const mounted = async (path?: string): Promise<void> => {
  mount(path);
  await waitFor(() => expect(litKey()).toBeDefined());
};

export const box = (): HTMLTextAreaElement =>
  document.querySelector('textarea[data-zen-box]') as HTMLTextAreaElement;

export const type = (text: string): void => {
  fireEvent.change(box(), { target: { value: text } });
};

export const footNote = (): string =>
  document.querySelector('[data-zen-foot-note]')?.textContent ?? '';

export const queueTab = (name: RegExp): HTMLElement =>
  screen.getByRole('tab', { name });

/** Goes to a queue, once the tab says it is on. */
export const onQueue = async (name: RegExp): Promise<void> => {
  fireEvent.click(queueTab(name));
  await waitFor(() =>
    expect(queueTab(name).getAttribute('aria-selected')).toBe('true'),
  );
};

export const burger = (): HTMLElement =>
  document.querySelector('[data-rail-burger]') as HTMLElement;

export const aside = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-inbox-sidebar]');

export const nav = (): HTMLElement =>
  document.querySelector('nav[aria-label="Inboxes"]') as HTMLElement;

export const rail = () => within(nav());

/** Brings the sidebar out, as a drawer, and waits for its list. */
export const openRail = async (): Promise<void> => {
  if (aside() === null) fireEvent.click(burger());
  await waitFor(() => expect(aside()).not.toBeNull());
};

export const railShut = (): Promise<void> =>
  waitFor(() => expect(aside()).toBeNull());

export const note = (kind: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-note="${kind}"]`);

export const send = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

/** Lets what is in flight land and the page draw it. */
export const settle = async (): Promise<void> => {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
};

/** Ctrl+R, to its end, on `next` when given. */
export const reread = async (next?: unknown): Promise<void> => {
  if (next !== undefined) serve.board = next;
  const was = serve.reads;
  fireEvent.keyDown(document, { code: 'KeyR', key: 'r', ctrlKey: true });
  await waitFor(() => expect(serve.reads).toBeGreaterThan(was));
  await settle();
};

export const press = (
  init: KeyboardEventInit,
  target: Element | Document = document,
): void => {
  act(() => {
    fireEvent.keyDown(target, init);
  });
};

/** The prefix, Ctrl+Space, and nothing yet after it. */
export const prefix = (): void =>
  press({ key: ' ', code: 'Space', ctrlKey: true });

/** Stands in for the clipboard; call after any mount's first read. */
export const stubClipboard = () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(
    async () => undefined,
  );
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  return writeText;
};

export { fromRowMenu, openRowMenu, rowMenu } from './row-menu';
