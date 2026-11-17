import path from 'node:path';
import { InboxId, inboxState, isImageAttachment } from '@operator-inbox/core';
import { InboxNotFound } from '@operator-inbox/core/api';
import { Effect, FileSystem } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { AttachmentsRoot } from './inbox-attachments';
import { fetchMachineAttachment } from './inbox-machine-client';
import { InboxLog } from './inbox-store';
import { recordedOwnerOf } from './serve-inbox-api';
import { ServedInboxMachines } from './serve-inbox-machines';

// `GET /api/attachments/<inbox id>/<hash>/<name>`: a file the operator
// attached, read back from where it is kept (`inbox-attachments.ts`), so an
// answered card can show an image as a thumbnail. A plain route beside the
// API, as listen mode's audio is, behind serve's `localOnly` guard.
//
// Only an image is sent as what it is, and only the raster types
// (`isImageAttachment`): anything else, SVG and HTML included, is sent as
// bytes to download, never to run in the page's origin. Every answer is
// `nosniff`, and carries a policy of `sandbox` and `default-src 'none'`, so a
// file a browser renders as a document anyway, opened in its own tab, runs no
// script, loads nothing and has no access to the app's origin. serve's
// framing handler adds `frame-ancestors 'none'` to this policy and never
// replaces it (`withFramingHeaders` in serve-server.ts). The policy binds
// only the file as a document: the app's own `<img>` and lightbox still
// draw an image from it.
//
// A file of an Inbox another machine holds is not in this machine's folder.
// When this machine's log lacks the Inbox too, the read goes to the Inbox
// machine recorded as claiming it (`recordedOwnerOf`, as the page's other
// reads of a Question do), and the bytes it sends come back with this
// serve's own type and headers, exactly as a file of its own would: the
// machine's headers are never passed on. A read carrying `local=true` (one
// Local sent here) is answered from this folder only, never sent on. A
// machine that cannot be reached is said in a short sentence, with 503 and
// nothing cached, within the client's bounds (`fetchMachineAttachment`).

// Each segment as `planAttachments` makes it: an id, a hash, a safe name.
const SEGMENT = /^[^/\\]+$/;

const HEADERS = {
  'cache-control': 'private, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
} as const;

const notFound = () => HttpServerResponse.text('not found\n', { status: 404 });

// A read that reached no file because its machine gave no usable answer:
// never cached, so the next look tries again.
const unavailable = (status: number, message: string) =>
  HttpServerResponse.text(`${message}\n`, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

// The headers a kept file is sent with, by its name: the same whether it was
// read here or from its machine.
const fileHeaders = (name: string) => {
  const type = imageTypeOf(name);
  return {
    contentType: type ?? 'application/octet-stream',
    headers: {
      ...HEADERS,
      'content-disposition': `${type === undefined ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  };
};

export const serveAttachment = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const segments = [params.inbox, params.folder, params.file];
  if (
    segments.some(
      (s) => s === undefined || !SEGMENT.test(s) || s === '.' || s === '..',
    )
  )
    return notFound();
  const checked = segments as unknown as readonly [string, string, string];
  const { root } = yield* AttachmentsRoot;
  const base = yield* root;
  const file = path.join(base, ...checked);
  if (path.relative(base, file).startsWith('..')) return notFound();
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.option);
  if (info._tag === 'Some' && info.value.type === 'File')
    return yield* HttpServerResponse.file(file, fileHeaders(checked[2]));
  return yield* fromOwner(checked);
}).pipe(
  Effect.catchTag(['PlatformError', 'InputError'], () =>
    Effect.succeed(notFound()),
  ),
);

// A file not in this machine's folder, read from the machine that holds its
// Inbox, when this one does not.
const fromOwner = (segments: readonly [string, string, string]) =>
  Effect.gen(function* () {
    const query = yield* HttpServerRequest.ParsedSearchParams;
    if (query.local === 'true') return notFound();
    const served = yield* ServedInboxMachines;
    const { entries } = yield* served.machines;
    if (entries.length === 0) return notFound();
    const inboxId = InboxId.make(segments[0]);
    if (yield* heldHere(inboxId)) return notFound();
    const owner = yield* recordedOwnerOf(
      inboxId,
      entries,
      new InboxNotFound({ message: `inbox ${inboxId} does not exist` }),
    ).pipe(Effect.result);
    if (owner._tag === 'Failure')
      return owner.failure._tag === 'InboxNotFound'
        ? notFound()
        : unavailable(503, owner.failure.message);
    const read = yield* fetchMachineAttachment(
      owner.success,
      segments,
      served.callOptions,
    );
    switch (read._tag) {
      case 'Found':
        return HttpServerResponse.uint8Array(
          read.bytes,
          fileHeaders(segments[2]),
        );
      case 'Missing':
        return notFound();
      case 'Unavailable':
        return unavailable(
          read.status === 'unreachable' ? 503 : 502,
          read.message,
        );
    }
  });

// Whether this machine's log holds the Inbox, whose files would then be in
// its own folder. A store that cannot be read says nothing either way, so
// the machines are asked.
const heldHere = (inboxId: InboxId) =>
  Effect.gen(function* () {
    const log = yield* InboxLog;
    const { events } = yield* log.read(inboxId);
    return inboxState(events).opened;
  }).pipe(Effect.orElseSucceed(() => false));

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
