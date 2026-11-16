import { type ResolvedInboxMachine, tunnelArgs } from '@operator-inbox/core';
import {
  inboxMachineAdvice,
  SERVE_DEFAULT_PORT,
} from '@operator-inbox/core/api';
import {
  Console,
  Data,
  type Duration,
  Effect,
  Result,
  Stream,
  type Stream as StreamType,
} from 'effect';
import { Argument, Command as Cli } from 'effect/cli';
import type { PlatformError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { binConfig } from '../bin-config';
import { InputError } from '../errors';
import {
  findInboxMachineEntry,
  HERDR_LIST_TIMEOUT,
  machinesOffOf,
  readInboxMachines,
} from '../inbox-machine-resolution';

// `operator-inbox tunnel <machine>`: open one Inbox machine's SSH tunnel, from
// its local port in `inboxMachines` to the machine's own serve on
// 127.0.0.1:7184, so Local's serve can merge that machine's Inboxes.
//
// It runs ssh in the FOREGROUND with the terminal's stdio and never
// backgrounds it: the tunnel lives exactly as long as this command, which
// ends when ssh ends (with ssh's exit code) or on Ctrl-C. ssh is spawned in
// the CLI's own process group (`detached: false`), so the terminal's Ctrl-C
// reaches ssh itself, and ssh can ask for a passphrase or a host key on the
// terminal without being stopped as a background job. If the CLI is
// interrupted while ssh still runs, the spawner's release kills it, so no ssh
// is left behind.
//
// A port something already listens on is refused BEFORE ssh runs, naming
// what holds it (`lsof`), since ssh's own refusal ("Address already in use")
// does not say. Without lsof, `ExitOnForwardFailure` still ends ssh at once.

const bins = Effect.all({
  ssh: binConfig('OPERATOR_INBOX_SSH_BIN', 'ssh'),
  lsof: binConfig('OPERATOR_INBOX_LSOF_BIN', 'lsof'),
}).pipe(Effect.orDie);

// ssh ended on its own with a non-zero code. It carries that code, so the
// process exits with it where the runtime can (2–125; `exitCodeOf`).
export class TunnelEnded extends Data.TaggedError('TunnelEnded')<{
  readonly message: string;
  readonly exitCode: number;
}> {}

// The config.json named is the one `loadConfig` read, so a refusal points
// where XDG_CONFIG_HOME does.
const configHint = (configPath: string) =>
  `add it to \`inboxMachines\` in ${configPath}, e.g. \`"inboxMachines": [{ "herdrMachine": "<id or label>", "port": 3010 }]\``;

// The machines' labels, joined with commas, for a refusal.
const labelList = (entries: ReadonlyArray<{ readonly label: string }>) =>
  entries.map((e) => e.label).join(', ');

// The configured machine a selector names, by its selector as configured,
// its section label or its Herdr id, regardless of case
// (`findInboxMachineEntry`). Refused: an `inboxMachines` (or a config.json)
// that cannot be read, with why; no entry, pointing at config.json; a Herdr
// that failed or did not answer within `within`, with Herdr's own advice
// (`inboxMachineAdvice`), since that is no entry's fault, and, when the
// selector is no entry's as configured, that it could not be checked, since
// only Herdr knows the ids and labels it might be; a selector
// two entries answer to, naming each by its label, which names it alone; and
// an entry that names no usable Herdr machine, or whose label is taken, with
// the reason. With the machine comes the path of the config.json it was read
// from, for the refusals after it.
export const findInboxMachine = Effect.fnUntraced(function* (
  selector: string,
  within: Duration.Input = HERDR_LIST_TIMEOUT,
) {
  const read = yield* readInboxMachines(within);
  if (read._tag !== 'Listed')
    return yield* new InputError({
      message: `cannot open the tunnel to "${selector}": ${machinesOffOf(read)}`,
    });
  const { entries, configPath } = read;
  if (entries.length === 0)
    return yield* new InputError({
      message: `"${selector}" is not an Inbox machine: no Inbox machines are configured; ${configHint(configPath)}`,
    });
  const herdrUnread = entries.find(
    (e) =>
      Result.isFailure(e.resolved) && e.resolved.failure._tag === 'HerdrUnread',
  );
  const found = findInboxMachineEntry(entries, selector);
  if (herdrUnread !== undefined && Result.isFailure(herdrUnread.resolved)) {
    const { advice } = inboxMachineAdvice({
      label: herdrUnread.label,
      port: herdrUnread.port,
      reason: 'herdr-unread',
    });
    const unchecked =
      Result.isFailure(found) && found.failure.length === 0
        ? `. So "${selector}" could not be checked: it is no entry's selector in ${configPath} (configured: ${labelList(entries)}), and only Herdr can say whether it is a machine's Herdr id or label`
        : '';
    return yield* new InputError({
      message: `cannot open the tunnel to "${selector}": ${herdrUnread.resolved.failure.reason}. ${advice}${unchecked}`,
    });
  }
  if (Result.isFailure(found)) {
    const matched = found.failure;
    return yield* new InputError({
      message:
        matched.length === 0
          ? `"${selector}" is not an Inbox machine (configured: ${labelList(entries)}); ${configHint(configPath)}`
          : `"${selector}" names more than one Inbox machine: name one by its label, ${labelList(matched)}`,
    });
  }
  const { herdrMachine, resolved } = found.success;
  if (Result.isFailure(resolved))
    return yield* new InputError({
      message: `the inboxMachines entry "${herdrMachine}" in ${configPath} cannot be used: ${resolved.failure.reason}`,
    });
  return { machine: resolved.success, configPath };
});

// One process listening on a port, as lsof names it.
export interface PortHolder {
  readonly command: string;
  readonly pid: number;
}

// The listeners in `lsof -nP -iTCP:<port> -sTCP:LISTEN` listing: a header,
// then one line per open file, COMMAND then PID first. A process listening on
// both 127.0.0.1 and ::1 has two lines, read as one holder.
export const parseLsofListeners = (
  stdout: string,
): ReadonlyArray<PortHolder> => {
  const holders: PortHolder[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const [command, pid] = line.trim().split(/\s+/);
    const n = Number(pid);
    if (command === undefined || command === '' || !Number.isInteger(n))
      continue;
    if (!holders.some((h) => h.pid === n)) holders.push({ command, pid: n });
  }
  return holders;
};

// The refusal for a port already held. An ssh holding it is most likely this
// machine's tunnel, already open, so the sentence says so.
export const portInUseMessage = (
  machine: Pick<ResolvedInboxMachine, 'label' | 'port'>,
  holders: ReadonlyArray<PortHolder>,
  configPath: string,
): string => {
  const named = holders.map((h) => `${h.command} (pid ${h.pid})`).join(', ');
  const tunnelOpen = holders.some((h) => h.command === 'ssh')
    ? ` Is the tunnel to ${machine.label} already open?`
    : '';
  return `port ${machine.port} is already in use by ${named}, so the tunnel to ${machine.label} cannot listen there.${tunnelOpen} Stop it, or give ${machine.label} another port in inboxMachines in ${configPath}`;
};

const collect = (
  stream: StreamType.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

// What listens on `port` on this machine. lsof exits 1 when nothing does; a
// missing lsof reads as nothing found, and ssh's ExitOnForwardFailure is the
// backstop.
export const portHolders = (port: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { lsof } = yield* bins;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const proc = yield* spawner.spawn(
        ChildProcess.make(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
          stdout: 'pipe',
          stderr: 'ignore',
        }),
      );
      const stdout = yield* collect(proc.stdout);
      yield* proc.exitCode;
      return parseLsofListeners(stdout);
    }),
  ).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<PortHolder>>([])));

// ssh in the foreground with the terminal's stdio, in the CLI's own process
// group, until it ends. Its exit code; a signal death is reported as such.
const runSsh = (machine: ResolvedInboxMachine) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { ssh } = yield* bins;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const proc = yield* spawner
        .spawn(
          ChildProcess.make(ssh, tunnelArgs(machine, machine.port), {
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
            detached: false,
          }),
        )
        .pipe(
          Effect.mapError(
            (e) =>
              new InputError({
                message: `could not run '${ssh}': ${e.message} (is it installed and on PATH?)`,
              }),
          ),
        );
      return yield* proc.exitCode.pipe(
        Effect.mapError(
          () =>
            new InputError({
              message: `ssh to ${machine.label} ended without an exit code (killed by a signal)`,
            }),
        ),
      );
    }),
  );

// The whole command, for the CLI and for the tests: find the machine, waiting
// at most `within` for Herdr, refuse a held port, then hold the tunnel open
// until ssh ends.
export const openTunnel = Effect.fnUntraced(function* (
  selector: string,
  within: Duration.Input = HERDR_LIST_TIMEOUT,
) {
  const { machine, configPath } = yield* findInboxMachine(selector, within);
  const holders = yield* portHolders(machine.port);
  if (holders.length > 0)
    return yield* new InputError({
      message: portInUseMessage(machine, holders, configPath),
    });
  yield* Console.error(
    `tunnel to ${machine.label}: 127.0.0.1:${machine.port} → ${machine.target}'s 127.0.0.1:${SERVE_DEFAULT_PORT} (Ctrl-C closes it)`,
  );
  const code = yield* runSsh(machine);
  if (code !== 0)
    return yield* new TunnelEnded({
      message: `ssh to ${machine.label} ended with exit code ${code}`,
      exitCode: code,
    });
});

export const machineTunnelCommand = Cli.make(
  'tunnel',
  {
    machine: Argument.String('machine').pipe(
      Argument.withDescription(
        'An Inbox machine: its Herdr id or label, as in inboxMachines',
      ),
    ),
  },
  // Scoped: a Herdr given up on, or one Ctrl-C stops tunnel waiting on, is
  // ended before tunnel exits (`readInboxMachines`).
  ({ machine }) => Effect.scoped(openTunnel(machine)),
).pipe(
  Cli.withDescription(
    "Open one Inbox machine's SSH tunnel in the foreground, so the local app shows its Inboxes; Ctrl-C closes it",
  ),
);
