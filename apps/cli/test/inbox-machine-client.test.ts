import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  type AddressInfo,
  createServer as createNetServer,
  type Socket,
} from 'node:net';
import { describe, expect, it } from '@effect/vitest';
import {
  InboxId,
  InboxMachinePort,
  renderQuestionMarkdown,
  renderQuestionParts,
} from '@operator-inbox/core';
import {
  HttpApiDecodeError,
  InboxNotFound,
  InboxUnavailable,
  inboxMachineKey,
  RenameRefused,
} from '@operator-inbox/core/api';
import { Duration, Effect, Exit, Fiber, Schema } from 'effect';
import { HttpClientError, HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import {
  classifyMachineFailure,
  fetchMachineBoard,
  fetchMachineIndex,
  forwardInboxCall,
  MACHINE_CALL_TIMEOUT,
  MACHINE_WRITE_TIMEOUT,
} from '../src/inbox-machine-client';

// The client Local's serve calls an Inbox machine with, against a
// plain `node:http` server on port 0 standing in for the machine's tunnel. It
// records the `Host` each request named: the machine's guard answers only
// 127.0.0.1:7184, whatever port the tunnel listens on.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// The machine `laptop` on `port`, as serve names it, and the ref the wire
// carries for it.
const laptop = (port: number) => ({
  key: inboxMachineKey(InboxMachinePort.make(port)),
  label: 'laptop',
  port: InboxMachinePort.make(port),
});
const laptopRef = (port: number) => ({
  key: inboxMachineKey(InboxMachinePort.make(port)),
  label: 'laptop',
});

// A server for the length of one test, and the Hosts and URLs it was sent.
const stub = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: InboxMachinePort;
      readonly hosts: Array<string>;
      readonly urls: Array<string>;
      readonly server: Server;
    }>((resume) => {
      const hosts: Array<string> = [];
      const urls: Array<string> = [];
      const server = createServer((req, res) => {
        hosts.push(req.headers.host ?? '');
        urls.push(req.url ?? '');
        handler(req, res);
      });
      server.listen(0, '127.0.0.1', () =>
        resume(
          Effect.succeed({
            port: InboxMachinePort.make((server.address() as AddressInfo).port),
            hosts,
            urls,
            server,
          }),
        ),
      );
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

// A port nothing listens on: bound, then released.
const freePort = Effect.callback<InboxMachinePort>((resume) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resume(Effect.succeed(InboxMachinePort.make(port))));
  });
});

// A machine that takes each request and never answers, and the moment its
// first request arrived.
const hanging = Effect.gen(function* () {
  let arrived = (): void => {};
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const s = yield* stub(() => arrived());
  return { ...s, first };
});

// A machine that answers each request only once `release` is called, with
// the moment its first request arrived.
const held = (answer: Handler) =>
  Effect.gen(function* () {
    let arrived = (): void => {};
    const first = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const waiting: Array<() => void> = [];
    const s = yield* stub((req, res) => {
      waiting.push(() => answer(req, res));
      arrived();
    });
    const release = () => {
      for (const go of waiting.splice(0)) go();
    };
    return { ...s, first, release };
  });

const json =
  (status: number, body: unknown): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

const ID = InboxId.make('01INBOXMACHINE000000000000');
const VIEW = {
  inboxId: ID,
  label: 'demo',
  metadata: {},
  archived: false,
  pinnedGroups: [],
  awaitingOperator: [],
  awaitingAgent: [],
  processed: [],
};
const INDEX = {
  inboxes: [
    {
      inboxId: ID,
      label: 'demo',
      archived: false,
      pinned: false,
      awaitingOperator: 2,
      awaitingAgent: 0,
      processed: 0,
    },
  ],
  totalAwaitingOperator: 2,
};

describe('inbox-machine-client', () => {
  it.live('sends Host 127.0.0.1:7184 whatever port it connects to', () =>
    Effect.gen(function* () {
      const s = yield* stub(json(200, INDEX));
      const read = yield* fetchMachineIndex(s.port);
      expect(read).toEqual({ status: 'reachable', value: INDEX });
      expect(s.hosts).toEqual(['127.0.0.1:7184']);
      expect(s.port).not.toBe(7184);
    }).pipe(Effect.scoped),
  );

  it.live('asks the machine for its own Inboxes only', () =>
    Effect.gen(function* () {
      const s = yield* stub(json(200, { ...INDEX, views: [VIEW] }));
      yield* fetchMachineIndex(s.port);
      yield* fetchMachineBoard(s.port);
      expect(s.urls).toEqual([
        '/api/inboxes?local=true',
        '/api/inbox-board?local=true',
      ]);
    }).pipe(Effect.scoped),
  );

  it.live('an older board with no machines key still decodes', () =>
    Effect.gen(function* () {
      const s = yield* stub(json(200, { ...INDEX, views: [VIEW] }));
      const read = yield* fetchMachineBoard(s.port);
      expect(read.status).toBe('reachable');
    }).pipe(Effect.scoped),
  );

  it.live('a refused port is unreachable, well within the timeout', () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const [took, read] = yield* Effect.timed(fetchMachineIndex(port));
      expect(read.status).toBe('unreachable');
      if (read.status !== 'reachable') {
        expect(read.reason).toBe('tunnel-down');
        expect(read.detail).toContain(`nothing answered on port ${port}`);
      }
      expect(Duration.toMillis(took)).toBeLessThan(2000);
    }),
  );

  // A listener on a port the OS chooses, for the length of the test's scope,
  // that does `onConnection` with each connection it takes.
  const holding = (
    onConnection: (socket: Socket) => void,
    options: { readonly pauseOnConnect?: boolean } = {},
  ) => {
    const server = createNetServer(options, onConnection);
    return Effect.acquireRelease(
      Effect.callback<InboxMachinePort>((resume) => {
        server.listen(0, '127.0.0.1', () =>
          resume(
            Effect.succeed(
              InboxMachinePort.make((server.address() as AddressInfo).port),
            ),
          ),
        );
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    );
  };

  // ssh holding the port, with the machine's sshd refusing the forward (or
  // nothing on the machine's 7184): it holds each connection unread until
  // the channel's open fails, then closes it, and the request unread makes
  // that a reset. That is not a tunnel to open (the port is held, so
  // `operator-inbox tunnel` would refuse it), so it is never `tunnel-down`.
  it.live('a port that resets the connection is forward-refused', () =>
    Effect.gen(function* () {
      const port = yield* holding((socket) => socket.resetAndDestroy(), {
        pauseOnConnect: true,
      });
      const read = yield* fetchMachineIndex(port);
      expect(read.status).toBe('unreachable');
      if (read.status !== 'reachable') {
        expect(read.reason).toBe('forward-refused');
        expect(read.detail).toContain(
          `port ${port} reset the connection before any answer`,
        );
      }
    }).pipe(Effect.scoped),
  );

  // What is behind the tunnel took the request and closed without an
  // answer: a clean close, no reset. Nothing says the forward was refused.
  it.live('a port that takes the request and closes is hung-up', () =>
    Effect.gen(function* () {
      const port = yield* holding((socket) =>
        socket.once('data', () => socket.end()),
      );
      const read = yield* fetchMachineIndex(port);
      expect(read.status).toBe('unreachable');
      if (read.status !== 'reachable') {
        expect(read.reason).toBe('hung-up');
        expect(read.detail).toContain(
          `port ${port} closed the connection without answering`,
        );
      }
    }).pipe(Effect.scoped),
  );

  // Only a refused connection is a tunnel that is down; any
  // other transport error says nothing of the tunnel, so it never offers
  // the tunnel command.
  it('a transport error other than a refused connection is connection-failed', () => {
    const failed = (code: string) =>
      classifyMachineFailure(
        InboxMachinePort.make(3010),
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request: HttpClientRequest.get('http://127.0.0.1:3010/'),
            cause: Object.assign(new Error(`connect ${code} 127.0.0.1:3010`), {
              code,
              syscall: 'connect',
            }),
          }),
        }),
      );
    expect(failed('EHOSTUNREACH')).toEqual({
      status: 'unreachable',
      reason: 'connection-failed',
      detail:
        'the connection to port 3010 failed before any answer (connect EHOSTUNREACH 127.0.0.1:3010)',
    });
    expect(failed('ECONNREFUSED').reason).toBe('tunnel-down');
  });

  it.effect('a machine that never answers is unreachable at the timeout', () =>
    Effect.gen(function* () {
      const s = yield* hanging;
      const fiber = yield* Effect.forkChild(
        fetchMachineIndex(s.port, { timeout: Duration.millis(200) }),
      );
      yield* Effect.promise(() => s.first);
      yield* TestClock.adjust(Duration.millis(200));
      expect(yield* Fiber.join(fiber)).toEqual({
        status: 'unreachable',
        reason: 'timed-out',
        detail: `no answer on port ${s.port} within 200ms`,
      });
    }).pipe(Effect.scoped),
  );

  it.live('garbage JSON is incompatible', () =>
    Effect.gen(function* () {
      const s = yield* stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{ not json');
      });
      const read = yield* fetchMachineIndex(s.port);
      expect(read.status).toBe('incompatible');
    }).pipe(Effect.scoped),
  );

  it.live('JSON of the wrong shape is incompatible', () =>
    Effect.gen(function* () {
      const s = yield* stub(json(200, { inboxes: 'nope' }));
      const read = yield* fetchMachineIndex(s.port);
      expect(read.status).toBe('incompatible');
      if (read.status !== 'reachable') {
        expect(read.reason).toBe('undecodable');
        expect(read.detail).toContain('not the inbox contract');
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    'the guard’s 421 is incompatible, and says the Host was refused',
    () =>
      Effect.gen(function* () {
        const s = yield* stub((_req, res) => {
          res.writeHead(421, { 'content-type': 'text/plain' });
          res.end(
            'operator-inbox serve answers only requests addressed to 127.0.0.1\n',
          );
        });
        const read = yield* fetchMachineIndex(s.port);
        expect(read.status).toBe('incompatible');
        if (read.status !== 'reachable') {
          expect(read.reason).toBe('misdirected');
          expect(read.detail).toContain('answered 421');
        }
      }).pipe(Effect.scoped),
  );

  it.live(
    'the machine’s InboxUnavailable is unreachable, with its sentence',
    () =>
      Effect.gen(function* () {
        const s = yield* stub(
          json(503, { message: 'the store is down', _tag: 'InboxUnavailable' }),
        );
        const read = yield* fetchMachineBoard(s.port);
        expect(read).toEqual({
          status: 'unreachable',
          reason: 'store-unavailable',
          detail: 'its inbox store is unavailable: the store is down',
        });
      }).pipe(Effect.scoped),
  );

  describe('forwardInboxCall', () => {
    it.live('returns the machine’s view tagged with its label', () =>
      Effect.gen(function* () {
        const s = yield* stub(json(200, VIEW));
        const view = yield* forwardInboxCall(laptop(s.port), 'read', (api) =>
          api.inbox.view({ query: {}, params: { inboxId: ID } }),
        );
        expect(view).toEqual({ ...VIEW, machine: laptopRef(s.port) });
        expect(s.hosts).toEqual(['127.0.0.1:7184']);
      }).pipe(Effect.scoped),
    );

    it.live('passes the machine’s refusal through with its machine set', () =>
      Effect.gen(function* () {
        const s = yield* stub(
          json(404, { message: 'no Inbox 01X here', _tag: 'InboxNotFound' }),
        );
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(s.port), 'read', (api) =>
            api.inbox.view({ query: {}, params: { inboxId: ID } }),
          ),
        );
        expect(error).toBeInstanceOf(InboxNotFound);
        expect(error.message).toBe('no Inbox 01X here');
        expect(error instanceof InboxNotFound && error.machine).toEqual(
          laptopRef(s.port),
        );
      }).pipe(Effect.scoped),
    );

    it.live(
      'keeps a rename refusal’s conflicting Inbox, with its machine',
      () =>
        Effect.gen(function* () {
          const s = yield* stub(
            json(409, {
              message: 'the name is taken',
              conflictingInboxId: ID,
              _tag: 'RenameRefused',
            }),
          );
          const error = yield* Effect.flip(
            forwardInboxCall(laptop(s.port), 'write', (api) =>
              api.inbox.rename({
                query: {},
                params: { inboxId: ID },
                payload: { label: 'x' },
              }),
            ),
          );
          expect(error).toBeInstanceOf(RenameRefused);
          if (error instanceof RenameRefused)
            expect([
              error.message,
              error.conflictingInboxId,
              error.machine,
            ]).toEqual(['the name is taken', ID, laptopRef(s.port)]);
        }).pipe(Effect.scoped),
    );

    // Only Local's serve sets `machine`, `clashedOn` and `mayHaveLanded`, for
    // its own page: a machine's refusal carrying them is passed on without
    // them, and with the machine Local sent the call to.
    it.live('a machine’s refusal keeps none of the fields Local sets', () =>
      Effect.gen(function* () {
        const s = yield* stub(
          json(503, {
            message: 'the store is down',
            machine: { key: '1', label: 'desktop' },
            clashedOn: [{ key: '1', label: 'desktop' }],
            // A value the schema rejects, so a refusal decoded
            // first and then remade would fail its decode here.
            mayHaveLanded: false,
            _tag: 'InboxUnavailable',
          }),
        );
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(s.port), 'write', (api) =>
            api.inbox.pin({
              query: {},
              params: { inboxId: ID },
              payload: { pinned: true },
            }),
          ),
        );
        expect(error).toEqual(
          new InboxUnavailable({
            message: 'the store is down',
            machine: laptopRef(s.port),
          }),
        );
      }).pipe(Effect.scoped),
    );

    it.live(
      'a refusal whose sentence is not a string is not the contract’s',
      () =>
        Effect.gen(function* () {
          const s = yield* stub(
            json(404, { message: 7, _tag: 'InboxNotFound' }),
          );
          const error = yield* Effect.flip(
            forwardInboxCall(laptop(s.port), 'read', (api) =>
              api.inbox.view({ query: {}, params: { inboxId: ID } }),
            ),
          );
          expect(error).toBeInstanceOf(InboxUnavailable);
          expect(error.message).toContain(
            'answered with something Local cannot use',
          );
        }).pipe(Effect.scoped),
    );

    // The machine could not decode the request Local sent, which decoded on
    // Local: the two serves' contracts differ. It is not the page's bad
    // request, so it is not passed on as one.
    it.live(
      'a machine’s HttpApiDecodeError is InboxUnavailable, incompatible',
      () =>
        Effect.gen(function* () {
          const s = yield* stub(
            json(400, {
              issues: [],
              message: 'Expected a string',
              _tag: 'HttpApiDecodeError',
            }),
          );
          const error = yield* Effect.flip(
            forwardInboxCall(laptop(s.port), 'read', (api) =>
              api.inbox.view({ query: {}, params: { inboxId: ID } }),
            ),
          );
          expect(error).not.toBeInstanceOf(HttpApiDecodeError);
          expect(error).toBeInstanceOf(InboxUnavailable);
          expect(error.message).toBe(
            `the Inbox machine laptop answered with something Local cannot use: port ${s.port} could not decode the request Local sent: Expected a string`,
          );
        }).pipe(Effect.scoped),
    );

    it.live('a transport failure is InboxUnavailable naming the machine', () =>
      Effect.gen(function* () {
        const port = yield* freePort;
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(port), 'read', (api) =>
            api.inbox.view({ query: {}, params: { inboxId: ID } }),
          ),
        );
        expect(error).toBeInstanceOf(InboxUnavailable);
        expect(error.message).toContain(
          'the Inbox machine laptop could not be reached',
        );
        expect(error instanceof InboxUnavailable && error.machine).toEqual(
          laptopRef(port),
        );
      }),
    );
  });

  // A machine is whatever holds its tunnel port, so nothing it sends may
  // reach the page as HTML, fill Local's memory, or put escapes in a detail.
  describe('what a machine sends is never trusted', () => {
    const HOSTILE = '<img src=x onerror="fetch(\'/api/inboxes\')">';
    const BODY = 'Pick <img src=x onerror=alert(1)> one';
    const hostileView = {
      ...VIEW,
      awaitingOperator: [
        {
          number: 1,
          revision: 1,
          metadata: {},
          title: 'q',
          body: BODY,
          bodyHtml: HOSTILE,
          bodyParts: [{ kind: 'html', html: HOSTILE }],
          askedSeq: 1,
        },
      ],
    };

    it.live('a forwarded view carries Local’s rendering of each body', () =>
      Effect.gen(function* () {
        const s = yield* stub(json(200, hostileView));
        const view = yield* forwardInboxCall(laptop(s.port), 'read', (api) =>
          api.inbox.view({ query: {}, params: { inboxId: ID } }),
        );
        const [q] = view.awaitingOperator;
        expect(q?.bodyHtml).toBe(renderQuestionMarkdown(BODY));
        expect(q?.bodyParts).toEqual(renderQuestionParts(BODY));
        expect(JSON.stringify(view)).not.toContain('fetch(');
      }).pipe(Effect.scoped),
    );

    const padded = (bytes: number) => ({
      ...INDEX,
      views: [{ ...VIEW, label: 'x'.repeat(bytes) }],
    });

    it.live('an answer declared over the byte limit is incompatible', () =>
      Effect.gen(function* () {
        const s = yield* stub(json(200, padded(4096)));
        const read = yield* fetchMachineBoard(s.port, { maxBytes: 1024 });
        expect(read).toEqual({
          status: 'incompatible',
          reason: 'undecodable',
          detail: `port ${s.port} answered with more than 1024 bytes, more than Local reads from a machine`,
        });
      }).pipe(Effect.scoped),
    );

    // Refused on its declared length, before waiting for a body that may
    // never come.
    it.live(
      'an answer declaring a length over the limit is not waited for',
      () =>
        Effect.gen(function* () {
          const s = yield* stub((_req, res) => {
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': '10000000',
            });
            res.write('{"inboxes":');
          });
          const read = yield* fetchMachineBoard(s.port, {
            maxBytes: 1024,
            timeout: Duration.seconds(5),
          });
          expect(read.status).toBe('incompatible');
        }).pipe(Effect.scoped),
    );

    it.live(
      'an answer streamed past the byte limit, with no length, is incompatible',
      () =>
        Effect.gen(function* () {
          const s = yield* stub((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            const body = JSON.stringify(padded(4096));
            for (let i = 0; i < body.length; i += 256)
              res.write(body.slice(i, i + 256));
            res.end();
          });
          const read = yield* fetchMachineBoard(s.port, { maxBytes: 1024 });
          expect(read.status).toBe('incompatible');
          if (read.status !== 'reachable')
            expect(read.detail).toContain('more than 1024 bytes');
          // Under the limit, the same answer reads.
          const whole = yield* fetchMachineBoard(s.port, { maxBytes: 8192 });
          expect(whole.status).toBe('reachable');
        }).pipe(Effect.scoped),
    );

    it.live('a forwarded call over the byte limit is InboxUnavailable', () =>
      Effect.gen(function* () {
        const s = yield* stub(json(200, { ...VIEW, label: 'x'.repeat(4096) }));
        const error = yield* Effect.flip(
          forwardInboxCall(
            laptop(s.port),
            'read',
            (api) => api.inbox.view({ query: {}, params: { inboxId: ID } }),
            { maxBytes: 1024 },
          ),
        );
        expect(error).toBeInstanceOf(InboxUnavailable);
        expect(error.message).toBe(
          `the Inbox machine laptop answered with something Local cannot use: port ${s.port} answered with more than 1024 bytes, more than Local reads from a machine`,
        );
      }).pipe(Effect.scoped),
    );

    // A status no web Response can carry makes the client throw: a defect,
    // which is still that machine's failure, never the board's.
    it.live('an answer the client dies on is incompatible, not a defect', () =>
      Effect.gen(function* () {
        const s = yield* stub(json(600, INDEX));
        const read = yield* fetchMachineBoard(s.port);
        expect(read.status).toBe('incompatible');
        if (read.status !== 'reachable')
          expect(read.detail).toContain(
            `port ${s.port} answered with something Local could not read`,
          );
        const forwarded = yield* Effect.flip(
          forwardInboxCall(laptop(s.port), 'write', (api) =>
            api.inbox.view({ query: {}, params: { inboxId: ID } }),
          ),
        );
        expect(forwarded).toBeInstanceOf(InboxUnavailable);
      }).pipe(Effect.scoped),
    );

    const ESCAPES =
      '\u001b]0;pwned\u0007\u001b[2J\u001b[32m✓ all fine\u009b31m\u0000';

    it.live('a machine’s sentence reaches a detail with no escapes', () =>
      Effect.gen(function* () {
        const s = yield* stub(
          json(503, { message: ESCAPES, _tag: 'InboxUnavailable' }),
        );
        const read = yield* fetchMachineIndex(s.port);
        expect(read).toEqual({
          status: 'unreachable',
          reason: 'store-unavailable',
          detail: 'its inbox store is unavailable: ✓ all fine',
        });
      }).pipe(Effect.scoped),
    );

    it.live(
      'a forwarded refusal carries the machine’s sentence with no escapes',
      () =>
        Effect.gen(function* () {
          const s = yield* stub(
            json(404, { message: ESCAPES, _tag: 'InboxNotFound' }),
          );
          const error = yield* Effect.flip(
            forwardInboxCall(laptop(s.port), 'read', (api) =>
              api.inbox.view({ query: {}, params: { inboxId: ID } }),
            ),
          );
          expect(error.message).toBe('✓ all fine');
        }).pipe(Effect.scoped),
    );
  });

  // A forwarded write may land after Local stops waiting, so it waits longer
  // than a read, and a timeout says the outcome is not known.
  describe('a forwarded write', () => {
    const answer = (
      api: Parameters<Parameters<typeof forwardInboxCall>[2]>[0],
    ) =>
      api.inbox.answer({
        query: {},
        params: { inboxId: ID, number: 1 as never },
        payload: { response: 'yes', seenRevision: 1 as never },
      });

    it.effect('waits longer than a read', () =>
      Effect.gen(function* () {
        const s = yield* held(json(200, VIEW));
        const options = {
          timeout: Duration.millis(100),
          writeTimeout: Duration.seconds(5),
        };
        const write = yield* Effect.forkChild(
          forwardInboxCall(laptop(s.port), 'write', answer, options),
        );
        const read = yield* Effect.forkChild(
          Effect.flip(
            forwardInboxCall(
              laptop(s.port),
              'read',
              (api) => api.inbox.view({ query: {}, params: { inboxId: ID } }),
              options,
            ),
          ),
        );
        yield* Effect.promise(() => s.first);
        yield* TestClock.adjust(Duration.millis(100));
        expect((yield* Fiber.join(read)).message).toBe(
          `the Inbox machine laptop could not be reached: no answer on port ${s.port} within 100ms`,
        );
        // Past the read's timeout, the write still waits, and takes the
        // answer when it comes.
        expect(write.pollUnsafe()).toBeUndefined();
        s.release();
        expect((yield* Fiber.join(write)).machine).toEqual(laptopRef(s.port));
      }).pipe(Effect.scoped),
    );

    it.effect(
      'that times out says the change may have reached the machine',
      () =>
        Effect.gen(function* () {
          const s = yield* hanging;
          const fiber = yield* Effect.forkChild(
            Effect.flip(
              forwardInboxCall(laptop(s.port), 'write', answer, {
                writeTimeout: Duration.millis(200),
              }),
            ),
          );
          yield* Effect.promise(() => s.first);
          yield* TestClock.adjust(Duration.millis(200));
          const error = yield* Fiber.join(fiber);
          expect(error).toBeInstanceOf(InboxUnavailable);
          expect(error.message).toBe(
            'the Inbox machine laptop did not answer within 200ms; the change may have reached it — reload to check',
          );
          // It did reach the machine.
          expect(s.urls).toHaveLength(1);
        }).pipe(Effect.scoped),
    );

    // The server interrupts a request's handler when
    // the page that sent it goes away. A write already sent is not cut off
    // with it: the machine answers it, and Local reads that answer.
    it.live('is not cut off when the call waiting on it is interrupted', () =>
      Effect.gen(function* () {
        // The machine says how its answer ended. It answers 200 ms after
        // the request arrived, on the real clock: showing a write is NOT cut
        // off needs time for a cut to reach the machine, and nothing signals
        // that no cut is coming. The end itself is waited on, not slept for.
        let arrived = (): void => {};
        const first = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        let ended = (_how: string): void => {};
        const end = new Promise<string>((resolve) => {
          ended = resolve;
        });
        const s = yield* stub((req, res) => {
          res.on('close', () =>
            ended(res.writableFinished ? 'answered' : 'cut off'),
          );
          arrived();
          setTimeout(() => json(200, VIEW)(req, res), 200);
        });
        const fiber = yield* Effect.forkChild(
          forwardInboxCall(laptop(s.port), 'write', answer),
        );
        yield* Effect.promise(() => first);
        yield* Fiber.interrupt(fiber);
        expect(yield* Effect.promise(() => end)).toBe('answered');
      }).pipe(Effect.scoped),
    );

    // A write that reached the machine and then lost its
    // connection (the tunnel stopped, ssh dropping the channel), or whose
    // answer is of no use, may have landed: it is never said not to have
    // arrived. Only a refused connection proves nothing was sent.
    it.live('that lands and loses its connection may have reached it', () =>
      Effect.gen(function* () {
        const bodies: Array<string> = [];
        const s = yield* stub((req) => {
          let body = '';
          req.on('data', (chunk) => {
            body += String(chunk);
          });
          req.on('end', () => {
            bodies.push(body);
            req.socket.destroy();
          });
        });
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(s.port), 'write', answer),
        );
        expect(bodies).toEqual([
          JSON.stringify({ response: 'yes', seenRevision: 1 }),
        ]);
        expect(error).toBeInstanceOf(InboxUnavailable);
        expect(error.message).toMatch(
          /^no answer Local can use came from the Inbox machine laptop: .*; the change may have reached it — reload to check$/,
        );
        expect(error).toMatchObject({ mayHaveLanded: true });
      }).pipe(Effect.scoped),
    );

    it.live('whose answer is an undeclared 5xx may have reached it', () =>
      Effect.gen(function* () {
        const s = yield* stub(json(502, { oops: true }));
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(s.port), 'write', answer),
        );
        expect(error.message).toBe(
          `no answer Local can use came from the Inbox machine laptop: port ${s.port} answered HTTP 502, which the inbox contract does not declare; the change may have reached it — reload to check`,
        );
        expect(error).toMatchObject({ mayHaveLanded: true });
      }).pipe(Effect.scoped),
    );

    it.live('to a port nothing listens on could not be reached', () =>
      Effect.gen(function* () {
        const port = yield* freePort;
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(port), 'write', answer),
        );
        expect(error.message).toMatch(
          /^the Inbox machine laptop could not be reached: nothing answered on port \d+/,
        );
        expect(error).not.toHaveProperty('mayHaveLanded');
      }),
    );

    // The far end refusing the request before any handler ran
    // proves nothing landed too: the machine's own decode refusal, and its
    // guard's 421 (`misdirected`).
    it.live('the machine could not decode is not said to have reached it', () =>
      Effect.gen(function* () {
        const s = yield* stub(
          json(400, {
            issues: [],
            message: 'Expected a string',
            _tag: 'HttpApiDecodeError',
          }),
        );
        const error = yield* Effect.flip(
          forwardInboxCall(laptop(s.port), 'write', answer),
        );
        expect(error.message).toBe(
          `the Inbox machine laptop answered with something Local cannot use: port ${s.port} could not decode the request Local sent: Expected a string`,
        );
        expect(error).not.toHaveProperty('mayHaveLanded');
      }).pipe(Effect.scoped),
    );

    it.live(
      'a 421 from the machine’s guard is not said to have reached it',
      () =>
        Effect.gen(function* () {
          const s = yield* stub((_req, res) => {
            res.writeHead(421, { 'content-type': 'text/plain' });
            res.end(
              'operator-inbox serve answers only requests addressed to 127.0.0.1\n',
            );
          });
          const error = yield* Effect.flip(
            forwardInboxCall(laptop(s.port), 'write', answer),
          );
          expect(error.message).toMatch(
            /^the Inbox machine laptop answered with something Local cannot use: .*421/,
          );
          expect(error).not.toHaveProperty('mayHaveLanded');
        }).pipe(Effect.scoped),
    );

    // A page from before the Inbox machines decodes InboxUnavailable
    // as `{ message, _tag }` and shows "Not sent — InboxUnavailable: <message>"
    // for any failure, so the uncertainty must ride in `message` itself.
    it.live(
      'an uncertain write says so in the sentence an older page reads',
      () =>
        Effect.gen(function* () {
          const s = yield* stub(json(502, { oops: true }));
          const error = yield* Effect.flip(
            forwardInboxCall(laptop(s.port), 'write', answer),
          );
          expect(error).toBeInstanceOf(InboxUnavailable);
          if (!(error instanceof InboxUnavailable)) return;
          const wire = yield* Schema.encodeEffect(InboxUnavailable)(error);
          const older = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              message: Schema.String,
              _tag: Schema.Literal('InboxUnavailable'),
            }),
          )(wire);
          expect(older.message).toMatch(
            /; the change may have reached it — reload to check$/,
          );
        }).pipe(Effect.scoped),
    );

    // A read waits about 10 s; a write still waits longer than a read.
    it('a read waits 10 s, and a write longer, 15 s', () => {
      expect(MACHINE_CALL_TIMEOUT).toEqual(Duration.seconds(10));
      expect(MACHINE_WRITE_TIMEOUT).toEqual(Duration.seconds(15));
    });
  });

  // With no options, as serve calls it, each read waits
  // MACHINE_CALL_TIMEOUT and a write MACHINE_WRITE_TIMEOUT, on the Clock:
  // still waiting a moment before, given up at it.
  describe('with no options, as serve calls a machine', () => {
    // Runs `call` against a hanging machine on the TestClock: not given up
    // on just before `waits`, given up at it.
    const givenUpAt = <A, E>(
      waits: Duration.Duration,
      call: (port: InboxMachinePort) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const s = yield* hanging;
        const fiber = yield* Effect.forkChild(call(s.port));
        yield* Effect.promise(() => s.first);
        yield* TestClock.adjust(Duration.subtract(waits, Duration.millis(1)));
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(Duration.millis(1));
        return { port: s.port, exit: yield* Fiber.await(fiber) };
      }).pipe(Effect.scoped);

    it.effect('a board read gives up at 10 s', () =>
      Effect.gen(function* () {
        const { port, exit } = yield* givenUpAt(
          Duration.seconds(10),
          fetchMachineBoard,
        );
        expect(exit).toEqual(
          Exit.succeed({
            status: 'unreachable',
            reason: 'timed-out',
            detail: `no answer on port ${port} within 10s`,
          }),
        );
      }),
    );

    it.effect('a forwarded read gives up at 10 s', () =>
      Effect.gen(function* () {
        const { port, exit } = yield* givenUpAt(Duration.seconds(10), (p) =>
          forwardInboxCall(laptop(p), 'read', (api) =>
            api.inbox.view({ query: {}, params: { inboxId: ID } }),
          ),
        );
        expect(exit).toEqual(
          Exit.fail(
            new InboxUnavailable({
              message: `the Inbox machine laptop could not be reached: no answer on port ${port} within 10s`,
              machine: laptopRef(port),
            }),
          ),
        );
      }),
    );

    it.effect('a forwarded write gives up at 15 s', () =>
      Effect.gen(function* () {
        const { port, exit } = yield* givenUpAt(Duration.seconds(15), (p) =>
          forwardInboxCall(laptop(p), 'write', (api) =>
            api.inbox.answer({
              query: {},
              params: { inboxId: ID, number: 1 as never },
              payload: { response: 'yes', seenRevision: 1 as never },
            }),
          ),
        );
        expect(exit).toEqual(
          Exit.fail(
            new InboxUnavailable({
              message:
                'the Inbox machine laptop did not answer within 15s; the change may have reached it — reload to check',
              machine: laptopRef(port),
              mayHaveLanded: true,
            }),
          ),
        );
      }),
    );
  });
});
