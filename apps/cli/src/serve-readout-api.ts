import path from 'node:path';
import type { OperatorInboxApi } from '@operator-inbox/core/api';
import { Effect, FileSystem, Option } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { audioHashOf, Readout, readoutCacheDir } from './readout';

// Listen mode's two routes. `POST /api/readout` hands the scripts a page
// wants to the `Readout` service and answers where each stands. The audio is
// a plain route outside the API, `GET /api/readout/audio/<hash>.mp3`, so it
// can answer `Range` and the browser can seek: it reads the cache folder
// directly, since a file there under that name is whole (it is renamed into
// place) and never changes (it is named by its content), so it may be cached
// for good. Both sit on serve's one router, behind its `localOnly` guard.

export const makeReadoutApiLive = (api: typeof OperatorInboxApi) =>
  HttpApiBuilder.group(api, 'readout', (handlers) =>
    Effect.gen(function* () {
      const readout = yield* Readout;
      return handlers.handle('queue', ({ payload }) =>
        readout.want(payload.scripts),
      );
    }),
  );

/** What a `Range` header asks of a file of `size` bytes. Pure. */
export type RangeAsked =
  | { readonly _tag: 'Whole' }
  | { readonly _tag: 'Part'; readonly start: number; readonly end: number }
  | { readonly _tag: 'Unsatisfiable' };

// One range, `bytes=a-b`, `bytes=a-` or `bytes=-n`; `end` is inclusive. A
// header that is not one such range (several ranges, another unit, nonsense)
// is ignored, as RFC 9110 allows, and the whole file is sent.
export const rangeAsked = (
  header: string | undefined,
  size: number,
): RangeAsked => {
  if (header === undefined) return { _tag: 'Whole' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return { _tag: 'Whole' };
  const [, from = '', to = ''] = m;
  if (from === '' && to === '') return { _tag: 'Whole' };
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return { _tag: 'Unsatisfiable' };
    return { _tag: 'Part', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return { _tag: 'Unsatisfiable' };
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return { _tag: 'Whole' };
  return { _tag: 'Part', start, end };
};

const AUDIO_HEADERS = {
  'accept-ranges': 'bytes',
  'cache-control': 'public, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
} as const;

const notFound = () => HttpServerResponse.text('not found\n', { status: 404 });

export const serveReadoutAudio = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const hash = audioHashOf(params.file ?? '');
  if (hash === undefined) return notFound();
  const dir = yield* Effect.option(readoutCacheDir);
  if (Option.isNone(dir)) return notFound();
  const file = path.join(dir.value, `${hash}.mp3`);
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== 'File') return notFound();
  const size = Number(info.value.size);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const asked = rangeAsked(request.headers.range, size);
  if (asked._tag === 'Unsatisfiable') {
    return HttpServerResponse.text('range not satisfiable\n', {
      status: 416,
      headers: { ...AUDIO_HEADERS, 'content-range': `bytes */${size}` },
    });
  }
  if (asked._tag === 'Whole') {
    return yield* HttpServerResponse.file(file, {
      contentType: 'audio/mpeg',
      headers: AUDIO_HEADERS,
    });
  }
  return yield* HttpServerResponse.file(file, {
    status: 206,
    contentType: 'audio/mpeg',
    headers: {
      ...AUDIO_HEADERS,
      'content-range': `bytes ${asked.start}-${asked.end}/${size}`,
    },
    offset: asked.start,
    bytesToRead: asked.end - asked.start + 1,
  });
}).pipe(
  // A file swept between the stat and the read.
  Effect.catchTag('PlatformError', () => Effect.succeed(notFound())),
);

// A route with a parameter, which the router prefers over the static files'
// catch-all.
export const readoutAudioRouteLive = HttpRouter.add(
  'GET',
  '/api/readout/audio/:file',
  serveReadoutAudio,
);
