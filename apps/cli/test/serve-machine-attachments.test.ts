import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  request,
  type ServerResponse,
} from 'node:http';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  type Attachment,
  HerdrMachineId,
  InboxId,
  type InboxMachineEntry,
  InboxMachinePort,
} from '@operator-inbox/core';
import {
  type InboxBoardDto,
  inboxMachineKey,
  OperatorInboxApi,
  SERVE_DEFAULT_PORT,
} from '@operator-inbox/core/api';
import {
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Result,
  Scope,
} from 'effect';
import { FetchHttpClient, HttpRouter, HttpServer } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { dispatchAsk, dispatchOpen } from '../src/commands/inbox';
import { AttachmentsRoot } from '../src/inbox-attachments';
import { InboxLogInMemory } from '../src/inbox-store';
import { attachmentRouteLive } from '../src/serve-attachments';
import { servedInboxMachinesLayer } from '../src/serve-inbox-machines';
import {
  localOnly,
  makeServeLayer,
  OperatorInboxApiLive,
  SERVE_HOST,
} from '../src/serve-server';

// A kept file of an Inbox another machine holds, read through Local's serve:
// `GET /api/attachments/<inbox>/<hash>/<name>` finds no such file in Local's
// folder and no such Inbox in Local's log, so it goes to the machine the
// board recorded as claiming the Inbox, and the bytes come back with Local's
// own headers. Two in-process serves on real listeners: Local, and a
// stand-in for the machine `laptop` behind its tunnel, running the real API,
// the real attachment route and the real `localOnly` guard, its address
// reported as 127.0.0.1:7184 as a real machine's is (see
// `serve-inbox-machines.test.ts`). Each has its own log and its own folder.

const TIMEOUT = '600 millis';
const LAPTOP_ID = InboxId.make('01INBOXLAPTOPFILES00000000');
const NOWHERE_ID = InboxId.make('01INBOXNOWHEREFILES0000000');
const HASH = '0123456789abcdef';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PAGE = Buffer.from('<script>x</script>', 'utf8');

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

const folder = (prefix: string) =>
  mkdtempSync(path.join(tmpdir(), `operator-inbox-${prefix}-`));

const rootLayer = (root: string) =>
  Layer.succeed(AttachmentsRoot, { root: Effect.succeed(root) });

const portOf = (server: HttpServer.HttpServer['Service']): number => {
  const { address } = server;
  if (NetAddress.isUnixPathAddress(address))
    throw new Error('not a TCP listener');
  return address.port;
};

// A file kept in `root` as the store keeps one, and the attachment naming it.
const keep = (root: string, name: string, bytes: Buffer): Attachment => {
  const dir = path.join(root, LAPTOP_ID, HASH);
  mkdirSync(dir, { recursive: true });
  const at = path.join(dir, name);
  writeFileSync(at, bytes);
  return {
    path: at,
    name,
    type: name.endsWith('.png') ? 'image/png' : 'text/html',
    bytes: bytes.byteLength,
  };
};

// The machine's serve, its address reported as 127.0.0.1:7184, holding one
// Inbox whose question carries `shot.png` and `page.html`, the body showing
// the first in place.
const startMachine = Effect.gen(function* () {
  const root = folder('machine-files');
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
    HttpRouter.serve(
      Layer.mergeAll(OperatorInboxApiLive, attachmentRouteLive),
      {
        middleware: localOnly,
        disableLogger: true,
        disableListenLog: true,
      },
    ).pipe(
      Layer.provide(
        Layer.succeedContext(
          Context.add(listener, HttpServer.HttpServer, asIfOn7184),
        ),
      ),
      Layer.provide(rootLayer(root)),
      Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
    ),
  );
  const attachments = [
    keep(root, 'shot.png', PNG),
    keep(root, 'page.html', PAGE),
  ];
  yield* Effect.gen(function* () {
    yield* dispatchOpen({
      session: Option.none(),
      inbox: Option.none(),
      label: Option.some('orchard'),
      freshId: LAPTOP_ID,
      cwd: '/w/orchard',
    });
    yield* dispatchAsk({
      inboxId: LAPTOP_ID,
      title: 'Does it look right?',
      body: 'Look:\n\n![the page](attachment:shot.png)',
      attachments,
    });
  }).pipe(Effect.provide(context));
  return { port: portOf(real) };
});

// Local's serve, the very layer `serve` runs, with `laptop` on `port` and an
// empty folder of its own.
const startLocal = (port: number) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      makeServeLayer(0, undefined).pipe(
        Layer.provideMerge(
          servedInboxMachinesLayer(
            Effect.succeed({ entries: [entry('laptop', port)] }),
            { timeout: TIMEOUT },
          ),
        ),
        Layer.provideMerge(rootLayer(folder('local-files'))),
        Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const localPort = portOf(Context.get(context, HttpServer.HttpServer));
    const api = yield* HttpApiClient.make(OperatorInboxApi, {
      baseUrl: `http://${SERVE_HOST}:${localPort}`,
    }).pipe(Effect.provide(FetchHttpClient.layer));
    return { port: localPort, api };
  });

interface Got {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

const get = (port: number, target: string) =>
  Effect.callback<Got, Error>((resume) => {
    const req = request({ hostname: SERVE_HOST, port, path: target }, (res) => {
      const chunks: Array<Buffer> = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resume(
          Effect.succeed({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        ),
      );
    });
    req.on('error', (e) => resume(Effect.fail(e)));
    req.end();
  });

const urlOf = (inboxId: string, name: string) =>
  `/api/attachments/${inboxId}/${HASH}/${encodeURIComponent(name)}`;

// A stand-in machine answering fixed JSON for its board, which lists
// LAPTOP_ID, and `file` for any `/api/attachments/…`, recording each such
// request as it came (path and query).
const stubMachine = (file: (res: ServerResponse) => void) => {
  const asked: Array<string> = [];
  const open = new Set<Socket>();
  const board: InboxBoardDto = {
    inboxes: [
      {
        inboxId: LAPTOP_ID,
        label: 'orchard',
        archived: false,
        pinned: false,
        awaitingOperator: 0,
        awaitingAgent: 0,
        processed: 0,
      },
    ],
    totalAwaitingOperator: 0,
    views: [],
  };
  const server: Server = createHttpServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/attachments/')) {
      asked.push(url);
      return file(res);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        url.startsWith('/api/inbox-board')
          ? board
          : { inboxes: board.inboxes, totalAwaitingOperator: 0 },
      ),
    );
  });
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
        for (const socket of open) socket.destroy();
      }),
  ).pipe(Effect.map((port) => ({ port, asked })));
};

describe('serve reads a kept file of another machine’s Inbox from that machine', () => {
  it.live('an image comes back as itself, with Local’s headers', () =>
    Effect.gen(function* () {
      const machine = yield* startMachine;
      const local = yield* startLocal(machine.port);
      // The board records which machine claims the Inbox.
      const board = yield* local.api.inbox.board({ query: {} });
      const q = board.views.find((v) => v.inboxId === LAPTOP_ID)
        ?.awaitingOperator[0];
      // The body's image is drawn again on Local, at Local's own URL.
      expect(q?.bodyImages).toStrictEqual(['shot.png']);
      expect(q?.bodyHtml).toContain(
        `<img src="${urlOf(LAPTOP_ID, 'shot.png')}" alt="the page"`,
      );
      const image = yield* get(local.port, urlOf(LAPTOP_ID, 'shot.png'));
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.headers['content-disposition']).toMatch(/^inline;/);
      expect(image.headers['x-content-type-options']).toBe('nosniff');
      expect(image.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
      expect(image.body).toStrictEqual(PNG);
      // Anything but a raster image is a download, never a page.
      const page = yield* get(local.port, urlOf(LAPTOP_ID, 'page.html'));
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('application/octet-stream');
      expect(page.headers['content-disposition']).toMatch(/^attachment;/);
      expect(page.body).toStrictEqual(PAGE);
      // Sandboxed and unframeable on Local as on its own machine: serve's
      // framing handler adds to the route's policy, never replaces it.
      for (const file of [image, page]) {
        expect(file.headers['content-security-policy']).toBe(
          "sandbox; default-src 'none', frame-ancestors 'none'",
        );
        expect(file.headers['x-frame-options']).toBe('DENY');
      }
    }).pipe(Effect.scoped),
  );

  it.live('a name the machine keeps no file of is not found', () =>
    Effect.gen(function* () {
      const machine = yield* startMachine;
      const local = yield* startLocal(machine.port);
      yield* local.api.inbox.board({ query: {} });
      const missing = yield* get(local.port, urlOf(LAPTOP_ID, 'gone.png'));
      expect(missing.status).toBe(404);
      // An Inbox no machine claims is not asked for at all.
      const nowhere = yield* get(local.port, urlOf(NOWHERE_ID, 'shot.png'));
      expect(nowhere.status).toBe(404);
      // A path that climbs is refused before anything is asked.
      const climbing = yield* get(
        local.port,
        `/api/attachments/${LAPTOP_ID}/..%2F..%2F/inbox.sqlite`,
      );
      expect(climbing.status).toBe(404);
    }).pipe(Effect.scoped),
  );

  it.live(
    'an owner that does not answer is unavailable within the timeout, and nothing is cached',
    () =>
      Effect.gen(function* () {
        // Answers its board, and never a file.
        const machine = yield* stubMachine(() => {});
        const local = yield* startLocal(machine.port);
        yield* local.api.inbox.board({ query: {} });
        const started = yield* Clock.currentTimeMillis;
        const got = yield* get(local.port, urlOf(LAPTOP_ID, 'shot.png'));
        const took = (yield* Clock.currentTimeMillis) - started;
        expect(got.status).toBe(503);
        expect(got.headers['cache-control']).toBe('no-store');
        expect(got.body.toString()).toContain(
          'the Inbox machine laptop could not be reached',
        );
        expect(took).toBeLessThan(2_000);
        expect(machine.asked).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.live('an owner whose tunnel is down is unavailable, saying so', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const machine = yield* stubMachine(() => {}).pipe(Scope.provide(scope));
      const local = yield* startLocal(machine.port);
      // The board records the claim; then nothing answers on the port.
      yield* local.api.inbox.board({ query: {} });
      yield* Scope.close(scope, Exit.void);
      const got = yield* get(local.port, urlOf(LAPTOP_ID, 'shot.png'));
      expect(got.status).toBe(503);
      expect(got.headers['cache-control']).toBe('no-store');
      expect(got.body.toString()).toContain(
        `the Inbox machine laptop could not be reached: nothing answered on port ${machine.port}`,
      );
    }).pipe(Effect.scoped),
  );

  it.live('the machine’s type and headers are never passed on', () =>
    Effect.gen(function* () {
      const machine = yield* stubMachine((res) => {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-disposition': 'inline',
          'set-cookie': 'a=b',
        });
        res.end('<script>x</script>');
      });
      const local = yield* startLocal(machine.port);
      yield* local.api.inbox.board({ query: {} });
      const got = yield* get(local.port, urlOf(LAPTOP_ID, 'notes.txt'));
      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toBe('application/octet-stream');
      expect(got.headers['content-disposition']).toMatch(/^attachment;/);
      expect(got.headers['set-cookie']).toBeUndefined();
      expect(got.headers['content-security-policy']).toBe(
        "sandbox; default-src 'none', frame-ancestors 'none'",
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    'the read Local sends carries local=true, and one that does is never sent on',
    () =>
      Effect.gen(function* () {
        const machine = yield* stubMachine((res) => {
          res.writeHead(404);
          res.end();
        });
        const local = yield* startLocal(machine.port);
        yield* local.api.inbox.board({ query: {} });
        expect(
          (yield* get(local.port, `${urlOf(LAPTOP_ID, 'shot.png')}?local=true`))
            .status,
        ).toBe(404);
        expect(machine.asked).toStrictEqual([]);
        expect(
          (yield* get(local.port, urlOf(LAPTOP_ID, 'shot.png'))).status,
        ).toBe(404);
        expect(machine.asked).toStrictEqual([
          `${urlOf(LAPTOP_ID, 'shot.png')}?local=true`,
        ]);
      }).pipe(Effect.scoped),
  );
});
