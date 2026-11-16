import { Result, Schema } from 'effect';

// Files the operator attaches to an answer or to a question they put to the
// agent: a screenshot, a log, a document. The point of one is its path on
// disk, so the agent reads the file itself: the file is written under the
// store's folder (`<store folder>/attachments/<inbox id>/<hash>/<name>`)
// BEFORE the event naming it is appended, and the event carries only where
// it is and what it is (`Attachment`), never its bytes. An append that then
// fails leaves a file no event names, which costs only its bytes.
//
// BROWSER-SAFE and pure: `effect` only, no clock, no platform.

// An attachment as an event carries it. Plain fields, so a log never fails
// to decode on a check made later; the decision checks them
// (`checkAttachments`).
export const Attachment = Schema.Struct({
  // Absolute, on the machine that holds the Inbox's log.
  path: Schema.String,
  // The name the file is kept under: the operator's, made safe
  // (`safeAttachmentName`).
  name: Schema.String,
  // Its media type, as the browser gave it; '' when it gave none.
  type: Schema.String,
  bytes: Schema.Int,
});
export type Attachment = typeof Attachment.Type;

export const Attachments = Schema.Array(Attachment);
export type Attachments = typeof Attachments.Type;

/** The most files one answer or question may carry. */
export const MAX_ATTACHMENTS = 10;

/** The most bytes one file may take. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The most bytes the files of one answer or question may take together. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 40 * 1024 * 1024;

/** The folder, beside the store, the files are kept in. */
export const ATTACHMENTS_DIR_NAME = 'attachments';

// The longest name a file is kept under, in characters, its extension kept.
const MAX_NAME_LENGTH = 120;

/**
 * The name a file is kept under: the last segment of what the browser gave,
 * with nothing a shell or a file system would read as more than a name.
 * Separators, control characters and the characters Windows refuses become
 * `-`; leading dots go, so the file is never hidden; runs of space become
 * one; and a long name is cut, its extension kept. Nothing left is `file`.
 */
export const safeAttachmentName = (given: string): string => {
  const last = given.split(/[/\\]/).pop() ?? '';
  const cleaned = last
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+/, '');
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  return `${cleaned.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd()}${ext}`;
};

/**
 * A set of attachments as an event may carry it: no more than
 * `MAX_ATTACHMENTS`, each path absolute and ending in its name, each name
 * safe, each size within the caps. The set as kept, or the first reason it
 * cannot be.
 */
export const checkAttachments = (
  attachments: ReadonlyArray<Attachment>,
): Result.Result<ReadonlyArray<Attachment>, string> => {
  if (attachments.length > MAX_ATTACHMENTS)
    return Result.fail(
      `an answer carries at most ${MAX_ATTACHMENTS} files, not ${attachments.length}`,
    );
  let total = 0;
  for (const a of attachments) {
    if (a.name === '' || safeAttachmentName(a.name) !== a.name)
      return Result.fail(`"${a.name}" is not a name a file is kept under`);
    if (!a.path.startsWith('/') || !a.path.endsWith(`/${a.name}`))
      return Result.fail(`the file ${a.name} is not kept at an absolute path`);
    if (!Number.isInteger(a.bytes) || a.bytes < 0)
      return Result.fail(`the file ${a.name} has no size`);
    if (a.bytes > MAX_ATTACHMENT_BYTES)
      return Result.fail(
        `the file ${a.name} is ${mib(a.bytes)}; a file may be at most ${mib(MAX_ATTACHMENT_BYTES)}`,
      );
    total += a.bytes;
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES)
    return Result.fail(
      `the files come to ${mib(total)}; together they may be at most ${mib(MAX_ATTACHMENTS_TOTAL_BYTES)}`,
    );
  return Result.succeed(attachments);
};

const mib = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

// The image types the page shows as a thumbnail and the server sends back
// as an image. SVG is left out: it can carry script.
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** Whether a file of this media type is shown as an image. */
export const isImageAttachment = (type: string): boolean =>
  IMAGE_TYPES.has(type.toLowerCase());

/** A file's size as a person reads it: `812 B`, `14 KB`, `2.3 MB`. */
export const attachmentSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
