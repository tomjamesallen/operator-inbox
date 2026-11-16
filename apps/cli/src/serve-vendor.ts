import path from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { isBundled, moduleDir, packageRootOf } from './package-paths';
import { isVendorFile, VENDOR_SOURCES, type VendorFile } from './vendor-files';

// `GET /vendor/<file>`: the fixed builds of three.js and d3 an HTML block may
// use (`vendor-files.ts`), and nothing else. The PAGE reads them, from its
// own origin, and hands their text into a block's frame, which makes its own
// `blob:` URLs of them (core's `htmlBlockSrcdoc`): the frame itself fetches
// nothing. So this route is guarded like any other (serve-server.ts), and
// sends no CORS header.

/** The path a vendored file is served at, `/vendor/` and its name. */
export const VENDOR_PREFIX = '/vendor/';

/** Where a vendored file is on disk: the build's copy, or the package's own. */
export const vendorFilePath = (
  name: VendorFile,
  dir: string = moduleDir,
): string =>
  isBundled(dir)
    ? path.join(dir, 'vendor', name)
    : path.join(packageRootOf(dir), 'node_modules', VENDOR_SOURCES[name]);

export const VENDOR_HEADERS = {
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
} as const;

const notFound = () => HttpServerResponse.text('not found\n', { status: 404 });

export const serveVendor = (dir: string = moduleDir) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const target = request.url.split(/[?#]/, 1)[0] ?? '';
    // The name exactly as one of the fixed few; nothing is decoded or joined
    // from the request, so no path can step anywhere else.
    const name = target.slice(VENDOR_PREFIX.length);
    if (!target.startsWith(VENDOR_PREFIX) || !isVendorFile(name))
      return notFound();
    const file = vendorFilePath(name, dir);
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'File') return notFound();
    return yield* HttpServerResponse.file(file, {
      contentType: 'text/javascript; charset=utf-8',
      headers: VENDOR_HEADERS,
    });
  }).pipe(Effect.catchTag('PlatformError', () => Effect.succeed(notFound())));

// The route, which the router prefers over the static files' catch-all.
export const vendorRoutesLive = HttpRouter.add(
  'GET',
  `${VENDOR_PREFIX}*`,
  serveVendor(),
);
