import path from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { WEB_BUILD_COMMAND } from './package-paths';

// The local app's client, served by `operator-inbox serve` itself: the Vite
// build of `apps/web` (found by `package-paths.ts`), mapped request path →
// file, with an SPA fallback to `index.html`, so `/`, `/inbox` and
// `/inbox/<id>` all answer the app. A small hand-written handler: Effect 4
// brings an `HttpStaticServer`, but the refusals, cache policy and
// missing-build answer below are this app's own, pinned by
// `test/serve.test.ts`.
//
// It is ONE catch-all route on the API's own router, so it sits behind the
// same `localOnly` guard as the API (serve-server.ts) and only ever sees a
// request no API route matched. Three refusals come before any file is
// touched: anything under `/api` is a 404, never `index.html` (a typo in a
// client route must not answer 200 with a page); a path that could step out
// of `dist/` is a 400; and a file that resolves outside `dist/` through a
// symlink is a 400 too.

// What a request path asks for. Pure, so the traversal rules are tested
// without a server.
export type StaticRequest =
  | { readonly _tag: 'Api' }
  | { readonly _tag: 'Refused' }
  | { readonly _tag: 'Asset'; readonly segments: readonly string[] };

const API: StaticRequest = { _tag: 'Api' };
const REFUSED: StaticRequest = { _tag: 'Refused' };

// Classify the raw request target (path and query, as the client sent it,
// never normalised by a URL parser — WHATWG URL resolves `%2e%2e` to `..` and
// would hide the very thing this checks). Each segment is percent-decoded
// ONCE, then refused if it is `.` or `..`, or holds a separator or a NUL,
// whatever encoding carried it there; a raw backslash anywhere is refused
// before decoding. A target that is not origin-form (no leading `/`) is
// refused. Empty segments (`//`, a trailing `/`) are dropped, so they can
// never make a joined path absolute.
export const classifyStaticPath = (target: string): StaticRequest => {
  const rawPath = target.split(/[?#]/, 1)[0] ?? '';
  if (!rawPath.startsWith('/') || rawPath.includes('\\')) return REFUSED;
  const segments: string[] = [];
  for (const raw of rawPath.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return REFUSED;
    }
    if (segment === '') continue;
    if (
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      return REFUSED;
    }
    segments.push(segment);
  }
  if (segments[0]?.toLowerCase() === 'api') return API;
  return { _tag: 'Asset', segments };
};

// Vite fingerprints everything under `assets/`, so a name there never changes
// content and may be cached for good. Everything else — `index.html`, the
// service worker (`sw.js`, which the browser must re-check to pick up a new
// build), the manifest and the icons — is revalidated on every load.
export const cacheControlFor = (segments: readonly string[]): string =>
  segments[0] === 'assets' && segments.length > 1
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

// Is `child` inside `root` (both already resolved through symlinks)?
const isWithin = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}${path.sep}`);

const text = (body: string, status: number) =>
  HttpServerResponse.text(`${body}\n`, { status });

const fileAt = (file: string, segments: readonly string[]) =>
  HttpServerResponse.file(file, {
    headers: {
      'cache-control': cacheControlFor(segments),
      'x-content-type-options': 'nosniff',
    },
  });

// The handler for one request, over the build at `dist` (`undefined` when no
// build could be located). The build is looked for on every request: a
// `vite build` run while the server is up is served without a restart.
export const serveStatic = (dist: string | undefined) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const asked = classifyStaticPath(request.url);
    if (asked._tag === 'Api') return text('no such API route', 404);
    if (asked._tag === 'Refused') return text('bad path', 400);

    const fs = yield* FileSystem.FileSystem;
    const realOf = (p: string) => fs.realPath(p).pipe(Effect.option);
    const root = dist === undefined ? Option.none() : yield* realOf(dist);
    const index = Option.isSome(root)
      ? path.join(root.value, 'index.html')
      : undefined;
    if (
      Option.isNone(root) ||
      index === undefined ||
      !(yield* fs.exists(index).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return text(
        `operator-inbox serve has no web build to serve; make one with: ${WEB_BUILD_COMMAND}`,
        404,
      );
    }

    const { segments } = asked;
    if (segments.length > 0) {
      const found = yield* realOf(path.join(root.value, ...segments));
      if (Option.isSome(found)) {
        // A symlink inside the build that points out of it.
        if (!isWithin(root.value, found.value)) return text('bad path', 400);
        const info = yield* fs.stat(found.value).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type === 'File') {
          return yield* fileAt(found.value, segments);
        }
      }
      // A missing name that looks like a file (`/assets/gone.js`) is a 404:
      // answering it with `index.html` would hand a script tag a page.
      const last = segments[segments.length - 1] ?? '';
      if (last.includes('.')) return text('not found', 404);
    }
    // `/`, and any client route (`/inbox`, `/inbox/<id>`): the app's shell.
    return yield* fileAt(index, []);
  }).pipe(
    // A file that vanished between the stat and the read. A bad argument is
    // not that, and is left to fail.
    Effect.catchTag('PlatformError', (e) =>
      e.reason._tag === 'BadArgument'
        ? Effect.fail(e)
        : Effect.succeed(text('not found', 404)),
    ),
  );

// The catch-all route, on the router the API registers with: the API's routes
// are static paths, which the router always prefers over `*`, so this only
// ever answers what the API does not.
export const staticRoutesLive = (dist: string | undefined) =>
  HttpRouter.add('GET', '*', serveStatic(dist));
