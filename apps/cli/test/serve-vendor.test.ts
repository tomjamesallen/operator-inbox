import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { HTML_BLOCK_VENDOR_FILES } from '@operator-inbox/core';
import { ConfigProvider, Effect, Layer } from 'effect';
import { HttpServer } from 'effect/http';
import { envProvider } from '../src/env-config';
import { InboxLogInMemory } from '../src/inbox-store';
import { makeServeLayer } from '../src/serve-server';
import { vendorFilePath } from '../src/serve-vendor';
import { VENDOR_SOURCES } from '../src/vendor-files';

// `GET /vendor/<file>`: the fixed builds of three.js and d3 an HTML block
// may use. The page reads them from its own origin and hands their text into
// the frame, so the route is guarded like any other and opens no CORS. Run
// in process on port 0, with the files served from this package's own
// node_modules.

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

const get = (
  url: string,
  target: string,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.callback<Answer, Error>((resume) => {
    const at = new URL(url);
    const req = request(
      { hostname: at.hostname, port: at.port, path: target, headers },
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
              headers: res.headers,
            }),
          ),
        );
      },
    );
    req.on('error', (e) => resume(Effect.fail(e)));
    req.end();
  });

const run = <A, E>(body: (url: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const url = yield* HttpServer.addressFormattedWith((u) =>
      Effect.succeed(u),
    );
    return yield* body(url);
  }).pipe(
    Effect.provide(
      makeServeLayer(0, undefined).pipe(
        Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({
        XDG_CONFIG_HOME: mkdtempSync(path.join(tmpdir(), 'oi-vendor-xdg-')),
      }),
    ),
  );

describe('serve /vendor/', () => {
  it('serves exactly the files core names', () => {
    expect(Object.keys(VENDOR_SOURCES).sort()).toEqual(
      [...HTML_BLOCK_VENDOR_FILES].sort(),
    );
  });

  it('finds each file in this package from source', () => {
    for (const name of HTML_BLOCK_VENDOR_FILES)
      expect(vendorFilePath(name, path.join('/pkg', 'src'))).toBe(
        path.join('/pkg', 'node_modules', VENDOR_SOURCES[name]),
      );
    expect(vendorFilePath('d3.min.js', path.join('/pkg', 'dist'))).toBe(
      path.join('/pkg', 'dist', 'vendor', 'd3.min.js'),
    );
  });

  it.effect('answers the page’s own read, with no CORS opening', () =>
    run((url) =>
      Effect.gen(function* () {
        const answer = yield* get(url, '/vendor/three.module.js');
        expect(answer.status).toBe(200);
        expect(answer.headers['access-control-allow-origin']).toBeUndefined();
        expect(answer.headers['cross-origin-resource-policy']).toBeUndefined();
        expect(answer.headers['content-type']).toContain('text/javascript');
        expect(answer.body).toContain("from './three.core.js'");
        const d3 = yield* get(url, '/vendor/d3.min.js', {
          origin: url.replace(/\/$/, ''),
        });
        expect(d3.status).toBe(200);
        expect(d3.body.length).toBeGreaterThan(1000);
        const controls = yield* get(
          url,
          '/vendor/three-addons/controls/OrbitControls.js',
        );
        expect(controls.status).toBe(200);
      }),
    ),
  );

  it.effect('serves nothing else under /vendor/, and steps nowhere', () =>
    run((url) =>
      Effect.gen(function* () {
        for (const target of [
          '/vendor/three.webgpu.js',
          '/vendor/../package.json',
          '/vendor/%2e%2e/package.json',
          '/vendor/',
        ])
          expect((yield* get(url, target)).status, target).toBe(404);
      }),
    ),
  );

  it.effect(
    'keeps the Host and Origin checks on /vendor/, Origin null included',
    () =>
      run((url) =>
        Effect.gen(function* () {
          expect(
            (yield* get(url, '/vendor/d3.min.js', { host: 'rebound.example' }))
              .status,
          ).toBe(421);
          for (const origin of ['null', 'http://evil.example'])
            expect(
              (yield* get(url, '/vendor/d3.min.js', { origin })).status,
              origin,
            ).toBe(403);
        }),
      ),
  );
});
