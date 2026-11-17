import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  type InboxBoardDto,
  type InboxMachineRef,
  type InboxSummaryDto,
  type InboxViewDto,
  inboxMachineKey,
  LOCAL_MACHINE_KEY,
} from '../src/api/inbox-api';
import type { Attachment } from '../src/attachment';
import { QuestionNumber, QuestionRevision } from '../src/inbox';
import {
  decideInboxOwner,
  heldClaims,
  INBOX_MACHINE_HOST,
  type InboxClaims,
  type InboxMachineEntry,
  inboxMachineEntries,
  inboxMachineLabels,
  type LocalInboxBoard,
  type MachineRead,
  type MachineResult,
  machineText,
  machineView,
  mergeInboxBoard,
  mergeInboxIndex,
  NO_INBOX_CLAIMS,
  type OwnerAnswer,
  ownerLookupMachines,
  ownersOfClaims,
  planInboxOwnerLookup,
  recordMachineClaims,
  resolveInboxMachines,
  tunnelArgs,
  unresolvedRead,
} from '../src/inbox-machines';
import type { HerdrMachine } from '../src/machines';
import {
  renderQuestionMarkdown,
  renderQuestionParts,
} from '../src/question-markdown';
import {
  HerdrMachineId,
  InboxId,
  InboxMachinePort,
} from '../src/schema/identifiers';

// The pure half of the combined inbox: resolving the configured
// machines, the tunnel's argv, the merge of each machine's read, and the order
// in which to look for an Inbox's owner.

const herdr = (
  id: string,
  label: string,
  target: string,
  enabled = true,
): HerdrMachine => ({
  id: HerdrMachineId.make(id),
  label,
  target,
  session: 'main',
  enabled,
  selected: false,
});

const LAPTOP = herdr('m1', 'laptop', 'operator@laptop.local');
const DESKTOP = herdr('m2', 'desktop', 'desktop');

const summary = (id: string, awaiting: number): InboxSummaryDto => ({
  inboxId: InboxId.make(id),
  label: id,
  archived: false,
  pinned: false,
  awaitingOperator: awaiting,
  awaitingAgent: 0,
  processed: 0,
});

const view = (id: string): InboxViewDto => ({
  inboxId: InboxId.make(id),
  label: id,
  metadata: {},
  archived: false,
  pinnedGroups: [],
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
});

const board = (
  ids: ReadonlyArray<[string, number]>,
  extra: Partial<InboxBoardDto> = {},
): InboxBoardDto & LocalInboxBoard => ({
  inboxes: ids.map(([id, n]) => summary(id, n)),
  totalAwaitingOperator: ids.reduce((t, [, n]) => t + n, 0),
  views: ids.map(([id]) => view(id)),
  ...extra,
});

// A machine's result, named as `inboxMachineEntries` names it: its key is
// its port.
const result = <A>(
  label: string,
  port: number,
  read: MachineRead<A>,
): MachineResult<A> => ({
  key: K(port),
  label,
  port: P(port),
  herdrMachine: label,
  read,
});
const reachable = <A>(label: string, port: number, value: A) =>
  result(label, port, { status: 'reachable', value });
const ref = (label: string, port: number): InboxMachineRef => ({
  key: K(port),
  label,
});
const P = (port: number) => InboxMachinePort.make(port);
const K = (port: number) => inboxMachineKey(P(port));

// A configured machine as serve holds it, resolved to the Herdr machine
// `herdrId` (by default one of its label's own).
const entryOf = (
  label: string,
  port: number,
  herdrId = `id-${label}`,
): InboxMachineEntry => ({
  key: K(port),
  label,
  port: P(port),
  herdrMachine: label,
  resolved: Result.succeed({
    herdrMachine: label,
    herdrId: HerdrMachineId.make(herdrId),
    label,
    port: P(port),
    target: label,
  }),
});
// One that cannot be called now: its Herdr profile gone, or Herdr unread.
const uncallableEntry = (
  label: string,
  port: number,
  tag: 'Unusable' | 'HerdrUnread' = 'Unusable',
): InboxMachineEntry => ({
  key: K(port),
  label,
  port: P(port),
  herdrMachine: label,
  resolved: Result.fail({
    _tag: tag,
    herdrMachine: label,
    port: P(port),
    reason: 'r',
  }),
});
// The entries a read's results were made against: each resolved.
const entriesOf = (
  results: ReadonlyArray<MachineResult<unknown>>,
): ReadonlyArray<InboxMachineEntry> =>
  results.map((r) => entryOf(r.label, r.port));
// What each machine a read reached claims, recorded as serve records it, one
// machine at a time, read `number`.
const recordRead = (
  before: InboxClaims,
  results: ReadonlyArray<MachineResult<Pick<InboxBoardDto, 'inboxes'>>>,
  number: number,
): InboxClaims =>
  results.reduce(
    (claims, r) =>
      r.read.status === 'reachable'
        ? recordMachineClaims(claims, {
            number,
            entries: entriesOf(results),
            key: r.key,
            rows: r.read.value.inboxes,
          })
        : claims,
    before,
  );

describe('tunnelArgs', () => {
  it('forwards loopback’s port to the machine’s serve, through its Herdr target', () => {
    expect(INBOX_MACHINE_HOST).toBe('127.0.0.1:7184');
    expect(tunnelArgs(LAPTOP, 3010)).toEqual([
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-L',
      '127.0.0.1:3010:127.0.0.1:7184',
      '--',
      'operator@laptop.local',
    ]);
  });
});

describe('resolveInboxMachines', () => {
  it('resolves by label or id, in the configured order, with the profile’s label and target', () => {
    const out = resolveInboxMachines(
      [
        { herdrMachine: 'm2', port: P(3011) },
        { herdrMachine: 'laptop', port: P(3010) },
      ],
      [LAPTOP, DESKTOP],
    );
    expect(out).toEqual([
      Result.succeed({
        herdrMachine: 'm2',
        herdrId: HerdrMachineId.make('m2'),
        label: 'desktop',
        port: 3011,
        target: 'desktop',
      }),
      Result.succeed({
        herdrMachine: 'laptop',
        herdrId: HerdrMachineId.make('m1'),
        label: 'laptop',
        port: 3010,
        target: 'operator@laptop.local',
      }),
    ]);
  });

  it('refuses each bad selector on its own, with findMachine’s sentence', () => {
    const out = resolveInboxMachines(
      [
        { herdrMachine: 'ghost', port: P(3010) },
        { herdrMachine: 'off', port: P(3011) },
        { herdrMachine: 'laptop', port: P(3012) },
      ],
      [LAPTOP, herdr('m3', 'off', 'off', false)],
    );
    expect(out[0]).toEqual(
      Result.fail({
        _tag: 'Unusable',
        herdrMachine: 'ghost',
        port: 3010,
        reason:
          'no saved Herdr machine has the id or label "ghost" (see `herdr machine list`)',
      }),
    );
    expect(out.map(Result.isFailure)).toEqual([true, true, false]);
  });

  it('with no Herdr profiles, every machine is refused', () => {
    const out = resolveInboxMachines(
      [{ herdrMachine: 'laptop', port: P(3010) }],
      [],
    );
    expect(out.map(Result.isFailure)).toEqual([true]);
  });

  it('refuses a second selector naming the same profile', () => {
    const out = resolveInboxMachines(
      [
        { herdrMachine: 'laptop', port: P(3010) },
        { herdrMachine: 'm1', port: P(3011) },
      ],
      [LAPTOP],
    );
    expect(out[1]).toEqual(
      Result.fail({
        _tag: 'Unusable',
        herdrMachine: 'm1',
        port: 3011,
        reason: '"m1" names the same Herdr machine as "laptop", already listed',
        sameMachineAs: LAPTOP.id,
      }),
    );
  });
});

describe('resolveInboxMachines — a label is a machine’s identity', () => {
  it('refuses a machine whose label an earlier machine already has, in any case', () => {
    const twin = herdr('m9', 'LAPTOP', 'operator@other');
    const out = resolveInboxMachines(
      [
        { herdrMachine: 'm1', port: P(3010) },
        { herdrMachine: 'm9', port: P(3011) },
      ],
      [LAPTOP, twin],
    );
    expect(out[0] && Result.isSuccess(out[0])).toBe(true);
    expect(out[1]).toEqual(
      Result.fail({
        _tag: 'Unusable',
        herdrMachine: 'm9',
        port: 3011,
        reason:
          '"m9" is the Herdr machine labelled "LAPTOP", the label of "m1", already listed: Herdr labels can repeat, but each Inbox machine needs a label of its own, so relabel one in Herdr',
      }),
    );
  });

  // The earlier label upper-cased: what is recorded is compared regardless
  // of case too, not only what is looked up.
  it('refuses a lower-case label after an upper-case one', () => {
    const upper = herdr('m9', 'LAPTOP', 'operator@other');
    const out = resolveInboxMachines(
      [
        { herdrMachine: 'm9', port: P(3011) },
        { herdrMachine: 'm1', port: P(3010) },
      ],
      [LAPTOP, upper],
    );
    expect(out[0] && Result.isSuccess(out[0])).toBe(true);
    expect(out[1] && Result.isFailure(out[1])).toBe(true);
  });

  it('refuses a machine labelled Local, in any case', () => {
    const out = resolveInboxMachines(
      [
        { herdrMachine: 'm5', port: P(3010) },
        { herdrMachine: 'laptop', port: P(3011) },
      ],
      [herdr('m5', 'local', 'box'), LAPTOP],
    );
    expect(out[0]).toEqual(
      Result.fail({
        _tag: 'Unusable',
        herdrMachine: 'm5',
        port: 3010,
        reason:
          '"m5" is the Herdr machine labelled "local", the name the app gives Local: relabel it in Herdr',
      }),
    );
    expect(out[1] && Result.isSuccess(out[1])).toBe(true);
  });
});

describe('inboxMachineEntries — one resolution for serve and tunnel', () => {
  it('keys each machine by its tunnel port and labels it as inboxMachineLabels does', () => {
    const out = inboxMachineEntries(
      [
        { herdrMachine: 'laptop', port: P(3010) },
        { herdrMachine: 'ghost', port: P(3011) },
      ],
      Result.succeed([LAPTOP]),
    );
    expect(out.map((e) => [e.key, e.label, e.port, e.herdrMachine])).toEqual([
      ['3010', 'laptop', 3010, 'laptop'],
      ['3011', 'ghost', 3011, 'ghost'],
    ]);
    expect(out.map((e) => Result.isSuccess(e.resolved))).toEqual([true, false]);
  });

  it('with Herdr unreadable, every machine is unresolved with that sentence', () => {
    const out = inboxMachineEntries(
      [
        { herdrMachine: 'laptop', port: P(3010) },
        { herdrMachine: 'desktop', port: P(3011) },
      ],
      Result.fail('herdr is not on PATH'),
    );
    expect(
      out.map((e) =>
        Result.isFailure(e.resolved) ? e.resolved.failure.reason : 'resolved',
      ),
    ).toEqual(['herdr is not on PATH', 'herdr is not on PATH']);
    expect(out.map((e) => e.label)).toEqual(['laptop', 'desktop']);
    // Herdr's, not the entries': never a config error.
    expect(
      out.map((e) =>
        Result.isFailure(e.resolved)
          ? unresolvedRead(e.resolved.failure).reason
          : 'resolved',
      ),
    ).toEqual(['herdr-unread', 'herdr-unread']);
  });

  it('keys never collide with Local’s', () => {
    expect(K(3010)).not.toBe(LOCAL_MACHINE_KEY);
    expect(LOCAL_MACHINE_KEY).toBe('local');
  });
});

describe('mergeInboxBoard — one level', () => {
  // `laptop` answered its own Inbox M and, merged from its own Inbox machine
  // `desktop`, S; `desktop` answered S itself. Local merges one level: S once,
  // from desktop, and a total of 1 + 1 + 1.
  const tagged = (id: string, n: number): InboxSummaryDto => ({
    ...summary(id, n),
    machine: ref('desktop', 3011),
  });
  const laptop: InboxBoardDto = {
    inboxes: [summary('M', 1), tagged('S', 1)],
    totalAwaitingOperator: 2,
    views: [view('M'), { ...view('S'), machine: ref('desktop', 3011) }],
  };
  const merged = mergeInboxBoard(board([['L', 1]]), [
    reachable('laptop', 3010, laptop),
    reachable('desktop', 3011, board([['S', 1]])),
  ]);

  it('passes on only what each machine sent untagged, its own', () => {
    expect(merged.inboxes.map((s) => [s.inboxId, s.machine?.key])).toEqual([
      ['L', undefined],
      ['M', '3010'],
      ['S', '3011'],
    ]);
    expect(merged.views.map((v) => [v.inboxId, v.machine?.label])).toEqual([
      ['L', undefined],
      ['M', 'laptop'],
      ['S', 'desktop'],
    ]);
    // What laptop merged from desktop is not a claim: no clash on S.
    expect(merged.clashes).toEqual([]);
  });

  it('counts each machine’s own active Inboxes, not its total', () => {
    expect(merged.totalAwaitingOperator).toBe(3);
    expect(
      merged.machines.map((m) =>
        m.status === 'local' || m.status === 'reachable'
          ? m.awaitingOperator
          : undefined,
      ),
    ).toEqual([1, 1, 1]);
  });

  it('leaves a machine’s archived Inboxes out of its count', () => {
    const withArchived = mergeInboxIndex(
      { inboxes: [], totalAwaitingOperator: 0 },
      [
        reachable('laptop', 3010, {
          inboxes: [summary('A', 2), { ...summary('B', 4), archived: true }],
        }),
      ],
    );
    expect(withArchived.totalAwaitingOperator).toBe(2);
    expect(withArchived.machines[1]).toEqual({
      status: 'reachable',
      key: K(3010),
      label: 'laptop',
      port: 3010,
      awaitingOperator: 2,
    });
  });
});

describe('a machine’s question HTML is never passed on', () => {
  // A machine (or whatever holds its tunnel port) sends a script as the
  // rendered body. The page renders `bodyHtml` and html parts as HTML, so
  // Local renders each body again from its raw markdown, and the script
  // reaches the page as escaped text.
  const HOSTILE = '<img src=x onerror="fetch(\'/api/inboxes\')">';
  const BODY = 'Pick one <img src=x onerror=alert(1)> **now**';
  const question = {
    number: QuestionNumber.make(1),
    revision: QuestionRevision.make(1),
    metadata: {},
    title: 'q',
    body: BODY,
    bodyHtml: HOSTILE,
    bodyParts: [{ kind: 'html' as const, html: HOSTILE }],
  };
  const hostile: InboxViewDto = {
    ...view('H'),
    awaitingOperator: [{ ...question, askedSeq: 1 }],
    awaitingAgent: [{ ...question, response: 'a', answeredSeq: 2 }],
    processed: [{ ...question, withdrawn: false, processedSeq: 3 }],
  };
  const bodiesOf = (v: InboxViewDto | undefined) =>
    v === undefined
      ? []
      : [...v.awaitingOperator, ...v.awaitingAgent, ...v.processed].map(
          (q) => ({ bodyHtml: q.bodyHtml, bodyParts: q.bodyParts }),
        );
  const local = {
    bodyHtml: renderQuestionMarkdown(BODY),
    bodyParts: renderQuestionParts(BODY),
  };

  it('the merged board carries Local’s rendering of each body, not the machine’s', () => {
    const merged = mergeInboxBoard(board([]), [
      reachable('laptop', 3010, { ...board([['H', 1]]), views: [hostile] }),
    ]);
    const bodies = bodiesOf(merged.views[0]);
    expect(bodies).toEqual([local, local, local]);
    expect(JSON.stringify(bodies)).not.toContain('<img');
    expect(local.bodyHtml).toContain('&lt;img');
  });

  it('machineView renders every column again, and tags the view', () => {
    const out = machineView(hostile, ref('laptop', 3010));
    expect(out.machine).toEqual({ key: '3010', label: 'laptop' });
    expect(bodiesOf(out)).toEqual([local, local, local]);
    // Everything else is the machine's, as it sent it.
    expect(out.awaitingAgent[0]?.response).toBe('a');
    expect(out.awaitingOperator[0]?.body).toBe(BODY);
  });
});

describe('a machine’s body images are drawn again by Local', () => {
  const question = (
    body: string,
    askedAttachments?: ReadonlyArray<Attachment>,
  ) => ({
    number: QuestionNumber.make(1),
    revision: QuestionRevision.make(1),
    metadata: {},
    title: 'q',
    body,
    bodyHtml: '<img src="https://elsewhere/x.png">',
    bodyImages: ['sent-by-the-machine.png'],
    ...(askedAttachments === undefined ? {} : { askedAttachments }),
  });
  const viewWith = (q: ReturnType<typeof question>) =>
    machineView(
      {
        ...view('H'),
        awaitingOperator: [{ ...q, askedSeq: 1 }],
        awaitingAgent: [{ ...q, response: 'a', answeredSeq: 2 }],
        processed: [{ ...q, withdrawn: false, processedSeq: 3 }],
      },
      ref('laptop', 3010),
    );
  const columns = (out: InboxViewDto) => [
    ...out.awaitingOperator,
    ...out.awaitingAgent,
    ...out.processed,
  ];

  it('machineView draws a body’s image from the Question’s own file, read through Local', () => {
    const out = viewWith(
      question('![a](attachment:shot.png)', [
        {
          path: '/far/state/attachments/01INBOX/0123456789abcdef/shot.png',
          name: 'shot.png',
          type: 'image/png',
          bytes: 3,
        },
      ]),
    );
    for (const q of columns(out)) {
      // Local's own names, never the machine's.
      expect(q.bodyImages).toStrictEqual(['shot.png']);
      expect(q.bodyHtml).toContain(
        'src="/api/attachments/01INBOX/0123456789abcdef/shot.png"',
      );
      expect(q.bodyHtml).not.toContain('elsewhere');
    }
  });

  it('a path a machine sent cannot climb out of the attachments route', () => {
    const out = viewWith(
      question('![a](attachment:shot.png)', [
        {
          path: '/x/../../shot.png',
          name: 'shot.png',
          type: 'image/png',
          bytes: 3,
        },
      ]),
    );
    expect('bodyImages' in (out.awaitingOperator[0] ?? {})).toBe(false);
    expect(out.awaitingOperator[0]?.bodyHtml).toBe('<p>a</p>\n');
  });

  it('a body naming no image the Question carries is its alt text, with no names', () => {
    const out = viewWith(question('![a](attachment:shot.png)'));
    for (const q of columns(out)) {
      expect('bodyImages' in q).toBe(false);
      expect(q.bodyHtml).toBe('<p>a</p>\n');
    }
  });
});

describe('inboxMachineLabels — every section its own label', () => {
  const ok = (label: string, port: number) =>
    Result.succeed({
      herdrMachine: label,
      herdrId: HerdrMachineId.make(label),
      label,
      port: P(port),
      target: 't',
    });
  const no = (herdrMachine: string, port: number) =>
    Result.fail({
      _tag: 'Unusable',
      herdrMachine,
      port: P(port),
      reason: 'r',
    } as const);

  it('keeps a resolved machine’s label, and a selector no section has', () => {
    expect(
      inboxMachineLabels([ok('laptop', 3010), no('desktop', 3011)]),
    ).toEqual(['laptop', 'desktop']);
  });

  it('gives a selector a section already has its port, in any case', () => {
    expect(
      inboxMachineLabels([
        no('LAPTOP', 3011),
        ok('laptop', 3010),
        no('local', 3012),
      ]),
    ).toEqual(['LAPTOP:3011', 'laptop', 'local:3012']);
  });

  // The resolved label in another case than the selector: the clash is
  // found on the label as Herdr gave it, compared regardless of case.
  it('keeps a selector off a resolved label that differs only in case', () => {
    expect(
      inboxMachineLabels([ok('LAPTOP', 3010), no('laptop', 3011)]),
    ).toEqual(['LAPTOP', 'laptop:3011']);
  });

  it('counts on when even selector and port are taken', () => {
    expect(
      inboxMachineLabels([
        ok('laptop', 3010),
        ok('laptop:3011', 3012),
        no('laptop', 3011),
      ]),
    ).toEqual(['laptop', 'laptop:3011', 'laptop:3011 (2)']);
  });
});

describe('machineText', () => {
  it('removes every escape sequence and control character', () => {
    const cases: ReadonlyArray<[string, string]> = [
      // OSC (a terminal title) ended by BEL, then by ST.
      ['\u001b]0;pwned\u0007ok', 'ok'],
      ['\u001b]8;;https://x\u001b\\ok', 'ok'],
      // CSI: clear the screen, paint green.
      ['\u001b[2J\u001b[32m✓ all fine\u001b[0m', '✓ all fine'],
      // The 8-bit CSI and a C1 OSC, and an unended OSC.
      ['a\u009b31mb\u009d0;t\u0007c', 'abc'],
      ['ok\u001b]0;never ended', 'ok'],
      // A lone ESC and the byte after it, DEL, NUL and the other C0s.
      ['a\u001bcb\u007f\u0000\u0008', 'ab'],
      // A tab or a line break is a space.
      ['one\ntwo\tthree\r', 'one two three '],
      ['plain words, kept', 'plain words, kept'],
    ];
    for (const [input, out] of cases) expect(machineText(input)).toBe(out);
  });
});

describe('mergeInboxBoard', () => {
  const local = board([
    ['L1', 2],
    ['L2', 0],
  ]);
  const results: ReadonlyArray<MachineResult<InboxBoardDto>> = [
    // A machine's own `machines` list is not carried into Local's.
    reachable(
      'laptop',
      3010,
      board([['M1', 3]], {
        machines: [
          {
            status: 'local',
            key: LOCAL_MACHINE_KEY,
            label: 'Local',
            awaitingOperator: 9,
          },
        ],
      }),
    ),
    result('desktop', 3011, {
      status: 'unreachable',
      reason: 'tunnel-down',
      detail: 'nothing answered on port 3011',
    }),
    result('old', 3012, {
      status: 'incompatible',
      reason: 'undecodable',
      detail: 'answered HTTP 500',
    }),
    reachable('mini', 3013, board([['N1', 1]])),
    result('ghost', 3014, {
      status: 'unreachable',
      reason: 'unresolved',
      detail: 'no saved Herdr machine has the id or label "ghost"',
    }),
  ];
  const merged = mergeInboxBoard(local, results);

  it('lists Local first untagged, then each reachable machine tagged, in configured order', () => {
    expect(merged.inboxes.map((s) => [s.inboxId, s.machine?.label])).toEqual([
      ['L1', undefined],
      ['L2', undefined],
      ['M1', 'laptop'],
      ['N1', 'mini'],
    ]);
    expect(merged.views.map((v) => [v.inboxId, v.machine?.key])).toEqual([
      ['L1', undefined],
      ['L2', undefined],
      ['M1', '3010'],
      ['N1', '3013'],
    ]);
    // Local's own rows carry no `machine` key at all.
    expect('machine' in (merged.inboxes[0] ?? {})).toBe(false);
  });

  it('totals Local’s and every reachable machine’s waiting questions', () => {
    expect(merged.totalAwaitingOperator).toBe(2 + 3 + 1);
  });

  // Local is the first entry, carrying its own total, so the page
  // never sums Local's rows itself.
  it('reports Local first with its own total, then every machine by its status', () => {
    expect(merged.machines).toEqual([
      { status: 'local', key: 'local', label: 'Local', awaitingOperator: 2 },
      {
        status: 'reachable',
        key: '3010',
        label: 'laptop',
        port: 3010,
        awaitingOperator: 3,
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
        reason: 'undecodable',
        detail: 'answered HTTP 500',
      },
      {
        status: 'reachable',
        key: '3013',
        label: 'mini',
        port: 3013,
        awaitingOperator: 1,
      },
      {
        status: 'unreachable',
        key: '3014',
        label: 'ghost',
        port: 3014,
        reason: 'unresolved',
        detail: 'no saved Herdr machine has the id or label "ghost"',
      },
    ]);
  });

  it('leaves a muted Inbox’s waiting questions out of a machine’s total', () => {
    const mutedRow = { ...summary('M2', 4), muted: true };
    const theirs = board([['M1', 3]]);
    const out = mergeInboxBoard(board([['L1', 2]]), [
      reachable('laptop', 3010, {
        ...theirs,
        inboxes: [...theirs.inboxes, mutedRow],
        views: [...theirs.views, view('M2')],
      }),
    ]);
    expect(out.inboxes.map((s) => s.inboxId)).toContain('M2');
    expect(out.totalAwaitingOperator).toBe(2 + 3);
    const laptop = out.machines.find((m) => m.key === K(3010));
    expect(laptop?.status === 'reachable' ? laptop.awaitingOperator : -1).toBe(
      3,
    );
  });

  it('with no machines configured, is Local’s board with Local alone', () => {
    expect(mergeInboxBoard(local, [])).toEqual({
      ...local,
      machines: [
        { status: 'local', key: 'local', label: 'Local', awaitingOperator: 2 },
      ],
      clashes: [],
    });
  });

  // Machines off, and the page told why.
  it('carries the sentence saying why machines are off, only when given', () => {
    const off = mergeInboxBoard(local, [], {
      machinesOff: 'inboxMachines — expected an array, got 3',
    });
    expect(off.machinesOff).toBe('inboxMachines — expected an array, got 3');
    expect(off.machines.map((m) => m.status)).toEqual(['local']);
    expect('machinesOff' in mergeInboxBoard(local, [])).toBe(false);
  });

  it('the index merges the same way', () => {
    const index = mergeInboxIndex(
      { inboxes: local.inboxes, totalAwaitingOperator: 2 },
      results,
    );
    expect(index.inboxes.map((s) => s.machine?.label)).toEqual([
      undefined,
      undefined,
      'laptop',
      'mini',
    ]);
    expect(index.totalAwaitingOperator).toBe(6);
    expect(index.machines).toEqual(merged.machines);
    expect('views' in index).toBe(false);
  });

  it('records each reached machine’s own Inboxes as its claims, by key', () => {
    expect([
      ...ownersOfClaims(
        recordRead(NO_INBOX_CLAIMS, results, 0),
        entriesOf(results),
      ),
    ]).toEqual([
      ['M1', ['3010']],
      ['N1', ['3013']],
    ]);
  });
});

// An Inbox id two machines claim is refused, not
// merged, and nothing is routed to either.
describe('mergeInboxBoard — an Inbox id two machines claim', () => {
  const X = InboxId.make('01CLASHEDINBOX000000000000');
  const claimant = (label: string, port: number, ids: Array<string>) =>
    reachable(label, port, board(ids.map((id) => [id, 1] as [string, number])));

  it('refuses it: neither machine’s row or view is passed on, and both are named', () => {
    const merged = mergeInboxBoard(board([['L', 0]]), [
      claimant('laptop', 3010, [X, 'M']),
      claimant('desktop', 3011, [X, 'S']),
    ]);
    expect(merged.inboxes.map((s) => s.inboxId)).toEqual(['L', 'M', 'S']);
    expect(merged.views.map((v) => v.inboxId)).toEqual(['L', 'M', 'S']);
    expect(merged.clashes).toEqual([
      {
        inboxId: X,
        outcome: 'refused',
        claims: [
          { machine: ref('laptop', 3010), label: X },
          { machine: ref('desktop', 3011), label: X },
        ],
      },
    ]);
  });

  it('leaves the refused Inbox out of every count', () => {
    const merged = mergeInboxIndex({ inboxes: [], totalAwaitingOperator: 0 }, [
      claimant('laptop', 3010, [X, 'M']),
      claimant('desktop', 3011, [X]),
    ]);
    expect(merged.totalAwaitingOperator).toBe(1);
    expect(
      merged.machines.map((m) =>
        m.status === 'reachable' ? m.awaitingOperator : m.status,
      ),
    ).toEqual(['local', 1, 0]);
  });

  it('records both claimants as its owners, so the lookup refuses it', () => {
    const merged = mergeInboxIndex({ inboxes: [], totalAwaitingOperator: 0 }, [
      claimant('laptop', 3010, [X]),
      claimant('desktop', 3011, [X]),
    ]);
    const results = [
      claimant('laptop', 3010, [X]),
      claimant('desktop', 3011, [X]),
    ];
    const owners = ownersOfClaims(
      recordRead(NO_INBOX_CLAIMS, results, 0),
      entriesOf(results),
    );
    expect(merged.clashes.map((c) => c.outcome)).toEqual(['refused']);
    expect(owners.get(X)).toEqual(['3010', '3011']);
    expect(
      planInboxOwnerLookup({
        inboxId: X,
        lastOwners: owners,
        machines: [K(3010), K(3011)],
        callable: [K(3010), K(3011)],
      }),
    ).toEqual({ _tag: 'Clashed', machines: ['3010', '3011'] });
  });

  it('keeps Local’s own Inbox when a machine claims its id, and names the claim', () => {
    const merged = mergeInboxBoard(board([[X, 2]]), [
      claimant('laptop', 3010, [X, 'M']),
    ]);
    expect(merged.inboxes.map((s) => [s.inboxId, s.machine?.key])).toEqual([
      [X, undefined],
      ['M', '3010'],
    ]);
    expect(merged.views.map((v) => v.inboxId)).toEqual([X, 'M']);
    expect(merged.clashes).toEqual([
      {
        inboxId: X,
        outcome: 'kept-on-local',
        claims: [
          { machine: { key: 'local', label: 'Local' }, label: X },
          { machine: ref('laptop', 3010), label: X },
        ],
      },
    ]);
  });

  it('one machine sending an id twice is not a clash: its first is passed on', () => {
    const twice: InboxBoardDto = {
      inboxes: [summary('M', 1), { ...summary('M', 5), label: 'again' }],
      totalAwaitingOperator: 6,
      views: [view('M'), { ...view('M'), label: 'again' }],
    };
    const merged = mergeInboxBoard(board([]), [
      reachable('laptop', 3010, twice),
    ]);
    expect(merged.clashes).toEqual([]);
    expect(merged.inboxes.map((s) => s.label)).toEqual(['M']);
    expect(merged.views.map((v) => v.label)).toEqual(['M']);
    expect(merged.totalAwaitingOperator).toBe(1);
  });

  it('a view for an Inbox the machine did not list is dropped', () => {
    const merged = mergeInboxBoard(board([]), [
      reachable('laptop', 3010, {
        ...board([['M', 1]]),
        views: [view('M'), view(X)],
      }),
    ]);
    expect(merged.views.map((v) => v.inboxId)).toEqual(['M']);
  });
});

// A clash under flapping: a machine that misses a read
// keeps what it last claimed, so a clash is refused while any claimant is
// unreached, whichever misses and in whatever order the reads finish.
describe('recordMachineClaims — a clash outlives a missed read', () => {
  const X = InboxId.make('01CLASHEDINBOX000000000000');
  const claims = (ids: Array<string>) =>
    board(ids.map((id) => [id, 1] as [string, number]));
  const down = (label: string, port: number) =>
    result<InboxBoardDto>(label, port, {
      status: 'unreachable',
      reason: 'tunnel-down',
      detail: `nothing answered on port ${port}`,
    });
  const machines = [K(3010), K(3011)];
  const entries = [entryOf('laptop', 3010), entryOf('desktop', 3011)];
  // Each board in turn, read `number` its index, each machine it reached
  // recording its claims, as serve does.
  const recorded = (
    ...boards: ReadonlyArray<ReadonlyArray<MachineResult<InboxBoardDto>>>
  ) =>
    boards.reduce(
      (claimed, results, number) => recordRead(claimed, results, number),
      NO_INBOX_CLAIMS,
    );
  // The plan for X against `entries`, the machines that can be called
  // `callable` (by default both).
  const plan = (claimed: InboxClaims, callable = machines) =>
    planInboxOwnerLookup({
      inboxId: X,
      lastOwners: ownersOfClaims(claimed, entries),
      machines,
      callable,
    });
  const clashed = { _tag: 'Clashed', machines: ['3010', '3011'] };
  const both = [
    reachable('laptop', 3010, claims([X])),
    reachable('desktop', 3011, claims([X])),
  ];

  it('one claimant missing the next read keeps the clash, either one', () => {
    expect(
      plan(
        recorded(both, [
          down('laptop', 3010),
          reachable('desktop', 3011, claims([X])),
        ]),
      ),
    ).toEqual(clashed);
    expect(
      plan(
        recorded(both, [
          reachable('laptop', 3010, claims([X])),
          down('desktop', 3011),
        ]),
      ),
    ).toEqual(clashed);
  });

  it('claimants missing reads in turn keep the clash on every read', () => {
    let claimed = recorded(both);
    const flaps = [
      [down('laptop', 3010), reachable('desktop', 3011, claims([X]))],
      [reachable('laptop', 3010, claims([X])), down('desktop', 3011)],
      [down('laptop', 3010), down('desktop', 3011)],
      [reachable('laptop', 3010, claims([X])), down('desktop', 3011)],
    ];
    flaps.forEach((results, i) => {
      claimed = recordRead(claimed, results, i + 1);
      expect(plan(claimed)).toEqual(clashed);
    });
  });

  it('an id two machines claimed on different reads, never together, is a clash', () => {
    expect(
      plan(
        recorded(
          [reachable('laptop', 3010, claims([X])), down('desktop', 3011)],
          [down('laptop', 3010), reachable('desktop', 3011, claims([X]))],
        ),
      ),
    ).toEqual(clashed);
  });

  it('once every claimant answers, the read is what it shows', () => {
    const claimed = recorded(
      both,
      [down('laptop', 3010), reachable('desktop', 3011, claims([X]))],
      [
        reachable('laptop', 3010, claims([])),
        reachable('desktop', 3011, claims([X])),
      ],
    );
    expect(plan(claimed)).toEqual({
      _tag: 'Ask',
      rounds: [['3011'], ['3010']],
      uncalled: [],
    });
  });

  it('an older read finishing last leaves alone a machine a newer read reached', () => {
    // Read 1 reached both and found the clash; read 0, started before it,
    // finishes after it, having seen laptop claim nothing.
    const newer = recordRead(NO_INBOX_CLAIMS, both, 1);
    const older = recordRead(
      newer,
      [
        reachable('laptop', 3010, claims([])),
        reachable('desktop', 3011, claims([X])),
      ],
      0,
    );
    expect(plan(older)).toEqual(clashed);
  });

  it('an older read finishing last still counts for a machine the newer one missed', () => {
    // Read 1 missed laptop; read 0, started before it, reached laptop claiming X.
    const newer = recordRead(
      NO_INBOX_CLAIMS,
      [down('laptop', 3010), reachable('desktop', 3011, claims([X]))],
      1,
    );
    const older = recordRead(newer, both, 0);
    expect(plan(older)).toEqual(clashed);
  });

  it('the board read while a claimant is missed shows the clash, not the other’s row', () => {
    const claimed = recorded(both);
    const merged = mergeInboxBoard(
      board([]),
      [down('laptop', 3010), reachable('desktop', 3011, claims([X, 'S']))],
      { claims: heldClaims(claimed, entries) },
    );
    expect(merged.inboxes.map((s) => s.inboxId)).toEqual(['S']);
    expect(merged.views.map((v) => v.inboxId)).toEqual(['S']);
    expect(merged.clashes).toEqual([
      {
        inboxId: X,
        outcome: 'refused',
        claims: [
          { machine: ref('laptop', 3010), label: X },
          { machine: ref('desktop', 3011), label: X },
        ],
      },
    ]);
    expect(merged.totalAwaitingOperator).toBe(1);
  });

  it('a missed machine’s claim alone, or on an id Local has, is no clash', () => {
    const claimed = recorded([
      reachable('laptop', 3010, claims([X, 'L'])),
      reachable('desktop', 3011, claims([])),
    ]);
    const merged = mergeInboxBoard(
      board([['L', 0]]),
      [down('laptop', 3010), reachable('desktop', 3011, claims(['L']))],
      { claims: heldClaims(claimed, entries) },
    );
    expect(merged.clashes.map((c) => [c.inboxId, c.outcome])).toEqual([
      ['L', 'kept-on-local'],
    ]);
    expect(merged.clashes[0]?.claims.map((c) => c.machine.key)).toEqual([
      'local',
      '3011',
    ]);
  });

  it('a machine no longer configured claims nothing', () => {
    const claimed = recorded(both, [reachable('desktop', 3011, claims([X]))]);
    expect(ownersOfClaims(claimed, [entryOf('desktop', 3011)]).get(X)).toEqual([
      '3011',
    ]);
    expect([...claimed.byMachine.keys()]).toEqual(['3011']);
  });

  // Two machines this read missed, whose
  // kept claims share an id no machine sent this read, make no clash on the
  // board: a missed machine's claim counts only beside one sent this read.
  it('two missed claimants of an id no machine sent this read make no clash', () => {
    const merged = mergeInboxBoard(
      board([]),
      [down('laptop', 3010), down('desktop', 3011)],
      { claims: heldClaims(recorded(both), entries) },
    );
    expect(merged.clashes).toEqual([]);
  });

  // A claimant that cannot be called now (its Herdr
  // profile gone or relabelled, on serve's own port, or Herdr unread) still
  // counts. The clash stays refused, and an id only it claims is its,
  // unreachable, never passed to another machine or answered not found.
  it('a claimant that cannot be called keeps the clash refused', () => {
    const claimed = recorded(both);
    expect(plan(claimed, [K(3011)])).toEqual(clashed);
    expect(plan(claimed, [K(3010)])).toEqual(clashed);
    // A Herdr timeout leaves no machine callable.
    expect(plan(claimed, [])).toEqual(clashed);
  });

  it('an id only a machine that cannot be called claims is that machine’s, unreached', () => {
    const claimed = recorded([
      reachable('laptop', 3010, claims([X])),
      reachable('desktop', 3011, claims([])),
    ]);
    expect(plan(claimed, [K(3011)])).toEqual({
      _tag: 'Unreached',
      key: '3010',
    });
    expect(plan(claimed, [])).toEqual({ _tag: 'Unreached', key: '3010' });
  });

  it('the claims of an entry that cannot be called still count for it', () => {
    const claimed = recorded(both);
    const now = [uncallableEntry('laptop', 3010, 'HerdrUnread'), entries[1]];
    expect(
      ownersOfClaims(claimed, now as ReadonlyArray<InboxMachineEntry>).get(X),
    ).toEqual(['3010', '3011']);
  });

  // Claims are kept by tunnel port, so a port another machine
  // takes keeps none of the claims of the machine that left it.
  it('a port another machine now holds keeps none of the last one’s claims', () => {
    const claimed = recorded(both);
    const desktop = entryOf('desktop', 3011);
    // A new selector on laptop's port, unresolved; and a resolved machine on it
    // that is another Herdr machine under laptop's selector.
    for (const onPort of [
      uncallableEntry('ghost', 3010),
      entryOf('laptop', 3010, 'another-machine'),
    ])
      expect(ownersOfClaims(claimed, [onPort, desktop]).get(X)).toEqual([
        '3011',
      ]);
    // The read made against the new machines drops them for good.
    const after = recordRead(
      claimed,
      [
        result('ghost', 3010, {
          status: 'unreachable',
          reason: 'unresolved',
          detail: 'r',
        }),
        reachable('desktop', 3011, claims([X])),
      ],
      1,
    );
    expect([...after.byMachine.keys()]).toEqual(['3011']);
  });

  // The owners are in section order whatever order the
  // machines were recorded in, so a config that swaps two machines' places,
  // on the same ports, names the claimants in the new order.
  it('names the claimants in section order after a reorder', () => {
    const claimed = recorded(both);
    expect(
      ownersOfClaims(claimed, [
        entryOf('desktop', 3011),
        entryOf('laptop', 3010),
      ]).get(X),
    ).toEqual(['3011', '3010']);
  });
});

describe('planInboxOwnerLookup', () => {
  const id = InboxId.make('01INBOXOWNER0000000000000A');
  const machines = [K(3010), K(3011), K(3012)];

  it('the last board’s owner is one round, then the other machines in one more', () => {
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map([[id, [K(3011)]]]),
        machines,
        callable: machines,
      }),
    ).toEqual({
      _tag: 'Ask',
      rounds: [['3011'], ['3010', '3012']],
      uncalled: [],
    });
  });

  it('unrecorded, or recorded on a machine no longer configured: every machine in one round', () => {
    const all = {
      _tag: 'Ask',
      rounds: [['3010', '3011', '3012']],
      uncalled: [],
    };
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map(),
        machines,
        callable: machines,
      }),
    ).toEqual(all);
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map([[id, [K(4000)]]]),
        machines,
        callable: machines,
      }),
    ).toEqual(all);
  });

  it('a recorded clash whose claimants are both still configured is refused at once', () => {
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map([[id, [K(3010), K(3012)]]]),
        machines,
        callable: machines,
      }),
    ).toEqual({ _tag: 'Clashed', machines: ['3010', '3012'] });
  });

  it('a recorded clash with one claimant left is that claimant first', () => {
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map([[id, [K(3010), K(4000)]]]),
        machines,
        callable: machines,
      }),
    ).toEqual({
      _tag: 'Ask',
      rounds: [['3010'], ['3011', '3012']],
      uncalled: [],
    });
  });

  it('a recorded owner that is the only machine is one round', () => {
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map([[id, [K(3010)]]]),
        machines: [K(3010)],
        callable: [K(3010)],
      }),
    ).toEqual({ _tag: 'Ask', rounds: [['3010']], uncalled: [] });
  });

  // A machine that cannot be called is never asked, but its record still
  // decides. It is named as uncalled, so no round
  // that lacks the Inbox can say it does not exist.
  it('a machine that cannot be called is asked in no round', () => {
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map([[id, [K(3011)]]]),
        machines,
        callable: [K(3010), K(3011)],
      }),
    ).toEqual({
      _tag: 'Ask',
      rounds: [['3011'], ['3010']],
      uncalled: ['3012'],
    });
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map(),
        machines,
        callable: [K(3012)],
      }),
    ).toEqual({
      _tag: 'Ask',
      rounds: [['3012']],
      uncalled: ['3010', '3011'],
    });
    // None can be called and none is recorded: no round, and
    // every machine uncalled, never "nowhere to look".
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map(),
        machines,
        callable: [],
      }),
    ).toEqual({ _tag: 'Ask', rounds: [], uncalled: machines });
  });

  it('with no machines, there is nowhere to look', () => {
    expect(
      planInboxOwnerLookup({
        inboxId: id,
        lastOwners: new Map(),
        machines: [],
        callable: [],
      }),
    ).toEqual({ _tag: 'Ask', rounds: [], uncalled: [] });
  });
});

// One Herdr machine named twice, a machine that cannot be called and was never recorded, and two
// reads made against different machines finishing out of order.
describe('claims and the owner lookup while the machines change', () => {
  const X = InboxId.make('01SELFCLASHINBOX0000000000');
  const rows = board([[X, 1]]);
  // The Herdr machine `X`, its id `id-X`, listed as "X-id" on 3011.
  const xOn3011 = entryOf('X-id', 3011, 'id-X');
  // The operator adds `laptop` on 3012 above it, which Herdr resolves to the
  // same machine, so "X-id" is refused as a second selector for it.
  const laptopOn3012 = entryOf('laptop', 3012, 'id-X');
  const xRefused = (
    tag: 'Unusable' | 'HerdrUnread' = 'Unusable',
  ): InboxMachineEntry => ({
    ...uncallableEntry('X-id', 3011, tag),
    resolved: Result.fail({
      _tag: tag,
      herdrMachine: 'X-id',
      port: P(3011),
      reason: '"X-id" names the same Herdr machine as "laptop", already listed',
      ...(tag === 'Unusable'
        ? { sameMachineAs: HerdrMachineId.make('id-X') }
        : {}),
    }),
  });
  const record = (
    before: InboxClaims,
    number: number,
    entries: ReadonlyArray<InboxMachineEntry>,
    key: InboxMachineEntry['key'],
  ) =>
    recordMachineClaims(before, {
      number,
      entries,
      key,
      rows: rows.inboxes,
    });
  const planFor = (
    claims: InboxClaims,
    entries: ReadonlyArray<InboxMachineEntry>,
  ) =>
    planInboxOwnerLookup({
      inboxId: X,
      lastOwners: ownersOfClaims(claims, entries),
      ...ownerLookupMachines(entries),
    });

  it('a second selector for a machine already listed never makes it clash with itself', () => {
    const before = record(NO_INBOX_CLAIMS, 0, [xOn3011], K(3011));
    const now = [laptopOn3012, xRefused()];
    // Before laptop is read, X is asked of laptop, never refused nor unreached.
    expect(planFor(before, now)).toEqual({
      _tag: 'Ask',
      rounds: [['3012']],
      uncalled: [],
    });
    // Once laptop is read, X is laptop's, one claimant.
    const after = record(before, 1, now, K(3012));
    expect(ownersOfClaims(after, now).get(X)).toEqual(['3012']);
    expect(planFor(after, now)).toEqual({
      _tag: 'Ask',
      rounds: [['3012']],
      uncalled: [],
    });
    const merged = mergeInboxBoard(
      board([]),
      [
        reachable('laptop', 3012, rows),
        result('X-id', 3011, unresolvedRead({ _tag: 'Unusable', reason: 'r' })),
      ],
      { claims: heldClaims(after, now) },
    );
    expect(merged.clashes).toEqual([]);
    expect(merged.inboxes.map((i) => [i.inboxId, i.machine?.key])).toEqual([
      [X, '3012'],
    ]);
    // The board read that first reaches laptop, made with the claims recorded
    // before it, is no clash either.
    const first = mergeInboxBoard(
      board([]),
      [
        reachable('laptop', 3012, rows),
        result('X-id', 3011, unresolvedRead({ _tag: 'Unusable', reason: 'r' })),
      ],
      { claims: heldClaims(before, now) },
    );
    expect(first.clashes).toEqual([]);
  });

  it('one Herdr machine’s claims count once, even with Herdr unread', () => {
    // Both entries were recorded as the same Herdr machine: "X-id" by read
    // 1, and `laptop` by read 0, made against `laptop` alone and finishing last,
    // so it pruned nothing. With Herdr down neither resolves, so neither is
    // refused as a second selector, and each names its own selector: the
    // newest read's claims count, and no others.
    const claimed = record(
      record(NO_INBOX_CLAIMS, 1, [xOn3011], K(3011)),
      0,
      [laptopOn3012],
      K(3012),
    );
    const now = [
      uncallableEntry('laptop', 3012, 'HerdrUnread'),
      uncallableEntry('X-id', 3011, 'HerdrUnread'),
    ];
    expect(ownersOfClaims(claimed, now).get(X)).toEqual(['3011']);
    expect(planFor(claimed, now)).toEqual({ _tag: 'Unreached', key: '3011' });
  });

  it('a machine that cannot be called and was never recorded is uncalled, not nowhere', () => {
    // Its selector renamed to one Herdr does not resolve: its claims were
    // the old selector's, so they no longer count.
    const claimed = record(
      NO_INBOX_CLAIMS,
      0,
      [entryOf('laptop', 3010)],
      K(3010),
    );
    const renamed = [uncallableEntry('laptop-typo', 3010)];
    expect(ownersOfClaims(claimed, renamed).get(X)).toBeUndefined();
    expect(planFor(claimed, renamed)).toEqual({
      _tag: 'Ask',
      rounds: [],
      uncalled: ['3010'],
    });
    // A second selector refused for a machine listed is never uncalled: its
    // machine is asked under the entry listed first.
    expect(ownerLookupMachines([laptopOn3012, xRefused()])).toEqual({
      machines: ['3012'],
      callable: ['3012'],
    });
  });

  // A read that started before the newest one, made against
  // machines configured then, drops nothing the newer read recorded.
  it('an older read, made against other machines, finishing last prunes nothing', () => {
    const desktop = entryOf('desktop', 3011);
    const laptop = entryOf('laptop', 3010);
    // Read 1, against laptop and desktop, records laptop claiming X.
    const newer = record(NO_INBOX_CLAIMS, 1, [laptop, desktop], K(3010));
    // Read 0, made while desktop alone was configured, finishes after it.
    const older = record(newer, 0, [desktop], K(3011));
    expect(ownersOfClaims(older, [laptop, desktop]).get(X)).toEqual([
      '3010',
      '3011',
    ]);
  });
});

// The owner lookup's failure policy, all of it in core.
describe('decideInboxOwner', () => {
  const has = (value: string): OwnerAnswer<string, string> => ({
    _tag: 'Has',
    value,
  });
  const lacks: OwnerAnswer<string, string> = { _tag: 'Lacks' };
  const unreached = (value: string): OwnerAnswer<string, string> => ({
    _tag: 'Unreached',
    value,
  });
  const at = (port: number, answer: OwnerAnswer<string, string>) => ({
    key: K(port),
    answer,
  });

  it('one machine has it: that machine owns it, however the rest answered', () => {
    expect(
      decideInboxOwner(
        [at(3010, unreached('down')), at(3011, has('view')), at(3012, lacks)],
        false,
      ),
    ).toEqual({ _tag: 'Owner', key: '3011', value: 'view' });
  });

  it('two machines have it: a clash naming both, and no owner, in any round', () => {
    for (const more of [true, false])
      expect(
        decideInboxOwner(
          [at(3010, has('a')), at(3011, lacks), at(3012, has('b'))],
          more,
        ),
      ).toEqual({ _tag: 'Clash', machines: ['3010', '3012'] });
  });

  it('none has it and one was not reached: that one’s answer, never not found, and no round after', () => {
    for (const more of [true, false])
      expect(
        decideInboxOwner(
          [
            at(3010, lacks),
            at(3011, unreached('first')),
            at(3012, unreached('second')),
          ],
          more,
        ),
      ).toEqual({ _tag: 'Unreached', key: '3011', value: 'first' });
  });

  it('every machine lacks it: ask the next round, or not found after the last', () => {
    expect(decideInboxOwner([at(3010, lacks)], true)).toEqual({
      _tag: 'AskNext',
    });
    expect(decideInboxOwner([at(3010, lacks)], false)).toEqual({
      _tag: 'NotFound',
    });
    expect(decideInboxOwner([], false)).toEqual({ _tag: 'NotFound' });
  });
});
