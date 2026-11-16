import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  HerdrMachineId,
  InboxId,
  type InboxMachineEntry,
  InboxMachinePort,
  QuestionNumber,
  QuestionRevision,
} from '@operator-inbox/core';
import {
  InboxNotFound,
  inboxMachineKey,
  OperatorInboxApi,
} from '@operator-inbox/core/api';
import { Cause, Context, Effect, Exit, Layer, Option, Result } from 'effect';
import { FetchHttpClient, HttpServer } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { dispatchAsk, dispatchOpen } from '../src/commands/inbox';
import { InboxLog, InboxLogInMemory } from '../src/inbox-store';
import { machinesAmong } from '../src/serve-inbox-api';
import { servedInboxMachinesLayer } from '../src/serve-inbox-machines';
import { makeServeLayer, SERVE_HOST } from '../src/serve-server';

// How Local's serve routes an endpoint keyed by an Inbox id, as Local's log
// sees it: Local's log is asked first, and once,
// whoever owns the Inbox. Local's serve runs as `serve` runs it, with an
// Inbox log that counts its reads, and one Inbox machine: a stand-in that
// answers every Inbox id with InboxNotFound and records each call.

const LOCAL_ID = InboxId.make('01INBOXROUTELOCAL000000000');
const LAPTOP_ID = InboxId.make('01INBOXROUTELAP00000000000');

// Every read of one Inbox in Local's log (`read`, and `readNamed` for a
// rename), by Inbox id.
const counted = (reads: Array<InboxId>) =>
  Layer.effect(
    InboxLog,
    Effect.gen(function* () {
      const log = yield* InboxLog;
      return InboxLog.of({
        ...log,
        read: (inboxId) => {
          reads.push(inboxId);
          return log.read(inboxId);
        },
        readNamed: (inboxId, label) => {
          reads.push(inboxId);
          return log.readNamed(inboxId, label);
        },
      });
    }),
  ).pipe(Layer.provide(Layer.fresh(InboxLogInMemory)));

// The stand-in machine: InboxNotFound for every call, each one recorded.
const machineWithNothing = Effect.gen(function* () {
  const calls: Array<string> = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ message: 'no such Inbox', _tag: 'InboxNotFound' }),
    );
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, SERVE_HOST, () =>
        resume(Effect.succeed((server.address() as AddressInfo).port)),
      );
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return { port, calls };
});

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

// Local's serve with `machines`, its log counting reads into `reads`, and
// one Inbox of its own with one question waiting.
const startLocal = (
  machines: ReadonlyArray<InboxMachineEntry>,
  reads: Array<InboxId>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      makeServeLayer(0, undefined).pipe(
        Layer.provide(
          servedInboxMachinesLayer(Effect.succeed({ entries: machines }), {
            timeout: '600 millis',
          }),
        ),
        Layer.provideMerge(counted(reads)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    yield* Effect.gen(function* () {
      yield* dispatchOpen({
        session: Option.none(),
        inbox: Option.none(),
        label: Option.some('alpha'),
        freshId: LOCAL_ID,
        cwd: '/w/alpha',
      });
      yield* dispatchAsk({ inboxId: LOCAL_ID, title: 'Pick one', body: '' });
    }).pipe(Effect.provide(context));
    const { address } = Context.get(context, HttpServer.HttpServer);
    if (!NetAddress.isInetAddress(address)) throw new Error('not TCP');
    const api = yield* HttpApiClient.make(OperatorInboxApi, {
      baseUrl: `http://${SERVE_HOST}:${address.port}`,
    }).pipe(Effect.provide(FetchHttpClient.layer));
    reads.length = 0;
    return api;
  });

describe('operator-inbox serve — Local’s log, asked once per Inbox id', () => {
  it.live('a view of a Local Inbox reads Local’s log once', () =>
    Effect.gen(function* () {
      const machine = yield* machineWithNothing;
      const reads: Array<InboxId> = [];
      const api = yield* startLocal([entry('laptop', machine.port)], reads);
      const view = yield* api.inbox.view({
        params: { inboxId: LOCAL_ID },
        query: {},
      });
      expect(view.label).toBe('alpha');
      expect(reads).toEqual([LOCAL_ID]);
      expect(machine.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  // Each write reads the Inbox to decide, and again to answer with its view:
  // with an Inbox machine configured, no more than with none.
  it.live('a write to a Local Inbox reads Local’s log as with no machine', () =>
    Effect.gen(function* () {
      const machine = yield* machineWithNothing;
      const write = (api: Effect.Success<ReturnType<typeof startLocal>>) =>
        Effect.gen(function* () {
          yield* api.inbox.answer({
            params: { inboxId: LOCAL_ID, number: QuestionNumber.make(1) },
            query: {},
            payload: {
              response: 'yes',
              seenRevision: QuestionRevision.make(1),
            },
          });
          yield* api.inbox.rename({
            params: { inboxId: LOCAL_ID },
            query: {},
            payload: { label: 'alpha-2' },
          });
        });
      const alone: Array<InboxId> = [];
      yield* write(yield* startLocal([], alone));
      const withMachine: Array<InboxId> = [];
      yield* write(
        yield* startLocal([entry('laptop', machine.port)], withMachine),
      );
      expect(withMachine).toEqual(alone);
      expect(machine.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    'an id Local lacks reads Local’s log once, then asks the machine',
    () =>
      Effect.gen(function* () {
        const machine = yield* machineWithNothing;
        const reads: Array<InboxId> = [];
        const api = yield* startLocal([entry('laptop', machine.port)], reads);
        const error = yield* Effect.flip(
          api.inbox.view({ params: { inboxId: LAPTOP_ID }, query: {} }),
        );
        expect(error).toBeInstanceOf(InboxNotFound);
        expect(reads).toEqual([LAPTOP_ID]);
        expect(machine.calls).toEqual([`GET /api/inbox/${LAPTOP_ID}`]);
      }).pipe(Effect.scoped),
  );
});

// Core's plan names only configured machines, so a key
// no entry has is Local's own bug. It dies naming the key, rather than the
// machine being left out of a round, a clash or a refusal without a word.
describe('machinesAmong', () => {
  const laptop = entry('laptop', 3010);
  const desktop = entry('desktop', 3011);

  it.effect(
    'gives the machines in section order, whatever order the keys',
    () =>
      Effect.gen(function* () {
        const machines = yield* machinesAmong(
          [laptop, desktop],
          [desktop.key, laptop.key],
        );
        expect(machines.map((m) => m.label)).toEqual(['laptop', 'desktop']);
      }),
  );

  it.effect('dies naming a key no configured machine has', () =>
    Effect.gen(function* () {
      const unknown = inboxMachineKey(InboxMachinePort.make(3999));
      const exit = yield* Effect.exit(
        machinesAmong([laptop, desktop], [laptop.key, unknown]),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        `no configured Inbox machine has the key ${unknown}`,
      );
    }),
  );
});
