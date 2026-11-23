import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  HerdrMachineId,
  INBOX_MACHINE_HOST,
  InboxId,
  type InboxMachineEntry,
  InboxMachinePort,
  inboxStateStamped,
  NO_INBOX_CLAIMS,
  QuestionNumber,
  QuestionRevision,
  type UnresolvedInboxMachine,
} from '@operator-inbox/core';
import {
  AnswerRefused,
  FORWARDED_WRITE_WORST,
  InboxBoardDto,
  InboxNotFound,
  InboxUnavailable,
  inboxClashSentence,
  inboxMachineKey,
  MACHINE_CALL_TIMEOUT,
  MACHINE_WRITE_TIMEOUT,
  OperatorInboxApi,
  SERVE_DEFAULT_PORT,
} from '@operator-inbox/core/api';
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Result,
  Scheduler,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from 'effect/http';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { TestClock } from 'effect/testing';
import { dispatchAsk, dispatchOpen } from '../src/commands/inbox';
import {
  type ServeMachines,
  serveAppLayer,
  serveMachinesFrom,
  serveOn,
} from '../src/commands/serve';
import { envProvider } from '../src/env-config';
import { InputError } from '../src/errors';
import {
  detachedWrite,
  fetchMachineBoard,
  type MachineCallOptions,
} from '../src/inbox-machine-client';
import {
  type InboxMachinesRead,
  readInboxMachines,
} from '../src/inbox-machine-resolution';
import { InboxLog, InboxLogInMemory } from '../src/inbox-store';
import {
  answerQuestion,
  inboxBoard,
  inboxIndex,
  inboxView,
  readMachines,
} from '../src/serve-inbox-api';
import {
  reloadingServedMachines,
  SERVED_MACHINES_TTL,
  ServedInboxMachines,
  type ServedMachines,
  servedAfterReRead,
  servedAtStartup,
  servedInboxMachinesLayer,
  servePortClash,
} from '../src/serve-inbox-machines';
import {
  localOnly,
  makeServeLayer,
  OperatorInboxApiLive,
  SERVE_HOST,
  SERVE_SHUTDOWN_GRACE,
} from '../src/serve-server';

// Serve's fan-out to Inbox machines, with two in-process serves on
// real listeners: Local, and a stand-in for the machine `laptop` behind its
// tunnel. Each has its own in-memory inbox log.
//
// The stand-in runs the REAL API and the REAL `localOnly` guard. A real
// machine's serve binds 7184 and is reached through a tunnel on another local
// port, so its guard compares the `Host` against 7184, not against the port
// the request travelled to. The stand-in reproduces exactly that: it listens
// on a port the OS chooses, and the `HttpServer` its guard reads reports the
// address as 127.0.0.1:7184. Nothing in the client or the guard is swapped,
// so Local's calls are answered only because they send `Host:
// 127.0.0.1:7184`, and a call without that override gets 421.

const TIMEOUT = '600 millis';

const LOCAL_ID = InboxId.make('01INBOXLOCAL00000000000000');
const LAPTOP_ID = InboxId.make('01INBOXLAPTOP0000000000000');
const NOWHERE_ID = InboxId.make('01INBOXNOWHERE000000000000');
const DESKTOP_ID = InboxId.make('01INBOXDESKTOP000000000000');

const n = QuestionNumber.make;
const r = QuestionRevision.make;

// One configured machine as serve holds it (core's `InboxMachineEntry`):
// resolved against a Herdr profile of the same label, keyed by its port.
const entry = (label: string, port: number): InboxMachineEntry => ({
  key: inboxMachineKey(InboxMachinePort.make(port)),
  label,
  port: InboxMachinePort.make(port),
  herdrMachine: label,
  resolved: Result.succeed({
    herdrMachine: label,
    herdrId: HerdrMachineId.make(`id-${label}`),
    label,
    port: InboxMachinePort.make(port),
    target: `operator@${label}`,
  }),
});
// One that names no usable Herdr profile, with the sentence saying why.
const unresolvedEntry = (
  label: string,
  port: number,
  reason: string,
  tag: UnresolvedInboxMachine['_tag'] = 'Unusable',
): InboxMachineEntry => ({
  key: inboxMachineKey(InboxMachinePort.make(port)),
  label,
  port: InboxMachinePort.make(port),
  herdrMachine: label,
  resolved: Result.fail({
    _tag: tag,
    herdrMachine: label,
    port: InboxMachinePort.make(port),
    reason,
  }),
});
const served = (
  entries: ReadonlyArray<InboxMachineEntry>,
): Effect.Effect<ServedMachines> => Effect.succeed({ entries });
// The machine fields the wire carries for a machine.
const refOf = (label: string, port: number) => ({
  key: inboxMachineKey(InboxMachinePort.make(port)),
  label,
});
// Local's own section, first on every board Local's serve builds.
const localSection = (awaitingOperator: number) => ({
  status: 'local',
  key: 'local',
  label: 'Local',
  awaitingOperator,
});
// A serve's machines fixed at `entries`, never re-read.
const fixedServeMachines = (
  entries: ReadonlyArray<InboxMachineEntry>,
): ServeMachines => ({
  loaded: { _tag: 'Listed', configPath: '/c/config.json', entries },
  current: served(entries),
});

const portOf = (server: HttpServer.HttpServer['Service']): number => {
  const { address } = server;
  if (NetAddress.isUnixPathAddress(address))
    throw new Error('not a TCP listener');
  return address.port;
};

// An Inbox with one question, in whichever log is in context.
const seedInbox = (inboxId: InboxId, label: string, title: string) =>
  Effect.gen(function* () {
    yield* dispatchOpen({
      session: Option.none(),
      inbox: Option.none(),
      label: Option.some(label),
      freshId: inboxId,
      cwd: `/w/${label}`,
    });
    yield* dispatchAsk({ inboxId, title, body: '' });
  });

// The machine's serve: a listener on a port the OS chooses, behind an
// `HttpServer` whose address names 7184, the port a real machine's serve
// binds, with Inbox machines of its own when given. Returns its context (for
// its log) and the port it really listens on.
const startMachine = (machines: Effect.Effect<ServedMachines> = served([])) =>
  Effect.gen(function* () {
    const listener = yield* Layer.build(
      NodeHttpServer.layer(() => createHttpServer(), {
        host: SERVE_HOST,
        port: 0,
      }),
    );
    const real = Context.get(listener, HttpServer.HttpServer);
    const asIfOn7184 = HttpServer.make({
      serve: real.serve,
      address: NetAddress.inetAddressFromIpStringUnsafe(
        SERVE_HOST,
        SERVE_DEFAULT_PORT,
      ),
    });
    const context = yield* Layer.build(
      HttpRouter.serve(OperatorInboxApiLive, {
        middleware: localOnly,
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provide(
          Layer.succeedContext(
            Context.add(listener, HttpServer.HttpServer, asIfOn7184),
          ),
        ),
        Layer.provide(servedInboxMachinesLayer(machines, { timeout: TIMEOUT })),
        Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
      ),
    );
    return { context, port: portOf(real) };
  });

// Local's serve, the very layer `serve` runs, with the given machines.
const startLocal = (
  machines: ReadonlyArray<InboxMachineEntry>,
  callOptions: MachineCallOptions = { timeout: TIMEOUT },
) => startLocalServing(served(machines), callOptions);

// Local's serve reading its machines from `machines` on each request, as a
// re-read changes them.
const startLocalServing = (
  machines: Effect.Effect<ServedMachines>,
  callOptions: MachineCallOptions = { timeout: TIMEOUT },
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      makeServeLayer(0, undefined).pipe(
        Layer.provideMerge(servedInboxMachinesLayer(machines, callOptions)),
        Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const port = portOf(Context.get(context, HttpServer.HttpServer));
    const api = yield* HttpApiClient.make(OperatorInboxApi, {
      baseUrl: `http://${SERVE_HOST}:${port}`,
    }).pipe(Effect.provide(FetchHttpClient.layer));
    // Serve's own record of what each machine claims, for a test to wait on.
    const { lastOwners } = Context.get(context, ServedInboxMachines);
    return { context, port, api, lastOwners };
  });

// Local and `laptop`, each with one Inbox and one question waiting.
const twoMachines = Effect.gen(function* () {
  const machine = yield* startMachine();
  yield* seedInbox(LAPTOP_ID, 'orchard', 'Pick a branch').pipe(
    Effect.provide(machine.context),
  );
  const local = yield* startLocal([entry('laptop', machine.port)]);
  yield* seedInbox(LOCAL_ID, 'alpha', 'Pick a store').pipe(
    Effect.provide(local.context),
  );
  return { machine, local };
});

// A port nothing listens on: bound by the OS, then closed.
const closedPort = Effect.callback<number>((resume) => {
  const s = createNetServer();
  s.listen(0, SERVE_HOST, () => {
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    s.close(() => resume(Effect.succeed(port)));
  });
});

// A listener for the length of the test's scope. Every connection it took is
// destroyed on release, so one that never answered does not hold it open.
const listening = (server: Server) =>
  Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, SERVE_HOST, () => {
        const address = server.address();
        resume(
          Effect.succeed(
            typeof address === 'object' && address ? address.port : 0,
          ),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        for (const socket of sockets.get(server) ?? []) socket.destroy();
      }),
  );

const sockets = new WeakMap<Server, Set<Socket>>();

// A server that remembers its connections, for `listening` to destroy.
const tracked = <S extends Server>(server: S): S => {
  const open = new Set<Socket>();
  sockets.set(server, open);
  server.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  });
  return server;
};

// A stand-in machine answering fixed JSON: its board, and `view` for any
// `/api/inbox/<id>` (status and body), recording each Inbox id it was asked
// about. Its index is empty.
const stubMachine = (input: {
  // The board, or, given which board read this is (from 0), the board and
  // when it is answered: after so many milliseconds, or once a promise the
  // test holds is resolved.
  readonly board?:
    | InboxBoardDto
    | ((nth: number) => readonly [InboxBoardDto, number | Promise<void>]);
  readonly view: (inboxId: string) => readonly [number, unknown];
}) => {
  let boards = 0;
  const viewed: Array<string> = [];
  // Every call to an Inbox, as `METHOD path`, the query left off.
  const calls: Array<string> = [];
  const server = tracked(
    createHttpServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (url.startsWith('/api/inbox/'))
        calls.push(`${req.method} ${url.split('?')[0]}`);
      if (url.startsWith('/api/inbox-board')) {
        if (typeof input.board !== 'function')
          return send(200, input.board ?? boardOf([]));
        const [board, after] = input.board(boards++);
        if (typeof after === 'number')
          setTimeout(() => send(200, board), after);
        else void after.then(() => send(200, board));
        return;
      }
      if (url.startsWith('/api/inboxes'))
        return send(200, { inboxes: [], totalAwaitingOperator: 0 });
      const id = /^\/api\/inbox\/([^/?]+)/.exec(url)?.[1];
      if (id === undefined) return send(404, {});
      viewed.push(id);
      const [status, body] = input.view(id);
      return send(status, body);
    }),
  );
  return Effect.map(listening(server), (port) => ({ port, viewed, calls }));
};

const viewOf = (inboxId: InboxId) => ({
  inboxId,
  label: 'orchard',
  metadata: {},
  archived: false,
  pinnedGroups: [],
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
});

const boardOf = (ids: ReadonlyArray<InboxId>): InboxBoardDto => ({
  inboxes: ids.map((inboxId) => ({
    inboxId,
    label: 'orchard',
    archived: false,
    pinned: false,
    awaitingOperator: 0,
    awaitingAgent: 0,
    processed: 0,
  })),
  totalAwaitingOperator: 0,
  views: ids.map(viewOf),
});

const notHere = [
  404,
  { message: 'no such Inbox here', _tag: 'InboxNotFound' },
] as const;
const storeDown = [
  503,
  { message: 'the store is down', _tag: 'InboxUnavailable' },
] as const;

describe('operator-inbox serve — Inbox machines', () => {
  it.live('the board merges Local’s Inboxes and the machine’s', () =>
    Effect.gen(function* () {
      const { local, machine } = yield* twoMachines;
      const board = yield* local.api.inbox.board({ query: {} });
      expect(board.inboxes.map((i) => [i.inboxId, i.machine?.label])).toEqual([
        [LOCAL_ID, undefined],
        [LAPTOP_ID, 'laptop'],
      ]);
      expect(board.views.map((v) => [v.label, v.machine?.label])).toEqual([
        ['alpha', undefined],
        ['orchard', 'laptop'],
      ]);
      expect(board.totalAwaitingOperator).toBe(2);
      // Local's section first, with Local's own total, then the machine's.
      expect(board.machines).toEqual([
        localSection(1),
        {
          status: 'reachable',
          key: inboxMachineKey(InboxMachinePort.make(machine.port)),
          label: 'laptop',
          port: machine.port,
          awaitingOperator: 1,
        },
      ]);
      expect(board.clashes).toEqual([]);
      expect(board.machinesOff).toBeUndefined();
      const index = yield* local.api.inbox.index({ query: {} });
      expect(index.inboxes.map((i) => i.machine?.label)).toEqual([
        undefined,
        'laptop',
      ]);
      expect(index.totalAwaitingOperator).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live('an answer to the machine’s Inbox lands in the machine’s log', () =>
    Effect.gen(function* () {
      const { local, machine } = yield* twoMachines;
      yield* local.api.inbox.board({ query: {} });
      const view = yield* local.api.inbox.answer({
        query: {},
        params: { inboxId: LAPTOP_ID, number: n(1) },
        payload: { response: 'main', seenRevision: r(1) },
      });
      expect(view.machine?.label).toBe('laptop');
      expect(view.awaitingAgent.map((q) => q.response)).toEqual(['main']);
      const onMachine = yield* inboxView(LAPTOP_ID).pipe(
        Effect.provide(machine.context),
      );
      expect(onMachine.awaitingAgent.map((q) => q.response)).toEqual(['main']);
      const localLog = yield* InboxLog.pipe(Effect.provide(local.context));
      const { stamped } = yield* localLog.read(LAPTOP_ID);
      expect(inboxStateStamped(stamped).opened).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live(
    'an answer to the machine’s Inbox carries its comments’ macros there',
    () =>
      Effect.gen(function* () {
        const { local, machine } = yield* twoMachines;
        yield* local.api.inbox.board({ query: {} });
        const SHOW_ME = {
          macro: 'show-me',
          instruction: 'Show the operator what this looks like.',
          args: { focus: 'the edge case' },
        };
        const comment = {
          quote: 'main',
          prefix: '',
          suffix: '',
          at: { part: 0, start: 0, end: 4 },
          text: '',
          macros: [SHOW_ME],
        } as const;
        const view = yield* local.api.inbox.answer({
          query: {},
          params: { inboxId: LAPTOP_ID, number: n(1) },
          payload: { response: '', seenRevision: r(1), comments: [comment] },
        });
        expect(view.machine?.label).toBe('laptop');
        expect(view.awaitingAgent[0]?.comments).toEqual([comment]);
        const onMachine = yield* inboxView(LAPTOP_ID).pipe(
          Effect.provide(machine.context),
        );
        expect(onMachine.awaitingAgent[0]?.comments).toEqual([comment]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'an ask to the machine’s Inbox lands in the machine’s log with its macros',
    () =>
      Effect.gen(function* () {
        const { local, machine } = yield* twoMachines;
        yield* local.api.inbox.board({ query: {} });
        const PARK = {
          macro: 'park',
          instruction: 'Stop work on this thread until asked.',
          args: {},
        };
        const view = yield* local.api.inbox.ask({
          query: {},
          params: { inboxId: LAPTOP_ID },
          payload: { text: 'Wrap this up?', macros: [PARK] },
        });
        expect(view.machine?.label).toBe('laptop');
        const asked = view.awaitingAgent.find(
          (q) => q.operatorQuestion === true,
        );
        expect(asked?.macros).toEqual([PARK]);
        const onMachine = yield* inboxView(LAPTOP_ID).pipe(
          Effect.provide(machine.context),
        );
        expect(
          onMachine.awaitingAgent.find((q) => q.operatorQuestion === true)
            ?.macros,
        ).toEqual([PARK]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'rename, pin and archive of the machine’s Inbox land on the machine',
    () =>
      Effect.gen(function* () {
        const { local, machine } = yield* twoMachines;
        yield* local.api.inbox.board({ query: {} });
        const params = { inboxId: LAPTOP_ID };
        const renamed = yield* local.api.inbox.rename({
          query: {},
          params,
          payload: { label: 'grove' },
        });
        expect([renamed.label, renamed.machine?.label]).toEqual([
          'grove',
          'laptop',
        ]);
        yield* local.api.inbox.pin({
          query: {},
          params,
          payload: { pinned: true },
        });
        const archived = yield* local.api.inbox.archive({
          query: {},
          params,
          payload: { archived: true },
        });
        expect([archived.archived, archived.machine?.label]).toEqual([
          true,
          'laptop',
        ]);
        const machineLog = yield* InboxLog.pipe(
          Effect.provide(machine.context),
        );
        const onMachine = yield* machineLog.read(LAPTOP_ID);
        const state = inboxStateStamped(onMachine.stamped);
        expect([state.label, state.pinned, state.archived]).toEqual([
          'grove',
          true,
          true,
        ]);
        const localLog = yield* InboxLog.pipe(Effect.provide(local.context));
        const { stamped } = yield* localLog.read(LAPTOP_ID);
        expect(inboxStateStamped(stamped).opened).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live('an Inbox no board has listed is found by asking the machine', () =>
    Effect.gen(function* () {
      const { local } = yield* twoMachines;
      const view = yield* local.api.inbox.view({
        query: {},
        params: { inboxId: LAPTOP_ID },
      });
      expect([view.label, view.machine?.label]).toEqual(['orchard', 'laptop']);
      const own = yield* local.api.inbox.view({
        query: {},
        params: { inboxId: LOCAL_ID },
      });
      expect([own.label, own.machine?.label]).toEqual(['alpha', undefined]);
    }).pipe(Effect.scoped),
  );

  it.live('the machine’s refusal comes back word for word', () =>
    Effect.gen(function* () {
      const { local, machine } = yield* twoMachines;
      const direct = yield* answerQuestion(LAPTOP_ID, n(9), 'x', r(1)).pipe(
        Effect.provide(machine.context),
        Effect.provide(NodeServices.layer),
        Effect.flip,
      );
      const forwarded = yield* local.api.inbox
        .answer({
          query: {},
          params: { inboxId: LAPTOP_ID, number: n(9) },
          payload: { response: 'x', seenRevision: r(1) },
        })
        .pipe(Effect.flip);
      expect(forwarded).toBeInstanceOf(AnswerRefused);
      expect(forwarded.message).toBe(direct.message);
    }).pipe(Effect.scoped),
  );

  it.live('an Inbox on no machine is not found', () =>
    Effect.gen(function* () {
      const { local } = yield* twoMachines;
      const e = yield* local.api.inbox
        .view({ query: {}, params: { inboxId: NOWHERE_ID } })
        .pipe(Effect.flip);
      expect(e).toBeInstanceOf(InboxNotFound);
    }).pipe(Effect.scoped),
  );

  it.live('a stopped machine is unreachable, and the board still answers', () =>
    Effect.gen(function* () {
      const port = yield* closedPort;
      const local = yield* startLocal([entry('laptop', port)]);
      yield* seedInbox(LOCAL_ID, 'alpha', 'Pick a store').pipe(
        Effect.provide(local.context),
      );
      const board = yield* local.api.inbox.board({ query: {} });
      expect(board.inboxes.map((i) => i.inboxId)).toEqual([LOCAL_ID]);
      expect(board.totalAwaitingOperator).toBe(1);
      const [, laptop] = board.machines ?? [];
      expect(laptop).toMatchObject({
        label: 'laptop',
        status: 'unreachable',
        reason: 'tunnel-down',
      });
      expect(laptop?.status === 'unreachable' && laptop.detail).toContain(
        `port ${port}`,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    'a machine that never answers is unreachable within the timeout',
    () =>
      Effect.gen(function* () {
        // Accepts the connection and says nothing.
        const port = yield* listening(tracked(createNetServer(() => {})));
        const local = yield* startLocal([entry('laptop', port)]);
        const started = yield* Clock.currentTimeMillis;
        const board = yield* local.api.inbox.board({ query: {} });
        const took = (yield* Clock.currentTimeMillis) - started;
        const [, laptop] = board.machines ?? [];
        expect(laptop).toMatchObject({
          status: 'unreachable',
          reason: 'timed-out',
        });
        expect(laptop?.status === 'unreachable' && laptop.detail).toContain(
          'no answer',
        );
        expect(took).toBeLessThan(2_000);
      }).pipe(Effect.scoped),
  );

  it.live('a response that does not decode is incompatible', () =>
    Effect.gen(function* () {
      const port = yield* listening(
        tracked(
          createHttpServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"inboxes":"not a list"}');
          }),
        ),
      );
      const local = yield* startLocal([entry('laptop', port)]);
      const board = yield* local.api.inbox.board({ query: {} });
      expect(board.machines?.map((m) => [m.label, m.status])).toEqual([
        ['Local', 'local'],
        ['laptop', 'incompatible'],
      ]);
    }).pipe(Effect.scoped),
  );

  it.live(
    'the machine’s guard answers 421 when the Host override is left out',
    () =>
      Effect.gen(function* () {
        const machine = yield* startMachine();
        const response = yield* HttpClient.get(
          `http://${SERVE_HOST}:${machine.port}/api/inboxes`,
        ).pipe(Effect.provide(FetchHttpClient.layer));
        expect(response.status).toBe(421);
        // A machine whose serve is reached on its own port, not as 7184,
        // shows on Local's board as the wrong destination.
        const plain = yield* startLocal([]);
        const local = yield* startLocal([entry('laptop', plain.port)]);
        const board = yield* local.api.inbox.board({ query: {} });
        const [, laptop] = board.machines ?? [];
        expect(laptop).toMatchObject({
          status: 'incompatible',
          reason: 'misdirected',
        });
        expect(laptop?.status === 'incompatible' && laptop.detail).toContain(
          '421',
        );
      }).pipe(Effect.scoped),
  );

  it.live('a machine that names no Herdr profile is never called', () =>
    Effect.gen(function* () {
      const local = yield* startLocal([
        unresolvedEntry('nas', 3999, 'no Herdr machine "nas"'),
      ]);
      const board = yield* local.api.inbox.board({ query: {} });
      expect(board.machines).toEqual([
        localSection(0),
        {
          status: 'unreachable',
          key: inboxMachineKey(InboxMachinePort.make(3999)),
          label: 'nas',
          port: 3999,
          reason: 'unresolved',
          detail: 'no Herdr machine "nas"',
        },
      ]);
    }).pipe(Effect.scoped),
  );

  // Herdr's failure is no fault of the entry, so the board says
  // `herdr-unread`, for the page to give Herdr's advice, not the entry's.
  it.live('a machine Herdr could not be read for is herdr-unread', () =>
    Effect.gen(function* () {
      const local = yield* startLocal([
        unresolvedEntry('laptop', 3999, 'herdr exited 1', 'HerdrUnread'),
      ]);
      const board = yield* local.api.inbox.board({ query: {} });
      const [, laptop] = board.machines ?? [];
      expect(laptop).toEqual({
        status: 'unreachable',
        key: inboxMachineKey(InboxMachinePort.make(3999)),
        label: 'laptop',
        port: 3999,
        reason: 'herdr-unread',
        detail: 'herdr exited 1',
      });
    }).pipe(Effect.scoped),
  );

  it.live('a read for Local’s serve (local=true) skips the machines', () =>
    Effect.gen(function* () {
      const laptop = yield* stubMachine({ view: () => notHere });
      const local = yield* startLocal([entry('laptop', laptop.port)]);
      yield* seedInbox(LOCAL_ID, 'alpha', 'Pick a store').pipe(
        Effect.provide(local.context),
      );
      const board = yield* local.api.inbox.board({ query: { local: 'true' } });
      expect(board.inboxes.map((i) => i.inboxId)).toEqual([LOCAL_ID]);
      // A serve asked as an Inbox machine leaves every machine field out:
      // Local merges one level.
      expect(Object.keys(board).sort()).toEqual([
        'inboxes',
        'totalAwaitingOperator',
        'views',
      ]);
      expect(laptop.viewed).toEqual([]);
      const index = yield* local.api.inbox.index({ query: { local: 'true' } });
      expect(Object.keys(index).sort()).toEqual([
        'inboxes',
        'totalAwaitingOperator',
      ]);
      // Without it, the same serve merges its machine.
      const merged = yield* local.api.inbox.board({ query: {} });
      expect(merged.machines?.map((m) => m.label)).toEqual(['Local', 'laptop']);
    }).pipe(Effect.scoped),
  );

  it.live(
    'a serve on an older build, with no query declared, still answers local=true',
    () =>
      Effect.gen(function* () {
        // The board endpoint as it was before `local`: no query at all.
        class OldInbox extends HttpApiGroup.make('inbox').add(
          HttpApiEndpoint.get('board', '/inbox-board', {
            success: InboxBoardDto,
          }),
        ) {}
        class OldApi extends HttpApi.make('old').add(OldInbox).prefix('/api') {}
        const context = yield* Layer.build(
          HttpRouter.serve(
            HttpApiBuilder.layer(OldApi).pipe(
              Layer.provide(
                HttpApiBuilder.group(OldApi, 'inbox', (h) =>
                  h.handle('board', () => Effect.succeed(boardOf([LAPTOP_ID]))),
                ),
              ),
            ),
            { disableLogger: true, disableListenLog: true },
          ).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(() => createHttpServer(), {
                host: SERVE_HOST,
                port: 0,
              }),
            ),
          ),
        );
        const port = portOf(Context.get(context, HttpServer.HttpServer));
        const read = yield* fetchMachineBoard(InboxMachinePort.make(port));
        expect(read.status).toBe('reachable');
        if (read.status === 'reachable')
          expect(read.value.inboxes.map((i) => i.inboxId)).toEqual([LAPTOP_ID]);
      }).pipe(Effect.scoped),
  );

  it.live('with no machines, the board’s machines are Local’s alone', () =>
    Effect.gen(function* () {
      const local = yield* startLocal([]);
      yield* seedInbox(LOCAL_ID, 'alpha', 'Pick a store').pipe(
        Effect.provide(local.context),
      );
      const board = yield* local.api.inbox.board({ query: {} });
      expect(board.machines).toEqual([localSection(1)]);
      expect(board.clashes).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

// Which timeout each endpoint keyed by an Inbox id forwards with: the view
// is a read, and gives up at the read timeout; the five writes may land late,
// so each waits the longer write timeout. The machine holds each request
// until the test answers it, and the timeouts run on the TestClock: a
// machine that answers after the read timeout but well inside the write
// timeout tells them apart, with no test time spent waiting. Every write
// comes back with the machine's view, and the view says the machine could
// not be reached.
describe('serve forwards a read with the read timeout, a write with the write timeout', () => {
  // A machine that holds every request until it is answered: `arrival` is
  // the next request to reach it, as the function that answers it with
  // `answer`'s status and body for its Inbox id.
  const heldMachine = (
    answer: (inboxId: string) => readonly [number, unknown],
  ) =>
    Effect.suspend(() => {
      const held: Array<() => void> = [];
      const waiting: Array<(release: Effect.Effect<() => void>) => void> = [];
      // Every request, as `METHOD path`, the query left off.
      const calls: Array<string> = [];
      const server = tracked(
        createHttpServer((req, res) => {
          calls.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
          const id = /^\/api\/inbox\/([^/?]+)/.exec(req.url ?? '')?.[1] ?? '';
          const release = () => {
            const [status, body] = answer(id);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          };
          const next = waiting.shift();
          if (next === undefined) held.push(release);
          else next(Effect.succeed(release));
        }),
      );
      const arrival = Effect.callback<() => void>((resume) => {
        const release = held.shift();
        if (release === undefined) waiting.push(resume);
        else resume(Effect.succeed(release));
      });
      return Effect.map(listening(server), (port) => ({
        port,
        arrival,
        calls,
      }));
    });
  const hasIt = (id: string) => [200, viewOf(InboxId.make(id))] as const;
  // Past the read timeout (100 ms), well inside the write timeout (5 s).
  const LATE = '1 second';

  it.effect('each of the five writes succeeds where the view times out', () =>
    Effect.gen(function* () {
      const machine = yield* heldMachine(hasIt);
      const local = yield* startLocal([entry('laptop', machine.port)], {
        timeout: '100 millis',
        writeTimeout: '5 seconds',
      });
      const params = { inboxId: LAPTOP_ID };
      const question = { inboxId: LAPTOP_ID, number: n(1) };
      const writes: ReadonlyArray<
        readonly [
          string,
          Effect.Effect<
            { readonly machine?: { readonly label: string } },
            unknown
          >,
        ]
      > = [
        [
          'answer',
          local.api.inbox.answer({
            query: {},
            params: question,
            payload: { response: 'main', seenRevision: r(1) },
          }),
        ],
        [
          'dismissHighlight',
          local.api.inbox.dismissHighlight({ query: {}, params: question }),
        ],
        [
          'pin',
          local.api.inbox.pin({
            query: {},
            params,
            payload: { pinned: true },
          }),
        ],
        [
          'archive',
          local.api.inbox.archive({
            query: {},
            params,
            payload: { archived: true },
          }),
        ],
        [
          'rename',
          local.api.inbox.rename({
            query: {},
            params,
            payload: { label: 'grove' },
          }),
        ],
      ];
      for (const [name, write] of writes) {
        const writing = yield* Effect.forkChild(
          write.pipe(
            Effect.mapError((e) => new Error(`${name}: ${String(e)}`)),
          ),
        );
        const answer = yield* machine.arrival;
        yield* TestClock.adjust(LATE);
        answer();
        const view = yield* Fiber.join(writing);
        expect([name, view.machine?.label]).toEqual([name, 'laptop']);
      }
      const viewing = yield* Effect.forkChild(
        Effect.flip(local.api.inbox.view({ query: {}, params })),
      );
      yield* machine.arrival;
      yield* TestClock.adjust(LATE);
      const viewed = yield* Fiber.join(viewing);
      expect(viewed).toBeInstanceOf(InboxUnavailable);
      expect((viewed as InboxUnavailable).message).toContain(
        'no answer on port',
      );
    }).pipe(Effect.scoped),
  );

  // A write's round of several machines is probed with `view`,
  // at a read's timeout, so a machine slower than a read is not reached, and
  // the write is never sent to it.
  it.effect('a write round of two probes each with the read timeout', () =>
    Effect.gen(function* () {
      const slow = yield* heldMachine(hasIt);
      const desktop = yield* heldMachine(() => notHere);
      const local = yield* startLocal(
        [entry('laptop', slow.port), entry('desktop', desktop.port)],
        { timeout: '100 millis', writeTimeout: '5 seconds' },
      );
      const answering = yield* Effect.forkChild(
        Effect.flip(
          local.api.inbox.answer({
            query: {},
            params: { inboxId: LAPTOP_ID, number: n(1) },
            payload: { response: 'main', seenRevision: r(1) },
          }),
        ),
      );
      yield* slow.arrival;
      (yield* desktop.arrival)();
      yield* TestClock.adjust(LATE);
      const e = yield* Fiber.join(answering);
      expect(e).toBeInstanceOf(InboxUnavailable);
      expect((e as InboxUnavailable).message).toBe(
        `the Inbox machine laptop could not be reached: no answer on port ${slow.port} within 100ms`,
      );
      // Each was sent the probe, a view.
      expect([...slow.calls, ...desktop.calls]).toEqual([
        `GET /api/inbox/${LAPTOP_ID}`,
        `GET /api/inbox/${LAPTOP_ID}`,
      ]);
    }).pipe(Effect.scoped),
  );
});

// A forwarded write in flight when serve stops is
// finished before serve's scope closes, not cut, whether or not the page
// that sent it is still there.
describe('stopping serve finishes a forwarded write in flight', () => {
  it.live('a write whose page has gone is answered before serve stops', () =>
    Effect.gen(function* () {
      // The machine holds its answer 300 ms on the real clock after the
      // write arrives: showing serve's close does NOT end before the write
      // needs time for an early close to happen, and nothing signals that
      // none is coming. What the close waited for is read, not slept for.
      let arrived = (): void => {};
      const first = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let ended: string | undefined;
      const machine = tracked(
        createHttpServer((_req, res) => {
          res.on('close', () => {
            ended = res.writableFinished ? 'answered' : 'cut off';
          });
          arrived();
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(viewOf(LAPTOP_ID)));
          }, 300);
        }),
      );
      const port = yield* listening(machine);
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        makeServeLayer(0, undefined).pipe(
          Layer.provide(
            servedInboxMachinesLayer(served([entry('laptop', port)]), {
              timeout: TIMEOUT,
              writeTimeout: '5 seconds',
            }),
          ),
          Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
          Layer.provideMerge(NodeServices.layer),
        ),
        scope,
      );
      const api = yield* HttpApiClient.make(OperatorInboxApi, {
        baseUrl: `http://${SERVE_HOST}:${portOf(Context.get(context, HttpServer.HttpServer))}`,
      }).pipe(Effect.provide(FetchHttpClient.layer));
      const page = yield* Effect.forkChild(
        api.inbox.answer({
          query: {},
          params: { inboxId: LAPTOP_ID, number: n(1) },
          payload: { response: 'main', seenRevision: r(1) },
        }),
      );
      yield* Effect.promise(() => first);
      // The page goes away, and then serve is stopped.
      yield* Fiber.interrupt(page);
      yield* Scope.close(scope, Exit.void);
      expect(ended).toBe('answered');
    }).pipe(Effect.scoped),
  );

  it.effect('serve’s scope waits for each write it keeps, and cuts none', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        servedInboxMachinesLayer(served([])),
        scope,
      );
      const { keepWrite } = Context.get(context, ServedInboxMachines);
      // The write takes a second on the test clock, so it is still in
      // flight, asleep, when serve starts to stop. Its page goes away first.
      const sent = yield* Deferred.make<void>();
      const landed = yield* Deferred.make<void>();
      const cut = yield* Deferred.make<void>();
      const page = yield* Effect.forkChild(
        keepWrite(
          Deferred.succeed(sent, undefined).pipe(
            Effect.andThen(Effect.sleep('1 second')),
            Effect.andThen(Deferred.succeed(landed, undefined)),
            Effect.onInterrupt(() => Deferred.succeed(cut, undefined)),
          ),
        ),
      );
      yield* Deferred.await(sent);
      yield* Fiber.interrupt(page);
      // Closing serve's scope signals as its first finalizer runs, so the
      // clock moves only once the close has begun: a close that did not
      // wait would have interrupted the sleeping write by then.
      const stopping = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(scope, Deferred.succeed(stopping, undefined));
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Deferred.await(stopping);
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(closing);
      expect(yield* Deferred.isDone(landed)).toBe(true);
      expect(yield* Deferred.isDone(cut)).toBe(false);
    }),
  );

  // A stand-in machine that answers its board at once and holds every call
  // to an Inbox until the test answers it: `next(call)` waits for the call
  // `METHOD /api/inbox/<id>…` and gives a way to answer it. `ended` says how
  // the last answered call's response closed.
  const heldMachine = (board: InboxBoardDto) =>
    Effect.gen(function* () {
      type Held = (status: number, body: unknown) => void;
      const waiting = new Map<string, (answer: Held) => void>();
      const arrived = new Map<string, Held>();
      const state = { ended: undefined as string | undefined };
      const server = tracked(
        createHttpServer((req, res) => {
          const url = req.url ?? '';
          if (url.startsWith('/api/inbox-board')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(board));
            return;
          }
          const call = `${req.method} ${url.split('?')[0]}`;
          const answer: Held = (status, body) => {
            res.on('close', () => {
              state.ended = res.writableFinished ? 'answered' : 'cut off';
            });
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          };
          const waiter = waiting.get(call);
          if (waiter === undefined) arrived.set(call, answer);
          else waiter(answer);
        }),
      );
      const port = yield* listening(server);
      const next = (call: string) =>
        Effect.promise(
          () =>
            new Promise<Held>((resolve) => {
              const held = arrived.get(call);
              if (held === undefined) waiting.set(call, resolve);
              else resolve(held);
            }),
        );
      return { port, next, ended: () => state.ended };
    });

  // The app `serve` launches (`serveAppLayer`), with its own timeouts on the
  // test clock, serving `entries`; and a page's client for it.
  const launchedServe = (entries: ReadonlyArray<InboxMachineEntry>) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        serveAppLayer(0, undefined, fixedServeMachines(entries)).pipe(
          Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
          Layer.provideMerge(NodeServices.layer),
        ),
        scope,
      );
      const api = yield* HttpApiClient.make(OperatorInboxApi, {
        baseUrl: `http://${SERVE_HOST}:${portOf(Context.get(context, HttpServer.HttpServer))}`,
      }).pipe(Effect.provide(FetchHttpClient.layer));
      // Serve told to stop: done once its close has begun.
      const stop = Effect.gen(function* () {
        const stopping = yield* Deferred.make<void>();
        yield* Scope.addFinalizer(scope, Deferred.succeed(stopping, undefined));
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        yield* Deferred.await(stopping);
        return closing;
      });
      return { api, stop };
    });

  const answerOn = (
    api: Effect.Success<ReturnType<typeof launchedServe>>['api'],
  ) =>
    api.inbox.answer({
      query: {},
      params: { inboxId: LAPTOP_ID, number: n(1) },
      payload: { response: 'main', seenRevision: r(1) },
    });
  const ANSWER = `POST /api/inbox/${LAPTOP_ID}/questions/1/answer`;
  const VIEW = `GET /api/inbox/${LAPTOP_ID}`;
  const less1ms = (d: Duration.Duration) =>
    Duration.subtract(d, Duration.millis(1));

  // The app serve launches keeps each write in the set
  // its scope awaits, so a write whose page has gone still lands before
  // serve stops.
  it.effect(
    'the app serve launches finishes a write whose page has gone before it stops',
    () =>
      Effect.gen(function* () {
        const laptop = yield* heldMachine(boardOf([]));
        const { api, stop } = yield* launchedServe([
          entry('laptop', laptop.port),
        ]);
        const page = yield* Effect.forkChild(answerOn(api));
        const answer = yield* laptop.next(ANSWER);
        yield* Fiber.interrupt(page);
        const closing = yield* stop;
        // The page's request is cut once its abort reaches serve, and then
        // only the write set holds the close. This waits a real 200 ms for a
        // close that did not wait for the write to end: never a flake when
        // serve is right, since such a close cannot end before the machine
        // answers; a close that does not wait ends well inside it.
        const before = yield* Effect.raceFirst(
          Effect.as(Fiber.await(closing), 'closed'),
          Effect.as(
            Effect.promise(() => new Promise((ok) => setTimeout(ok, 200))),
            'still closing',
          ),
        );
        expect(before).toBe('still closing');
        expect(laptop.ended()).toBeUndefined();
        answer(200, viewOf(LAPTOP_ID));
        yield* Fiber.join(closing);
        expect(laptop.ended()).toBe('answered');
      }).pipe(Effect.scoped),
  );

  // The longest a forwarded write's request
  // takes, each call answered a millisecond inside its timeout: the
  // recorded owner lacks the Inbox at the end of its write, the two other
  // machines are probed, and the write goes to the one that has it. Serve
  // was told to stop as the request began, and its grace covers all of it.
  it.effect(
    'the longest forwarded write still gets its owner’s answer while serve stops',
    () =>
      Effect.gen(function* () {
        const laptop = yield* heldMachine(boardOf([LAPTOP_ID]));
        const desktop = yield* heldMachine(boardOf([]));
        const air = yield* heldMachine(boardOf([]));
        const { api, stop } = yield* launchedServe([
          entry('laptop', laptop.port),
          entry('desktop', desktop.port),
          entry('air', air.port),
        ]);
        // A board read records laptop as the Inbox's owner, asked first.
        yield* api.inbox.board({ query: {} });
        const page = yield* Effect.forkChild(answerOn(api));
        const fromLaptop = yield* laptop.next(ANSWER);
        const closing = yield* stop;
        const notCut = <A>(call: Effect.Effect<A>) =>
          Effect.raceFirst(
            call,
            Effect.andThen(Fiber.await(page), (exit) =>
              Effect.die(new Error(`the page was answered early: ${exit}`)),
            ),
          );
        yield* TestClock.adjust(less1ms(MACHINE_WRITE_TIMEOUT));
        fromLaptop(...notHere);
        const probeDesktop = yield* notCut(desktop.next(VIEW));
        const probeAir = yield* notCut(air.next(VIEW));
        yield* TestClock.adjust(less1ms(MACHINE_CALL_TIMEOUT));
        probeDesktop(200, viewOf(LAPTOP_ID));
        probeAir(...notHere);
        const toDesktop = yield* notCut(desktop.next(ANSWER));
        yield* TestClock.adjust(less1ms(MACHINE_WRITE_TIMEOUT));
        toDesktop(200, viewOf(LAPTOP_ID));
        expect((yield* Fiber.join(page)).inboxId).toBe(LAPTOP_ID);
        yield* Fiber.join(closing);
        expect(Duration.toMillis(SERVE_SHUTDOWN_GRACE)).toBeGreaterThan(
          Duration.toMillis(FORWARDED_WRITE_WORST),
        );
      }).pipe(Effect.scoped),
  );
});

describe('serve’s Inbox machines at start-up and on a re-read', () => {
  const listed = (
    entries: ReadonlyArray<InboxMachineEntry>,
    herdrTimedOut?: string,
  ): InboxMachinesRead => ({
    _tag: 'Listed',
    configPath: '/c/config.json',
    entries,
    ...(herdrTimedOut === undefined ? {} : { herdrTimedOut }),
  });
  const invalid: InboxMachinesRead = {
    _tag: 'Invalid',
    configPath: '/c/config.json',
    problem: 'inboxMachines — Expected an array',
  };
  const unreadable: InboxMachinesRead = {
    _tag: 'Unreadable',
    problem: 'config.json at /c/config.json is not valid JSON: Unexpected end',
  };

  // Serve starts with the machines off, and the banner says why,
  // in the whole-file failure's words.
  it('starts with the machines off when config.json or its inboxMachines cannot be read', () => {
    expect(servedAtStartup(invalid)).toEqual({
      entries: [],
      machinesOff:
        'config.json at /c/config.json: inboxMachines — Expected an array',
    });
    expect(servedAtStartup(unreadable)).toEqual({
      entries: [],
      machinesOff: unreadable.problem,
    });
    const laptop = entry('laptop', 3010);
    expect(servedAtStartup(listed([laptop]))).toEqual({ entries: [laptop] });
  });

  // A re-read that cannot
  // read the machines keeps the list, and says on the page why it is stale.
  it('a re-read that cannot read inboxMachines keeps the list, and sets the banner', () => {
    const last: ServedMachines = { entries: [entry('laptop', 3010)] };
    const after = servedAfterReRead(last, invalid);
    expect(after.served.entries).toEqual(last.entries);
    expect(after.served.machinesOff).toBe(
      'config.json at /c/config.json: inboxMachines — Expected an array; serve keeps the Inbox machine it read before',
    );
    expect(after.problem).toContain('inboxMachines — Expected an array');
    // With none to keep, the banner is the problem alone.
    expect(
      servedAfterReRead({ entries: [] }, unreadable).served.machinesOff,
    ).toBe(unreadable.problem);
    // Once it reads again, the list is replaced and the banner goes.
    const desktop = entry('desktop', 3011);
    expect(servedAfterReRead(after.served, listed([desktop]))).toEqual({
      served: { entries: [desktop] },
    });
  });

  it('a re-read that Herdr did not answer keeps what serve had', () => {
    const last: ServedMachines = { entries: [entry('laptop', 3010)] };
    const after = servedAfterReRead(
      last,
      listed([unresolvedEntry('laptop', 3010, 'slow', 'HerdrUnread')], 'slow'),
    );
    expect(after).toEqual({ served: last, problem: 'slow' });
  });

  // What serve had was kept under the banner, because
  // config.json could not be read. This read found config.json readable, so
  // the banner no longer holds: the machines it lists are served, unresolved
  // with Herdr's sentence, rather than the banner saying config.json is
  // broken until Herdr next answers.
  it('a re-read that Herdr did not answer clears a banner config.json no longer earns', () => {
    const desktop = unresolvedEntry('desktop', 3011, 'slow', 'HerdrUnread');
    for (const last of [
      { entries: [], machinesOff: invalid.problem },
      {
        entries: [entry('laptop', 3010)],
        machinesOff: `${invalid.problem}; serve keeps the Inbox machine it read before`,
      },
    ] satisfies ReadonlyArray<ServedMachines>)
      expect(servedAfterReRead(last, listed([desktop], 'slow'))).toEqual({
        served: { entries: [desktop] },
        problem: 'slow',
      });
  });

  it('refuses serve on a machine’s tunnel port, and allows port 0', () => {
    const machines = [entry('laptop', 3010)];
    expect(servePortClash(3010, machines)).toContain('"laptop"');
    expect(servePortClash(3011, machines)).toBeUndefined();
    expect(servePortClash(0, machines)).toBeUndefined();
  });

  it.effect('serve refuses to start on a machine’s tunnel port', () =>
    Effect.gen(function* () {
      const e = yield* serveOn(
        3010,
        undefined,
        fixedServeMachines([entry('laptop', 3010)]),
      ).pipe(Effect.flip);
      expect(e).toBeInstanceOf(InputError);
      expect(e.message).toContain('--port 3010');
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, InboxLogInMemory)),
    ),
  );
});

// The owner lookup carried out across two machines:
// `desktop` is configured first, so a lookup that asks in turn asks it first.
describe('operator-inbox serve — the owner lookup across two machines', () => {
  it.live(
    'the last board’s owner is asked first, and its InboxUnavailable is the answer',
    () =>
      Effect.gen(function* () {
        const laptop = yield* stubMachine({
          board: boardOf([LAPTOP_ID]),
          view: () => storeDown,
        });
        const desktop = yield* stubMachine({ view: () => notHere });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        yield* local.api.inbox.board({ query: {} });
        const e = yield* local.api.inbox
          .view({ query: {}, params: { inboxId: LAPTOP_ID } })
          .pipe(Effect.flip);
        expect(e).toBeInstanceOf(InboxUnavailable);
        expect(e instanceof InboxUnavailable && e.machine?.label).toBe(
          'laptop',
        );
        expect(laptop.viewed).toEqual([LAPTOP_ID]);
        // It did not go on to ask the other machine.
        expect(desktop.viewed).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live('the board records each Inbox’s owner, asked first next time', () =>
    Effect.gen(function* () {
      const laptop = yield* stubMachine({
        board: boardOf([LAPTOP_ID]),
        view: (id) => [200, viewOf(InboxId.make(id))],
      });
      const desktop = yield* stubMachine({ view: () => notHere });
      const local = yield* startLocal([
        entry('desktop', desktop.port),
        entry('laptop', laptop.port),
      ]);
      yield* local.api.inbox.board({ query: {} });
      const view = yield* local.api.inbox.view({
        query: {},
        params: { inboxId: LAPTOP_ID },
      });
      expect(view.machine?.label).toBe('laptop');
      expect(desktop.viewed).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    'a machine asked in turn that cannot be reached does not end the lookup',
    () =>
      Effect.gen(function* () {
        const down = yield* closedPort;
        const desktop = yield* stubMachine({
          view: (id) => [200, viewOf(InboxId.make(id))],
        });
        const local = yield* startLocal([
          entry('laptop', down),
          entry('desktop', desktop.port),
        ]);
        const view = yield* local.api.inbox.view({
          query: {},
          params: { inboxId: LAPTOP_ID },
        });
        expect(view.machine?.label).toBe('desktop');
      }).pipe(Effect.scoped),
  );

  it.live(
    'when no machine has the Inbox and one could not be reached, it is unavailable, not missing',
    () =>
      Effect.gen(function* () {
        const down = yield* closedPort;
        const desktop = yield* stubMachine({ view: () => notHere });
        const local = yield* startLocal([
          entry('laptop', down),
          entry('desktop', desktop.port),
        ]);
        const e = yield* local.api.inbox
          .view({ query: {}, params: { inboxId: NOWHERE_ID } })
          .pipe(Effect.flip);
        expect(e).toBeInstanceOf(InboxUnavailable);
        expect(e instanceof InboxUnavailable && e.machine?.label).toBe(
          'laptop',
        );
        expect(desktop.viewed).toEqual([NOWHERE_ID]);
      }).pipe(Effect.scoped),
  );
});

// A clash and the owner lookup's failure policy (core's
// `decideInboxOwner`), carried out across two stand-in machines.
describe('operator-inbox serve — an Inbox two machines claim, and asking at once', () => {
  const answerOf = (inboxId: InboxId) => ({
    query: {},
    params: { inboxId, number: n(1) },
    payload: { response: 'main', seenRevision: r(1) },
  });
  const hasIt = (id: string) => [200, viewOf(InboxId.make(id))] as const;

  it.live(
    'an Inbox two machines’ boards claim is refused, and nothing is sent to either',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: boardOf([LAPTOP_ID]),
          view: hasIt,
        });
        const laptop = yield* stubMachine({
          board: boardOf([LAPTOP_ID]),
          view: hasIt,
        });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const claimants = [
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ];
        const board = yield* local.api.inbox.board({ query: {} });
        expect(board.inboxes.map((i) => i.inboxId)).toEqual([]);
        expect(board.views).toEqual([]);
        expect(board.clashes).toEqual([
          {
            inboxId: LAPTOP_ID,
            outcome: 'refused',
            claims: claimants.map((machine) => ({
              machine,
              label: 'orchard',
            })),
          },
        ]);
        const e = yield* local.api.inbox
          .answer(answerOf(LAPTOP_ID))
          .pipe(Effect.flip);
        expect(e).toBeInstanceOf(InboxUnavailable);
        expect(e instanceof InboxUnavailable && e.clashedOn).toEqual(claimants);
        expect(e.message).toBe(inboxClashSentence(LAPTOP_ID, claimants));
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );

  // Two board reads overlap. The first reaches laptop before laptop
  // claims the Inbox and is answered late; the second starts after it, sees
  // the clash and finishes first. The first finishing last must not undo the
  // clash the newer read found: the write is still sent to neither.
  it.live(
    'an older board read finishing last does not forget a clash a newer one found',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: boardOf([LAPTOP_ID]),
          view: hasIt,
        });
        // laptop holds the older read's board until the newer read is done,
        // and says when the older read has reached it.
        let reachedLaptop = (): void => {};
        const reached = new Promise<void>((resolve) => {
          reachedLaptop = resolve;
        });
        let releaseOlder = (): void => {};
        const released = new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
        const laptop = yield* stubMachine({
          board: (nth) => {
            if (nth !== 0) return [boardOf([LAPTOP_ID]), 0];
            reachedLaptop();
            return [boardOf([]), released];
          },
          view: hasIt,
        });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const older = yield* Effect.forkChild(
          local.api.inbox.board({ query: {} }),
        );
        yield* Effect.promise(() => reached);
        const newer = yield* local.api.inbox.board({ query: {} });
        expect(newer.clashes?.map((c) => c.outcome)).toEqual(['refused']);
        releaseOlder();
        expect((yield* Fiber.join(older)).clashes ?? []).toEqual([]);
        const e = yield* local.api.inbox
          .answer(answerOf(LAPTOP_ID))
          .pipe(Effect.flip);
        expect(e instanceof InboxUnavailable && e.clashedOn).toEqual([
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ]);
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'with no board yet, a write finds its owner by a view to every machine at once, and goes to that one alone',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({ view: () => notHere });
        const laptop = yield* stubMachine({ view: hasIt });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const view = yield* local.api.inbox.answer(answerOf(LAPTOP_ID));
        expect(view.machine).toEqual(refOf('laptop', laptop.port));
        expect(desktop.calls).toEqual([`GET /api/inbox/${LAPTOP_ID}`]);
        expect(laptop.calls).toEqual([
          `GET /api/inbox/${LAPTOP_ID}`,
          `POST /api/inbox/${LAPTOP_ID}/questions/1/answer`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'two machines found to have an Inbox no board listed are a clash, the write sent to neither',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({ view: hasIt });
        const laptop = yield* stubMachine({ view: hasIt });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const e = yield* local.api.inbox
          .answer(answerOf(LAPTOP_ID))
          .pipe(Effect.flip);
        expect(e instanceof InboxUnavailable && e.clashedOn).toEqual([
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ]);
        expect([...desktop.calls, ...laptop.calls]).toEqual([
          `GET /api/inbox/${LAPTOP_ID}`,
          `GET /api/inbox/${LAPTOP_ID}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'the machines are asked at once: two that hang cost one timeout',
    () =>
      Effect.gen(function* () {
        const silent = () => listening(tracked(createNetServer(() => {})));
        const a = yield* silent();
        const b = yield* silent();
        const local = yield* startLocal([entry('a', a), entry('b', b)]);
        const started = yield* Clock.currentTimeMillis;
        const e = yield* local.api.inbox
          .view({ query: {}, params: { inboxId: NOWHERE_ID } })
          .pipe(Effect.flip);
        const took = (yield* Clock.currentTimeMillis) - started;
        expect(e).toBeInstanceOf(InboxUnavailable);
        expect(e instanceof InboxUnavailable && e.machine).toEqual(
          refOf('a', a),
        );
        // One read timeout (600 ms), not one for each machine.
        expect(took).toBeLessThan(1000);
      }).pipe(Effect.scoped),
  );

  it.live(
    'an Inbox Local has is Local’s, whatever a machine claims, and the machine is never asked',
    () =>
      Effect.gen(function* () {
        const laptop = yield* stubMachine({
          board: boardOf([LOCAL_ID]),
          view: hasIt,
        });
        const local = yield* startLocal([entry('laptop', laptop.port)]);
        yield* seedInbox(LOCAL_ID, 'alpha', 'Pick a store').pipe(
          Effect.provide(local.context),
        );
        const board = yield* local.api.inbox.board({ query: {} });
        expect(board.clashes?.map((c) => [c.inboxId, c.outcome])).toEqual([
          [LOCAL_ID, 'kept-on-local'],
        ]);
        const view = yield* local.api.inbox.view({
          query: {},
          params: { inboxId: LOCAL_ID },
        });
        expect([view.label, view.machine]).toEqual(['alpha', undefined]);
        expect(laptop.calls).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

// A clash under flapping: a machine that misses a read
// still claims what it last had, so an id it shares with another machine
// stays refused, shown as a clash, and no write is sent to either. A claimant
// misses a read here by answering what does not decode (incompatible), at
// once, so no test waits on a timeout.
describe('operator-inbox serve — a clash outlives a missed read', () => {
  const X = LAPTOP_ID;
  const garbled = [{} as unknown as InboxBoardDto, 0] as const;
  const answerX = {
    query: {},
    params: { inboxId: X, number: n(1) },
    payload: { response: 'main', seenRevision: r(1) },
  };
  const hasIt = (id: string) => [200, viewOf(InboxId.make(id))] as const;

  it.live(
    'a clash is kept while one claimant misses a read, and no write is sent',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: boardOf([X]),
          view: hasIt,
        });
        const laptop = yield* stubMachine({
          board: (nth) => (nth === 0 ? [boardOf([X]), 0] : garbled),
          view: hasIt,
        });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const claimants = [
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ];
        const first = yield* local.api.inbox.board({ query: {} });
        expect(first.clashes?.map((c) => c.outcome)).toEqual(['refused']);
        const missed = yield* local.api.inbox.board({ query: {} });
        expect(missed.machines?.map((m) => m.status)).toEqual([
          'local',
          'reachable',
          'incompatible',
        ]);
        expect(missed.inboxes.map((i) => i.inboxId)).toEqual([]);
        expect(missed.clashes).toEqual([
          {
            inboxId: X,
            outcome: 'refused',
            claims: claimants.map((machine) => ({
              machine,
              label: 'orchard',
            })),
          },
        ]);
        const e = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
        expect(e instanceof InboxUnavailable && e.clashedOn).toEqual(claimants);
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'an id two machines claimed on different reads, never together, is refused',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: (nth) => (nth === 0 ? garbled : [boardOf([X]), 0]),
          view: hasIt,
        });
        const laptop = yield* stubMachine({
          board: (nth) => (nth === 0 ? [boardOf([X]), 0] : garbled),
          view: hasIt,
        });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const first = yield* local.api.inbox.board({ query: {} });
        expect(first.inboxes.map((i) => i.machine?.label)).toEqual(['laptop']);
        const second = yield* local.api.inbox.board({ query: {} });
        expect(second.inboxes).toEqual([]);
        expect(second.clashes?.map((c) => c.outcome)).toEqual(['refused']);
        const e = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
        expect(e instanceof InboxUnavailable && e.clashedOn).toEqual([
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ]);
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

// What each
// machine claims holds while the machines serve can call change under it.
describe('operator-inbox serve — claims while the machines change', () => {
  const X = LAPTOP_ID;
  const answerX = {
    query: {},
    params: { inboxId: X, number: n(1) },
    payload: { response: 'main', seenRevision: r(1) },
  };
  const hasIt = (id: string) => [200, viewOf(InboxId.make(id))] as const;
  // Machines a test changes between requests, as a re-read would.
  const changing = (first: ReadonlyArray<InboxMachineEntry>) => {
    let entries = first;
    return {
      machines: Effect.sync((): ServedMachines => ({ entries })),
      set: (next: ReadonlyArray<InboxMachineEntry>) => {
        entries = next;
      },
    };
  };

  it.live(
    'a claimant that can no longer be called keeps the clash refused, and nothing is sent',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: boardOf([X]),
          view: hasIt,
        });
        const laptop = yield* stubMachine({ board: boardOf([X]), view: hasIt });
        const config = changing([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const local = yield* startLocalServing(config.machines);
        const claimants = [
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ];
        const first = yield* local.api.inbox.board({ query: {} });
        expect(first.clashes?.map((c) => c.outcome)).toEqual(['refused']);
        // laptop's Herdr profile is gone, and then Herdr itself times out.
        for (const now of [
          [
            entry('desktop', desktop.port),
            unresolvedEntry('laptop', laptop.port, 'gone'),
          ],
          [
            unresolvedEntry(
              'desktop',
              desktop.port,
              'Herdr timed out',
              'HerdrUnread',
            ),
            unresolvedEntry(
              'laptop',
              laptop.port,
              'Herdr timed out',
              'HerdrUnread',
            ),
          ],
        ]) {
          config.set(now);
          const e = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
          expect(e instanceof InboxUnavailable && e.clashedOn).toEqual(
            claimants,
          );
          const v = yield* local.api.inbox
            .view({ query: {}, params: { inboxId: X } })
            .pipe(Effect.flip);
          expect(v instanceof InboxUnavailable && v.clashedOn).toEqual(
            claimants,
          );
        }
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'an Inbox only a machine that can no longer be called claims is unreachable, never not found',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: boardOf([]),
          view: () => notHere,
        });
        const laptop = yield* stubMachine({ board: boardOf([X]), view: hasIt });
        const config = changing([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        const local = yield* startLocalServing(config.machines);
        yield* local.api.inbox.board({ query: {} });
        for (const now of [
          [
            entry('desktop', desktop.port),
            unresolvedEntry('laptop', laptop.port, 'gone'),
          ],
          // A Herdr timeout leaves no machine callable.
          [
            unresolvedEntry(
              'desktop',
              desktop.port,
              'Herdr timed out',
              'HerdrUnread',
            ),
            unresolvedEntry(
              'laptop',
              laptop.port,
              'Herdr timed out',
              'HerdrUnread',
            ),
          ],
        ]) {
          config.set(now);
          const e = yield* local.api.inbox
            .view({ query: {}, params: { inboxId: X } })
            .pipe(Effect.flip);
          expect(e).toBeInstanceOf(InboxUnavailable);
          expect(e instanceof InboxUnavailable && e.machine).toEqual(
            refOf('laptop', laptop.port),
          );
          expect(e.message).toMatch(
            /^the Inbox machine laptop could not be reached: /,
          );
        }
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );

  // Claims are kept by tunnel port. A machine that leaves its
  // port leaves none of its claims to the machine that takes it next.
  it.live(
    'a port another machine takes keeps none of the claims of the one that left it',
    () =>
      Effect.gen(function* () {
        const laptop = yield* stubMachine({ board: boardOf([X]), view: hasIt });
        const desktop = yield* stubMachine({
          board: boardOf([X]),
          view: hasIt,
        });
        const config = changing([entry('laptop', laptop.port)]);
        const local = yield* startLocalServing(config.machines);
        yield* local.api.inbox.board({ query: {} });
        // laptop moves off its port, and `ghost`, not resolved, takes it.
        config.set([
          unresolvedEntry('ghost', laptop.port, 'no such profile'),
          entry('desktop', desktop.port),
        ]);
        const board = yield* local.api.inbox.board({ query: {} });
        expect(board.clashes).toEqual([]);
        expect(board.inboxes.map((i) => [i.inboxId, i.machine?.label])).toEqual(
          [[X, 'desktop']],
        );
        const view = yield* local.api.inbox.answer(answerX);
        expect(view.machine).toEqual(refOf('desktop', desktop.port));
      }).pipe(Effect.scoped),
  );

  // Renaming an entry's selector to one Herdr does not
  // resolve drops the claims its old selector made, but the machine is still
  // configured and cannot be called, so serve cannot say the Inbox does not
  // exist: it is unreachable, never a 404.
  it.live(
    'an Inbox no machine asked has, while a machine cannot be called, is unreachable, never not found',
    () =>
      Effect.gen(function* () {
        const laptop = yield* stubMachine({ board: boardOf([X]), view: hasIt });
        const desktop = yield* stubMachine({ view: () => notHere });
        const config = changing([entry('laptop', laptop.port)]);
        const local = yield* startLocalServing(config.machines);
        yield* local.api.inbox.board({ query: {} });
        config.set([
          unresolvedEntry('laptop-typo', laptop.port, 'no such profile'),
        ]);
        const renamed = yield* local.api.inbox
          .answer(answerX)
          .pipe(Effect.flip);
        expect(renamed).toBeInstanceOf(InboxUnavailable);
        expect(renamed.message).toBe(
          'the Inbox machine laptop-typo could not be reached: no such profile',
        );
        expect(renamed instanceof InboxUnavailable && renamed.machine).toEqual(
          refOf('laptop-typo', laptop.port),
        );
        // Every machine asked lacks it, and one could not be asked.
        config.set([
          entry('desktop', desktop.port),
          unresolvedEntry('laptop-typo', laptop.port, 'no such profile'),
        ]);
        const lacked = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
        expect(lacked).toBeInstanceOf(InboxUnavailable);
        expect(lacked.message).toBe(
          'the Inbox machine laptop-typo could not be reached: no such profile',
        );
        expect(desktop.calls).toEqual([
          `POST /api/inbox/${X}/questions/1/answer`,
        ]);
        // Herdr unread: no machine can be called, and none is recorded.
        const ghost = changing([
          unresolvedEntry('laptop', 4101, 'herdr timed out', 'HerdrUnread'),
          unresolvedEntry('desktop', 4102, 'herdr timed out', 'HerdrUnread'),
        ]);
        const fresh = yield* startLocalServing(ghost.machines);
        const both = yield* fresh.api.inbox.answer(answerX).pipe(Effect.flip);
        expect(both).toBeInstanceOf(InboxUnavailable);
        expect(both.message).toBe(
          `no Inbox machine asked has inbox ${X}, and the Inbox machines laptop, desktop could not be reached, so it may be on one of them: laptop: herdr timed out; desktop: herdr timed out`,
        );
        expect(laptop.calls).toEqual([]);
        // With every machine asked lacking it and none left uncalled, it does
        // not exist.
        config.set([entry('desktop', desktop.port)]);
        const gone = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
        expect(gone).toBeInstanceOf(InboxNotFound);
      }).pipe(Effect.scoped),
  );

  // A second selector for a Herdr machine already listed
  // is refused, and its port's claims, made under the old selector, are the
  // same machine's: one machine never clashes with itself.
  it.live('a second selector for a machine already listed makes no clash', () =>
    Effect.gen(function* () {
      // The one Herdr machine, reached through either tunnel.
      const viaOld = yield* stubMachine({ board: boardOf([X]), view: hasIt });
      const viaNew = yield* stubMachine({ board: boardOf([X]), view: hasIt });
      const asX = (label: string, port: number): InboxMachineEntry => {
        const e = entry(label, port);
        return Result.isSuccess(e.resolved)
          ? {
              ...e,
              resolved: Result.succeed({
                ...e.resolved.success,
                herdrId: HerdrMachineId.make('id-X'),
              }),
            }
          : e;
      };
      const config = changing([asX('X-id', viaOld.port)]);
      const local = yield* startLocalServing(config.machines);
      yield* local.api.inbox.board({ query: {} });
      const refused = unresolvedEntry(
        'X-id',
        viaOld.port,
        '"X-id" names the same Herdr machine as "laptop", already listed',
      );
      config.set([
        asX('laptop', viaNew.port),
        Result.isFailure(refused.resolved)
          ? {
              ...refused,
              resolved: Result.fail({
                ...refused.resolved.failure,
                sameMachineAs: HerdrMachineId.make('id-X'),
              }),
            }
          : refused,
      ]);
      for (const _ of [1, 2]) {
        const board = yield* local.api.inbox.board({ query: {} });
        expect(board.clashes).toEqual([]);
        expect(board.inboxes.map((i) => [i.inboxId, i.machine?.label])).toEqual(
          [[X, 'laptop']],
        );
      }
      const view = yield* local.api.inbox.answer(answerX);
      expect(view.machine).toEqual(refOf('laptop', viaNew.port));
    }).pipe(Effect.scoped),
  );

  // The page gives up on a board read a hanging machine holds
  // open. The machines that read reached record their claims all the same.
  it.live(
    'a board read the page gives up on still records the machines it reached',
    () =>
      Effect.gen(function* () {
        const desktop = yield* stubMachine({
          board: boardOf([X]),
          view: hasIt,
        });
        // laptop claims X, and then says it lacks it.
        const laptop = yield* stubMachine({
          board: boardOf([X]),
          view: () => notHere,
        });
        const silent = yield* listening(tracked(createNetServer(() => {})));
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
          entry('silent', silent),
        ]);
        const read = yield* Effect.forkChild(
          local.api.inbox.board({ query: {} }),
        );
        // Local reads desktop and laptop, which answer at once, and records each
        // one's claims as its read completes, while silent holds the board
        // read open: the page gives up once both are recorded.
        const reached = [
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ];
        yield* SubscriptionRef.changes(local.lastOwners).pipe(
          Stream.filter(({ claims }) =>
            reached.every((m) => claims.byMachine.has(m.key)),
          ),
          Stream.runHead,
        );
        expect(read.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(read);
        const e = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
        expect(e instanceof InboxUnavailable && e.clashedOn).toEqual([
          refOf('desktop', desktop.port),
          refOf('laptop', laptop.port),
        ]);
        expect([...desktop.calls, ...laptop.calls]).toEqual([]);
      }).pipe(Effect.scoped),
  );

  // A machine's read that completes records its claims,
  // wherever the read waiting on it is interrupted. The stand-in read
  // yields `pad` times before it completes, as a real one waits on the
  // network; with the scheduler yielding every 3 and every 4 steps, and the
  // read interrupted after each number of the test's own yields in turn,
  // between them an interruption falls at every boundary, the one between a
  // read completing and its claims being recorded included.
  it.effect('a machine read that completes always records its claims', () =>
    Effect.gen(function* () {
      const laptop = entry('laptop', 4201);
      const outcomes = new Set<string>();
      for (const every of [3, 4])
        for (let pad = 0; pad < 5; pad += 1)
          for (let step = 0; step < 16; step += 1) {
            const lastOwners = yield* SubscriptionRef.make({
              claims: NO_INBOX_CLAIMS,
              next: 0,
            });
            let completed = false;
            const done = Effect.sync(() => {
              completed = true;
              return {
                status: 'reachable' as const,
                value: { inboxes: boardOf([X]).inboxes },
              };
            });
            const fetch = () =>
              Effect.forEach(
                Array.from({ length: pad }),
                () => Effect.yieldNow,
              ).pipe(Effect.andThen(done));
            const read = yield* Effect.forkChild(
              readMachines(fetch).pipe(
                Effect.provideService(ServedInboxMachines, {
                  machines: served([laptop]),
                  lastOwners,
                  keepWrite: detachedWrite,
                }),
                Effect.provideService(Scheduler.MaxOpsBeforeYield, every),
              ),
              { startImmediately: true },
            );
            for (let i = 0; i < step; i += 1) yield* Effect.yieldNow;
            yield* Fiber.interrupt(read);
            const { claims } = yield* SubscriptionRef.get(lastOwners);
            const recorded = claims.byMachine.has(laptop.key);
            outcomes.add(`${completed}/${recorded}`);
            expect({ every, pad, step, recorded }).toEqual({
              every,
              pad,
              step,
              recorded: completed,
            });
          }
      // The sweep interrupted reads both before and after they completed.
      expect([...outcomes].sort()).toEqual(['false/false', 'true/true']);
    }),
  );

  // A config that swaps two machines' places, on the same ports,
  // names the claimants in its new section order.
  it.live('a clash names its claimants in section order after a reorder', () =>
    Effect.gen(function* () {
      const desktop = yield* stubMachine({ board: boardOf([X]), view: hasIt });
      const laptop = yield* stubMachine({ board: boardOf([X]), view: hasIt });
      const config = changing([
        entry('desktop', desktop.port),
        entry('laptop', laptop.port),
      ]);
      const local = yield* startLocalServing(config.machines);
      yield* local.api.inbox.board({ query: {} });
      config.set([
        entry('laptop', laptop.port),
        entry('desktop', desktop.port),
      ]);
      const e = yield* local.api.inbox.answer(answerX).pipe(Effect.flip);
      expect(e instanceof InboxUnavailable && e.clashedOn).toEqual([
        refOf('laptop', laptop.port),
        refOf('desktop', desktop.port),
      ]);
    }).pipe(Effect.scoped),
  );

  // Only Local's InboxNotFound sends a call
  // on: Local's own refusal of an Inbox it has comes back as it is.
  it.live('Local’s own refusal is never sent on to the machines', () =>
    Effect.gen(function* () {
      const laptop = yield* stubMachine({ view: () => notHere });
      const local = yield* startLocal([entry('laptop', laptop.port)]);
      yield* seedInbox(LOCAL_ID, 'alpha', 'Pick a store').pipe(
        Effect.provide(local.context),
      );
      const answer = {
        query: {},
        params: { inboxId: LOCAL_ID, number: n(1) },
        payload: { response: 'main', seenRevision: r(1) },
      };
      yield* local.api.inbox.answer(answer);
      const e = yield* local.api.inbox.answer(answer).pipe(Effect.flip);
      expect(e).toBeInstanceOf(AnswerRefused);
      expect(laptop.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

// A call goes one level and no further: every call Local's serve makes to a
// machine carries `local=true`, and a serve that receives it answers from
// its own log.
describe('operator-inbox serve — a call to a machine goes no further', () => {
  // A client calling a machine-style serve (its guard on 7184) the way a
  // serve that lists it would, but WITHOUT `local=true`: as Local's own page
  // calls Local.
  const callerOf = (port: number) =>
    HttpApiClient.make(OperatorInboxApi, {
      baseUrl: `http://${SERVE_HOST}:${port}`,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader('host', INBOX_MACHINE_HOST),
      ),
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

  it.live(
    'two machines that list each other answer InboxNotFound at once, not after the timeout',
    () =>
      Effect.gen(function* () {
        let aPort = 0;
        let bPort = 0;
        const a = yield* startMachine(
          Effect.sync(() => ({ entries: [entry('b', bPort)] })),
        );
        const b = yield* startMachine(
          Effect.sync(() => ({ entries: [entry('a', aPort)] })),
        );
        aPort = a.port;
        bPort = b.port;
        yield* seedInbox(LAPTOP_ID, 'orchard', 'Pick a branch').pipe(
          Effect.provide(b.context),
        );
        const api = yield* callerOf(a.port);
        const started = yield* Clock.currentTimeMillis;
        const e = yield* api.inbox
          .view({ query: {}, params: { inboxId: NOWHERE_ID } })
          .pipe(Effect.flip);
        const took = (yield* Clock.currentTimeMillis) - started;
        expect(e).toBeInstanceOf(InboxNotFound);
        expect(took).toBeLessThan(Duration.toMillis(TIMEOUT));
        // The Inbox b holds is still reached through a, named as b's.
        const view = yield* api.inbox.view({
          query: {},
          params: { inboxId: LAPTOP_ID },
        });
        expect([view.label, view.machine?.label]).toEqual(['orchard', 'b']);
      }).pipe(Effect.scoped),
  );

  it.live('an Inbox two machines away is not reached through Local', () =>
    Effect.gen(function* () {
      // Local lists laptop, laptop lists desktop, and desktop owns the Inbox.
      const desktop = yield* startMachine();
      yield* seedInbox(DESKTOP_ID, 'kiln', 'Fire it').pipe(
        Effect.provide(desktop.context),
      );
      const laptop = yield* startMachine(
        served([entry('desktop', desktop.port)]),
      );
      const local = yield* startLocal([entry('laptop', laptop.port)]);
      const viewed = yield* local.api.inbox
        .view({ query: {}, params: { inboxId: DESKTOP_ID } })
        .pipe(Effect.flip);
      expect(viewed).toBeInstanceOf(InboxNotFound);
      const answered = yield* local.api.inbox
        .answer({
          query: {},
          params: { inboxId: DESKTOP_ID, number: n(1) },
          payload: { response: 'now', seenRevision: r(1) },
        })
        .pipe(Effect.flip);
      expect(answered).toBeInstanceOf(InboxNotFound);
      // Nothing was written on desktop.
      const onDesktop = yield* inboxView(DESKTOP_ID).pipe(
        Effect.provide(desktop.context),
      );
      expect(onDesktop.awaitingAgent).toEqual([]);
      // laptop, asked directly, still finds it on desktop: only Local's calls
      // stop at one level.
      const direct = yield* (yield* callerOf(laptop.port)).inbox.view({
        query: {},
        params: { inboxId: DESKTOP_ID },
      });
      expect(direct.machine?.label).toBe('desktop');
    }).pipe(Effect.scoped),
  );

  it.live(
    'a read for Local’s serve leaves the owners the last board recorded',
    () =>
      Effect.gen(function* () {
        const laptop = yield* stubMachine({
          board: boardOf([LAPTOP_ID]),
          view: (id) => [200, viewOf(InboxId.make(id))],
        });
        const desktop = yield* stubMachine({ view: () => notHere });
        const local = yield* startLocal([
          entry('desktop', desktop.port),
          entry('laptop', laptop.port),
        ]);
        yield* local.api.inbox.board({ query: {} });
        // Local's serve reading this one: its board and its index merge
        // nothing, so neither may wipe what the full board recorded.
        yield* local.api.inbox.board({ query: { local: 'true' } });
        yield* local.api.inbox.index({ query: { local: 'true' } });
        const view = yield* local.api.inbox.view({
          query: {},
          params: { inboxId: LAPTOP_ID },
        });
        expect(view.machine?.label).toBe('laptop');
        // laptop, the recorded owner, was asked first: desktop never was.
        expect(desktop.viewed).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

describe('serve re-reads its Inbox machines when they are needed', () => {
  // What a read lists: one machine, `label`, unresolved (so nothing is
  // called), as a relabelled Herdr profile would be.
  const listedAs = (label: string): InboxMachinesRead => ({
    _tag: 'Listed',
    configPath: '/c/config.json',
    entries: [unresolvedEntry(label, 3990, 'stand-in')],
  });
  // A stand-in for `readInboxMachines`: each read finds the machine under a
  // new label, unless `next` says otherwise for that read.
  const counted = (
    next: (read: number) => InboxMachinesRead | undefined = () => undefined,
  ) => {
    const reads = { count: 0 };
    const load = Effect.sync((): InboxMachinesRead => {
      reads.count += 1;
      return next(reads.count) ?? listedAs(`m${reads.count}`);
    });
    return { reads, load };
  };

  const boardOn = (machines: ServeMachines) =>
    inboxBoard({}).pipe(
      Effect.provide(servedInboxMachinesLayer(machines.current)),
    );
  // The machines' sections, Local's left out.
  const indexOf = (machines: ServeMachines) =>
    inboxIndex({}).pipe(
      Effect.map((index) =>
        index.machines?.filter((m) => m.status !== 'local'),
      ),
      Effect.provide(servedInboxMachinesLayer(machines.current)),
    );
  const labelsOf = (machines: ServeMachines) =>
    Effect.map(indexOf(machines), (ms) => ms?.map((m) => m.label));

  // A config.json listing `laptop` on 3990, and a stand-in `herdr` running
  // `script` for every call, in a fresh directory: the env serve reads them
  // with.
  const herdrStandIn = (script: (dir: string) => ReadonlyArray<string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-inbox-herdr-'));
    mkdirSync(join(dir, 'operator-inbox'));
    writeFileSync(
      join(dir, 'operator-inbox', 'config.json'),
      JSON.stringify({
        inboxMachines: [{ herdrMachine: 'laptop', port: 3990 }],
      }),
    );
    const herdr = join(dir, 'herdr');
    writeFileSync(herdr, ['#!/bin/sh', ...script(dir)].join('\n'));
    chmodSync(herdr, 0o755);
    const env = Layer.merge(
      NodeServices.layer,
      ConfigProvider.layer(
        envProvider({ XDG_CONFIG_HOME: dir, OPERATOR_INBOX_HERDR_BIN: herdr }),
      ),
    );
    return { dir, env };
  };
  const HERDR_LAPTOP = JSON.stringify([
    {
      id: 'm1',
      label: 'laptop',
      target: 'operator@laptop',
      session: 'main',
      enabled: true,
      selected: false,
    },
  ]);

  it.effect(
    'start-up reads once, and the inbox re-reads at most once a SERVED_MACHINES_TTL',
    () =>
      Effect.gen(function* () {
        const { reads, load } = counted();
        const machines = yield* serveMachinesFrom(7184, load);
        expect(reads.count).toBe(1);
        expect(
          servedAtStartup(machines.loaded).entries.map((m) => m.label),
        ).toEqual(['m1']);
        // Start-up's read serves until the TTL passes: herdr is not run again.
        expect(yield* labelsOf(machines)).toEqual(['m1']);
        yield* TestClock.adjust('29 seconds');
        expect(yield* labelsOf(machines)).toEqual(['m1']);
        expect(reads.count).toBe(1);
        yield* TestClock.adjust('1 second');
        // The request that finds the TTL passed starts the re-read and
        // answers at once with what it has: it never waits on Herdr.
        expect(yield* labelsOf(machines)).toEqual(['m1']);
        yield* machines.settled;
        expect(yield* labelsOf(machines)).toEqual(['m2']);
        expect(yield* labelsOf(machines)).toEqual(['m2']);
        expect(reads.count).toBe(2);
        expect(SERVED_MACHINES_TTL).toEqual(Duration.seconds(30));
      }).pipe(Effect.provide(InboxLogInMemory)),
  );

  // Requests that come while a re-read runs (the page polls
  // every few seconds, and Herdr may take its time) start no second one.
  it.effect('a request while a re-read runs starts no second re-read', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const reads = { count: 0 };
      const load = Effect.gen(function* () {
        reads.count += 1;
        const read = listedAs(`m${reads.count}`);
        if (reads.count > 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(gate);
        }
        return read;
      });
      const machines = yield* serveMachinesFrom(7184, load);
      yield* TestClock.adjust(SERVED_MACHINES_TTL);
      expect(yield* labelsOf(machines)).toEqual(['m1']);
      yield* Deferred.await(started);
      // Requests while that re-read waits on Herdr answer with the list
      // serve has, and start none of their own: any they started would be
      // waited on by `settled` below, and counted.
      for (const _ of [1, 2, 3])
        expect(yield* labelsOf(machines)).toEqual(['m1']);
      yield* Deferred.succeed(gate, undefined);
      yield* machines.settled;
      expect(yield* labelsOf(machines)).toEqual(['m2']);
      expect(reads.count).toBe(2);
    }).pipe(Effect.provide(InboxLogInMemory)),
  );

  // A re-read whose load dies still clears its mark, so the next
  // request re-reads rather than none ever again.
  it.effect('a re-read that dies leaves the next request free to re-read', () =>
    Effect.gen(function* () {
      const reads = { count: 0 };
      const load = Effect.suspend(() => {
        reads.count += 1;
        return reads.count === 2
          ? Effect.die(new Error('the load died'))
          : Effect.succeed(listedAs(`m${reads.count}`));
      });
      const machines = yield* serveMachinesFrom(7184, load);
      yield* TestClock.adjust(SERVED_MACHINES_TTL);
      expect(yield* labelsOf(machines)).toEqual(['m1']);
      yield* machines.settled;
      expect(reads.count).toBe(2);
      expect(yield* labelsOf(machines)).toEqual(['m1']);
      yield* machines.settled;
      expect(reads.count).toBe(3);
      expect(yield* labelsOf(machines)).toEqual(['m3']);
    }).pipe(Effect.provide(InboxLogInMemory)),
  );

  // The page aborts each poll's request when it sends the next,
  // so an abort can land anywhere in one. With the scheduler yielding after
  // every other step (the least it can be: at 1 it never resumes), an abort
  // is tried at every step of a request that starts a
  // re-read: none may leave the re-read marked running with none running,
  // which would stop every re-read after it for good.
  it.effect('an aborted request never leaves a re-read marked as running', () =>
    Effect.gen(function* () {
      const { reads, load } = counted();
      const machines = yield* serveMachinesFrom(7184, load);
      // Yielding every 2 and every 3 steps, between them, puts a yield at
      // every boundary in the request.
      for (const every of [2, 3])
        for (let step = 0; step < 40; step += 1) {
          yield* TestClock.adjust(SERVED_MACHINES_TTL);
          const fiber = yield* Effect.forkChild(
            machines.current.pipe(
              Effect.provideService(Scheduler.MaxOpsBeforeYield, every),
            ),
            { startImmediately: true },
          );
          for (let i = 0; i < step; i += 1) yield* Effect.yieldNow;
          yield* Fiber.interrupt(fiber);
          yield* machines.settled;
        }
      // A request a TTL on still re-reads.
      const before = reads.count;
      yield* TestClock.adjust(SERVED_MACHINES_TTL);
      yield* machines.current;
      yield* machines.settled;
      expect(reads.count).toBe(before + 1);
    }),
  );

  // A Herdr that hangs: `herdr machine list` never answers. The re-read runs
  // in the background, so a request on Local's own Inboxes answers at once
  // with the list serve has; the re-read gives Herdr up at its time limit,
  // ends its process, and keeps the list read before, saying so in the log.
  it.live(
    'a hanging Herdr never holds up a request, and its re-read keeps the last list',
    () => {
      const warnings: Array<string> = [];
      const collect = Logger.make((o) => {
        if (o.logLevel === 'Warn') warnings.push(String(o.message));
      });
      return Effect.gen(function* () {
        const { dir, env } = herdrStandIn((d) => [
          `if [ -e '${join(d, 'hang')}' ]; then echo $$ > '${join(d, 'herdr.pid')}'; exec sleep 20; fi`,
          `echo '${HERDR_LAPTOP}'`,
        ]);
        const hang = join(dir, 'hang');
        const pidFile = join(dir, 'herdr.pid');
        // Start-up is given all the time it needs; the re-read 2 s.
        const first = yield* readInboxMachines('20 seconds').pipe(
          Effect.provide(env),
        );
        const load = readInboxMachines('2 seconds').pipe(Effect.provide(env));
        expect(servedAtStartup(first).entries.map((e) => e.label)).toEqual([
          'laptop',
        ]);
        const { current } = yield* reloadingServedMachines(
          servedAtStartup(first),
          load,
          '50 millis',
        );
        writeFileSync(hang, '');
        // A real wait, not the TestClock: Herdr here is a real process, given
        // up on and ended on the real clock (the 2 s bound, the kill's grace).
        // This one lets the 50 ms re-read interval pass.
        yield* Effect.sleep('100 millis');
        const read = inboxIndex({}).pipe(
          Effect.provide(
            servedInboxMachinesLayer(current, { timeout: TIMEOUT }),
          ),
        );
        // This read starts the re-read; it and the next answer at once.
        for (const _ of [1, 2]) {
          const [took, index] = yield* Effect.timed(read);
          // Well inside the 2 s the re-read gives Herdr.
          expect(Duration.toMillis(took)).toBeLessThan(1000);
          expect(index.machines?.map((m) => m.label)).toEqual([
            'Local',
            'laptop',
          ]);
        }
        // Herdr hung; the re-read gave it up and ended it. Polled on the
        // real clock, bounded at 5 s, since the process is real: the poll
        // ends as soon as the warning is logged and the process is gone.
        const timedOut = "'herdr machine list --json' did not answer within 2s";
        const gone = () => {
          if (!existsSync(pidFile)) return false;
          try {
            process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0);
            return false;
          } catch {
            return true;
          }
        };
        for (
          let i = 0;
          i < 100 && !(warnings.join('\n').includes(timedOut) && gone());
          i += 1
        )
          yield* Effect.sleep('50 millis');
        expect(warnings.join('\n')).toContain(timedOut);
        expect(existsSync(pidFile)).toBe(true);
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        expect(() => process.kill(pid, 0)).toThrow();
        // The list read before is kept: laptop is still resolved, still called.
        // (Herdr answers again first, so the re-read this read starts leaves
        // nothing running.)
        rmSync(hang);
        const after = yield* read;
        expect(after.machines?.[1]).toMatchObject({
          label: 'laptop',
          reason: 'tunnel-down',
        });
      }).pipe(
        Effect.provide(InboxLogInMemory),
        Effect.provide(Logger.layer([collect])),
      );
    },
  );

  // Serve stopped while a re-read waits on a Herdr that hangs
  // and ignores SIGTERM. Herdr runs in a process group of its own, so only
  // serve can end it: closing serve's Scope waits for it to be ended (SIGKILL
  // after the 500 ms grace), so it is gone by the time serve has stopped.
  it.live('stopping serve during a re-read ends the Herdr it waits on', () =>
    Effect.gen(function* () {
      const { dir, env } = herdrStandIn((d) => [
        `if [ -e '${join(d, 'hang')}' ]; then trap '' TERM; echo $$ > '${join(d, 'herdr.pid')}'; exec sleep 20; fi`,
        `echo '${HERDR_LAPTOP}'`,
      ]);
      const pidFile = join(dir, 'herdr.pid');
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const serveScope = yield* Scope.make();
      const load = readInboxMachines('10 seconds').pipe(Effect.provide(env));
      const { current } = yield* reloadingServedMachines(
        servedAtStartup(yield* load.pipe(Scope.provide(serveScope))),
        load,
        '50 millis',
      ).pipe(Scope.provide(serveScope));
      writeFileSync(join(dir, 'hang'), '');
      // Real waits, not the TestClock: Herdr here is a real process that
      // serve's Scope must end. The first lets the 50 ms re-read interval
      // pass; the poll, bounded at 5 s, waits for Herdr to have started.
      yield* Effect.sleep('100 millis');
      yield* current;
      for (let i = 0; i < 100 && !existsSync(pidFile); i += 1)
        yield* Effect.sleep('50 millis');
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      try {
        expect(alive(pid)).toBe(true);
        const [took] = yield* Effect.timed(Scope.close(serveScope, Exit.void));
        expect(alive(pid)).toBe(false);
        expect(Duration.toMillis(took)).toBeLessThan(2000);
      } finally {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }),
  );

  // The re-read itself is serve's, not detached: stopping serve
  // interrupts one still running.
  it.effect('stopping serve interrupts a re-read still running', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const load = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      const serveScope = yield* Scope.make();
      const { current } = yield* reloadingServedMachines(
        servedAtStartup(listedAs('m1')),
        load,
      ).pipe(Scope.provide(serveScope));
      yield* TestClock.adjust(SERVED_MACHINES_TTL);
      yield* current;
      yield* Deferred.await(started);
      yield* Scope.close(serveScope, Exit.void);
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
    }),
  );

  // A Herdr that ignores SIGTERM (`trap '' TERM`, which `exec`
  // keeps) under a 2 s bound. Ending a timed-out read waits for its process
  // to die, so without a kill that does not wait on SIGTERM, or a bound that
  // does not wait on the ending, the read returns only when `sleep 8` does,
  // and a re-read stays marked running all that time.
  it.live(
    'a Herdr that ignores SIGTERM never holds the read past its bound',
    () =>
      Effect.gen(function* () {
        const { dir, env } = herdrStandIn((d) => [
          "trap '' TERM",
          `echo $$ > '${join(d, 'herdr.pid')}'`,
          'exec sleep 8',
        ]);
        // 2 s, so the stand-in has started under a loaded test run.
        const [took, read] = yield* Effect.timed(
          readInboxMachines('2 seconds').pipe(Effect.provide(env)),
        );
        try {
          expect(read).toMatchObject({
            _tag: 'Listed',
            herdrTimedOut:
              "'herdr machine list --json' did not answer within 2s",
          });
          expect(Duration.toMillis(took)).toBeLessThan(3500);
        } finally {
          try {
            const pidFile = join(dir, 'herdr.pid');
            process.kill(
              Number(readFileSync(pidFile, 'utf8').trim()),
              'SIGKILL',
            );
          } catch {}
        }
      }),
  );

  // The last hop of the chain `serve` runs through (`serveCommand` →
  // `serveOn` → `serveAppLayer`): the listener's inbox reads `current` on
  // each request, not the list start-up read. The whole chain, from argv, is
  // pinned in serve.test.ts ("re-reads its Inbox machines once the TTL
  // passes").
  it.live(
    'the app serve launches reads its machines afresh on each request',
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const current = Effect.sync((): ServedMachines => {
          reads += 1;
          return { entries: [unresolvedEntry(`m${reads}`, 3990, 'stand-in')] };
        });
        const context = yield* Layer.build(
          serveAppLayer(0, undefined, {
            ...fixedServeMachines([]),
            current,
          }).pipe(
            Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
            Layer.provideMerge(NodeServices.layer),
          ),
        );
        const port = portOf(Context.get(context, HttpServer.HttpServer));
        const api = yield* HttpApiClient.make(OperatorInboxApi, {
          baseUrl: `http://${SERVE_HOST}:${port}`,
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const first = yield* api.inbox.board({ query: {} });
        const second = yield* api.inbox.board({ query: {} });
        expect(
          [first, second].map((b) => b.machines?.map((m) => m.label)),
        ).toEqual([
          ['Local', 'm1'],
          ['Local', 'm2'],
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    'a re-read that cannot decode inboxMachines keeps the last list, warns, and sets the banner',
    () => {
      const warnings: Array<string> = [];
      const collect = Logger.make((o) => {
        if (o.logLevel === 'Warn') warnings.push(String(o.message));
      });
      return Effect.gen(function* () {
        const { reads, load } = counted((read) =>
          read === 2
            ? {
                _tag: 'Invalid',
                configPath: '/c/config.json',
                problem: 'inboxMachines — a typo',
              }
            : undefined,
        );
        const machines = yield* serveMachinesFrom(7184, load);
        yield* TestClock.adjust(SERVED_MACHINES_TTL);
        yield* labelsOf(machines);
        yield* machines.settled;
        expect(yield* labelsOf(machines)).toEqual(['m1']);
        expect((yield* boardOn(machines)).machinesOff).toBe(
          'config.json at /c/config.json: inboxMachines — a typo; serve keeps the Inbox machine it read before',
        );
        expect(reads.count).toBe(2);
        expect(warnings.join('\n')).toContain('inboxMachines — a typo');
        // Once config.json reads again, so do the machines, and the banner
        // goes.
        yield* TestClock.adjust(SERVED_MACHINES_TTL);
        yield* labelsOf(machines);
        yield* machines.settled;
        expect(yield* labelsOf(machines)).toEqual(['m3']);
        expect((yield* boardOn(machines)).machinesOff).toBeUndefined();
      }).pipe(
        Effect.provide(InboxLogInMemory),
        Effect.provide(Logger.layer([collect])),
      );
    },
  );

  // A problem that lasts is said once, not on every re-read;
  // said again when it changes, and its end said once.
  it.effect(
    'a lasting problem is logged once, again when it changes, and its end once',
    () => {
      const logged: Array<readonly [string, string]> = [];
      const collect = Logger.make((o) => {
        logged.push([o.logLevel, String(o.message)]);
      });
      const typo = (problem: string): InboxMachinesRead => ({
        _tag: 'Invalid',
        configPath: '/c/config.json',
        problem,
      });
      return Effect.gen(function* () {
        const { reads, load } = counted((read) =>
          read >= 2 && read <= 5
            ? typo('inboxMachines — a typo')
            : read >= 6 && read <= 7
              ? typo('inboxMachines — another typo')
              : undefined,
        );
        const machines = yield* serveMachinesFrom(7184, load);
        for (const _ of Array.from({ length: 9 })) {
          yield* TestClock.adjust(SERVED_MACHINES_TTL);
          yield* labelsOf(machines);
          yield* machines.settled;
        }
        expect(reads.count).toBe(10);
        expect(logged).toEqual([
          [
            'Warn',
            'could not re-read the Inbox machines (config.json at /c/config.json: inboxMachines — a typo); said once, and again only when this changes',
          ],
          [
            'Warn',
            'could not re-read the Inbox machines (config.json at /c/config.json: inboxMachines — another typo); said once, and again only when this changes',
          ],
          [
            'Info',
            're-read the Inbox machines: the earlier problem (config.json at /c/config.json: inboxMachines — another typo) no longer holds',
          ],
        ]);
      }).pipe(
        Effect.provide(InboxLogInMemory),
        Effect.provide(Logger.layer([collect])),
      );
    },
  );

  // Start-up says its own problem, so the first re-read that
  // finds the same one says nothing.
  it.effect(
    'a problem start-up found is not logged again by the first re-read',
    () => {
      const logged: Array<readonly [string, string]> = [];
      const collect = Logger.make((o) => {
        logged.push([o.logLevel, String(o.message)]);
      });
      return Effect.gen(function* () {
        const { load } = counted((read) =>
          read <= 2
            ? {
                _tag: 'Invalid',
                configPath: '/c/config.json',
                problem: 'inboxMachines — a typo',
              }
            : undefined,
        );
        const machines = yield* serveMachinesFrom(7184, load);
        for (const _ of [1, 2]) {
          yield* TestClock.adjust(SERVED_MACHINES_TTL);
          yield* labelsOf(machines);
          yield* machines.settled;
        }
        expect(logged).toEqual([
          [
            'Info',
            're-read the Inbox machines: the earlier problem (config.json at /c/config.json: inboxMachines — a typo) no longer holds',
          ],
        ]);
      }).pipe(
        Effect.provide(InboxLogInMemory),
        Effect.provide(Logger.layer([collect])),
      );
    },
  );

  it.effect(
    'a machine a re-read finds on serve’s own port is unresolved, saying why',
    () =>
      Effect.gen(function* () {
        const { load } = counted((read) => ({
          _tag: 'Listed',
          configPath: '/c/config.json',
          entries: read === 1 ? [] : [entry('late', 3990)],
        }));
        const machines = yield* serveMachinesFrom(3990, load);
        yield* TestClock.adjust(SERVED_MACHINES_TTL);
        yield* indexOf(machines);
        yield* machines.settled;
        const [late] = (yield* indexOf(machines)) ?? [];
        expect(late).toMatchObject({
          label: 'late',
          status: 'unreachable',
          reason: 'unresolved',
        });
        expect(late?.status === 'unreachable' && late.detail).toContain(
          "serve's own --port",
        );
      }).pipe(Effect.provide(InboxLogInMemory)),
  );

  // The machine on serve's own
  // port is never called, but it could hold any Inbox, so an id no machine
  // was asked for is unavailable, naming it, never not found.
  it.effect(
    'an id while a machine sits on serve’s own port is unavailable, not unknown',
    () =>
      Effect.gen(function* () {
        const { load } = counted((read) => ({
          _tag: 'Listed',
          configPath: '/c/config.json',
          entries: read === 1 ? [] : [entry('late', 3990)],
        }));
        const machines = yield* serveMachinesFrom(3990, load);
        yield* TestClock.adjust(SERVED_MACHINES_TTL);
        yield* indexOf(machines);
        yield* machines.settled;
        // Through the app serve launches, since the lookup is its handlers'.
        const context = yield* Layer.build(
          serveAppLayer(0, undefined, machines).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        );
        const api = yield* HttpApiClient.make(OperatorInboxApi, {
          baseUrl: `http://${SERVE_HOST}:${portOf(Context.get(context, HttpServer.HttpServer))}`,
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const refused = yield* api.inbox
          .view({ params: { inboxId: NOWHERE_ID }, query: {} })
          .pipe(Effect.flip);
        expect(refused).toBeInstanceOf(InboxUnavailable);
        expect(refused.message).toContain('late');
      }).pipe(Effect.scoped, Effect.provide(InboxLogInMemory)),
  );
});
