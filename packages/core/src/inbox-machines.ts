import { Result } from 'effect';
import { SERVE_DEFAULT_PORT } from './api/api';
import {
  type InboxBoardDto,
  type InboxClashDto,
  type InboxIncompatibleReason,
  type InboxIndexDto,
  type InboxMachineRef,
  type InboxMachineStatusDto,
  type InboxSummaryDto,
  type InboxUnreachableReason,
  type InboxViewDto,
  inboxMachineKey,
  LOCAL_MACHINE,
  LOCAL_MACHINE_KEY,
} from './api/inbox-api';
import type { InboxMachine } from './config';
import {
  findMachine,
  type HerdrMachine,
  renderMachineRejection,
} from './machines';
import { renderedQuestionBody } from './question-markdown';
import type {
  InboxId,
  InboxMachineKey,
  InboxMachinePort,
} from './schema/identifiers';

// Inbox machines: Local's serve merges the Inboxes of each Herdr
// machine in `inboxMachines` when the inbox is read, reaching each through an
// SSH tunnel from a local port to the machine's own serve. Everything here is
// pure — resolving the configured machines against Herdr's profiles, the ssh
// argv of a tunnel, the merge of what each machine answered, and the order in
// which to look for the machine that owns an Inbox. The CLI edge
// (`apps/cli/src/inbox-machine-client.ts`) makes the calls around them.

// The `Host` every call to a machine names: the machine's serve binds
// SERVE_DEFAULT_PORT and its Host guard answers 421 to any other
// authority, whichever local port the tunnel listens on.
export const INBOX_MACHINE_HOST = `127.0.0.1:${SERVE_DEFAULT_PORT}`;

// A configured machine resolved against `herdr machine list --json`: its
// label and SSH target are the Herdr profile's, and `herdrId` its id, so the
// machine can be named by either whichever the entry used. `herdrMachine` is
// the selector as configured.
export interface ResolvedInboxMachine {
  readonly herdrMachine: string;
  readonly herdrId: HerdrMachine['id'];
  readonly label: string;
  readonly port: InboxMachinePort;
  readonly target: string;
}

// A configured machine that names no usable Herdr profile, and why, in
// `reason`, a sentence. `Unusable`: its entry's fault, being `findMachine`'s
// refusal, a second selector naming a machine already listed, or a label
// another machine (or Local) already has. `HerdrUnread`: Herdr's own failure
// or timeout, which left every entry unresolved through no fault of its own.
// The tag is required, so no reader can drop which it is. `sameMachineAs`
// is set on a second selector naming a machine already listed: the id of
// that Herdr machine, which an earlier entry resolved to and is read under,
// so this entry can hold nothing that one does not.
export interface UnresolvedInboxMachine {
  readonly _tag: 'Unusable' | 'HerdrUnread';
  readonly herdrMachine: string;
  readonly port: InboxMachinePort;
  readonly reason: string;
  readonly sameMachineAs?: HerdrMachine['id'];
}

// Each configured machine in its configured order, resolved or refused on
// its own: one bad selector never hides the others. Two selectors naming the
// same profile (its id and its label) are one machine read twice, so the
// second is refused. A machine is keyed by its port (`InboxMachineKey`), but
// its label is what the operator reads on its section and in a
// refusal, and Herdr does not keep labels unique, so a label an earlier
// machine already has is refused too, as is
// Local's own section name; both compared regardless of case.
export const resolveInboxMachines = (
  configured: ReadonlyArray<InboxMachine>,
  herdr: ReadonlyArray<HerdrMachine>,
): ReadonlyArray<
  Result.Result<ResolvedInboxMachine, UnresolvedInboxMachine>
> => {
  const seen = new Map<string, string>();
  // Each label taken so far, lower-cased, to the selector that took it;
  // `null` for Local's.
  const labels = new Map<string, string | null>([
    [LOCAL_MACHINE.toLowerCase(), null],
  ]);
  return configured.map(({ herdrMachine, port }) => {
    const found = findMachine(herdr, herdrMachine);
    if (Result.isFailure(found))
      return Result.fail({
        _tag: 'Unusable',
        herdrMachine,
        port,
        reason: renderMachineRejection(found.failure),
      });
    const m = found.success;
    const earlier = seen.get(m.id);
    if (earlier !== undefined)
      return Result.fail({
        _tag: 'Unusable',
        herdrMachine,
        port,
        reason: `"${herdrMachine}" names the same Herdr machine as "${earlier}", already listed`,
        sameMachineAs: m.id,
      });
    const taken = labels.get(m.label.toLowerCase());
    if (taken !== undefined)
      return Result.fail({
        _tag: 'Unusable',
        herdrMachine,
        port,
        reason:
          taken === null
            ? `"${herdrMachine}" is the Herdr machine labelled "${m.label}", the name the app gives Local: relabel it in Herdr`
            : `"${herdrMachine}" is the Herdr machine labelled "${m.label}", the label of "${taken}", already listed: Herdr labels can repeat, but each Inbox machine needs a label of its own, so relabel one in Herdr`,
      });
    seen.set(m.id, herdrMachine);
    labels.set(m.label.toLowerCase(), herdrMachine);
    return Result.succeed({
      herdrMachine,
      herdrId: m.id,
      label: m.label,
      port,
      target: m.target,
    });
  });
};

// The sidebar section label of each configured machine, in order. No two
// sections may read alike, so every label is unique regardless of case, and
// none is Local's; a section is keyed by its port
// all the same, never by this. A resolved machine has its Herdr label, which
// `resolveInboxMachines` already kept unique. A machine that names no usable
// Herdr profile has no label from Herdr, so it takes its selector, unless
// that is already a section's label (a resolved machine's, another entry's,
// or Local's): then its selector and its tunnel port, `laptop:3011`, ports
// being unique in the config, and a count after that should even that be
// taken.
export const inboxMachineLabels = (
  results: ReadonlyArray<
    Result.Result<ResolvedInboxMachine, UnresolvedInboxMachine>
  >,
): ReadonlyArray<string> => {
  const taken = new Set<string>([LOCAL_MACHINE.toLowerCase()]);
  for (const r of results)
    if (Result.isSuccess(r)) taken.add(r.success.label.toLowerCase());
  return results.map((r) => {
    if (Result.isSuccess(r)) return r.success.label;
    const { herdrMachine, port } = r.failure;
    const candidate = (n: number): string =>
      n === 0
        ? herdrMachine
        : n === 1
          ? `${herdrMachine}:${port}`
          : `${herdrMachine}:${port} (${n})`;
    let n = 0;
    while (taken.has(candidate(n).toLowerCase())) n += 1;
    const label = candidate(n);
    taken.add(label.toLowerCase());
    return label;
  });
};

// A configured machine as every command sees it (serve, tunnel): its
// key and section label, its tunnel port, and how it resolved against
// Herdr's profiles. A machine names itself by `key`, never by `label`.
export interface InboxMachineName {
  readonly key: InboxMachineKey;
  readonly label: string;
  readonly port: InboxMachinePort;
  // The selector as configured (`inboxMachines`' `herdrMachine`), which a
  // config error names.
  readonly herdrMachine: string;
}

export interface InboxMachineEntry extends InboxMachineName {
  readonly resolved: Result.Result<
    ResolvedInboxMachine,
    UnresolvedInboxMachine
  >;
}

// The configured machines against Herdr's profiles, or against the sentence
// saying Herdr could not be read, in which case every machine is unresolved
// with it. Each takes its label from `inboxMachineLabels` and its key from
// its port. The one resolution serve and tunnel both take, so none
// writes its own "Herdr failed, so every entry fails" mapping.
export const inboxMachineEntries = (
  configured: ReadonlyArray<InboxMachine>,
  herdr: Result.Result<ReadonlyArray<HerdrMachine>, string>,
): ReadonlyArray<InboxMachineEntry> => {
  const results = Result.isFailure(herdr)
    ? configured.map(({ herdrMachine, port }) =>
        Result.fail<UnresolvedInboxMachine>({
          _tag: 'HerdrUnread',
          herdrMachine,
          port,
          reason: herdr.failure,
        }),
      )
    : resolveInboxMachines(configured, herdr.success);
  const labels = inboxMachineLabels(results);
  return results.map((resolved, i) => {
    const { herdrMachine, port } = Result.isSuccess(resolved)
      ? resolved.success
      : resolved.failure;
    return {
      key: inboxMachineKey(port),
      label: labels[i] ?? herdrMachine,
      port,
      herdrMachine,
      resolved,
    };
  });
};

// What reading `inboxMachines` came to, as every command reads it (apart
// from the rest of config.json), `Listed`
// carrying what that command made of the machines (`L`).
// - `Unreadable`: config.json itself did not load, so nothing in it is read.
//   `problem` is the sentence saying why, naming the file.
// - `Invalid`: config.json loaded, but its `inboxMachines` did not decode
//   (`problem`, in `describeConfigFailure`'s clause form). No machine is read.
// - `Listed`: the machines configured, none being an empty list.
// `configPath` is the config.json read, which a refusal or a fix names.
export type InboxMachinesReadOf<L> =
  | { readonly _tag: 'Unreadable'; readonly problem: string }
  | {
      readonly _tag: 'Invalid';
      readonly configPath: string;
      readonly problem: string;
    }
  | ({ readonly _tag: 'Listed'; readonly configPath: string } & L);

// The `InboxMachineRef` the wire carries for a machine.
export const machineRef = (
  m: Pick<InboxMachineName, 'key' | 'label'>,
): InboxMachineRef => ({ key: m.key, label: m.label });

// The argv of `ssh` for one machine's tunnel: no remote command, a refused
// forward ends ssh rather than leaving it up and useless, a keep-alive so a
// dropped link is noticed, and the local port forwarded to the machine's own
// serve. The local end names 127.0.0.1, so it listens on loopback whatever
// `GatewayPorts` says: the tunnel is loopback at both ends. The
// target is the Herdr profile's, so ssh reaches the machine as Herdr does,
// after `--`, so a target beginning `-` is never read as an option.
export const tunnelArgs = (
  machine: Pick<HerdrMachine, 'target'>,
  port: number,
): ReadonlyArray<string> => [
  '-N',
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'ServerAliveInterval=30',
  '-L',
  `127.0.0.1:${port}:${INBOX_MACHINE_HOST}`,
  '--',
  machine.target,
];

// A machine's text (a refusal's or an error's message) made safe to print:
// every escape sequence (CSI, OSC and the rest) and every other control
// character (C0, DEL, C1) removed, a tab or line break becoming a space. A
// machine's words reach the terminal and the page's details, and a
// machine is whatever holds its tunnel port, so none of it may set a
// terminal's title, clear its screen or paint a false tick.
//
// Each pattern is a control character's: removing them is the point, so the
// lint against control characters in a regex is set aside for each.
// CSI: ESC [ (or the 8-bit CSI), parameters, intermediates, a final byte.
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// OSC, DCS, SOS, PM, APC: up to BEL or ST, or to the end when unended.
const STRING_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: see above
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g;
// Any other escape: ESC and the byte after it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above
const OTHER_ESCAPE = /\u001b[\s\S]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: see above
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export const machineText = (text: string): string =>
  text
    .replace(CSI, '')
    .replace(STRING_SEQUENCE, '')
    .replace(OTHER_ESCAPE, '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(CONTROL, '');

// What one call to a machine came to. `reachable` carries what it answered;
// `unreachable` (nothing answered, or its inbox store was down) and
// `incompatible` (an answer that did not decode) carry which (`reason`) and
// the sentence saying so (`detail`).
export type MachineCallRead<A> =
  | { readonly status: 'reachable'; readonly value: A }
  | {
      readonly status: 'unreachable';
      readonly reason: Exclude<InboxUnreachableReason, NeverCalled>;
      readonly detail: string;
    }
  | {
      readonly status: 'incompatible';
      readonly reason: InboxIncompatibleReason;
      readonly detail: string;
    };

// The reasons a machine was never called.
type NeverCalled = 'unresolved' | 'herdr-unread';

// What serve's read of one machine came to: its call's, or a machine never
// called, with the sentence saying why: `herdr-unread` when Herdr could not
// be read, otherwise `unresolved` (its entry names no usable Herdr machine,
// its Herdr label is another machine's or Local's, or a re-read found it on
// serve's own port).
export interface NeverCalledRead {
  readonly status: 'unreachable';
  readonly reason: Extract<InboxUnreachableReason, NeverCalled>;
  readonly detail: string;
}
export type MachineRead<A> = MachineCallRead<A> | NeverCalledRead;

// The read of an entry never called, with its reason.
export const unresolvedRead = (
  unresolved: Pick<UnresolvedInboxMachine, '_tag' | 'reason'>,
): NeverCalledRead => ({
  status: 'unreachable',
  reason: unresolved._tag === 'HerdrUnread' ? 'herdr-unread' : 'unresolved',
  detail: unresolved.reason,
});

// One machine's read, named by its key, label and tunnel port.
export interface MachineResult<A> extends InboxMachineName {
  readonly read: MachineRead<A>;
}

// A machine's OWN rows: those it sent with no `machine`. A machine's serve
// may merge Inbox machines of its own; Local merges one level, so what that
// machine merged (its rows with `machine` set) is never passed on, nor
// counted. Local asks a machine for its own Inboxes only (`local=true`), and
// this holds however the machine answered that.
const ownOf = <T extends { readonly machine?: InboxMachineRef }>(
  rows: ReadonlyArray<T>,
): ReadonlyArray<T> => rows.filter((r) => r.machine === undefined);

// The waiting count of some rows' active, unmuted Inboxes, as Local's total
// counts Local's.
const activeAwaiting = (rows: ReadonlyArray<InboxSummaryDto>): number =>
  rows
    .filter((s) => !s.archived && s.muted !== true)
    .reduce((n, s) => n + s.awaitingOperator, 0);

// A question with its body rendered by Local, from its raw `body`: the
// `bodyHtml` and `bodyParts` the machine sent are discarded, never passed on.
const renderedOnLocal = <
  Q extends {
    readonly body: string;
    readonly bodyHtml: string;
    readonly bodyParts?: InboxViewDto['awaitingOperator'][number]['bodyParts'];
  },
>(
  q: Q,
): Q => ({ ...q, ...renderedQuestionBody(q.body) });

// A machine's view as Local passes it to the page: tagged with the
// machine, and every question's body rendered again here. The page renders
// `bodyHtml` and each html part as HTML, on the promise that Local's own
// escaping renderers made it (`RenderedBody`, apps/web). A machine is
// another serve, reached through a port anything may hold, so Local never
// forwards HTML it did not render: the board's merge and every forwarded
// call (`forwardInboxCall`, apps/cli) pass a machine's view through here.
export const machineView = (
  v: InboxViewDto,
  machine: InboxMachineRef,
): InboxViewDto => ({
  ...v,
  awaitingOperator: v.awaitingOperator.map(renderedOnLocal),
  awaitingAgent: v.awaitingAgent.map(renderedOnLocal),
  processed: v.processed.map(renderedOnLocal),
  machine,
});

// What Local's serve builds for its own page: the merged index or board,
// with every machine field filled (`machines` with Local first, `clashes`,
// and `machinesOff` when `inboxMachines` could not be read). Local's own
// part comes in without them.
export type LocalInboxIndex = Omit<
  InboxIndexDto,
  'machines' | 'clashes' | 'machinesOff'
>;
export type LocalInboxBoard = Omit<
  InboxBoardDto,
  'machines' | 'clashes' | 'machinesOff'
>;
export type MergedInboxIndex = LocalInboxIndex & {
  readonly machines: ReadonlyArray<InboxMachineStatusDto>;
  readonly clashes: ReadonlyArray<InboxClashDto>;
  readonly machinesOff?: string;
};
export type MergedInboxBoard = LocalInboxBoard & MergedInboxIndex;

// What the merge is given beside the reads.
// - `machinesOff`: when `inboxMachines` (or config.json) could not be read,
//   the sentence for the page's banner. Serve then reads no machine at
//   start-up, or keeps those it read before on a re-read, and its sentence
//   says which; the merge passes it on as given.
// - `claims`: what each machine claims as serve last recorded it, those
//   that still count (`heldClaims`). A machine this read did not reach still
//   claims what it last had, so an id it shares with a machine this read did
//   reach is refused as a clash, not passed on as the other's.
export interface MergeOptions {
  readonly machinesOff?: string;
  readonly claims?: InboxClaims;
}

// A machine that could not be read, as its section's status.
const unreadStatus = (
  { key, label, port }: Omit<InboxMachineName, 'herdrMachine'>,
  read: Exclude<MachineRead<unknown>, { readonly status: 'reachable' }>,
): InboxMachineStatusDto =>
  read.status === 'unreachable'
    ? {
        status: 'unreachable',
        key,
        label,
        port,
        reason: read.reason,
        detail: read.detail,
      }
    : {
        status: 'incompatible',
        key,
        label,
        port,
        reason: read.reason,
        detail: read.detail,
      };

// The merge of the rows, which the index and the board share. Each reachable
// machine's own rows (`ownOf`), the first of any id it sends twice, are
// claims, and so is what a machine this read did not reach last claimed
// (`MergeOptions.claims`) of an id a reachable machine sent; an id with two
// claims is a clash (`InboxClashDto`): refused when two Inbox
// machines claim it, so no row is passed on, and kept on Local when Local's
// own log has it, so only Local's is. Every other claim is passed on tagged
// with its machine. `kept` is, per machine key, the ids passed on, which the
// board's views follow.
const mergeRows = (
  local: LocalInboxIndex,
  results: ReadonlyArray<MachineResult<Pick<InboxIndexDto, 'inboxes'>>>,
  options: MergeOptions,
) => {
  const localRows = new Map(local.inboxes.map((s) => [s.inboxId, s]));
  const sent = new Map<InboxMachineKey, ReadonlyArray<InboxSummaryDto>>();
  for (const { key, read } of results)
    if (read.status === 'reachable') {
      const mine = new Set<InboxId>();
      sent.set(
        key,
        ownOf(read.value.inboxes).filter((row) => {
          if (mine.has(row.inboxId)) return false;
          mine.add(row.inboxId);
          return true;
        }),
      );
    }
  const sentIds = new Set(
    [...sent.values()].flatMap((rows) => rows.map((r) => r.inboxId)),
  );
  // Each id's claims in configured order; `row` only on a reachable one.
  const claims = new Map<
    InboxId,
    Array<{
      readonly machine: InboxMachineRef;
      readonly label: string;
      readonly row?: InboxSummaryDto;
    }>
  >();
  const claim = (
    inboxId: InboxId,
    c: { machine: InboxMachineRef; label: string; row?: InboxSummaryDto },
  ) => {
    const claimed = claims.get(inboxId) ?? [];
    claimed.push(c);
    claims.set(inboxId, claimed);
  };
  for (const { key, label, read } of results) {
    const machine = { key, label };
    if (read.status === 'reachable') {
      for (const row of sent.get(key) ?? [])
        claim(row.inboxId, { machine, label: row.label, row });
      continue;
    }
    for (const [inboxId, claimedLabel] of options.claims?.byMachine.get(key)
      ?.ids ?? [])
      if (sentIds.has(inboxId) && !localRows.has(inboxId))
        claim(inboxId, { machine, label: claimedLabel });
  }
  const clashes: Array<InboxClashDto> = [];
  const passed = new Map<InboxMachineKey, Array<InboxSummaryDto>>();
  for (const [inboxId, claimed] of claims) {
    const onLocal = localRows.get(inboxId);
    if (onLocal !== undefined || claimed.length > 1) {
      clashes.push({
        inboxId,
        outcome: onLocal === undefined ? 'refused' : 'kept-on-local',
        claims: [
          ...(onLocal === undefined
            ? []
            : [
                {
                  machine: { key: LOCAL_MACHINE_KEY, label: LOCAL_MACHINE },
                  label: onLocal.label,
                },
              ]),
          ...claimed.map(({ machine, label }) => ({ machine, label })),
        ],
      });
      continue;
    }
    for (const { machine, row } of claimed) {
      if (row === undefined) continue;
      const rows = passed.get(machine.key) ?? [];
      rows.push({ ...row, machine });
      passed.set(machine.key, rows);
    }
  }
  const inboxes: Array<InboxSummaryDto> = [...local.inboxes];
  let total = local.totalAwaitingOperator;
  const machines: Array<InboxMachineStatusDto> = [
    {
      status: 'local',
      key: LOCAL_MACHINE_KEY,
      label: LOCAL_MACHINE,
      awaitingOperator: local.totalAwaitingOperator,
    },
  ];
  const kept = new Map<InboxMachineKey, ReadonlySet<InboxId>>();
  for (const { key, label, port, read } of results) {
    if (read.status !== 'reachable') {
      machines.push(unreadStatus({ key, label, port }, read));
      continue;
    }
    // A machine's rows in the order it sent them, as `claims` met them.
    const rows = passed.get(key) ?? [];
    inboxes.push(...rows);
    const awaitingOperator = activeAwaiting(rows);
    total += awaitingOperator;
    kept.set(key, new Set(rows.map((r) => r.inboxId)));
    machines.push({ status: 'reachable', key, label, port, awaitingOperator });
  }
  const index: MergedInboxIndex = {
    inboxes,
    totalAwaitingOperator: total,
    machines,
    clashes,
    ...(options.machinesOff === undefined
      ? {}
      : { machinesOff: options.machinesOff }),
  };
  return { index, kept };
};

// Local's Inboxes first, as Local's serve built them, then each reachable
// machine's own (`ownOf`) in the configured order, each tagged with its
// machine, an id two machines claim left out and reported in `clashes`. A
// machine's own `machines` list is dropped, and so is anything it merged:
// Local merges one level, never a machine's merge. `machines` lists Local
// first, with its own total, then every configured machine in order; the
// total adds every reachable machine's own waiting count, over the rows
// passed on, to Local's.
export const mergeInboxIndex = (
  local: LocalInboxIndex,
  results: ReadonlyArray<MachineResult<Pick<InboxIndexDto, 'inboxes'>>>,
  options: MergeOptions = {},
): MergedInboxIndex => mergeRows(local, results, options).index;

// The board's merge: the index's, with each reachable machine's own views
// appended in its order, each through `machineView`: only the view of an
// Inbox whose row was passed on (a view a machine sends for an Inbox it did
// not list, or for a clash, is dropped), and the first of an id sent twice.
export const mergeInboxBoard = (
  local: LocalInboxBoard,
  results: ReadonlyArray<
    MachineResult<Pick<InboxBoardDto, 'inboxes' | 'views'>>
  >,
  options: MergeOptions = {},
): MergedInboxBoard => {
  const { index, kept } = mergeRows(local, results, options);
  const views: Array<InboxViewDto> = [...local.views];
  for (const { key, label, read } of results) {
    if (read.status !== 'reachable') continue;
    const passed = kept.get(key) ?? new Set();
    const mine = new Set<InboxId>();
    for (const v of ownOf(read.value.views)) {
      if (!passed.has(v.inboxId) || mine.has(v.inboxId)) continue;
      mine.add(v.inboxId);
      views.push(machineView(v, { key, label }));
    }
  }
  return { ...index, views };
};

// --- the owner of an Inbox ---------------------------------------------------------

// The machines each Inbox lives on, for the owner lookup's second rung: one
// key for an Inbox one machine claims, every claimant's, in section order,
// for a clash.
export type InboxOwners = ReadonlyMap<InboxId, ReadonlyArray<InboxMachineKey>>;

// What one Inbox machine claims, as serve last saw it: the Inbox ids it had
// on the newest read that reached it (`read`, the number that read took as
// it started), each with the label the machine gave its Inbox, and which
// machine that was: its entry's selector and the Herdr machine it resolved
// to. A machine is keyed by its tunnel port, and another machine may take
// that port, so its claims count only while the entry on that port is still
// that machine (`heldClaims`).
export interface MachineClaims {
  readonly read: number;
  readonly herdrMachine: string;
  readonly herdrId: ResolvedInboxMachine['herdrId'];
  readonly ids: ReadonlyMap<InboxId, string>;
}

// What each Inbox machine claims, per machine key. A read that does not
// reach a machine leaves its claims as they were, so a machine that misses a
// read, or alternates between answering and not, or cannot be called at
// all, still claims what it last had: an id it shares with another machine
// stays a clash while either is unreached, and an id two
// machines claimed on different reads is one too.
export interface InboxClaims {
  readonly byMachine: ReadonlyMap<InboxMachineKey, MachineClaims>;
}

export const NO_INBOX_CLAIMS: InboxClaims = { byMachine: new Map() };

// Whether the claims recorded on an entry's port are that entry's machine's:
// the same Herdr machine, when the entry resolves now; the same selector,
// when it does not, since an entry Herdr cannot resolve now (its profile
// gone, its label taken, Herdr down) still names the machine it named. A
// second selector for a machine already listed (`sameMachineAs`) holds
// none: that machine is read, and claims, under the entry listed first.
const claimsOfEntry = (
  claims: MachineClaims,
  entry: InboxMachineEntry,
): boolean =>
  Result.isSuccess(entry.resolved)
    ? entry.resolved.success.herdrId === claims.herdrId
    : entry.resolved.failure.sameMachineAs === undefined &&
      entry.herdrMachine === claims.herdrMachine;

// The claims that count against the machines configured now (`entries`):
// each configured machine's own, whether or not it can be called, and none
// of a port no longer configured or that another machine now holds. One
// Herdr machine's claims count once (a second selector for a machine
// already listed must never make it clash with itself): on the
// entry that resolves to it now, when one does, otherwise on the entry whose
// claims are the newest read's, the first in section order on a tie.
export const heldClaims = (
  claims: InboxClaims,
  entries: ReadonlyArray<InboxMachineEntry>,
): InboxClaims => {
  const held = entries.flatMap((entry) => {
    const c = claims.byMachine.get(entry.key);
    return c !== undefined && claimsOfEntry(c, entry) ? [{ entry, c }] : [];
  });
  const counts = ({ entry, c }: (typeof held)[number], i: number): boolean => {
    if (Result.isSuccess(entry.resolved)) return true;
    return held.every(
      (other, j) =>
        j === i ||
        other.c.herdrId !== c.herdrId ||
        (Result.isFailure(other.entry.resolved) &&
          (other.c.read < c.read || (other.c.read === c.read && j > i))),
    );
  };
  return {
    byMachine: new Map(
      held.filter(counts).map(({ entry, c }) => [entry.key, c] as const),
    ),
  };
};

// One machine's claims, recorded as soon as its read completes, so a read
// the page gives up on still records each machine it reached: its own rows
// (`ownOf`), the first of an id sent twice. A machine keeps the claims of
// the newest read to reach it, so a read that started before the one that
// recorded a machine's claims leaves them alone, however late it finishes.
// A read no newer read has recorded before drops what the
// machines configured for it no longer hold (`heldClaims`). `entries` are
// the machines that read was made against; one not resolved among them
// records nothing.
export const recordMachineClaims = (
  before: InboxClaims,
  read: {
    readonly number: number;
    readonly entries: ReadonlyArray<InboxMachineEntry>;
    readonly key: InboxMachineKey;
    readonly rows: ReadonlyArray<InboxSummaryDto>;
  },
): InboxClaims => {
  const entry = read.entries.find((e) => e.key === read.key);
  if (entry === undefined || Result.isFailure(entry.resolved)) return before;
  const newest = [...before.byMachine.values()].every(
    (c) => c.read <= read.number,
  );
  const byMachine = new Map(
    (newest ? heldClaims(before, read.entries) : before).byMachine,
  );
  const last = byMachine.get(read.key);
  if (last !== undefined && last.read > read.number) return { byMachine };
  const ids = new Map<InboxId, string>();
  for (const row of ownOf(read.rows))
    if (!ids.has(row.inboxId)) ids.set(row.inboxId, row.label);
  byMachine.set(read.key, {
    read: read.number,
    herdrMachine: entry.herdrMachine,
    herdrId: entry.resolved.success.herdrId,
    ids,
  });
  return { byMachine };
};

// The owners the claims make against the machines configured now: each id
// with every machine whose claims still count claiming it, in section
// order.
export const ownersOfClaims = (
  claims: InboxClaims,
  entries: ReadonlyArray<InboxMachineEntry>,
): InboxOwners => {
  const held = heldClaims(claims, entries).byMachine;
  const owners = new Map<InboxId, Array<InboxMachineKey>>();
  for (const { key } of entries)
    for (const id of held.get(key)?.ids.keys() ?? []) {
      const keys = owners.get(id) ?? [];
      keys.push(key);
      owners.set(id, keys);
    }
  return owners;
};

// Where to look for the Inbox machine that owns an Inbox Local's log does
// not have (the caller asks Local's log first, and stops there when it has
// it: an Inbox id is a ULID and belongs to one machine). `Clashed`: two of
// the machines still configured claim it (`ownersOfClaims`), so it is
// refused at once and nothing is sent to either, whether or not either can
// be called. `Unreached`: the one machine recorded as claiming it cannot be
// called, so it is answered for as unreachable, never as not found.
// `Ask`: rounds of machines, each round asked AT ONCE (never one after
// another, so a machine that hangs costs one timeout, not one each), and
// each round's answers given to `decideInboxOwner`: first the machine
// recorded as claiming it, then every other machine that can be called, in
// order; no record, every one of them in one round. No machine to call is
// no round at all. `uncalled` are the machines that cannot be called and
// so are never asked: while any is configured, no round's "lacks it" can
// say the Inbox does not exist, since one of them may hold it, so the caller answers for them as unreachable instead of not found.
export type InboxOwnerPlan =
  | {
      readonly _tag: 'Clashed';
      readonly machines: ReadonlyArray<InboxMachineKey>;
    }
  | { readonly _tag: 'Unreached'; readonly key: InboxMachineKey }
  | {
      readonly _tag: 'Ask';
      readonly rounds: ReadonlyArray<ReadonlyArray<InboxMachineKey>>;
      readonly uncalled: ReadonlyArray<InboxMachineKey>;
    };

// The machines the owner lookup plans over (`planInboxOwnerLookup`), from
// the entries configured now, in section order: every machine that could
// hold an Inbox, and those of them that can be called (resolved). An entry
// refused as a second selector for a machine already listed
// (`sameMachineAs`) is left out: its machine is read, and asked, under the
// entry that resolved to it, so it holds nothing of its own.
export const ownerLookupMachines = (
  entries: ReadonlyArray<InboxMachineEntry>,
): {
  readonly machines: ReadonlyArray<InboxMachineKey>;
  readonly callable: ReadonlyArray<InboxMachineKey>;
} => ({
  machines: entries.flatMap((e) =>
    Result.isFailure(e.resolved) &&
    e.resolved.failure.sameMachineAs !== undefined
      ? []
      : [e.key],
  ),
  callable: entries.flatMap((e) =>
    Result.isSuccess(e.resolved) ? [e.key] : [],
  ),
});

export const planInboxOwnerLookup = (input: {
  readonly inboxId: InboxId;
  readonly lastOwners: InboxOwners;
  // Every machine that could hold an Inbox, in the configured order
  // (`ownerLookupMachines`).
  readonly machines: ReadonlyArray<InboxMachineKey>;
  // Those of them that can be called (resolved).
  readonly callable: ReadonlyArray<InboxMachineKey>;
}): InboxOwnerPlan => {
  const recorded = (input.lastOwners.get(input.inboxId) ?? []).filter((k) =>
    input.machines.includes(k),
  );
  if (recorded.length > 1) return { _tag: 'Clashed', machines: recorded };
  const [owner] = recorded;
  if (owner !== undefined && !input.callable.includes(owner))
    return { _tag: 'Unreached', key: owner };
  const rest = input.callable.filter((k) => !recorded.includes(k));
  return {
    _tag: 'Ask',
    rounds: [recorded, rest].filter((round) => round.length > 0),
    uncalled: input.machines.filter((k) => !input.callable.includes(k)),
  };
};

// How one machine answered a round's ask. `Has`: it has the Inbox, and
// `value` is its answer (a view, or a refusal other than InboxNotFound,
// which only the owner can give). `Lacks`: InboxNotFound. `Unreached`: it
// could not be asked (InboxUnavailable: its tunnel, its serve or its store),
// so it may yet be the owner.
export type OwnerAnswer<H, U> =
  | { readonly _tag: 'Has'; readonly value: H }
  | { readonly _tag: 'Lacks' }
  | { readonly _tag: 'Unreached'; readonly value: U };

// What a round's answers come to, the whole failure policy in one place:
// - two or more `Has`: `Clash`, refused, and nothing is sent to either;
// - one `Has`: `Owner`, that machine, however the rest answered;
// - none, and one or more `Unreached`: `Unreached`, the first in order's
//   answer, never InboxNotFound, since that machine may own it; the round
//   after is not asked, so the machine recorded as claiming it is answered
//   for outright, reachable or not;
// - none, every machine `Lacks`: `AskNext` while a round is left (`more`),
//   otherwise `NotFound`.
export type InboxOwnerDecision<H, U> =
  | { readonly _tag: 'Owner'; readonly key: InboxMachineKey; readonly value: H }
  | {
      readonly _tag: 'Clash';
      readonly machines: ReadonlyArray<InboxMachineKey>;
    }
  | {
      readonly _tag: 'Unreached';
      readonly key: InboxMachineKey;
      readonly value: U;
    }
  | { readonly _tag: 'AskNext' }
  | { readonly _tag: 'NotFound' };

export const decideInboxOwner = <H, U>(
  answers: ReadonlyArray<{
    readonly key: InboxMachineKey;
    readonly answer: OwnerAnswer<H, U>;
  }>,
  more: boolean,
): InboxOwnerDecision<H, U> => {
  const has = answers.flatMap(({ key, answer }) =>
    answer._tag === 'Has' ? [{ key, value: answer.value }] : [],
  );
  const [owner, second] = has;
  if (owner !== undefined && second !== undefined)
    return { _tag: 'Clash', machines: has.map((h) => h.key) };
  if (owner !== undefined) return { _tag: 'Owner', ...owner };
  for (const { key, answer } of answers)
    if (answer._tag === 'Unreached')
      return { _tag: 'Unreached', key, value: answer.value };
  return more ? { _tag: 'AskNext' } : { _tag: 'NotFound' };
};
