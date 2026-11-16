import {
  InboxBoardDto,
  InboxId,
  InboxMachineKey,
  type InboxMachineStatusDto,
  SERVE_MACHINES_READ_WORST,
} from '@operator-inbox/core/api';
import { Duration, Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  BOARD_READ_BOUND,
  DEFAULT_SCREEN_STATE,
  drawnBoardOf,
  fuzzyScore,
  hashOfScreenState,
  INBOXES_SEEN_LIMIT,
  inboxesSeenAfter,
  inboxIdFromPath,
  linkTargetOf,
  machineHintOf,
  machineSectionOpen,
  machineSectionsOf,
  missingInboxOf,
  questionPath,
  screenStateFromHash,
  searchSidebar,
  topMatches,
} from '../src/inbox';
import {
  A,
  BOARD,
  MACHINE_BOARD,
  summary,
  VIEW_A,
  VIEW_B,
} from './inbox-page-harness';

// The inbox's plain sums: its paths, the board as the page draws it, what it
// remembers, and the sidebar's search and machine sections. No page is mounted.

describe('the inbox paths and hash', () => {
  it('reads its selection from the path', () => {
    expect(inboxIdFromPath('/')).toEqual(Option.none());
    expect(inboxIdFromPath('/inbox')).toEqual(Option.none());
    expect(inboxIdFromPath('/inbox/abc')).toEqual(Option.some('abc'));
    expect(inboxIdFromPath('/inbox/abc/')).toEqual(Option.some('abc'));
    expect(inboxIdFromPath('/inbox/')).toEqual(Option.none());
    expect(inboxIdFromPath('/inbox/a/b')).toEqual(Option.none());
  });

  it('round-trips the filter and the groups through the hash', () => {
    const state = {
      inboxes: [InboxId.make(A)],
      // A group name is free text, and the default group is the empty one.
      groups: ['north, east', ''],
    };
    expect(screenStateFromHash(hashOfScreenState(state))).toEqual(state);
    expect(hashOfScreenState(DEFAULT_SCREEN_STATE)).toBe('');
    // A sort from an old link is not state any more.
    expect(screenStateFromHash('#sort=oldest')).toEqual(DEFAULT_SCREEN_STATE);
  });

  it('reads a link to one question from the path and the hash', () => {
    const link = questionPath(InboxId.make(A), 5);
    expect(link).toBe(`/inbox/${A}#q=5`);
    const [path, hash] = link.split('#');
    expect(linkTargetOf(path ?? '', `#${hash}`)).toEqual({
      inboxId: A,
      number: 5,
    });
    expect(linkTargetOf(`/inbox/${A}`, '#sort=oldest&q=2')).toEqual({
      inboxId: A,
      number: 2,
    });
    // It needs an Inbox in the path, and a number.
    expect(linkTargetOf('/inbox', '#q=5')).toBeUndefined();
    expect(linkTargetOf(`/inbox/${A}`, '#q=five')).toBeUndefined();
    expect(linkTargetOf(`/inbox/${A}`, '')).toBeUndefined();
  });
});

describe('the sidebar’s machine sections', () => {
  const decode = Schema.decodeUnknownSync(InboxBoardDto);

  it('reads a board whose machines list is empty as Local alone', () => {
    expect(
      machineSectionsOf({
        ...decode({ ...BOARD, machines: [] }),
        greyed: new Set(),
      }).map((x) => [
        x.key,
        x.status,
        'awaitingOperator' in x ? x.awaitingOperator : undefined,
        x.inboxes.length,
      ]),
    ).toEqual([['local', 'local', 3, 2]]);
  });

  it('builds the sections, their defaults and hints from the board', () => {
    const decoded = { ...decode(MACHINE_BOARD), greyed: new Set<never>() };
    const sections = machineSectionsOf(decoded);
    expect(
      sections.map((x) => [
        x.label,
        'awaitingOperator' in x ? x.awaitingOperator : undefined,
        x.inboxes.length,
      ]),
    ).toEqual([
      ['Local', 2, 2],
      ['laptop', 2, 1],
      ['desktop', undefined, 0],
      ['old', undefined, 0],
    ]);
    // A board with no machines is Local's alone, with the board's total.
    expect(
      machineSectionsOf({
        inboxes: decoded.inboxes,
        totalAwaitingOperator: 9,
        greyed: new Set(),
      }).map((x) => [x.key, x.status, x.inboxes.length]),
    ).toEqual([['local', 'local', 2]]);
    expect(sections.map((x) => machineSectionOpen({}, x))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(
      machineSectionOpen(
        { '3011': true },
        {
          key: InboxMachineKey.make('3011'),
          status: 'unreachable',
          greyed: false,
        },
      ),
    ).toBe(true);
    // An unreachable machine still greyed stays open.
    expect(
      machineSectionOpen(
        {},
        {
          key: InboxMachineKey.make('3011'),
          status: 'unreachable',
          greyed: true,
        },
      ),
    ).toBe(true);
    expect(sections.map((x) => machineHintOf(x))).toEqual([
      undefined,
      undefined,
      { _tag: 'Tunnel', command: 'operator-inbox tunnel desktop' },
      {
        _tag: 'Detail',
        text: 'its board did not decode: expected an array at inboxes. old runs an operator-inbox whose inbox contract this one cannot read: pull and `pnpm build` there, then restart its serve.',
      },
    ]);
  });

  it('gives each reason core’s advice, and the tunnel command only for a tunnel that is down', () => {
    const unread = (
      reason:
        | 'unresolved'
        | 'herdr-unread'
        | 'timed-out'
        | 'forward-refused'
        | 'hung-up'
        | 'connection-failed'
        | 'store-unavailable',
      detail: string,
    ) =>
      machineHintOf(
        decode({
          inboxes: [],
          totalAwaitingOperator: 0,
          views: [],
          machines: [
            {
              status: 'unreachable',
              key: '3013',
              label: 'nas',
              port: 3013,
              reason,
              detail,
            },
          ],
        }).machines?.[0] as InboxMachineStatusDto,
      );
    // An entry Herdr cannot resolve: `operator-inbox tunnel` would refuse it, so
    // the fix is config.json.
    expect(
      unread('unresolved', 'no saved Herdr machine has the id or label "nas"'),
    ).toEqual({
      _tag: 'Detail',
      text: 'no saved Herdr machine has the id or label "nas". Correct or remove its entry in inboxMachines in config.json on this machine.',
    });
    // Herdr not read is no fault of the entry, so the section
    // never says to correct it.
    expect(
      unread(
        'herdr-unread',
        "'herdr machine list --json' did not answer within 3s",
      ),
    ).toEqual({
      _tag: 'Detail',
      text: "'herdr machine list --json' did not answer within 3s. Herdr could not be read on this machine, which is no fault of any inboxMachines entry: check that Herdr is installed and that `herdr machine list --json` answers here.",
    });
    expect(unread('timed-out', 'no answer on port 3013 within 10s')).toEqual({
      _tag: 'Detail',
      text: 'no answer on port 3013 within 10s. Its tunnel is open, so look at `operator-inbox serve` on nas (its log is ~/.local/state/operator-inbox/serve.log).',
    });
    expect(unread('forward-refused', 'port 3013 reset it')).toEqual({
      _tag: 'Detail',
      text: 'port 3013 reset it. The tunnel to nas is open, but it reset the connection: on nas, check that sshd lets the tunnel forward to 127.0.0.1:7184 (AllowTcpForwarding, PermitOpen) and that `operator-inbox serve` runs there on port 7184.',
    });
    expect(unread('store-unavailable', 'disk full')?._tag).toBe('Detail');
    // A tunnel that took the request and hung up is open,
    // so its section points at the machine's serve, not the tunnel command.
    expect(
      unread('hung-up', 'port 3013 closed the connection without answering'),
    ).toMatchObject({
      _tag: 'Detail',
      text: expect.stringContaining('look at `operator-inbox serve` on nas'),
    });
    // A transport error that is neither a refused
    // connection nor a reset or a hang-up says neither that nothing listens
    // on the port nor what does, so its section points at the port, never
    // the tunnel command.
    expect(
      unread('connection-failed', 'connect EHOSTUNREACH 127.0.0.1:3013'),
    ).toEqual({
      _tag: 'Detail',
      text: "connect EHOSTUNREACH 127.0.0.1:3013. The connection to port 3013 failed: check what listens on port 3013 (`lsof -nP -iTCP:3013 -sTCP:LISTEN`) and that it is nas's tunnel.",
    });
  });
});

describe('the sidebar’s search', () => {
  it('scores letters in order, gaps allowed, and refuses what is missing', () => {
    expect(fuzzyScore('mkchk', 'Markdown check')).toBeDefined();
    expect(fuzzyScore('MARK', 'markdown')).toBeDefined();
    expect(fuzzyScore('km', 'markdown')).toBeUndefined();
    expect(fuzzyScore('', 'anything')).toBe(0);
    // Letters together score more than letters apart.
    expect(fuzzyScore('or', 'orchard') ?? 0).toBeGreaterThan(
      fuzzyScore('or', 'o-r') ?? 0,
    );
  });

  it('hides a match too scattered to mean anything', () => {
    const rows = [
      { inboxId: InboxId.make('a'), label: 'orchard' },
      // o, r, c, h, all mid-word and far apart.
      { inboxId: InboxId.make('b'), label: 'xoxxrxxcxxh' },
    ];
    const hits = searchSidebar(rows, () => [], 'orch');
    expect(hits.map((h) => h.row.inboxId)).toEqual(['a']);
    // The scattered one does match letter by letter: the threshold hides it.
    expect(fuzzyScore('orch', 'xoxxrxxcxxh')).toBeDefined();
  });

  it('marks the three best matches', () => {
    const rows = [
      { inboxId: InboxId.make('a'), label: 'store one' },
      { inboxId: InboxId.make('b'), label: 'store two' },
      { inboxId: InboxId.make('c'), label: 'store three' },
      { inboxId: InboxId.make('d'), label: 'st-o-r-e' },
    ];
    const hits = searchSidebar(rows, () => [], 'store');
    expect(hits.map((h) => h.row.inboxId)).toEqual(['a', 'b', 'c', 'd']);
    expect([...topMatches(hits.flatMap((h) => h.matches))]).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('the board as the page draws it, a missed poll greyed', () => {
  const decode = Schema.decodeUnknownSync(InboxBoardDto);
  const LAPTOP = { key: '3010', label: 'laptop' };
  const LOCAL = {
    status: 'local',
    key: 'local',
    label: 'Local',
    awaitingOperator: 2,
  };
  const VIEW_M = { ...VIEW_B, inboxId: 'inbox-m', machine: LAPTOP };
  const reachable = {
    status: 'reachable',
    ...LAPTOP,
    port: 3010,
    awaitingOperator: 1,
  };
  const down = {
    status: 'unreachable',
    ...LAPTOP,
    port: 3010,
    reason: 'timed-out',
    detail: 'no answer in 10s',
  };
  const UP = decode({
    inboxes: [summary(VIEW_A), { ...summary(VIEW_M), machine: LAPTOP }],
    totalAwaitingOperator: 3,
    views: [VIEW_A, VIEW_M],
    machines: [LOCAL, reachable],
  });
  const DOWN = () =>
    decode({
      inboxes: [summary(VIEW_A)],
      totalAwaitingOperator: 2,
      views: [VIEW_A],
      machines: [LOCAL, down],
    });
  const ids = (b: { views: ReadonlyArray<{ inboxId: string }> }) =>
    b.views.map((v) => v.inboxId);

  it('keeps a machine’s last Inboxes for one miss, and drops them on the second', () => {
    const up = drawnBoardOf(undefined, UP);
    expect(up.drawn).toEqual({ ...UP, greyed: new Set() });
    const once = drawnBoardOf(up, DOWN());
    expect(ids(once.drawn)).toEqual([A, 'inbox-m']);
    expect(once.drawn.inboxes.map((i) => i.inboxId)).toEqual([A, 'inbox-m']);
    expect([...once.drawn.greyed]).toEqual(['3010']);
    // Greyed cards are counted:
    // the total adds the greyed Inbox's one waiting question to serve's 2.
    // The statuses stay as serve gave them.
    expect(once.drawn.totalAwaitingOperator).toBe(3);
    expect(once.drawn.machines).toEqual(DOWN().machines);
    expect(
      machineSectionsOf(once.drawn).map((m) => [m.key, m.waiting]),
    ).toEqual([
      ['local', 2],
      ['3010', 1],
    ]);
    const twice = drawnBoardOf(once, DOWN());
    expect(ids(twice.drawn)).toEqual([A]);
    expect([...twice.drawn.greyed]).toEqual([]);
    expect(twice.drawn.totalAwaitingOperator).toBe(2);
  });

  it('greys nothing for a machine it never read, and leaves out a held Inbox the board now refuses', () => {
    expect([...drawnBoardOf(undefined, DOWN()).drawn.greyed]).toEqual([]);
    const up = drawnBoardOf(undefined, UP);
    const clashed = decode({
      ...DOWN(),
      clashes: [
        {
          inboxId: 'inbox-m',
          outcome: 'refused',
          claims: [
            { machine: LAPTOP, label: 'quarry' },
            { machine: { key: '3011', label: 'desktop' }, label: 'quarry' },
          ],
        },
      ],
    });
    expect(ids(drawnBoardOf(up, clashed).drawn)).toEqual([A]);
  });
});

describe('what the page remembers of each Inbox', () => {
  const row = (n: number) => ({
    inboxId: InboxId.make(`inbox-${n}`),
    label: `inbox ${n}`,
    archived: false,
    pinned: false,
    awaitingOperator: 0,
    awaitingAgent: 0,
    processed: 0,
  });

  it('forgets the Inbox gone from the boards longest once it holds more than its limit', () => {
    const first = inboxesSeenAfter(new Map(), {
      inboxes: Array.from({ length: INBOXES_SEEN_LIMIT }, (_, n) => row(n)),
    });
    expect(first.size).toBe(INBOXES_SEEN_LIMIT);
    // inbox-0 is seen again, so inbox-1 is now the one gone longest.
    const next = inboxesSeenAfter(first, {
      inboxes: [row(0), row(INBOXES_SEEN_LIMIT)],
    });
    expect(next.size).toBe(INBOXES_SEEN_LIMIT);
    expect(next.has(InboxId.make('inbox-1'))).toBe(false);
    expect(next.has(InboxId.make('inbox-0'))).toBe(true);
    expect(next.get(InboxId.make(`inbox-${INBOXES_SEEN_LIMIT}`))).toEqual({
      machine: 'local',
      label: `inbox ${INBOXES_SEEN_LIMIT}`,
    });
  });
});

// The page remembers an Inbox's machine by its key, the tunnel
// port. A key the board no longer has did not answer, so an Inbox last seen
// on it may be anywhere: never "does not exist" while a machine is out of
// reach.
describe('the selected Inbox not on the board, after its machine’s port moves', () => {
  const X = InboxId.make('inbox-x');
  const LOCAL_STATUS = {
    status: 'local',
    key: InboxMachineKey.make('local'),
    label: 'Local',
    awaitingOperator: 0,
  } as const;
  const MOVED = {
    status: 'unreachable',
    key: InboxMachineKey.make('3020'),
    label: 'laptop',
    port: 3020,
    reason: 'tunnel-down',
    detail: 'nothing answered on port 3020',
  } as const;
  const seenOn3010 = new Map([
    [X, { machine: InboxMachineKey.make('3010'), label: 'grove' }],
  ]);

  it('is unknown while a machine cannot be read, not missing', () => {
    const missing = missingInboxOf(
      { machines: [LOCAL_STATUS, MOVED], totalAwaitingOperator: 0 },
      X,
      seenOn3010,
    );
    expect(missing).toEqual({ _tag: 'Unknown', machines: [MOVED] });
  });

  it('is missing once every machine on the board answered', () => {
    const missing = missingInboxOf(
      { machines: [LOCAL_STATUS], totalAwaitingOperator: 0 },
      X,
      seenOn3010,
    );
    expect(missing).toEqual({ _tag: 'Missing' });
  });
});

describe('how long a board read may take', () => {
  // The page's bound sits at least 15 s past the longest
  // serve waits on its machines for a board read, so a read serve answers
  // slowly, its machines' timeouts and all, is never given up.
  it('gives a board read at least 15 s more than serve waits on its machines', () => {
    expect(Duration.toMillis(BOARD_READ_BOUND)).toBeGreaterThanOrEqual(
      Duration.toMillis(SERVE_MACHINES_READ_WORST) + 15_000,
    );
  });
});
