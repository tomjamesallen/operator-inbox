import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  createServer as createNetServer,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  HerdrMachineId,
  INBOX_MACHINE_HOST,
  type InboxMachineEntry,
  InboxMachinePort,
} from '@operator-inbox/core';
import {
  inboxMachineKey,
  LOCAL_MACHINE,
  LOCAL_MACHINE_KEY,
  OperatorInboxApi,
  type WidgetDto,
  WidgetNotFound,
  WidgetsUnavailable,
} from '@operator-inbox/core/api';
import {
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Result,
  type Scope,
} from 'effect';
import { FetchHttpClient, HttpServer } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { envProvider } from '../src/env-config';
import { InboxLogInMemory } from '../src/inbox-store';
import { servedInboxMachinesLayer } from '../src/serve-inbox-machines';
import { makeServeLayer, SERVE_HOST } from '../src/serve-server';

// Local's widgets fan-out and forwarded runs, with Local's real serve on a
// real listener (temp config and state folders, no widgets of its own) and
// stand-in machines behind their "tunnel" ports: `node:http` servers that
// answer the widgets endpoints with fixed JSON, as a machine's serve asked
// with `local=true` does, and record every call they take.

const TIMEOUT = '600 millis';

// One configured machine, resolved against a Herdr profile of its label.
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

// One that names no usable Herdr profile, so it is never called.
const unresolvedEntry = (
  label: string,
  port: number,
  reason: string,
): InboxMachineEntry => ({
  key: inboxMachineKey(InboxMachinePort.make(port)),
  label,
  port: InboxMachinePort.make(port),
  herdrMachine: label,
  resolved: Result.fail({
    _tag: 'Unusable',
    herdrMachine: label,
    port: InboxMachinePort.make(port),
    reason,
  }),
});

const keyOf = (port: number) => inboxMachineKey(InboxMachinePort.make(port));

const widgetOf = (id: string, label: string): WidgetDto => ({
  id,
  label,
  format: 'text',
  lines: 1,
  intervalSeconds: 60,
  timeoutSeconds: 10,
  running: false,
  runningSince: null,
  refreshQueued: false,
  lastRun: null,
  lastOk: null,
  nextRunAt: null,
});

// A machine's own widgets, as its serve answers them under Local's key.
const ownWidgets = (
  widgets: ReadonlyArray<WidgetDto>,
  problems: ReadonlyArray<string> = [],
  now = 1_700_000_000_000,
) => ({
  machines: [
    {
      key: LOCAL_MACHINE_KEY,
      label: LOCAL_MACHINE,
      status: 'local',
      widgets,
      problems,
      now,
    },
  ],
});

// One call a stand-in took.
interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly host: string | undefined;
  readonly body: string;
}

const sockets = new WeakMap<Server, Set<Socket>>();

// A listener for the length of the test's scope; every connection it took is
// destroyed on release.
const listening = (server: Server) => {
  const open = new Set<Socket>();
  sockets.set(server, open);
  server.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  });
  return Effect.acquireRelease(
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
};

// A port nothing listens on: bound by the OS, then closed.
const closedPort = Effect.callback<number>((resume) => {
  const s = createNetServer();
  s.listen(0, SERVE_HOST, () => {
    const address = s.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    s.close(() => resume(Effect.succeed(port)));
  });
});

// What a stand-in answers: `widgets` for a read and `opened`, and a run of
// one of their ids with them too; a run of any other id is the machine's
// WidgetNotFound. `old` answers every widgets route as a serve that predates
// widgets does: 404, text. `garbage` answers 200 with a body that is not the
// contract's.
type Behaviour =
  | { readonly _tag: 'widgets'; readonly widgets: unknown }
  | { readonly _tag: 'old' }
  | { readonly _tag: 'garbage' };

const standIn = (behaviour: Behaviour) => {
  const calls: Array<Call> = [];
  const server = createHttpServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        host: req.headers.host,
        body,
      });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (behaviour._tag === 'old') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such API route\n');
        return;
      }
      if (behaviour._tag === 'garbage') return json(200, { widgets: 'none' });
      if (url.pathname === '/api/widgets/run') {
        const { id } = JSON.parse(body) as { id: string };
        const known = JSON.stringify(behaviour.widgets).includes(
          `"id":"${id}"`,
        );
        return known
          ? json(200, behaviour.widgets)
          : json(404, {
              message: `No widget ${id} here.`,
              _tag: 'WidgetNotFound',
            });
      }
      return json(200, behaviour.widgets);
    });
  });
  return Effect.map(listening(server), (port) => ({ port, calls }));
};

// Local's serve, the very layer `serve` runs, with the given machines, and a
// client of it.
const startLocal = (entries: ReadonlyArray<InboxMachineEntry>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      makeServeLayer(0, undefined).pipe(
        Layer.provideMerge(
          servedInboxMachinesLayer(Effect.succeed({ entries }), {
            timeout: TIMEOUT,
            writeTimeout: TIMEOUT,
          }),
        ),
        Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const { address } = Context.get(context, HttpServer.HttpServer);
    if (!NetAddress.isInetAddress(address)) throw new Error('not TCP');
    return yield* HttpApiClient.make(OperatorInboxApi, {
      baseUrl: `http://${SERVE_HOST}:${address.port}`,
    }).pipe(Effect.provide(FetchHttpClient.layer));
  });

// Temp config and state folders, with no widgets.json: Local has no widgets
// of its own, so nothing is spawned.
const inTemp = <A, E>(effect: Effect.Effect<A, E, never>) =>
  effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      (() => {
        const xdg = mkdtempSync(
          path.join(tmpdir(), 'operator-inbox-widgets-machines-'),
        );
        return envProvider({
          XDG_CONFIG_HOME: path.join(xdg, 'config'),
          XDG_STATE_HOME: path.join(xdg, 'state'),
        });
      })(),
    ),
  );

const scopedInTemp = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  inTemp(Effect.scoped(effect));

const LOAD = widgetOf('load', 'Load');
const DISK = widgetOf('disk-use', 'Disk use');

const widgetCalls = (calls: ReadonlyArray<Call>) =>
  calls.map((c) => `${c.method} ${c.path}`);

describe('operator-inbox serve — other machines’ widgets', () => {
  it.live(
    'merges every machine’s widgets after Local’s, rekeyed as the board keys them',
    () =>
      scopedInTemp(
        Effect.gen(function* () {
          const laptop = yield* standIn({
            _tag: 'widgets',
            widgets: ownWidgets([LOAD], [], 1_700_000_000_500),
          });
          const desk = yield* standIn({
            _tag: 'widgets',
            widgets: ownWidgets([DISK], ['widgets.1 \u001b[31mbad\u001b[0m']),
          });
          const api = yield* startLocal([
            entry('laptop', laptop.port),
            unresolvedEntry('attic', 3901, 'no Herdr machine is named attic'),
            entry('desk', desk.port),
          ]);
          const read = yield* api.widgets.read({ query: {} });
          expect(read.machines.map((m) => [m.key, m.label, m.status])).toEqual([
            [LOCAL_MACHINE_KEY, LOCAL_MACHINE, 'local'],
            [keyOf(laptop.port), 'laptop', 'reachable'],
            [keyOf(3901), 'attic', 'unreachable'],
            [keyOf(desk.port), 'desk', 'reachable'],
          ]);
          const [local, onLaptop, attic, onDesk] = read.machines;
          expect(local?.widgets).toEqual([]);
          expect(onLaptop?.widgets).toEqual([LOAD]);
          // Its own clock, as it answered.
          expect(onLaptop?.now).toBe(1_700_000_000_500);
          expect(attic).toMatchObject({
            reason: 'unresolved',
            detail: 'no Herdr machine is named attic',
            widgets: [],
            problems: [],
          });
          expect(onDesk?.widgets).toEqual([DISK]);
          // A machine's words are passed on as text, its escapes dropped.
          expect(onDesk?.problems).toEqual(['widgets.1 bad']);
          // Every call names the machine's own serve and asks for its own.
          for (const call of [...laptop.calls, ...desk.calls]) {
            expect(call.host).toBe(INBOX_MACHINE_HOST);
            expect(call.query.local).toBe('true');
          }
        }),
      ),
  );

  it.live('a read is `watching` on the machines only when Local’s is', () =>
    scopedInTemp(
      Effect.gen(function* () {
        const laptop = yield* standIn({
          _tag: 'widgets',
          widgets: ownWidgets([LOAD]),
        });
        const api = yield* startLocal([entry('laptop', laptop.port)]);
        yield* api.widgets.read({ query: { watching: 'true' } });
        yield* api.widgets.read({ query: {} });
        expect(laptop.calls.map((c) => [c.method, c.path, c.query])).toEqual([
          ['GET', '/api/widgets', { local: 'true', watching: 'true' }],
          ['GET', '/api/widgets', { local: 'true' }],
        ]);
      }),
    ),
  );

  it.live('a read with `local=true` answers Local’s alone, calling none', () =>
    scopedInTemp(
      Effect.gen(function* () {
        const laptop = yield* standIn({
          _tag: 'widgets',
          widgets: ownWidgets([LOAD]),
        });
        const api = yield* startLocal([entry('laptop', laptop.port)]);
        const read = yield* api.widgets.read({ query: { local: 'true' } });
        expect(read.machines.map((m) => m.key)).toEqual([LOCAL_MACHINE_KEY]);
        const opened = yield* api.widgets.opened({ query: { local: 'true' } });
        expect(opened.machines.map((m) => m.key)).toEqual([LOCAL_MACHINE_KEY]);
        expect(laptop.calls).toEqual([]);
      }),
    ),
  );

  it.live(
    'an unreachable machine gives why, with no widgets, and fails nothing',
    () =>
      scopedInTemp(
        Effect.gen(function* () {
          const port = yield* closedPort;
          const laptop = yield* standIn({
            _tag: 'widgets',
            widgets: ownWidgets([LOAD]),
          });
          const api = yield* startLocal([
            entry('gone', port),
            entry('laptop', laptop.port),
          ]);
          const read = yield* api.widgets.read({ query: { watching: 'true' } });
          expect(read.machines[1]).toMatchObject({
            key: keyOf(port),
            label: 'gone',
            status: 'unreachable',
            reason: 'tunnel-down',
            widgets: [],
          });
          expect(read.machines[1]?.detail).toContain(`port ${port}`);
          expect(read.machines[2]?.widgets).toEqual([LOAD]);
        }),
      ),
  );

  it.live(
    'an older serve’s 404, or an answer that does not decode, is no widgets on a reachable machine',
    () =>
      scopedInTemp(
        Effect.gen(function* () {
          const old = yield* standIn({ _tag: 'old' });
          const odd = yield* standIn({ _tag: 'garbage' });
          const api = yield* startLocal([
            entry('old', old.port),
            entry('odd', odd.port),
          ]);
          for (const answer of [
            yield* api.widgets.read({ query: { watching: 'true' } }),
            yield* api.widgets.opened({ query: {} }),
          ]) {
            const [, onOld, onOdd] = answer.machines;
            for (const section of [onOld, onOdd]) {
              expect(section?.status).toBe('reachable');
              expect(section?.widgets).toEqual([]);
              expect(section?.problems).toEqual([]);
              expect(section).not.toHaveProperty('reason');
              expect(section).not.toHaveProperty('detail');
            }
          }
          expect(widgetCalls(old.calls)).toEqual([
            'GET /api/widgets',
            'POST /api/widgets/opened',
          ]);
        }),
      ),
  );

  it.live('`opened` is sent on to every machine', () =>
    scopedInTemp(
      Effect.gen(function* () {
        const laptop = yield* standIn({
          _tag: 'widgets',
          widgets: ownWidgets([LOAD]),
        });
        const desk = yield* standIn({
          _tag: 'widgets',
          widgets: ownWidgets([DISK]),
        });
        const api = yield* startLocal([
          entry('laptop', laptop.port),
          entry('desk', desk.port),
        ]);
        const opened = yield* api.widgets.opened({ query: {} });
        expect(opened.machines.map((m) => m.widgets.map((w) => w.id))).toEqual([
          [],
          ['load'],
          ['disk-use'],
        ]);
        for (const calls of [laptop.calls, desk.calls])
          expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
            ['POST', '/api/widgets/opened', { local: 'true' }],
          ]);
      }),
    ),
  );

  it.live(
    'a run on a machine is forwarded to that machine alone, by its id alone',
    () =>
      scopedInTemp(
        Effect.gen(function* () {
          const laptop = yield* standIn({
            _tag: 'widgets',
            widgets: ownWidgets([LOAD]),
          });
          const desk = yield* standIn({
            _tag: 'widgets',
            widgets: ownWidgets([DISK]),
          });
          const api = yield* startLocal([
            entry('laptop', laptop.port),
            entry('desk', desk.port),
          ]);
          const ran = yield* api.widgets.run({
            query: {},
            payload: { machine: keyOf(laptop.port), id: 'load' },
          });
          // The run's answer is the whole snapshot, the laptop's section
          // from the run itself: it is not read again.
          expect(ran.machines.map((m) => [m.key, m.widgets])).toEqual([
            [LOCAL_MACHINE_KEY, []],
            [keyOf(laptop.port), [LOAD]],
            [keyOf(desk.port), [DISK]],
          ]);
          expect(laptop.calls).toHaveLength(1);
          const [call] = laptop.calls;
          expect(call).toMatchObject({
            method: 'POST',
            path: '/api/widgets/run',
            query: { local: 'true' },
            host: INBOX_MACHINE_HOST,
          });
          expect(JSON.parse(call?.body ?? '')).toEqual({ id: 'load' });
          expect(widgetCalls(desk.calls)).toEqual(['GET /api/widgets']);
          expect(desk.calls[0]?.query).toEqual({ local: 'true' });
        }),
      ),
  );

  it.live(
    'a run on an unknown machine, or of an id the machine lacks, is WidgetNotFound',
    () =>
      scopedInTemp(
        Effect.gen(function* () {
          const laptop = yield* standIn({
            _tag: 'widgets',
            widgets: ownWidgets([LOAD]),
          });
          const old = yield* standIn({ _tag: 'old' });
          const api = yield* startLocal([
            entry('laptop', laptop.port),
            entry('old', old.port),
          ]);
          const unknownMachine = yield* Effect.flip(
            api.widgets.run({
              query: {},
              payload: { machine: keyOf(3999), id: 'load' },
            }),
          );
          expect(unknownMachine).toBeInstanceOf(WidgetNotFound);
          const unknownId = yield* Effect.flip(
            api.widgets.run({
              query: {},
              payload: { machine: keyOf(laptop.port), id: 'nope' },
            }),
          );
          expect(unknownId).toBeInstanceOf(WidgetNotFound);
          // In Local's words, never the machine's.
          expect(unknownId.message).toBe(
            'The Inbox machine laptop has no widget nope.',
          );
          const onOld = yield* Effect.flip(
            api.widgets.run({
              query: {},
              payload: { machine: keyOf(old.port), id: 'load' },
            }),
          );
          expect(onOld).toBeInstanceOf(WidgetNotFound);
          // A run asked of a machine by Local never travels on.
          const travelled = yield* Effect.flip(
            api.widgets.run({
              query: { local: 'true' },
              payload: { machine: keyOf(laptop.port), id: 'load' },
            }),
          );
          expect(travelled).toBeInstanceOf(WidgetNotFound);
          expect(widgetCalls(laptop.calls)).toEqual(['POST /api/widgets/run']);
        }),
      ),
  );

  it.live(
    'a run on a machine that cannot be reached is WidgetsUnavailable, naming it',
    () =>
      scopedInTemp(
        Effect.gen(function* () {
          const port = yield* closedPort;
          const api = yield* startLocal([
            entry('gone', port),
            unresolvedEntry('attic', 3901, 'no Herdr machine is named attic'),
          ]);
          const down = yield* Effect.flip(
            api.widgets.run({
              query: {},
              payload: { machine: keyOf(port), id: 'load' },
            }),
          );
          expect(down).toBeInstanceOf(WidgetsUnavailable);
          if (!(down instanceof WidgetsUnavailable)) return;
          expect(down.machine).toEqual({ key: keyOf(port), label: 'gone' });
          expect(down.message).toContain(
            'the Inbox machine gone could not be reached',
          );
          const never = yield* Effect.flip(
            api.widgets.run({
              query: {},
              payload: { machine: keyOf(3901), id: 'load' },
            }),
          );
          expect(never).toBeInstanceOf(WidgetsUnavailable);
          expect(never.message).toBe(
            'the Inbox machine attic could not be reached: no Herdr machine is named attic',
          );
        }),
      ),
  );
});
