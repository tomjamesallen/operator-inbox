import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { OperatorInboxApi } from '@operator-inbox/core/api';
import { ConfigProvider, Effect, Layer } from 'effect';
import { FetchHttpClient, type HttpClient, HttpServer } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import { envProvider } from '../src/env-config';
import { InboxLogInMemory } from '../src/inbox-store';
import { MLX_AUDIO_MISSING } from '../src/readout-kokoro';
import { rangeAsked } from '../src/serve-readout-api';
import { makeServeLayer } from '../src/serve-server';

// Listen mode through serve itself, on a real listener on port 0: the audio
// route's answers to `Range`, and the readout group wired into the API. The
// state and config folders are temp dirs, and the environment holds nothing
// else (no PATH, no HOME), so the voice is never found and nothing is
// spawned.

const HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const AUDIO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

const setUp = () => {
  const state = mkdtempSync(
    path.join(tmpdir(), 'operator-inbox-readout-state-'),
  );
  const dir = path.join(state, 'operator-inbox', 'readout');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${HASH}.mp3`), AUDIO);
  return envProvider({
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: mkdtempSync(
      path.join(tmpdir(), 'operator-inbox-readout-xdg-'),
    ),
  });
};

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

const get = (port: number, target: string, range?: string) =>
  Effect.callback<Answer, Error>((resume) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: target,
        headers: range === undefined ? {} : { range },
      },
      (res) => {
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
      },
    );
    req.on('error', (e) => resume(Effect.fail(e)));
    req.end();
  });

const serving = Layer.mergeAll(
  makeServeLayer(0, undefined),
  FetchHttpClient.layer,
).pipe(
  Layer.provideMerge(Layer.fresh(InboxLogInMemory)),
  Layer.provideMerge(NodeServices.layer),
);

const run = <A, E>(
  body: (
    port: number,
  ) => Effect.Effect<A, E, HttpServer.HttpServer | HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer;
    const port = 'port' in address ? address.port : 0;
    return yield* body(port);
  }).pipe(
    Effect.provide(serving),
    Effect.provideService(ConfigProvider.ConfigProvider, setUp()),
  );

const audioPath = `/api/readout/audio/${HASH}.mp3`;

describe('rangeAsked (pure)', () => {
  it('reads one range of each form, and ignores what it cannot use', () => {
    expect(rangeAsked(undefined, 100)).toEqual({ _tag: 'Whole' });
    expect(rangeAsked('bytes=10-19', 100)).toEqual({
      _tag: 'Part',
      start: 10,
      end: 19,
    });
    expect(rangeAsked('bytes=90-', 100)).toEqual({
      _tag: 'Part',
      start: 90,
      end: 99,
    });
    expect(rangeAsked('bytes=-10', 100)).toEqual({
      _tag: 'Part',
      start: 90,
      end: 99,
    });
    expect(rangeAsked('bytes=-500', 100)).toEqual({
      _tag: 'Part',
      start: 0,
      end: 99,
    });
    expect(rangeAsked('bytes=50-500', 100)).toEqual({
      _tag: 'Part',
      start: 50,
      end: 99,
    });
    expect(rangeAsked('bytes=100-', 100)).toEqual({ _tag: 'Unsatisfiable' });
    expect(rangeAsked('bytes=-0', 100)).toEqual({ _tag: 'Unsatisfiable' });
    expect(rangeAsked('bytes=0-1,5-6', 100)).toEqual({ _tag: 'Whole' });
    expect(rangeAsked('pages=1-2', 100)).toEqual({ _tag: 'Whole' });
    expect(rangeAsked('bytes=9-3', 100)).toEqual({ _tag: 'Whole' });
  });
});

describe('serve: the readout audio route', () => {
  it.effect('answers the whole file, as cacheable MP3 that takes ranges', () =>
    run((port) =>
      Effect.gen(function* () {
        const a = yield* get(port, audioPath);
        expect(a.status).toBe(200);
        expect(a.headers['content-type']).toBe('audio/mpeg');
        expect(a.headers['accept-ranges']).toBe('bytes');
        expect(a.headers['cache-control']).toBe(
          'public, max-age=31536000, immutable',
        );
        expect(a.headers['content-length']).toBe('1000');
        expect(a.body.equals(AUDIO)).toBe(true);
        // Behind the same guard as everything else.
        expect(a.headers['x-frame-options']).toBe('DENY');
      }),
    ),
  );

  it.effect('answers a range with 206 and the bytes asked for', () =>
    run((port) =>
      Effect.gen(function* () {
        const a = yield* get(port, audioPath, 'bytes=100-199');
        expect(a.status).toBe(206);
        expect(a.headers['content-range']).toBe('bytes 100-199/1000');
        expect(a.headers['content-length']).toBe('100');
        expect(a.body.equals(AUDIO.subarray(100, 200))).toBe(true);
        const tail = yield* get(port, audioPath, 'bytes=-10');
        expect(tail.status).toBe(206);
        expect(tail.headers['content-range']).toBe('bytes 990-999/1000');
        expect(tail.body.equals(AUDIO.subarray(990))).toBe(true);
        const open = yield* get(port, audioPath, 'bytes=995-');
        expect(open.body.equals(AUDIO.subarray(995))).toBe(true);
      }),
    ),
  );

  it.effect('answers 416 for a range past the end', () =>
    run((port) =>
      Effect.gen(function* () {
        const a = yield* get(port, audioPath, 'bytes=1000-');
        expect(a.status).toBe(416);
        expect(a.headers['content-range']).toBe('bytes */1000');
      }),
    ),
  );

  it.effect('answers 404 for an unknown or malformed name, never the app', () =>
    run((port) =>
      Effect.gen(function* () {
        for (const name of [
          `${'f'.repeat(24)}.mp3`,
          `${HASH}.wav`,
          `${HASH.toUpperCase()}.mp3`,
          'short.mp3',
          '..%2f..%2fetc%2fpasswd',
        ]) {
          const a = yield* get(port, `/api/readout/audio/${name}`);
          expect(a.status, name).toBe(404);
          expect(a.body.toString(), name).toBe('not found\n');
        }
      }),
    ),
  );

  it.effect('refuses a request that does not name this server', () =>
    run((port) =>
      Effect.callback<number, Error>((resume) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: audioPath,
            headers: { host: 'evil.example' },
          },
          (res) => {
            res.resume();
            resume(Effect.succeed(res.statusCode ?? 0));
          },
        );
        req.on('error', (e) => resume(Effect.fail(e)));
        req.end();
      }).pipe(Effect.map((status) => expect(status).toBe(421))),
    ),
  );
});

describe('serve: the readout group', () => {
  it.effect(
    'wanting nothing answers no entries; with no voice installed, every entry fails',
    () =>
      run((port) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(OperatorInboxApi, {
            baseUrl: `http://127.0.0.1:${port}`,
          });
          const none = yield* client.readout.queue({
            payload: { scripts: [] },
          });
          expect(none.entries).toEqual([]);
          expect(none.voice).toBe('bm_george');
          const one = yield* client.readout.queue({
            payload: {
              scripts: [
                {
                  segments: [{ id: 'title', text: 'Hello.', pauseAfter: 0.3 }],
                },
              ],
            },
          });
          expect(one.unavailable).toBe(MLX_AUDIO_MISSING);
          expect(one.entries).toEqual([
            {
              _tag: 'Failed',
              hash: expect.stringMatching(/^[0-9a-f]{24}$/),
              message: MLX_AUDIO_MISSING,
            },
          ]);
        }),
      ),
  );
});
