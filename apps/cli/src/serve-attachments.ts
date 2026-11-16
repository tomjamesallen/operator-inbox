import path from 'node:path';
import { isImageAttachment } from '@operator-inbox/core';
import { Effect, FileSystem } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { AttachmentsRoot } from './inbox-attachments';

// `GET /api/attachments/<inbox id>/<hash>/<name>`: a file the operator
// attached, read back from where it is kept (`inbox-attachments.ts`), so an
// answered card can show an image as a thumbnail. A plain route beside the
// API, as listen mode's audio is, behind serve's `localOnly` guard.
//
// Only an image is sent as what it is, and only the raster types
// (`isImageAttachment`): anything else, SVG and HTML included, is sent as
// bytes to download, never to run in the page's origin. Every answer is
// `nosniff`, and sandboxed, so a file opened in its own tab runs nothing.

// Each segment as `planAttachments` makes it: an id, a hash, a safe name.
const SEGMENT = /^[^/\\]+$/;

const HEADERS = {
  'cache-control': 'private, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
  'content-security-policy': 'sandbox; default-src none',
} as const;

const notFound = () => HttpServerResponse.text('not found\n', { status: 404 });

export const serveAttachment = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const segments = [params.inbox, params.folder, params.file];
  if (
    segments.some(
      (s) => s === undefined || !SEGMENT.test(s) || s === '.' || s === '..',
    )
  )
    return notFound();
  const { root } = yield* AttachmentsRoot;
  const base = yield* root;
  const file = path.join(base, ...(segments as ReadonlyArray<string>));
  if (path.relative(base, file).startsWith('..')) return notFound();
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file);
  if (info.type !== 'File') return notFound();
  const name = params.file ?? 'file';
  const type = imageTypeOf(name);
  return yield* HttpServerResponse.file(file, {
    contentType: type ?? 'application/octet-stream',
    headers: {
      ...HEADERS,
      'content-disposition': `${type === undefined ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}).pipe(
  Effect.catchTag(['PlatformError', 'InputError'], () =>
    Effect.succeed(notFound()),
  ),
);

// The type an image is sent as, by its extension: what the browser said
// it was is on the event, not here, and the extension is what the name kept.
const imageTypeOf = (name: string): string | undefined => {
  const ext = path.extname(name).toLowerCase();
  const type =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
  return isImageAttachment(type) ? type : undefined;
};

export const attachmentRouteLive = HttpRouter.add(
  'GET',
  '/api/attachments/:inbox/:folder/:file',
  serveAttachment,
);
