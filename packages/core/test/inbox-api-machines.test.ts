import { describe, expect, it } from '@effect/vitest';
import { Result, Schema } from 'effect';
import {
  InboxBoardDto,
  InboxIndexDto,
  InboxMachineStatusDto,
  InboxReadQuery,
  InboxUnavailable,
  inboxClashSentence,
  inboxMachineAdvice,
  inboxMachineKey,
  LOCAL_MACHINE_KEY,
  machineKeyOf,
  SERVE_DEFAULT_PORT,
  shellWord,
  tunnelCommand,
} from '../src/api';
import { InboxId, InboxMachinePort } from '../src/schema/identifiers';

// The combined inbox's wire: a machine's status as a tagged union with Local
// first, machines keyed by port, and a board that still decodes what a machine
// on an older build sends back. A machine is always asked with `local=true`, so what
// it sends never carries the fields only Local's serve fills for its page.

const decodeBoard = Schema.decodeUnknownResult(InboxBoardDto);
const decodeIndex = Schema.decodeUnknownResult(InboxIndexDto);
const decodeStatus = Schema.decodeUnknownResult(InboxMachineStatusDto);

const ROW = {
  inboxId: '01INBOXWIRE000000000000000',
  label: 'laptop work',
  archived: false,
  pinned: false,
  awaitingOperator: 1,
  awaitingAgent: 0,
  processed: 0,
};
const VIEW = {
  inboxId: '01INBOXWIRE000000000000000',
  label: 'laptop work',
  metadata: {},
  archived: false,
  pinnedGroups: [],
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
};

describe('a machine’s answer decodes whatever build it runs', () => {
  it('a serve from before Inbox machines: no machine fields at all', () => {
    expect(
      Result.isSuccess(
        decodeBoard({
          inboxes: [ROW],
          totalAwaitingOperator: 1,
          views: [VIEW],
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decodeIndex({ inboxes: [ROW], totalAwaitingOperator: 1 }),
      ),
    ).toBe(true);
  });

  // An early serve, asked with `local=true`, merges nothing and sends an
  // empty `machines` list.
  it('an early serve, asked with local=true: an empty machines list', () => {
    expect(
      Result.isSuccess(
        decodeBoard({
          inboxes: [ROW],
          totalAwaitingOperator: 1,
          views: [VIEW],
          machines: [],
        }),
      ),
    ).toBe(true);
  });

  // A machine entry is only ever sent by Local's serve to its own page, never
  // by a machine asked with `local=true`, so the flat shape need not decode.
  it('a flat machine entry, never sent with local=true, does not decode', () => {
    expect(
      Result.isFailure(
        decodeStatus({
          label: 'laptop',
          port: 3010,
          status: 'reachable',
          awaitingOperator: 1,
        }),
      ),
    ).toBe(true);
  });
});

describe('InboxMachineStatusDto — one shape per status', () => {
  const statuses = [
    { status: 'local', key: 'local', label: 'Local', awaitingOperator: 2 },
    {
      status: 'reachable',
      key: '3010',
      label: 'laptop',
      port: 3010,
      awaitingOperator: 1,
    },
    {
      status: 'unreachable',
      key: '3011',
      label: 'desktop',
      port: 3011,
      reason: 'tunnel-down',
      detail: 'nothing answered on port 3011',
    },
    {
      status: 'incompatible',
      key: '3012',
      label: 'old',
      port: 3012,
      reason: 'misdirected',
      detail: 'port 3012 answered 421',
    },
  ];

  it('decodes each, and encodes it back as it came', () => {
    for (const s of statuses) {
      const decoded = decodeStatus(s);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isSuccess(decoded))
        expect(
          Schema.encodeSync(InboxMachineStatusDto)(decoded.success),
        ).toEqual(s);
    }
  });

  it('refuses a state the union does not allow', () => {
    const refused = [
      // reachable with no count, unreachable with no reason or detail.
      { status: 'reachable', key: '3010', label: 'laptop', port: 3010 },
      {
        status: 'unreachable',
        key: '3011',
        label: 's',
        port: 3011,
        detail: 'd',
      },
      {
        status: 'unreachable',
        key: '3011',
        label: 's',
        port: 3011,
        reason: 'tunnel-down',
      },
      // a reason of the other status.
      {
        status: 'unreachable',
        key: '3011',
        label: 's',
        port: 3011,
        reason: 'undecodable',
        detail: 'd',
      },
      {
        status: 'incompatible',
        key: '3012',
        label: 'o',
        port: 3012,
        reason: 'tunnel-down',
        detail: 'd',
      },
      // a machine with no port, or no key.
      {
        status: 'reachable',
        key: '3010',
        label: 'laptop',
        awaitingOperator: 1,
      },
      { status: 'local', label: 'Local', awaitingOperator: 1 },
    ];
    for (const s of refused)
      expect(Result.isFailure(decodeStatus(s))).toBe(true);
  });
});

describe('machine keys', () => {
  it('a row with no machine is Local’s; a merged row is its machine’s', () => {
    expect(machineKeyOf({})).toBe(LOCAL_MACHINE_KEY);
    expect(
      machineKeyOf({
        machine: {
          key: inboxMachineKey(InboxMachinePort.make(3010)),
          label: 'Local',
        },
      }),
    ).toBe('3010');
  });
});

describe('the board’s clash and banner fields', () => {
  it('decode on Local’s own page', () => {
    const board = decodeBoard({
      inboxes: [],
      totalAwaitingOperator: 0,
      views: [],
      machines: [
        { status: 'local', key: 'local', label: 'Local', awaitingOperator: 0 },
      ],
      clashes: [
        {
          inboxId: ROW.inboxId,
          outcome: 'refused',
          claims: [
            { machine: { key: '3010', label: 'laptop' }, label: 'a' },
            { machine: { key: '3011', label: 'desktop' }, label: 'b' },
          ],
        },
      ],
      machinesOff: 'inboxMachines — expected array, got 3',
    });
    expect(Result.isSuccess(board)).toBe(true);
  });

  it('a clash refusal rides on InboxUnavailable and round-trips; without it, the body is as before', () => {
    const id = InboxId.make(ROW.inboxId);
    const claimants = [
      { key: inboxMachineKey(InboxMachinePort.make(3010)), label: 'laptop' },
      { key: inboxMachineKey(InboxMachinePort.make(3011)), label: 'desktop' },
    ];
    const refused = new InboxUnavailable({
      message: inboxClashSentence(id, claimants),
      clashedOn: claimants,
    });
    const encoded = Schema.encodeSync(InboxUnavailable)(refused);
    expect(
      Schema.decodeUnknownSync(InboxUnavailable)(encoded).clashedOn,
    ).toEqual(claimants);
    expect(refused.message).toBe(
      `the Inbox ${id} is claimed by laptop and desktop: an Inbox lives on one machine, so it is refused on every one of them until one no longer has it`,
    );
    expect(
      Schema.encodeSync(InboxUnavailable)(
        new InboxUnavailable({ message: 'x' }),
      ),
    ).toStrictEqual({ _tag: 'InboxUnavailable', message: 'x' });
  });
});

describe('InboxReadQuery', () => {
  it('is local=true or nothing', () => {
    const decode = Schema.decodeUnknownResult(InboxReadQuery);
    expect(decode({ local: 'true' })).toEqual(
      Result.succeed({ local: 'true' }),
    );
    expect(decode({})).toEqual(Result.succeed({}));
    expect(Result.isFailure(decode({ local: 'false' }))).toBe(true);
  });
});

// The advice is written once, here, for the CLI and the page.
describe('inboxMachineAdvice', () => {
  const advise = (
    reason: Parameters<typeof inboxMachineAdvice>[0]['reason'],
    label = 'laptop',
  ) => inboxMachineAdvice({ label, port: 3010, reason });

  it('offers a command to copy only for a tunnel that is down', () => {
    expect(advise('tunnel-down')).toEqual({
      advice: 'Open its tunnel with `operator-inbox tunnel laptop`',
      command: 'operator-inbox tunnel laptop',
    });
    for (const reason of [
      'forward-refused',
      'hung-up',
      'connection-failed',
      'timed-out',
      'store-unavailable',
      'unresolved',
      'misdirected',
      'undecodable',
    ] as const) {
      const a = advise(reason);
      expect(a.command).toBeUndefined();
      expect(a.advice).not.toContain('operator-inbox tunnel');
    }
  });

  it('names serve’s own port, not a number written twice', () => {
    expect(advise('forward-refused').advice).toContain(
      `forward to 127.0.0.1:${SERVE_DEFAULT_PORT} (AllowTcpForwarding, PermitOpen) and that \`operator-inbox serve\` runs there on port ${SERVE_DEFAULT_PORT}`,
    );
  });

  // The request was taken and dropped behind the tunnel,
  // so the fix is on the machine's serve, never its sshd.
  it('sends a hung-up machine to its serve, not to sshd', () => {
    expect(advise('hung-up').advice).toBe(
      'Its tunnel took the request and closed it without an answer, so look at `operator-inbox serve` on laptop (its log is ~/.local/state/operator-inbox/serve.log)',
    );
  });

  // A connection that failed any way but refused says nothing
  // of the tunnel, so the advice is to look at what holds the port.
  it('sends a failed connection to what holds the port', () => {
    expect(advise('connection-failed').advice).toBe(
      "The connection to port 3010 failed: check what listens on port 3010 (`lsof -nP -iTCP:3010 -sTCP:LISTEN`) and that it is laptop's tunnel",
    );
  });

  it('names the config.json it is given, and this machine’s when it is not', () => {
    expect(
      inboxMachineAdvice(
        { label: 'g', port: 1, reason: 'unresolved' },
        '/c.json',
      ).advice,
    ).toBe('Correct or remove its entry in inboxMachines in /c.json');
    expect(advise('unresolved').advice).toBe(
      'Correct or remove its entry in inboxMachines in config.json on this machine',
    );
  });

  it('quotes a label a shell would read apart', () => {
    expect(tunnelCommand('my mac')).toBe("operator-inbox tunnel 'my mac'");
    expect(tunnelCommand("tom's")).toBe("operator-inbox tunnel 'tom'\\''s'");
    expect(tunnelCommand('laptop-2.local')).toBe(
      'operator-inbox tunnel laptop-2.local',
    );
    expect(shellWord('$(rm -rf)')).toBe("'$(rm -rf)'");
    expect(advise('tunnel-down', 'my mac').command).toBe(
      "operator-inbox tunnel 'my mac'",
    );
  });
});
