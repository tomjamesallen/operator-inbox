import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { InboxId } from '@operator-inbox/core';
import { OperatorInboxApi } from '@operator-inbox/core/api';
import {
  ConfigProvider,
  Console,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
} from 'effect';
import { Command } from 'effect/cli';
import {
  FetchHttpClient,
  type HttpClient,
  HttpServer,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { TestClock } from 'effect/testing';
import { dispatchOpen } from '../src/commands/inbox';
import {
  describeBindFailure,
  type ServeMachines,
  serveCommand,
  serveOn,
} from '../src/commands/serve';
import { envProvider } from '../src/env-config';
import { InputError } from '../src/errors';
import { HERDR_LIST_TIMEOUT } from '../src/inbox-machine-resolution';
import { type InboxLog, InboxLogInMemory } from '../src/inbox-store';
import { SERVED_MACHINES_TTL } from '../src/serve-inbox-machines';
import {
  judgeLocalRequest,
  makeServeLayer,
  SERVE_HOST,
  withFramingHeaders,
} from '../src/serve-server';
import { cacheControlFor, classifyStaticPath } from '../src/serve-static';

// `operator-inbox serve`, run IN PROCESS on a real Node listener on port 0,
// and called through `HttpApiClient` derived from the same `OperatorInboxApi`
// the web client uses — so a payload that does not decode against the
// contract fails here. The inbox log is the in-memory one, seeded with one
// Inbox labelled `Alpha` per case, and every config read goes to a temp dir,
// so neither the operator's store nor their config is read.

// Herdr's advice, the contract's, for a Herdr that could not be read.
const HERDR_ADVICE =
  'Herdr could not be read on this machine, which is no fault of any inboxMachines entry: check that Herdr is installed and that `herdr machine list --json` answers here';

const write = (file: string, lines: readonly string[]) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.join('\n'));
};

// The one Inbox each case's log holds: its label is what a refusal must
// never carry, and what an allowed request's board does.
const ALPHA_ID = InboxId.make('01INBOXSERVEALPHA000000000');
const ALPHA = 'Alpha';

const seedAlpha = dispatchOpen({
  session: Option.none(),
  inbox: Option.none(),
  label: Option.some(ALPHA),
  freshId: ALPHA_ID,
  cwd: '/w/alpha',
});

// A config dir with nothing in it, so serve's config reads (the metadata
// rules, the tailnet) see every default and never the operator's own.
const emptyConfig = () =>
  envProvider({
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'operator-inbox-serve-xdg-')),
  });

// A Vite-shaped web build: the shell, one fingerprinted asset, the service
// worker and the manifest. Beside it, OUTSIDE the build, a secret file that
// no request may reach — and inside it a symlink pointing at that secret.
const INDEX_HTML = '<!doctype html><title>the app shell</title>';
const ASSET_JS = 'console.log("the asset");';
const SECRET = 'the secret outside the build';

const makeWebDist = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-inbox-serve-web-'));
  const dist = join(dir, 'dist');
  write(join(dist, 'index.html'), [INDEX_HTML]);
  write(join(dist, 'assets', 'index-AbC123.js'), [ASSET_JS]);
  write(join(dist, 'sw.js'), ['self.addEventListener("fetch", () => {});']);
  write(join(dist, 'manifest.webmanifest'), ['{"name":"Operator Inbox"}']);
  write(join(dir, 'secret.txt'), [SECRET]);
  symlinkSync(join(dir, 'secret.txt'), join(dist, 'escape.txt'));
  symlinkSync(dir, join(dist, 'up'));
  return dist;
};

// A directory that holds no build at all.
const noWebDist = () => join(tmpdir(), 'operator-inbox-serve-no-such-web-dist');

// The server on port 0 over a fresh in-memory log, plus a fetch client for
// it, provided in ONE call.
const servingWith = (webDist: string | undefined) =>
  Layer.mergeAll(makeServeLayer(0, webDist), FetchHttpClient.layer).pipe(
    Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
    Layer.provideMerge(NodeServices.layer),
  );

const clientFor = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const url = yield* HttpServer.addressFormattedWith((u) => Effect.succeed(u));
  const client = yield* HttpApiClient.make(OperatorInboxApi, { baseUrl: url });
  return { server, url, client };
});

const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    HttpServer.HttpServer | HttpClient.HttpClient | InboxLog
  >,
  webDist: string | undefined = makeWebDist(),
) =>
  seedAlpha.pipe(
    Effect.andThen(body),
    Effect.provide(servingWith(webDist)),
    Effect.provideService(ConfigProvider.ConfigProvider, emptyConfig()),
  );

describe('operator-inbox serve', () => {
  it.effect('binds 127.0.0.1 and nothing wider', () =>
    run(
      Effect.gen(function* () {
        const { server, url } = yield* clientFor;
        expect(SERVE_HOST).toBe('127.0.0.1');
        expect(server.address._tag).toBe('InetAddressV4');
        if (NetAddress.isInetAddressV4(server.address)) {
          expect(NetAddress.formatIp(server.address.address)).toBe('127.0.0.1');
          expect(server.address.port).toBeGreaterThan(0);
        }
        expect(url.startsWith('http://127.0.0.1:')).toBe(true);
      }),
    ),
  );
});

// --- Local-only requests (DNS rebinding) ---
// `fetch` will not let a caller choose `Host` (a forbidden header), and a
// rebinding attack is exactly a request whose `Host` is not ours, so these
// cases speak raw HTTP through `node:http`. `host: null` sends no `Host` at all.
interface RawAnswer {
  readonly status: number;
  readonly body: string;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly framing: {
    readonly csp: string | readonly string[] | undefined;
    readonly xFrameOptions: string | readonly string[] | undefined;
  };
}

// `path` goes on the wire exactly as written: `node:http` does not normalise
// it, which is what lets the traversal cases below send `..` at all.
const rawGet = (
  url: string,
  headers: { readonly host?: string | null; readonly origin?: string },
  path = '/api/inbox-board',
) =>
  Effect.callback<RawAnswer, Error>((resume) => {
    const target = new URL(url);
    const out: Record<string, string> = {};
    if (typeof headers.host === 'string') out.host = headers.host;
    if (headers.origin !== undefined) out.origin = headers.origin;
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: 'GET',
        headers: out,
        setHost: headers.host === undefined,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resume(
            Effect.succeed({
              status: res.statusCode ?? 0,
              body,
              contentType: res.headers['content-type'],
              cacheControl: res.headers['cache-control'],
              framing: {
                csp: res.headers['content-security-policy'],
                xFrameOptions: res.headers['x-frame-options'],
              },
            }),
          ),
        );
      },
    );
    req.on('error', (e) => resume(Effect.fail(e)));
    req.end();
  });

describe('operator-inbox serve answers only local requests', () => {
  const portOf = (url: string) => Number(new URL(url).port);

  it.effect('refuses a foreign Host with 421 and no inbox data', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const port = portOf(url);
        for (const host of [
          `rebound.example:${port}`,
          'rebound.example',
          `127.0.0.1:${port + 1}`,
          `localhost.rebound.example:${port}`,
          `127.0.0.1`,
          'localhost',
        ]) {
          const answer = yield* rawGet(url, { host });
          expect(answer.status, `Host: ${host}`).toBe(421);
          expect(answer.body).not.toContain(ALPHA);
          expect(answer.body).not.toContain('inboxes');
        }
        // No Host at all: Node's own listener refuses an HTTP/1.1 request
        // without one (400) before the middleware sees it; either refusal
        // will do, so long as no data comes back.
        const hostless = yield* rawGet(url, { host: null });
        expect([400, 421]).toContain(hostless.status);
        expect(hostless.body).not.toContain(ALPHA);
      }),
    ),
  );

  it.effect('answers 127.0.0.1:<port> and localhost:<port>', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const port = portOf(url);
        for (const host of [
          `127.0.0.1:${port}`,
          `localhost:${port}`,
          `LOCALHOST:${port}`,
        ]) {
          const answer = yield* rawGet(url, { host });
          expect(answer.status, `Host: ${host}`).toBe(200);
          expect(answer.body).toContain(`"label":"${ALPHA}"`);
        }
      }),
    ),
  );

  it.effect('refuses a cross-site Origin with 403, answers its own', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const port = portOf(url);
        const host = `127.0.0.1:${port}`;
        const foreign = yield* rawGet(url, {
          host,
          origin: 'http://rebound.example',
        });
        expect(foreign.status).toBe(403);
        expect(foreign.body).not.toContain(ALPHA);
        const own = yield* rawGet(url, {
          host,
          origin: `http://localhost:${port}`,
        });
        expect(own.status).toBe(200);
      }),
    ),
  );

  it.effect('forbids framing on every answer, refusals included', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const port = portOf(url);
        const host = `127.0.0.1:${port}`;
        const answers = {
          allowed: yield* rawGet(url, { host }),
          shell: yield* rawGet(url, { host }, '/'),
          misdirected: yield* rawGet(url, { host: 'rebound.example' }),
          crossSite: yield* rawGet(url, {
            host,
            origin: 'http://rebound.example',
          }),
        };
        expect(answers.allowed.status).toBe(200);
        expect(answers.shell.status).toBe(200);
        expect(answers.misdirected.status).toBe(421);
        expect(answers.crossSite.status).toBe(403);
        for (const [name, answer] of Object.entries(answers)) {
          expect(answer.framing, name).toEqual({
            csp: "frame-ancestors 'none'",
            xFrameOptions: 'DENY',
          });
        }
      }),
    ),
  );

  it('adds the framing policy to a route’s own, never replacing it', () => {
    const csp = (headers: Record<string, string>) =>
      withFramingHeaders(HttpServerResponse.text('x', { headers })).headers;
    expect(csp({})).toMatchObject({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    expect(
      csp({ 'content-security-policy': "sandbox; default-src 'none'" }),
    ).toMatchObject({
      'content-security-policy':
        "sandbox; default-src 'none', frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    // A route's own `frame-ancestors` stays in its policy, and the framing
    // policy still binds beside it: a browser enforces both.
    expect(
      csp({ 'content-security-policy': 'frame-ancestors *' })[
        'content-security-policy'
      ],
    ).toBe("frame-ancestors *, frame-ancestors 'none'");
  });

  it('judges a request by Host first, then Origin', () => {
    const at = (host: string | undefined, origin?: string) =>
      judgeLocalRequest({ host, origin }, 7184);
    expect(at('127.0.0.1:7184')).toBe('allow');
    expect(at('localhost:7184')).toBe('allow');
    expect(at(undefined)).toBe('misdirected');
    expect(at('evil.example:7184')).toBe('misdirected');
    expect(at('127.0.0.1:7185')).toBe('misdirected');
    // Loopback by name or address, but with no port: not this server.
    expect(at('localhost')).toBe('misdirected');
    expect(at('127.0.0.1')).toBe('misdirected');
    expect(at('127.0.0.1:7184', 'http://evil.example')).toBe('cross-site');
    expect(at('127.0.0.1:7184', 'https://127.0.0.1:7184')).toBe('cross-site');
    expect(at('127.0.0.1:7184', 'http://127.0.0.1:7184')).toBe('allow');
    // A foreign Host is misdirected whatever Origin it claims.
    expect(at('evil.example:7184', 'http://127.0.0.1:7184')).toBe(
      'misdirected',
    );
  });

  it('answers the tailnet name, bare, on 80 or 443, or on its own port, only from an allowed peer, by the last X-Forwarded-For entry', () => {
    const tailnet = {
      host: 'mac.tail0000.ts.net',
      allowFrom: ['100.64.0.7'],
    };
    const at = (
      host: string | undefined,
      forwardedFor: string | undefined,
      origin?: string,
      withTailnet = true,
    ) =>
      judgeLocalRequest(
        { host, origin, forwardedFor },
        7184,
        withTailnet ? tailnet : undefined,
      );
    expect(at('mac.tail0000.ts.net', '100.64.0.7')).toBe('allow');
    expect(at('mac.tail0000.ts.net:443', '100.64.0.7')).toBe('allow');
    expect(
      at('mac.tail0000.ts.net', '100.64.0.7', 'https://mac.tail0000.ts.net'),
    ).toBe('allow');
    // Another tailnet device.
    expect(at('mac.tail0000.ts.net', '100.64.0.8')).toBe('peer-refused');
    // A client claiming the allowed address ahead of the proxy's own entry.
    expect(at('mac.tail0000.ts.net', '100.64.0.7, 100.64.0.8')).toBe(
      'peer-refused',
    );
    expect(at('mac.tail0000.ts.net', '')).toBe('peer-refused');
    // Plain http (tailscale serve --http=80) too, from its own origin only.
    expect(at('mac.tail0000.ts.net:80', '100.64.0.7')).toBe('allow');
    expect(
      at('mac.tail0000.ts.net', '100.64.0.7', 'http://mac.tail0000.ts.net'),
    ).toBe('allow');
    // The tailnet name on this listener's own port (tailscale serve
    // --http=7184), from an allowed peer and its own origin only.
    expect(at('mac.tail0000.ts.net:7184', '100.64.0.7')).toBe('allow');
    expect(at('mac.tail0000.ts.net:7184', '100.64.0.8')).toBe('peer-refused');
    expect(
      at(
        'mac.tail0000.ts.net:7184',
        '100.64.0.7',
        'http://mac.tail0000.ts.net:7184',
      ),
    ).toBe('allow');
    expect(
      at(
        'mac.tail0000.ts.net:7184',
        '100.64.0.7',
        'https://mac.tail0000.ts.net:7184',
      ),
    ).toBe('allow');
    expect(
      at('mac.tail0000.ts.net:7184', '100.64.0.7', 'http://evil.example:7184'),
    ).toBe('cross-site');
    // Only the port this listener bound: another port is not this server.
    expect(
      judgeLocalRequest(
        {
          host: 'mac.tail0000.ts.net:7184',
          origin: undefined,
          forwardedFor: '100.64.0.7',
        },
        7185,
        tailnet,
      ),
    ).toBe('misdirected');
    expect(at('mac.tail0000.ts.net:8080', '100.64.0.7')).toBe('misdirected');
    expect(
      at(
        'mac.tail0000.ts.net',
        '100.64.0.7',
        'http://mac.tail0000.ts.net:8080',
      ),
    ).toBe('cross-site');
    expect(
      at('mac.tail0000.ts.net', '100.64.0.7', 'https://evil.example'),
    ).toBe('cross-site');
    // A forwarded request naming loopback does not take the loopback rule.
    expect(at('127.0.0.1:7184', '100.64.0.7')).toBe('misdirected');
    // The tailnet name direct, with nothing forwarded: not this server.
    expect(at('mac.tail0000.ts.net', undefined)).toBe('misdirected');
    // No tailnet configured: the tailnet name is misdirected.
    expect(at('mac.tail0000.ts.net', '100.64.0.7', undefined, false)).toBe(
      'misdirected',
    );
    // Loopback is unchanged with a tailnet configured.
    expect(at('127.0.0.1:7184', undefined)).toBe('allow');
  });
});

// --- The web build, served beside the API ---
// Raw HTTP again, because `fetch` normalises `..` and `%2e%2e` out of a path
// before it is sent, and the traversal cases need them on the wire.
describe('operator-inbox serve serves the web build', () => {
  const get = (url: string, path: string) => rawGet(url, {}, path);

  it.effect('serves a known asset, long-cached, with its content type', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const asset = yield* get(url, '/assets/index-AbC123.js');
        expect(asset.status).toBe(200);
        expect(asset.body).toContain(ASSET_JS);
        expect(asset.contentType).toMatch(/javascript/);
        expect(asset.cacheControl).toBe('public, max-age=31536000, immutable');
        const manifest = yield* get(url, '/manifest.webmanifest');
        expect(manifest.status).toBe(200);
        expect(manifest.contentType).toMatch(/manifest\+json/);
      }),
    ),
  );

  it.effect('serves / and the service worker uncached', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const root = yield* get(url, '/');
        expect(root.status).toBe(200);
        expect(root.body).toContain(INDEX_HTML);
        expect(root.contentType).toMatch(/text\/html/);
        expect(root.cacheControl).toBe('no-cache');
        expect(root.framing).toEqual({
          csp: "frame-ancestors 'none'",
          xFrameOptions: 'DENY',
        });
        const sw = yield* get(url, '/sw.js');
        expect(sw.status).toBe(200);
        expect(sw.cacheControl).toBe('no-cache');
      }),
    ),
  );

  it.effect('falls back to index.html for a client route', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        for (const path of ['/inbox', `/inbox/${ALPHA_ID}`, '/inbox?x=1#y']) {
          const answer = yield* get(url, path);
          expect(answer.status, path).toBe(200);
          expect(answer.body, path).toContain(INDEX_HTML);
          expect(answer.cacheControl, path).toBe('no-cache');
        }
        // A missing name that looks like a file is a 404, not the shell.
        const gone = yield* get(url, '/assets/gone-XyZ.js');
        expect(gone.status).toBe(404);
        expect(gone.body).not.toContain(INDEX_HTML);
      }),
    ),
  );

  it.effect('answers /api/unknown with a 404, never index.html', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        for (const path of [
          '/api/unknown',
          '/api',
          '/api/',
          '/API/x',
          '/%61pi/x',
        ]) {
          const answer = yield* get(url, path);
          expect(answer.status, path).toBe(404);
          expect(answer.body, path).not.toContain(INDEX_HTML);
        }
        // The API's own route still answers.
        expect((yield* get(url, '/api/inbox-board')).status).toBe(200);
      }),
    ),
  );

  it.effect(
    'refuses a path that escapes the build, however it is encoded',
    () =>
      run(
        Effect.gen(function* () {
          const { url } = yield* clientFor;
          for (const path of [
            '/../secret.txt',
            '/assets/../../secret.txt',
            '/%2e%2e/secret.txt',
            '/%2E%2E/secret.txt',
            '/.%2e/secret.txt',
            '/..%2fsecret.txt',
            '/..%2Fsecret.txt',
            '/..%5csecret.txt',
            '/..\\secret.txt',
            '/%00',
          ]) {
            const answer = yield* get(url, path);
            expect(answer.status, path).toBe(400);
            expect(answer.body, path).not.toContain(SECRET);
            expect(answer.body, path).not.toContain(INDEX_HTML);
          }
          // Malformed percent-encoding: the router refuses it (404) before
          // the handler would (400); either will do, so long as nothing is
          // served.
          const malformed = yield* get(url, '/%E0%A4%A');
          expect([400, 404]).toContain(malformed.status);
          expect(malformed.body).not.toContain(INDEX_HTML);
          // A symlink inside the build that points out of it.
          for (const path of ['/escape.txt', '/up/secret.txt']) {
            const answer = yield* get(url, path);
            expect(answer.status, path).toBe(400);
            expect(answer.body, path).not.toContain(SECRET);
          }
        }),
      ),
  );

  // The classifier alone, so its rules are pinned even though the realpath
  // check behind it would catch most escapes on its own.
  it('classifies a request path before touching the filesystem', () => {
    const refused = { _tag: 'Refused' };
    for (const path of [
      '/../x',
      '/a/../../x',
      '/%2e%2e/x',
      '/%2E%2E/x',
      '/.%2e/x',
      '/./x',
      '/%2e/x',
      '/..%2fx',
      '/a%2F..%2F..%2Fx',
      '/..%5cx',
      '/a\\..\\x',
      '/%00',
      '/%E0%A4%A',
      'x',
      'http://evil.example/x',
    ]) {
      expect(classifyStaticPath(path), path).toEqual(refused);
    }
    expect(classifyStaticPath('/api/x')).toEqual({ _tag: 'Api' });
    expect(classifyStaticPath('/%41PI')).toEqual({ _tag: 'Api' });
    expect(classifyStaticPath('/')).toEqual({ _tag: 'Asset', segments: [] });
    expect(classifyStaticPath('//etc//passwd/?q=1')).toEqual({
      _tag: 'Asset',
      segments: ['etc', 'passwd'],
    });
    expect(classifyStaticPath('/a%20b.txt#frag')).toEqual({
      _tag: 'Asset',
      segments: ['a b.txt'],
    });
    expect(cacheControlFor(['assets', 'x.js'])).toContain('immutable');
    expect(cacheControlFor(['assets'])).toBe('no-cache');
    expect(cacheControlFor(['sw.js'])).toBe('no-cache');
  });

  it.effect('applies the local-only guard to static files too', () =>
    run(
      Effect.gen(function* () {
        const { url } = yield* clientFor;
        const port = Number(new URL(url).port);
        const foreign = yield* rawGet(
          url,
          { host: `rebound.example:${port}` },
          '/',
        );
        expect(foreign.status).toBe(421);
        expect(foreign.body).not.toContain(INDEX_HTML);
        const crossSite = yield* rawGet(
          url,
          { origin: 'http://rebound.example' },
          '/assets/index-AbC123.js',
        );
        expect(crossSite.status).toBe(403);
        expect(crossSite.body).not.toContain(ASSET_JS);
      }),
    ),
  );

  it.effect('still serves the API when there is no web build', () =>
    run(
      Effect.gen(function* () {
        const { url, client } = yield* clientFor;
        expect((yield* client.inbox.board({ query: {} })).inboxes).toHaveLength(
          1,
        );
        const page = yield* get(url, '/');
        expect(page.status).toBe(404);
        expect(page.body).toContain(
          'pnpm build (in the operator-inbox checkout',
        );
      }),
      noWebDist(),
    ),
  );
});

// --- The command itself: --port, and what it says at start-up ---
// The console is swapped for one that records both streams and resolves a
// Deferred on the first stdout line (Effect 4's console methods are plain
// synchronous calls, so the Deferred is completed in place), so a case can wait for the listener to
// announce itself and then interrupt the never-ending server.
const recordingConsole = Effect.gen(function* () {
  const out: string[] = [];
  const err: string[] = [];
  const listening = yield* Deferred.make<void>();
  // Those waiting on a stderr line (`errLine`), each resumed by the first
  // line its pattern matches.
  const waiting: Array<{
    readonly pattern: RegExp;
    readonly resume: (line: Effect.Effect<string>) => void;
  }> = [];
  const base = yield* Console.consoleWith(Effect.succeed);
  const console: Console.Console = {
    ...base,
    log: (...args: ReadonlyArray<unknown>) => {
      const line = args.join(' ');
      out.push(line);
      if (LISTENING.test(line)) Deferred.doneUnsafe(listening, Effect.void);
    },
    error: (...args: ReadonlyArray<unknown>) => {
      const line = args.join(' ');
      err.push(line);
      for (const w of waiting.splice(0))
        if (w.pattern.test(line)) w.resume(Effect.succeed(line));
        else waiting.push(w);
    },
  };
  // The first stderr line `pattern` matches, printed already or still to
  // come: no test waits on the clock for serve's start-up lines.
  const errLine = (pattern: RegExp) =>
    Effect.callback<string>((resume) => {
      const line = err.find((l) => pattern.test(l));
      if (line !== undefined) resume(Effect.succeed(line));
      else waiting.push({ pattern, resume });
    });
  return { out, err, listening, console, errLine };
});

// Start `eff` (a server that never returns), wait for its start-up line, then
// stop it and hand back what it printed.
const startupOf = <E, R>(eff: Effect.Effect<never, E, R>) =>
  Effect.gen(function* () {
    const rec = yield* recordingConsole;
    const fiber = yield* Effect.forkChild(
      Effect.provideService(eff, Console.Console, rec.console),
    );
    yield* Deferred.await(rec.listening).pipe(
      Effect.timeoutOrElse({
        duration: '10 seconds',
        orElse: () => Effect.fail(new Error('serve never announced itself')),
      }),
    );
    // Effect 4 resumes a Deferred's waiter in place, inside the server's own
    // `Console.log` call, so without a yield the server is interrupted before
    // the stderr lines that follow its URL. Yielding lets the start-up finish.
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    return { out: rec.out, err: rec.err };
  });

const withLog = Effect.provide(InboxLogInMemory);

const LISTENING =
  /^operator-inbox serve: listening on http:\/\/127\.0\.0\.1:\d+$/;

// A serve with no Inbox machines, never re-read.
const noMachines: ServeMachines = {
  loaded: { _tag: 'Listed', configPath: '/c/config.json', entries: [] },
  current: Effect.succeed({ entries: [] }),
};

describe('operator-inbox serve (the command)', () => {
  // The start-up printed by `serveOn(0, webDist)` over an empty config dir.
  const startupWith = (webDist: string | undefined = makeWebDist()) =>
    startupOf(serveOn(0, webDist, noMachines)).pipe(
      withLog,
      Effect.provideService(ConfigProvider.ConfigProvider, emptyConfig()),
      Effect.provide(NodeServices.layer),
    );

  it.live('announces the URL on stdout and nothing on stderr', () =>
    Effect.gen(function* () {
      const { out, err } = yield* startupWith();
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(LISTENING);
      expect(err).toEqual([]);
    }),
  );

  // The real command, argv and all: config.json is a temp file named through
  // the ConfigProvider, so the operator's config is never read.
  const throughTheCli = (argv: readonly string[], config: object) => {
    const xdg = mkdtempSync(join(tmpdir(), 'operator-inbox-serve-cmd-'));
    write(join(xdg, 'operator-inbox', 'config.json'), [JSON.stringify(config)]);
    // `--static` always, so the case never depends on whether this checkout
    // happens to hold a web build.
    return Command.runWith(serveCommand, { version: '0.0.0' })([
      ...argv,
      '--static',
      makeWebDist(),
    ]).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        envProvider({ XDG_CONFIG_HOME: xdg }),
      ),
      Effect.provide(NodeServices.layer),
      Effect.provide(InboxLogInMemory),
    );
  };

  it.live('runs from argv: --port 0 serves', () =>
    Effect.gen(function* () {
      const { out, err } = yield* startupOf(
        throughTheCli(['--port', '0'], {}).pipe(Effect.andThen(Effect.never)),
      );
      expect(out[0]).toMatch(LISTENING);
      expect(err).toEqual([]);
    }),
  );

  // The whole chain `operator-inbox serve` runs: `serveCommand` reads the
  // Inbox machines through `serveMachinesFrom`, hands them to `serveOn`,
  // which launches `serveAppLayer` with them. Driven from argv, so if any hop
  // passed start-up's list rather than how to read it, the board below would
  // keep the first machine. `herdr` is a stand-in listing no profile, so each
  // machine is unresolved and labelled by its selector, and the case changes
  // `config.json` between reads, with the TestClock past the TTL.
  it.effect(
    'runs from argv: re-reads its Inbox machines once the TTL passes',
    () =>
      Effect.gen(function* () {
        const xdg = mkdtempSync(
          join(tmpdir(), 'operator-inbox-serve-machines-'),
        );
        const configure = (selector: string) =>
          write(join(xdg, 'operator-inbox', 'config.json'), [
            JSON.stringify({
              inboxMachines: [{ herdrMachine: selector, port: 3990 }],
            }),
          ]);
        configure('zz-first');
        const herdr = join(xdg, 'herdr');
        writeFileSync(herdr, "#!/bin/sh\necho '[]'\n");
        chmodSync(herdr, 0o755);
        const rec = yield* recordingConsole;
        const fiber = yield* Effect.forkChild(
          Command.runWith(serveCommand, { version: '0.0.0' })([
            '--port',
            '0',
            '--static',
            makeWebDist(),
          ]).pipe(
            Effect.provideService(Console.Console, rec.console),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              envProvider({
                XDG_CONFIG_HOME: xdg,
                OPERATOR_INBOX_HERDR_BIN: herdr,
              }),
            ),
            Effect.provide(NodeServices.layer),
            Effect.provide(InboxLogInMemory),
          ),
        );
        yield* Deferred.await(rec.listening);
        const port = Number(
          rec.out
            .find((l) => LISTENING.test(l))
            ?.split(':')
            .at(-1),
        );
        const api = yield* HttpApiClient.make(OperatorInboxApi, {
          baseUrl: `http://${SERVE_HOST}:${port}`,
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const labels = Effect.map(api.inbox.board({ query: {} }), (b) =>
          b.machines?.map((m) => m.label),
        );
        expect(yield* labels).toEqual(['Local', 'zz-first']);
        // Start-up says why the machine cannot be called, with core's advice.
        yield* rec.errLine(/cannot be reached through Herdr/);
        expect(rec.err.join('\n')).toContain(
          'the Inbox machine "zz-first" cannot be reached through Herdr: no saved Herdr machines',
        );
        expect(rec.err.join('\n')).toContain(
          `Correct or remove its entry in inboxMachines in ${join(xdg, 'operator-inbox', 'config.json')}`,
        );
        configure('zz-second');
        expect(yield* labels).toEqual(['Local', 'zz-first']);
        yield* TestClock.adjust(SERVED_MACHINES_TTL);
        // The board that finds the TTL passed starts the re-read in the
        // background and answers with what serve has; a later board has the
        // re-read's list.
        expect(yield* labels).toEqual(['Local', 'zz-first']);
        let seen: ReadonlyArray<string> | undefined = ['Local', 'zz-first'];
        for (let i = 0; i < 200 && seen?.[1] === 'zz-first'; i += 1)
          seen = yield* labels;
        expect(seen).toEqual(['Local', 'zz-second']);
        yield* Fiber.interrupt(fiber);
      }),
  );

  // A Herdr that does not answer within its bound at start-up is said once,
  // as Herdr's, and never as a fault of each machine's entry. The bound runs
  // on the TestClock: the stand-in `herdr` says it has started through a
  // FIFO (the bound starts before Herdr is run), then the clock is moved past
  // the bound, so no test time is spent waiting on it.
  it.effect(
    'says once at start-up that Herdr did not answer, without blaming the entries',
    () =>
      Effect.gen(function* () {
        const xdg = mkdtempSync(
          join(tmpdir(), 'operator-inbox-serve-herdr-slow-'),
        );
        write(join(xdg, 'operator-inbox', 'config.json'), [
          JSON.stringify({
            inboxMachines: [{ herdrMachine: 'laptop', port: 3990 }],
          }),
        ]);
        const started = join(xdg, 'started');
        expect(spawnSync('mkfifo', [started]).status).toBe(0);
        const herdr = join(xdg, 'herdr');
        writeFileSync(
          herdr,
          `#!/bin/sh\necho started > '${started}'\nexec sleep 8\n`,
        );
        chmodSync(herdr, 0o755);
        const rec = yield* recordingConsole;
        const fiber = yield* Effect.forkChild(
          Command.runWith(serveCommand, { version: '0.0.0' })([
            '--port',
            '0',
            '--static',
            makeWebDist(),
          ]).pipe(
            Effect.provideService(Console.Console, rec.console),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              envProvider({
                XDG_CONFIG_HOME: xdg,
                OPERATOR_INBOX_HERDR_BIN: herdr,
              }),
            ),
            Effect.provide(NodeServices.layer),
            Effect.provide(InboxLogInMemory),
          ),
        );
        yield* Effect.promise(() => readFile(started, 'utf8'));
        yield* TestClock.adjust(HERDR_LIST_TIMEOUT);
        yield* Deferred.await(rec.listening);
        // stderr follows the listening line on stdout.
        yield* rec.errLine(/herdr machine list/);
        const err = rec.err.join('\n');
        expect(err).toContain(
          `operator-inbox serve: 'herdr machine list --json' did not answer within 3s, so no Inbox machine is read until serve reads Herdr again, every 30s. ${HERDR_ADVICE}`,
        );
        expect(err).not.toContain('Correct or remove');
        yield* Fiber.interrupt(fiber);
      }),
  );

  // A `herdr` that cannot be run is said once, as Herdr's, with Herdr's
  // advice, and never as a fault of each machine's entry.
  it.effect(
    'says once at start-up that Herdr could not be run, without blaming the entries',
    () =>
      Effect.gen(function* () {
        const xdg = mkdtempSync(
          join(tmpdir(), 'operator-inbox-serve-herdr-gone-'),
        );
        write(join(xdg, 'operator-inbox', 'config.json'), [
          JSON.stringify({
            inboxMachines: [
              { herdrMachine: 'laptop', port: 3990 },
              { herdrMachine: 'desktop', port: 3991 },
            ],
          }),
        ]);
        const rec = yield* recordingConsole;
        const fiber = yield* Effect.forkChild(
          Command.runWith(serveCommand, { version: '0.0.0' })([
            '--port',
            '0',
            '--static',
            makeWebDist(),
          ]).pipe(
            Effect.provideService(Console.Console, rec.console),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              envProvider({
                XDG_CONFIG_HOME: xdg,
                OPERATOR_INBOX_HERDR_BIN: join(xdg, 'no-such-herdr'),
              }),
            ),
            Effect.provide(NodeServices.layer),
            Effect.provide(InboxLogInMemory),
          ),
        );
        yield* Deferred.await(rec.listening);
        // stderr follows the listening line on stdout.
        yield* rec.errLine(/no-such-herdr/);
        const lines = rec.err.filter((l) => l.includes('no-such-herdr'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          new RegExp(
            `^operator-inbox serve: could not run '${xdg}/no-such-herdr'`,
          ),
        );
        expect(lines[0]).toContain(
          `, so no Inbox machine is read until serve reads Herdr again, every 30s. ${HERDR_ADVICE}`,
        );
        expect(rec.err.join('\n')).not.toContain('Correct or remove');
        yield* Fiber.interrupt(fiber);
      }),
  );

  // An `inboxMachines` that does not decode never stops serve, nor the rest
  // of config.json (its `serve.tailnet` is still read): serve starts with the
  // machines off, says so on stderr, and the board carries the sentence for
  // the page's banner, with Local's section alone.
  it.effect(
    'runs from argv with machines off when inboxMachines does not decode',
    () =>
      Effect.gen(function* () {
        const xdg = mkdtempSync(
          join(tmpdir(), 'operator-inbox-serve-machines-'),
        );
        write(join(xdg, 'operator-inbox', 'config.json'), [
          JSON.stringify({
            serve: {
              tailnet: { host: 'mac.tail0000.ts.net', allowFrom: [] },
            },
            inboxMachines: 'nope',
          }),
        ]);
        const rec = yield* recordingConsole;
        const fiber = yield* Effect.forkChild(
          Command.runWith(serveCommand, { version: '0.0.0' })([
            '--port',
            '0',
            '--static',
            makeWebDist(),
          ]).pipe(
            Effect.provideService(Console.Console, rec.console),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              envProvider({
                XDG_CONFIG_HOME: xdg,
                OPERATOR_INBOX_HERDR_BIN: join(xdg, 'no-such-herdr'),
              }),
            ),
            Effect.provide(NodeServices.layer),
            Effect.provide(InboxLogInMemory),
          ),
        );
        yield* Deferred.await(rec.listening);
        const port = Number(
          rec.out
            .find((l) => LISTENING.test(l))
            ?.split(':')
            .at(-1),
        );
        const api = yield* HttpApiClient.make(OperatorInboxApi, {
          baseUrl: `http://${SERVE_HOST}:${port}`,
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const board = yield* api.inbox.board({ query: {} });
        const at = `config.json at ${join(xdg, 'operator-inbox', 'config.json')}: inboxMachines`;
        expect(board.machinesOff).toContain(at);
        expect(board.machines?.map((m) => m.status)).toEqual(['local']);
        yield* rec.errLine(/could not read the Inbox machines/);
        expect(rec.err.join('\n')).toContain(
          `could not read the Inbox machines (${at}`,
        );
        // The rest of config.json was read: the tailnet it names is answered.
        expect(rec.out.join('\n')).toContain(
          'also answering mac.tail0000.ts.net through tailscale serve',
        );
        yield* Fiber.interrupt(fiber);
      }),
  );

  for (const port of ['65536', '70000']) {
    it.live(`rejects --port ${port} before binding anything`, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(throughTheCli(['--port', port], {}));
        expect(failure).toBeInstanceOf(InputError);
        expect((failure as InputError).message).toBe(
          `--port must be an integer from 0 to 65535, got ${port}`,
        );
      }),
    );
  }

  it.live('rejects a negative port', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        serveOn(-1, undefined, noMachines).pipe(withLog),
      );
      expect(failure).toBeInstanceOf(InputError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // A port another listener already holds (a second `serve` on the default
  // port, most likely): the failure names the address and the cause, rather
  // than reaching the error boundary as a ServeError with no message.
  it.live('says which address is taken when the port is in use', () =>
    Effect.gen(function* () {
      const occupier = createServer();
      const port = yield* Effect.callback<number>((resume) => {
        occupier.listen(0, SERVE_HOST, () => {
          const address = occupier.address();
          resume(
            Effect.succeed(
              typeof address === 'object' && address !== null
                ? address.port
                : 0,
            ),
          );
        });
      });
      // If the bind wrongly succeeds, the server announces itself and runs
      // forever; the race turns that into an immediate, named failure rather
      // than a hang that ends at the vitest timeout.
      const rec = yield* recordingConsole;
      const bound = Deferred.await(rec.listening).pipe(
        Effect.andThen(
          Effect.die(
            new Error(`serve bound ${port}, which another listener holds`),
          ),
        ),
      );
      const failure = yield* Effect.raceFirst(
        Effect.flip(
          Effect.provideService(
            serveOn(port, noWebDist(), noMachines).pipe(withLog),
            Console.Console,
            rec.console,
          ),
        ),
        bound,
      ).pipe(
        Effect.ensuring(
          Effect.callback<void>((resume) => {
            occupier.close(() => resume(Effect.void));
          }),
        ),
      );
      expect(port).toBeGreaterThan(0);
      expect(failure).toBeInstanceOf(InputError);
      expect((failure as InputError).message).toBe(
        `cannot listen on 127.0.0.1:${port}: the address is already in use (is another operator-inbox serve running? choose another with --port)`,
      );
    }).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, emptyConfig()),
      Effect.provide(NodeServices.layer),
    ),
  );

  it('describes any other bind failure by its own message', () => {
    expect(
      describeBindFailure(80, new Error('listen EACCES: permission denied')),
    ).toBe('cannot listen on 127.0.0.1:80: listen EACCES: permission denied');
  });

  it('names the address once when Node names it too', () => {
    const nodes = Object.assign(
      new Error('listen EACCES: permission denied 127.0.0.1:80'),
      { code: 'EACCES' },
    );
    expect(describeBindFailure(80, nodes)).toBe(
      'cannot listen on 127.0.0.1:80: listen EACCES: permission denied',
    );
  });

  it.live('says on stderr when there is no web build, and still serves', () =>
    Effect.gen(function* () {
      const dist = noWebDist();
      const { out, err } = yield* startupWith(dist);
      expect(out[0]).toMatch(LISTENING);
      expect(err).toEqual([
        `operator-inbox serve: no web build found at ${dist}; the API still serves. Make one with: pnpm build (in the operator-inbox checkout: it builds the web app and copies it into the CLI)`,
      ]);
    }),
  );

  it.live('rejects a --port that is not an integer', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(throughTheCli(['--port', 'abc'], {}));
      expect(failure).not.toBeInstanceOf(InputError);
    }),
  );
});
