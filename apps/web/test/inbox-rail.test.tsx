import {
  RegistryProvider,
  useAtomRefresh,
  useAtomSet,
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
import { type DrawnBoard, inboxBoardAtom, strayWritesAtom } from '../src/inbox';
import {
  attentionOf,
  clampRail,
  greyedLineOf,
  type RailMeasure,
  railListOf,
  railMeasureAtom,
  railWidthOf,
  type SideNote,
  sideNotesOf,
} from '../src/inbox-rail';
import { json } from './fixture';
import { fromRowMenu, openRowMenu } from './row-menu';

// The sidebar and the page around it, on the real machine and Atoms, over a
// fetch that answers as serve does. All names are invented.

const GROVE = InboxId.make('inbox-grove');
const NIGHTLY = InboxId.make('inbox-nightly');
const REMOTE = InboxMachineKey.make('7102');
const REMOTE_REF = { key: REMOTE, label: 'build-box' };

const question = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  revision: 1,
  metadata: {},
  title: `Question ${number}`,
  body: '',
  bodyHtml: `<p>Body of ${number}</p>`,
  askedSeq: number,
  askedAt: `2026-11-05T0${number}:00:00.000Z`,
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

const row = (v: View, pinned = false) => ({
  inboxId: v.inboxId,
  label: v.label,
  archived: v.archived,
  pinned,
  awaitingOperator: (v.awaitingOperator as Array<unknown>).length,
  awaitingAgent: 0,
  processed: 0,
  ...('machine' in v ? { machine: v.machine } : {}),
});

const boardOf = (views: ReadonlyArray<View>, more: object = {}) => ({
  inboxes: views.map((v) => row(v)),
  totalAwaitingOperator: views.reduce(
    (n, v) => n + (v.awaitingOperator as Array<unknown>).length,
    0,
  ),
  views,
  ...more,
});

const LOCAL_UP = {
  status: 'local',
  key: 'local',
  label: 'Local',
  awaitingOperator: 1,
};
const REMOTE_UP = {
  status: 'reachable',
  ...REMOTE_REF,
  port: 7102,
  awaitingOperator: 1,
};
const REMOTE_DOWN = {
  status: 'unreachable',
  ...REMOTE_REF,
  port: 7102,
  reason: 'tunnel-down',
  detail: 'connect ECONNREFUSED 127.0.0.1:7102',
};

const grove = view({ awaitingOperator: [question(1)] });
const nightly = view({
  inboxId: NIGHTLY,
  label: 'nightly',
  machine: REMOTE_REF,
  awaitingOperator: [question(2)],
});
const twoMachines = () =>
  boardOf([grove, nightly], { machines: [LOCAL_UP, REMOTE_UP] });
const remoteDown = () =>
  boardOf([grove], { machines: [LOCAL_UP, REMOTE_DOWN] });

let board: unknown = boardOf([grove]);
let boardFails = false;
let boardReads = 0;
const writes: Array<{ path: string; body: unknown }> = [];
let writeResponse: (path: string) => Response = () => json(view());

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  board = boardOf([grove]);
  boardFails = false;
  writes.length = 0;
  writeResponse = () => json(view());
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
      writes.push({ path: url.pathname, body: JSON.parse(text) });
      return writeResponse(url.pathname);
    }
    if (url.pathname === '/api/inbox-config')
      return json({ metadata: { extras: 'allow', keys: [] } });
    if (url.pathname === '/api/keybindings') return json({ text: '' });
    boardReads += 1;
    if (boardFails) return new Response('nope', { status: 500 });
    return json(board);
  });
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WIDE: RailMeasure = {
  room: 400,
  pushRoom: 300,
  design: 327,
  viewport: 1600,
};
const NARROW: RailMeasure = {
  room: 100,
  pushRoom: 200,
  design: 327,
  viewport: 1000,
};
// Too tight for the gutter, with room for a column.
const MIDDLE: RailMeasure = {
  room: 250,
  pushRoom: 400,
  design: 327,
  viewport: 1262,
};

// A way to read the board again, and to change what the page measured.
const Controls = () => {
  const refresh = useAtomRefresh(inboxBoardAtom);
  const measure = useAtomSet(railMeasureAtom);
  const strays = useAtomSet(strayWritesAtom);
  return (
    <>
      <button type="button" onClick={refresh}>
        read
      </button>
      <button type="button" onClick={() => measure(WIDE)}>
        wide
      </button>
      <button type="button" onClick={() => measure(NARROW)}>
        narrow
      </button>
      <button type="button" onClick={() => measure(MIDDLE)}>
        middle
      </button>
      <button
        type="button"
        onClick={() => strays([{ id: 1, text: 'Pinning grove — Not pinned.' }])}
      >
        stray
      </button>
    </>
  );
};

const mount = async (path = '/inbox') => {
  history.replaceState(null, '', path);
  render(
    <RegistryProvider>
      <InboxPage />
      <Controls />
    </RegistryProvider>,
  );
  await waitFor(() =>
    expect(document.querySelector('[data-zen-lit]')).not.toBeNull(),
  );
};

const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

const burger = () =>
  document.querySelector('[data-rail-burger]') as HTMLButtonElement;
const aside = () => document.querySelector('[data-inbox-sidebar]');
const rail = () =>
  within(document.querySelector('nav[aria-label="Inboxes"]') as HTMLElement);
const railIs = (state: string) =>
  waitFor(() =>
    expect(aside()?.getAttribute('data-inbox-sidebar')).toBe(state),
  );
const railShut = () => waitFor(() => expect(aside()).toBeNull());
const openDrawer = async () => {
  fireEvent.click(burger());
  await railIs('drawer');
};
const note = (kind: string) =>
  document.querySelector<HTMLElement>(`[data-note="${kind}"]`);
// One read, to its end: a second click while one is out would not be a second.
const read = async () => {
  const was = boardReads;
  click('read');
  await waitFor(() => expect(boardReads).toBeGreaterThan(was));
  await act(() => new Promise((r) => setTimeout(r, 20)));
};

describe('how the sidebar opens', () => {
  it('peeks on a hover and shuts on leaving', async () => {
    await mount();
    expect(aside()).toBeNull();
    fireEvent.mouseEnter(burger());
    await railIs('peeking');
    fireEvent.mouseLeave(aside()?.parentElement as HTMLElement);
    await railShut();
  });

  it('keeps a peek that takes the focus, until dismissed', async () => {
    await mount();
    fireEvent.mouseEnter(burger());
    await railIs('peeking');
    fireEvent.focus(screen.getByLabelText('Search inboxes and groups'));
    await railIs('drawer');
    fireEvent.mouseLeave(aside()?.parentElement as HTMLElement);
    await railIs('drawer');
    click('Close the inbox sidebar');
    await railShut();
  });

  it('stays open as a pin while it fits, with no veil', async () => {
    await mount();
    click('wide');
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(burger());
    await railIs('docked');
    expect(document.querySelector('[data-rail-veil]')).toBeNull();
    fireEvent.click(burger());
    await railShut();
  });

  it('takes a column of its own when pinned past the gutter', async () => {
    const layer = () => document.querySelector('[data-rail-layer]');
    await mount();
    click('middle');
    await act(() => new Promise((r) => setTimeout(r, 0)));
    // A peek still lies over the question.
    fireEvent.mouseEnter(burger());
    await railIs('peeking');
    expect(layer()?.getAttribute('data-rail-layer')).toBe('over');
    fireEvent.click(burger());
    await railIs('docked');
    expect(layer()?.getAttribute('data-rail-layer')).toBe('column');
    expect(document.querySelector('[data-rail-veil]')).toBeNull();
    // With the gutter back it lies over again, and pinned all the while.
    click('wide');
    await waitFor(() =>
      expect(layer()?.getAttribute('data-rail-layer')).toBe('over'),
    );
    await railIs('docked');
  });

  it('opens as a drawer when it does not fit', async () => {
    await mount();
    click('narrow');
    await openDrawer();
    expect(document.querySelector('[data-rail-veil]')).not.toBeNull();
  });

  it('gives way when the room goes, and comes back with it', async () => {
    await mount();
    click('wide');
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(burger());
    await railIs('docked');
    click('narrow');
    await railShut();
    click('wide');
    await railIs('docked');
  });

  it('shuts a drawer on picking a row, and leaves a pin open', async () => {
    await mount();
    await openDrawer();
    fireEvent.click(rail().getByRole('link', { name: 'grove' }));
    await railShut();
    expect(location.pathname).toBe(`/inbox/${GROVE}`);
    click('wide');
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(burger());
    await railIs('docked');
    fireEvent.click(rail().getByRole('link', { name: 'All' }));
    await waitFor(() => expect(location.pathname).toBe('/inbox'));
    await railIs('docked');
  });
});

describe('the wordmark and the queues', () => {
  const brand = () =>
    document.querySelector('[data-zen-brand]')?.getAttribute('data-zen-brand');
  const queues = () =>
    document
      .querySelector('[data-zen-queues]')
      ?.getAttribute('data-zen-queues');

  it('opens long with the sidebar, and the queues give way', async () => {
    await mount();
    await waitFor(() => expect(brand()).toBe('short'), { timeout: 2_000 });
    expect(queues()).toBe('shown');
    fireEvent.mouseEnter(burger());
    await waitFor(() => expect(brand()).toBe('long'));
    expect(queues()).toBe('hidden');
  });

  it('keeps the queues beside a pinned sidebar', async () => {
    await mount();
    await waitFor(() => expect(brand()).toBe('short'), { timeout: 2_000 });
    click('wide');
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(burger());
    await waitFor(() => expect(brand()).toBe('long'));
    expect(queues()).toBe('shown');
  });

  it('names the tab Operator Inbox', async () => {
    await mount();
    expect(document.title).toBe('Operator Inbox');
    expect(screen.getByRole('img', { name: 'Operator Inbox' })).toBeDefined();
  });
});

describe('the sidebar’s foot', () => {
  it('links to the maker', async () => {
    await mount();
    await openDrawer();
    expect(
      screen.getByRole('link', { name: /Made by Tom/ }).getAttribute('href'),
    ).toBe('https://www.tomjamesallen.co.uk/');
  });
});

describe('the rows', () => {
  const openMenu = async () => {
    return openRowMenu('grove');
  };
  const rename = async () => {
    await openDrawer();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Rename/ }));
    return (await screen.findByLabelText('Inbox name')) as HTMLInputElement;
  };

  it('pins through the write, and says a refusal under the row', async () => {
    writeResponse = () =>
      json({ _tag: 'PinRefused', message: 'no change' }, 409);
    await mount();
    await openDrawer();
    await fromRowMenu('grove', 'Pin the inbox grove');
    await waitFor(() =>
      expect(writes).toEqual([
        { path: `/api/inbox/${GROVE}/pin`, body: { pinned: true } },
      ]),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Not pinned',
    );
  });

  it('archives from the row’s menu', async () => {
    await mount();
    await openDrawer();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Archive/ }));
    await waitFor(() =>
      expect(writes).toEqual([
        { path: `/api/inbox/${GROVE}/archive`, body: { archived: true } },
      ]),
    );
  });

  it('renames in place and closes when it lands', async () => {
    await mount();
    const field = await rename();
    fireEvent.change(field, { target: { value: 'orchard' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() =>
      expect(writes).toEqual([
        { path: `/api/inbox/${GROVE}/rename`, body: { label: 'orchard' } },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Inbox name')).toBeNull(),
    );
  });

  it('leaves the refusal of an unchanged name to core, and stays open', async () => {
    writeResponse = () =>
      json(
        { _tag: 'RenameRefused', message: 'it is already called that' },
        409,
      );
    await mount();
    const field = await rename();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'it is already called that',
    );
    expect(screen.getByLabelText('Inbox name')).toBeDefined();
  });

  it('writes nothing on leaving an unchanged name, or on Escape', async () => {
    await mount();
    const field = await rename();
    fireEvent.blur(field);
    await waitFor(() =>
      expect(screen.queryByLabelText('Inbox name')).toBeNull(),
    );
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Rename/ }));
    const again = await screen.findByLabelText('Inbox name');
    fireEvent.change(again, { target: { value: 'orchard' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByLabelText('Inbox name')).toBeNull(),
    );
    expect(writes).toEqual([]);
  });

  it('nests groups, and shift adds one to what is in force', async () => {
    board = boardOf([
      view({
        awaitingOperator: [
          question(1, { metadata: { group: 'alpha' } }),
          question(2, { metadata: { group: 'beta' } }),
        ],
      }),
    ]);
    await mount();
    await openDrawer();
    expect(
      within(screen.getByRole('list', { name: 'Groups in grove' }))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Default', 'alpha', 'beta']);
    fireEvent.click(rail().getByRole('link', { name: /alpha/ }));
    await railShut();
    await openDrawer();
    fireEvent.click(rail().getByRole('link', { name: /beta/ }), {
      shiftKey: true,
    });
    await railShut();
    expect(decodeURIComponent(location.hash)).toContain('alpha');
    expect(decodeURIComponent(location.hash)).toContain('beta');
  });
});

describe('the sidebar’s search', () => {
  const search = () =>
    screen.getByLabelText('Search inboxes and groups') as HTMLInputElement;

  it('narrows the rows, Enter opens the first and Esc clears', async () => {
    board = twoMachines();
    await mount();
    await openDrawer();
    fireEvent.change(search(), { target: { value: 'nigh' } });
    await waitFor(() =>
      expect(rail().queryByRole('link', { name: 'grove' })).toBeNull(),
    );
    fireEvent.keyDown(search(), { key: 'Escape' });
    await waitFor(() => expect(search().value).toBe(''));
    fireEvent.change(search(), { target: { value: 'nigh' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    await waitFor(() => expect(location.pathname).toBe(`/inbox/${NIGHTLY}`));
  });

  it('says so when nothing matches, and what it could not search', async () => {
    board = remoteDown();
    await mount();
    await openDrawer();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(await screen.findByText('No inbox or group matches.')).toBeDefined();
    expect(
      screen.getByText('build-box not searched: cannot be reached.'),
    ).toBeDefined();
  });

  it('shows only what is pinned', async () => {
    board = {
      ...boardOf([grove]),
      inboxes: [row(grove, false)],
    };
    await mount();
    await openDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Show only pinned' }));
    await waitFor(() =>
      expect(rail().queryByRole('link', { name: 'grove' })).toBeNull(),
    );
  });
});

describe('the machines', () => {
  const section = (label: string) =>
    document.querySelector<HTMLElement>(`[data-machine-section="${label}"]`);

  it('draws nothing machine-shaped for one machine', async () => {
    await mount();
    await openDrawer();
    expect(document.querySelector('[data-machine-section]')).toBeNull();
    expect(rail().getByRole('link', { name: 'grove' })).toBeDefined();
  });

  it('heads each machine with no count, and puts the port in its title', async () => {
    board = twoMachines();
    await mount();
    await openDrawer();
    const head = within(section('build-box') as HTMLElement).getByRole(
      'button',
      { name: /build-box/ },
    );
    expect(head.textContent).not.toMatch(/\d/);
    expect(head.getAttribute('title')).toBe(
      'build-box: 127.0.0.1:7102, reachable',
    );
    expect(rail().getByRole('link', { name: 'nightly' })).toBeDefined();
  });

  it('folds an unreachable machine, with its tunnel inside', async () => {
    board = remoteDown();
    await mount();
    await openDrawer();
    const remote = section('build-box') as HTMLElement;
    expect(remote.querySelector('[data-machine-dot]')?.className).toContain(
      'bg-red',
    );
    expect(document.querySelector('[data-machine-hint]')).toBeNull();
    fireEvent.click(within(remote).getByRole('button', { name: /build-box/ }));
    await waitFor(() =>
      expect(document.querySelector('[data-machine-hint]')).not.toBeNull(),
    );
  });

  it('keeps a greyed machine’s rows, faded, without the fix', async () => {
    board = twoMachines();
    await mount();
    await openDrawer();
    board = remoteDown();
    await read();
    const remote = section('build-box') as HTMLElement;
    await waitFor(() =>
      expect(remote.getAttribute('data-greyed')).not.toBeNull(),
    );
    expect(remote.querySelector('[data-machine-dot]')?.className).toContain(
      'bg-orange',
    );
    expect(
      within(remote).getByText('Showing what it held at the last read.'),
    ).toBeDefined();
    expect(within(remote).getByRole('link', { name: 'nightly' })).toBeDefined();
    expect(remote.querySelector('[data-machine-hint]')).toBeNull();
    expect(
      within(remote)
        .getByRole('link', { name: 'nightly' })
        .closest('[data-greyed-faded]')?.className,
    ).toContain('group-data-greyed/greyed');
    expect(screen.getByTestId('inbox-greyed').textContent).toContain(
      'build-box did not answer the last read',
    );
  });

  it('opens a greyed section to a search, though it was shut', async () => {
    board = twoMachines();
    await mount();
    await openDrawer();
    const remote = () => section('build-box') as HTMLElement;
    fireEvent.click(
      within(remote()).getByRole('button', { name: /build-box/ }),
    );
    await waitFor(() =>
      expect(rail().queryByRole('link', { name: 'nightly' })).toBeNull(),
    );
    board = remoteDown();
    await read();
    await waitFor(() =>
      expect(remote().getAttribute('data-greyed')).not.toBeNull(),
    );
    fireEvent.change(screen.getByLabelText('Search inboxes and groups'), {
      target: { value: 'nigh' },
    });
    expect(await rail().findByRole('link', { name: 'nightly' })).toBeDefined();
  });
});

describe('the question search across machines', () => {
  const open = () => {
    fireEvent.keyDown(document.body, { key: 'p', code: 'KeyP', ctrlKey: true });
    return screen.findByTestId('search-field');
  };

  it('finds a greyed question, and names its machine', async () => {
    board = twoMachines();
    await mount();
    board = remoteDown();
    await read();
    const field = await open();
    fireEvent.change(field, { target: { value: 'Question 2' } });
    const hits = await screen.findAllByTestId('search-hit');
    expect(hits.map((h) => h.textContent).join()).toContain(
      'build-box · nightly',
    );
  });

  it('says what it could not search', async () => {
    board = remoteDown();
    await mount();
    await open();
    expect(
      await screen.findByText('build-box not searched: cannot be reached.'),
    ).toBeDefined();
  });
});

describe('the notes and the burger’s dot', () => {
  const dot = () =>
    document
      .querySelector('[data-zen-attention]')
      ?.getAttribute('data-zen-attention');

  it('has none while all is well', async () => {
    await mount();
    expect(dot()).toBeUndefined();
    await openDrawer();
    expect(document.querySelector('[data-zen-side-notes]')).toBeNull();
  });

  it('says a failed read while the last board stays up', async () => {
    await mount();
    boardFails = true;
    await read();
    await waitFor(() => expect(dot()).toBe('red'));
    expect(burger().getAttribute('aria-label')).toBe(
      'Sidebar, something needs attention',
    );
    await openDrawer();
    expect(dot()).toBeUndefined();
    expect(note('serve')?.textContent).toContain(
      'Showing the last view that loaded.',
    );
  });

  it('turns red for an unreachable machine, not for one flap', async () => {
    board = twoMachines();
    await mount();
    board = remoteDown();
    await read();
    expect(dot()).toBeUndefined();
    await read();
    await waitFor(() => expect(dot()).toBe('red'));
  });

  it('says machines off, in orange', async () => {
    board = boardOf([grove], { machinesOff: 'config.json is not valid JSON' });
    await mount();
    await waitFor(() => expect(dot()).toBe('orange'));
    await openDrawer();
    expect(note('machines-off')?.textContent).toContain(
      'config.json is not valid JSON',
    );
  });

  it('leads a clash with the name, and keeps its claims', async () => {
    board = boardOf([grove], {
      clashes: [
        {
          inboxId: GROVE,
          outcome: 'kept-on-local',
          claims: [
            { machine: { key: 'local', label: 'Local' }, label: 'grove' },
            { machine: REMOTE_REF, label: 'copse' },
          ],
        },
      ],
    });
    await mount();
    await waitFor(() => expect(dot()).toBe('orange'));
    await openDrawer();
    const clash = note('clash')?.textContent ?? '';
    expect(clash).toContain('Two machines claim grove and copse.');
    expect(clash).toContain('build-box calls it “copse”');
  });

  it('lists a stray until it is cleared', async () => {
    await mount();
    click('stray');
    await waitFor(() => expect(dot()).toBe('red'));
    await openDrawer();
    expect(note('stray')?.textContent).toContain('Not pinned.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(note('stray')).toBeNull());
  });

  it('links a failed answer back to its question, without taking focus before', async () => {
    board = boardOf([view({ awaitingOperator: [question(1), question(2)] })]);
    writeResponse = () =>
      json({ _tag: 'AnswerRefused', message: 'it changed' }, 409);
    await mount();
    fireEvent.change(
      document.querySelector('[data-zen-box]') as HTMLTextAreaElement,
      { target: { value: 'My answer' } },
    );
    click('Send');
    await waitFor(() => expect(dot()).toBe('red'));
    const lit = () =>
      document
        .querySelector('[data-zen-lit]')
        ?.closest('[data-zen-item]')
        ?.getAttribute('data-zen-item');
    expect(lit()).toBe(`${GROVE}/2`);
    await openDrawer();
    click('Answer to #1 not sent');
    await waitFor(() => expect(lit()).toBe(`${GROVE}/1`));
    await railShut();
  });
});

describe('the resizer', () => {
  it('steps by key within its limits, and Enter resets it', async () => {
    await mount();
    await openDrawer();
    const handle = screen.getByRole('separator');
    Object.defineProperty(aside(), 'offsetWidth', { value: 300 });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() =>
      expect((aside() as HTMLElement).style.width).toBe('316px'),
    );
    fireEvent.keyDown(handle, { key: 'Enter' });
    await waitFor(() => expect((aside() as HTMLElement).style.width).toBe(''));
  });
});

describe('the sums', () => {
  it('keeps a dragged width to what it may take', () => {
    expect(clampRail(100, WIDE, true)).toBe(240);
    expect(clampRail(900, WIDE, true)).toBe(400);
    expect(clampRail(900, WIDE, false)).toBe(520);
    expect(clampRail(900, { ...NARROW, viewport: 400 }, false)).toBe(340);
    expect(clampRail(300, undefined, false)).toBe(300);
    // Rounded up it would no longer fit, and the pin would shut mid-drag.
    expect(clampRail(900, { ...WIDE, room: 335.75 }, true)).toBe(335);
    expect(clampRail(900, MIDDLE, true)).toBe(400);
  });

  it('raises a width kept from the old floor', () => {
    expect(railWidthOf(160, 327)).toBe(240);
    expect(railWidthOf(null, 327)).toBe(327);
  });

  const drawn = (b: unknown, greyed: ReadonlyArray<string> = []) =>
    ({ ...(b as object), greyed: new Set(greyed) }) as unknown as DrawnBoard;

  it('counts only an Inbox shown in the search’s empty list', () => {
    const list = railListOf(drawn(twoMachines()), 'zzz', false);
    expect(list.searching).toBe(true);
    expect(list.first).toBeUndefined();
  });

  it('orders the notes red before orange', () => {
    const notes = sideNotesOf({
      serve: 'No reply.',
      troubles: [
        {
          key: 'k',
          inboxId: InboxId.make('inbox-a'),
          number: 8,
          machine: REMOTE,
          tag: 'uncertain',
          text: 'x',
        },
      ],
      stray: [{ id: 1, text: 'gone' }],
      rules: 'bad',
      board: drawn(boardOf([], { machinesOff: 'no config' })),
      selected: undefined,
    });
    expect(notes.map((n) => n.kind)).toEqual([
      'serve',
      'answer',
      'stray',
      'rules',
      'machines-off',
    ]);
    expect(notes[1]?.text).toBe('Answer to #8 unconfirmed');
  });

  it('shows a clash in All, and only a kept one in its own view', () => {
    const clash = (outcome: string) =>
      drawn(
        boardOf([], {
          clashes: [
            {
              inboxId: GROVE,
              outcome,
              claims: [
                { machine: { key: 'local', label: 'Local' }, label: 'grove' },
                { machine: REMOTE_REF, label: 'grove' },
              ],
            },
          ],
        }),
      );
    const none = {
      serve: undefined,
      troubles: [],
      stray: [],
      rules: undefined,
    };
    const count = (outcome: string, selected: InboxId | undefined) =>
      sideNotesOf({ ...none, board: clash(outcome), selected }).length;
    expect(count('refused', undefined)).toBe(1);
    expect(count('refused', GROVE)).toBe(0);
    expect(count('kept-on-local', GROVE)).toBe(1);
    expect(count('kept-on-local', NIGHTLY)).toBe(0);
  });

  it('picks the dot’s colour', () => {
    const orange = { tone: 'orange' } as SideNote;
    const red = { tone: 'red' } as SideNote;
    const unreachable = REMOTE_DOWN as never;
    const incompatible = { ...REMOTE_DOWN, status: 'incompatible' } as never;
    expect(attentionOf([], [])).toBeUndefined();
    expect(attentionOf([orange], [])).toBe('orange');
    expect(attentionOf([orange, red], [])).toBe('red');
    expect(attentionOf([], [incompatible])).toBe('orange');
    expect(attentionOf([], [unreachable])).toBe('red');
  });

  it('names what is greyed for a screen reader', () => {
    const b = drawn(
      boardOf([grove, nightly], { machines: [LOCAL_UP, REMOTE_DOWN] }),
      [REMOTE],
    );
    expect(greyedLineOf(b, undefined)).toContain('build-box did not answer');
    expect(greyedLineOf(b, NIGHTLY)).toContain('what it held at the read');
    expect(greyedLineOf(b, GROVE)).toBeUndefined();
  });
});
