import path from 'node:path';
import {
  ATTACHMENTS_DIR_NAME,
  type Attachment,
  checkAttachments,
  type InboxId,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  safeAttachmentName,
} from '@operator-inbox/core';
import type { AttachmentUpload } from '@operator-inbox/core/api';
import { Context, Effect, FileSystem, Result } from 'effect';
import { InputError } from './errors';
import { sha256Hex } from './inbox-blobs';
import { resolveInboxDatabaseEdge } from './inbox-database';

// The operator's files on the store's side (core's `attachment.ts`). Each is
// kept at `<store folder>/attachments/<inbox id>/<hash>/<name>`, the hash the
// first 16 hex digits of the SHA-256 of its bytes. So where a file goes is
// known from its bytes before anything is written (`planAttachments`), the
// decision can be run on that plan first, and a refused answer writes no
// file. Two different files never share a folder, and the same file sent
// twice under one name is one file. The file is written whole, then renamed
// into place, BEFORE the event naming it is appended: an append that then
// fails leaves a file no event names, which costs only its bytes.

/** Where the files are kept: the `attachments` folder beside the store. */
export class AttachmentsRoot extends Context.Reference<{
  readonly root: Effect.Effect<string, InputError, FileSystem.FileSystem>;
}>('operator-inbox/AttachmentsRoot', {
  defaultValue: () => ({
    root: Effect.map(resolveInboxDatabaseEdge, (resolved) =>
      path.join(path.dirname(resolved.path), ATTACHMENTS_DIR_NAME),
    ),
  }),
}) {}

/** A file planned: where it will be kept, and its bytes. */
export interface PlannedAttachment {
  readonly attachment: Attachment;
  readonly data: Uint8Array;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// An Inbox id as a folder name: the ids the CLI makes are ulids, and an id
// that could climb out of the folder is never one.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
// The longest media type kept; a browser's are far shorter.
const MAX_TYPE_LENGTH = 100;

/**
 * Where each upload will be kept, and its bytes, or the first reason it
 * cannot be: data that is not base64, a file or a set over the caps, an
 * Inbox id that is no folder name. Pure past reading the root: nothing is
 * written.
 */
export const planAttachments = (
  root: string,
  inboxId: InboxId,
  uploads: ReadonlyArray<AttachmentUpload>,
): Result.Result<ReadonlyArray<PlannedAttachment>, string> => {
  if (uploads.length > MAX_ATTACHMENTS)
    return Result.fail(
      `an answer carries at most ${MAX_ATTACHMENTS} files, not ${uploads.length}`,
    );
  if (!SAFE_SEGMENT.test(inboxId))
    return Result.fail(`inbox ${inboxId} cannot keep files`);
  const planned: Array<PlannedAttachment> = [];
  let total = 0;
  for (const upload of uploads) {
    const name = safeAttachmentName(upload.name);
    if (upload.data.length % 4 !== 0 || !BASE64.test(upload.data))
      return Result.fail(`the file ${name} did not arrive whole`);
    // Checked on the encoded length first, so an oversized file is refused
    // before it is decoded.
    if ((upload.data.length / 4) * 3 > MAX_ATTACHMENT_BYTES + 2)
      return Result.fail(
        `the file ${name} is too large; a file may be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB`,
      );
    const data = new Uint8Array(Buffer.from(upload.data, 'base64'));
    total += data.byteLength;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES)
      return Result.fail(
        `the files are too large together; they may be at most ${MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)} MiB`,
      );
    const folder = path.join(root, inboxId, sha256Hex(data).slice(0, 16));
    planned.push({
      attachment: {
        path: path.join(folder, name),
        name,
        type: upload.type.trim().toLowerCase().slice(0, MAX_TYPE_LENGTH),
        bytes: data.byteLength,
      },
      data,
    });
  }
  return Result.map(
    checkAttachments(planned.map((p) => p.attachment)),
    () => planned,
  );
};

/**
 * The plan for a set of uploads under this machine's root, or the refusal's
 * sentence. Nothing is written.
 */
export const plannedUploads = Effect.fnUntraced(function* (
  inboxId: InboxId,
  uploads: ReadonlyArray<AttachmentUpload>,
) {
  if (uploads.length === 0) return Result.succeed([]);
  const { root } = yield* AttachmentsRoot;
  return planAttachments(yield* root, inboxId, uploads);
});

/**
 * Write each planned file: whole, under a temporary name in its own folder,
 * then renamed into place. A file already there at its size is left as it
 * is: its folder is named by its bytes.
 */
export const keepAttachments = Effect.fnUntraced(
  function* (planned: ReadonlyArray<PlannedAttachment>) {
    const fs = yield* FileSystem.FileSystem;
    for (const { attachment, data } of planned) {
      const folder = path.dirname(attachment.path);
      const there = yield* fs.stat(attachment.path).pipe(Effect.option);
      if (
        there._tag === 'Some' &&
        there.value.type === 'File' &&
        Number(there.value.size) === attachment.bytes
      )
        continue;
      yield* fs.makeDirectory(folder, { recursive: true });
      const partial = path.join(folder, `.${attachment.name}.partial`);
      yield* fs.writeFile(partial, data);
      yield* fs.rename(partial, attachment.path);
    }
    return planned.map((p) => p.attachment);
  },
  Effect.mapError(
    (e) =>
      new InputError({
        message: `inbox: the attached files could not be kept: ${e.message}`,
      }),
  ),
);
