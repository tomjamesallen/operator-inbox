import path from 'node:path';
import {
  loadConfig,
  loadMetadataRules,
  type ServeTailnet,
} from '@operator-inbox/core';
import {
  inboxMachineAdvice,
  SERVE_DEFAULT_PORT,
} from '@operator-inbox/core/api';
import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { HttpServer } from 'effect/http';
import { InputError } from '../errors';
import {
  type InboxMachinesRead,
  machinesOffOf,
  readInboxMachines,
} from '../inbox-machine-resolution';
import { locateWebDist, WEB_BUILD_COMMAND } from '../package-paths';
import {
  machinesReadProblem,
  markServePortClash,
  reloadingServedMachines,
  SERVED_MACHINES_TTL,
  type ServedMachines,
  servedAtStartup,
  servedInboxMachinesLayer,
  servePortClash,
} from '../serve-inbox-machines';
import { makeServeLayer, SERVE_HOST } from '../serve-server';

// `operator-inbox serve`: serve the local app on 127.0.0.1: the inbox API
// under `/api`, and the Vite build of `apps/web` for everything else, so one
// command and one URL give the whole app. It runs until interrupted (Ctrl-C).
// Every request reads the inbox log afresh, so there is nothing to refresh on
// the server side.
//
// The build is found relative to the CLI package (`package-paths.ts`), or
// wherever `--static` says. With no build the API still serves, and start-up
// says on stderr how to make one; the Vite dev server, which proxies /api
// here, still works either way. There is no host flag: the bind address is
// fixed (`SERVE_HOST`).

const portOpt = Flag.Int('port').pipe(
  Flag.withDescription(
    `The port to listen on, on 127.0.0.1 only (default ${SERVE_DEFAULT_PORT}; 0 lets the OS choose)`,
  ),
  Flag.withDefault(SERVE_DEFAULT_PORT),
);

const staticOpt = Flag.Directory('static').pipe(
  Flag.withDescription(
    "Serve the web build from this directory (default: the build shipped with the CLI, or the web package's own from source)",
  ),
  Flag.optional,
);

const MAX_PORT = 65_535;

// config.json's `serve.tailnet`, read once at start-up. A config.json that does not load leaves serve on loopback only:
// the Inbox machines' start-up line already names that file's problem.
const tailnetOf = loadConfig().pipe(
  Effect.map(({ config }) => config.serve?.tailnet),
  Effect.orElseSucceed(() => undefined),
);

// One sentence for a listener that could not bind. Node's `listen` error
// arrives wrapped in a `ServeError` with no message of its own, so without
// this the error boundary prints `operator-inbox: ` and nothing else. The common
// case (a second `serve` on the default port) is named outright; anything
// else carries Node's own code and message. Node ends a `listen` message with
// the address (`listen EACCES: permission denied 127.0.0.1:80`), which the
// sentence has already named, so that tail is dropped rather than said twice.
export const describeBindFailure = (port: number, cause: unknown): string => {
  const at = `${SERVE_HOST}:${port}`;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String(cause.code)
      : undefined;
  if (code === 'EADDRINUSE') {
    return `cannot listen on ${at}: the address is already in use (is another operator-inbox serve running? choose another with --port)`;
  }
  const message =
    cause instanceof Error && cause.message !== ''
      ? cause.message
      : String(cause);
  const detail = message.endsWith(` ${at}`)
    ? message.slice(0, -(at.length + 1))
    : message;
  return `cannot listen on ${at}: ${detail}`;
};

// What the operator sees once the listener is up: the URL on stdout, and on
// stderr anything that means requests will NOT be answered as they should
// yet. No condition is fatal: every request looks for the web build and reads
// the config afresh, so a config that is fixed or a build that is made is
// picked up without a restart. But each is said here, so a server that
// cannot serve yet never starts in silence.
export const announceStartup = Effect.fnUntraced(function* (
  webDist: string | undefined,
  machines: InboxMachinesRead,
  tailnet?: ServeTailnet,
) {
  const fs = yield* FileSystem.FileSystem;
  const built =
    webDist !== undefined &&
    (yield* fs
      .exists(path.join(webDist, 'index.html'))
      .pipe(Effect.orElseSucceed(() => false)));
  yield* HttpServer.addressFormattedWith((url) =>
    Console.log(`operator-inbox serve: listening on ${url}`),
  );
  if (tailnet !== undefined) {
    yield* Console.log(
      `operator-inbox serve: also answering ${tailnet.host} through tailscale serve, from ${tailnet.allowFrom.length === 0 ? 'no peer' : tailnet.allowFrom.join(', ')}`,
    );
  }
  if (!built) {
    const where = webDist === undefined ? '' : ` at ${webDist}`;
    yield* Console.error(
      `operator-inbox serve: no web build found${where}; the API still serves. Make one with: ${WEB_BUILD_COMMAND}`,
    );
  }
  // The Inbox's metadata rules: unusable ones stop neither serve nor a write,
  // so they are said here, and the page's config read answers the same sentence.
  const rules = yield* loadMetadataRules().pipe(
    Effect.map((loaded) => loaded.rules),
    Effect.option,
  );
  if (Option.isSome(rules) && Result.isFailure(rules.value)) {
    yield* Console.error(
      `operator-inbox serve: the Inbox's metadata rules are not in force (${rules.value.failure}); \`operator-inbox keys\` says the same`,
    );
  }
  // The Inbox machines: neither a config that cannot be read nor
  // a machine that names no Herdr profile stops serve; each is said here,
  // with core's advice, and the board shows the same (the banner, or the
  // machine as unreachable with the same sentence).
  const machinesOff = machinesOffOf(machines);
  if (machinesOff !== undefined) {
    yield* Console.error(
      `operator-inbox serve: could not read the Inbox machines (${machinesOff}); serving Local's inbox only`,
    );
  }
  if (machines._tag !== 'Listed') return;
  // A Herdr that failed, or did not answer in time, leaves every machine
  // unresolved with that sentence, which is no fault of their entries: said
  // once, with Herdr's advice, never the entry's. The next re-read that
  // Herdr answers lists them.
  const unresolved = machines.entries.flatMap(({ label, resolved }) =>
    Result.isFailure(resolved) ? [{ label, ...resolved.failure }] : [],
  );
  const herdr = unresolved.find((u) => u._tag === 'HerdrUnread');
  if (herdr !== undefined) {
    const { advice } = inboxMachineAdvice({ ...herdr, reason: 'herdr-unread' });
    yield* Console.error(
      `operator-inbox serve: ${herdr.reason}, so no Inbox machine is read until serve reads Herdr again, every ${Duration.format(SERVED_MACHINES_TTL)}. ${advice}`,
    );
    return;
  }
  for (const { label, port, reason } of unresolved) {
    const { advice } = inboxMachineAdvice(
      { label, port, reason: 'unresolved' },
      machines.configPath,
    );
    yield* Console.error(
      `operator-inbox serve: the Inbox machine "${label}" cannot be reached through Herdr: ${reason}. ${advice}`,
    );
  }
});

// The Inbox machines a serve on `port` uses: what start-up read (`loaded`,
// for the announcement and the port check), and how the inbox handlers read
// them on each request (`current`).
export interface ServeMachines {
  readonly loaded: InboxMachinesRead;
  readonly current: Effect.Effect<ServedMachines>;
}

// `load` run once, now, for start-up; then re-read in the background once
// SERVED_MACHINES_TTL has passed (`reloadingServedMachines`: a request never
// waits on the re-read), with a machine on serve's own `port` marked
// unresolved, since start-up's refusal is past. The command gives
// `readInboxMachines()`.
export const serveMachinesFrom = <R>(
  port: number,
  load: Effect.Effect<InboxMachinesRead, never, R>,
) =>
  Effect.gen(function* () {
    const loaded = yield* load;
    const reload = yield* reloadingServedMachines(
      servedAtStartup(loaded),
      load,
      SERVED_MACHINES_TTL,
      machinesReadProblem(loaded),
    );
    return {
      loaded,
      current: Effect.map(reload.current, markServePortClash(port)),
      // Done once no re-read is running; tests wait on it.
      settled: reload.settled,
    } satisfies ServeMachines & { readonly settled: Effect.Effect<void> };
  });

// The listener and the app it serves, with the inbox reading its machines
// through `machines.current`. `serveOn` launches it under the announcement.
export const serveAppLayer = (
  port: number,
  webDist: string | undefined,
  machines: ServeMachines,
  tailnet?: ServeTailnet,
) =>
  makeServeLayer(port, webDist, tailnet).pipe(
    Layer.provide(servedInboxMachinesLayer(machines.current)),
  );

// The whole command once the port and the web build are known: check the
// port, then launch the listener with the announcement layered over it, and
// run until interrupted. The announcement is built AFTER the listener (it
// depends on its `HttpServer`), so it reports the port actually bound. The
// Inbox
// machines were read at start-up by the caller (`serveMachinesFrom`); serve
// refuses to take a port one of their tunnels is configured on.
export const serveOn = (
  port: number,
  webDist: string | undefined,
  machines: ServeMachines,
  tailnet?: ServeTailnet,
) =>
  Effect.gen(function* () {
    if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
      return yield* new InputError({
        message: `--port must be an integer from 0 to ${MAX_PORT}, got ${port}`,
      });
    }
    const clash = servePortClash(
      port,
      servedAtStartup(machines.loaded).entries,
    );
    if (clash !== undefined) return yield* new InputError({ message: clash });
    return yield* Layer.effectDiscard(
      announceStartup(webDist, machines.loaded, tailnet),
    ).pipe(
      Layer.provide(serveAppLayer(port, webDist, machines, tailnet)),
      Layer.launch,
      Effect.catchTag('ServeError', (e) =>
        Effect.fail(
          new InputError({ message: describeBindFailure(port, e.cause) }),
        ),
      ),
    );
  });

export const serveCommand = Command.make(
  'serve',
  { port: portOpt, staticDir: staticOpt },
  ({ port, staticDir }) =>
    Effect.gen(function* () {
      const webDist = Option.isSome(staticDir)
        ? path.resolve(staticDir.value)
        : yield* locateWebDist();
      return yield* serveOn(
        port,
        webDist,
        yield* serveMachinesFrom(port, readInboxMachines()),
        yield* tailnetOf,
      );
      // Scoped: the re-reads, and any Herdr one waits on, are serve's, so
      // stopping serve ends them (`reloadingServedMachines`).
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    `Serve the inbox (its API and its web app) on 127.0.0.1:${SERVE_DEFAULT_PORT}; runs until interrupted`,
  ),
);
