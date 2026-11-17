import {
  type Attachment,
  type AttachmentUpload,
  imageAttachmentNamed,
  isImageAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from '@operator-inbox/core/api';
import { Effect } from 'effect';
import { Atom, type AtomRegistry } from 'effect/reactivity';

// The files the operator attaches before they send, by the box they belong
// to (the box's place: `answer:<key>`, `follow:<key>` or `ask:<inboxId>`).
// They are the browser's `File`s, held in memory only: a reload drops them,
// as it would a file picked into any form. The send reads each as base64 and
// carries it in the answer's own request (`AttachmentUpload`); the server
// keeps it on disk and the event names it by its path.

/** A file waiting to be sent. */
export interface PendingFile {
  // Unique within its box, for React's key and for taking it off.
  readonly id: number;
  readonly file: File;
  readonly name: string;
  readonly type: string;
  readonly bytes: number;
  // An object URL for an image's thumbnail, revoked when the file goes.
  readonly preview?: string;
}

interface PendingFiles {
  readonly files: ReadonlyArray<PendingFile>;
  readonly next: number;
  // Why the last files added were not all taken, until the next change.
  readonly refused?: string;
}

const EMPTY: PendingFiles = {
  files: [] as ReadonlyArray<PendingFile>,
  next: 1,
};

const pendingAtom = Atom.family((_place: string) =>
  Atom.make<PendingFiles>(EMPTY).pipe(Atom.keepAlive),
);

/**
 * The file picker asked for, by the box's place: `/attach` sets it, and the
 * box's own hidden picker (`AttachDrop`) opens when it is its place. A new
 * object each time, so asking twice for one box opens it twice.
 */
export const pickerAskedAtom = Atom.make<
  { readonly place: string } | undefined
>(undefined).pipe(Atom.keepAlive);

/** The files waiting in one box, in the order they were added. */
export const pendingFilesAtom = Atom.family((place: string) =>
  Atom.make((get) => get(pendingAtom(place)).files),
);

/** Why the last files added to the box were not all taken, if they were not. */
export const pendingRefusalAtom = Atom.family((place: string) =>
  Atom.make((get) => get(pendingAtom(place)).refused),
);

const mib = (bytes: number): string =>
  `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Add files to a box, as many as the caps allow: each within
 * `MAX_ATTACHMENT_BYTES`, the box's within `MAX_ATTACHMENTS` and
 * `MAX_ATTACHMENTS_TOTAL_BYTES`. A file left out says why.
 */
export const addFilesAtom = Atom.writable<
  void,
  { readonly place: string; readonly files: ReadonlyArray<File> }
>(
  () => undefined,
  (ctx, { place, files }) => {
    const was = ctx.get(pendingAtom(place));
    const kept = [...was.files];
    let next = was.next;
    let total = kept.reduce((n, f) => n + f.bytes, 0);
    let refused: string | undefined;
    for (const file of files) {
      if (kept.length >= MAX_ATTACHMENTS) {
        refused = `At most ${MAX_ATTACHMENTS} files.`;
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        refused = `${file.name} is over ${mib(MAX_ATTACHMENT_BYTES)}.`;
        continue;
      }
      if (total + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
        refused = `The files may come to ${mib(MAX_ATTACHMENTS_TOTAL_BYTES)} at most.`;
        continue;
      }
      total += file.size;
      kept.push({
        id: next++,
        file,
        name: file.name === '' ? 'pasted' : file.name,
        type: file.type,
        bytes: file.size,
        ...(isImageAttachment(file.type)
          ? { preview: URL.createObjectURL(file) }
          : {}),
      });
    }
    ctx.set(pendingAtom(place), {
      files: kept,
      next,
      ...(refused === undefined ? {} : { refused }),
    });
  },
);

/** Take one file off a box. */
export const removeFileAtom = Atom.writable<
  void,
  { readonly place: string; readonly id: number }
>(
  () => undefined,
  (ctx, { place, id }) => {
    const was = ctx.get(pendingAtom(place));
    const gone = was.files.find((f) => f.id === id);
    if (gone?.preview !== undefined) URL.revokeObjectURL(gone.preview);
    ctx.set(pendingAtom(place), {
      files: was.files.filter((f) => f.id !== id),
      next: was.next,
    });
  },
);

/**
 * Clear the files that went with a send, by id: any added while it was on
 * its way stay.
 */
export const clearSentFiles = (
  registry: AtomRegistry.AtomRegistry,
  place: string,
  sent: ReadonlyArray<PendingFile>,
): void => {
  const was = registry.get(pendingAtom(place));
  const ids = new Set(sent.map((f) => f.id));
  for (const f of was.files)
    if (ids.has(f.id) && f.preview !== undefined)
      URL.revokeObjectURL(f.preview);
  registry.set(pendingAtom(place), {
    files: was.files.filter((f) => !ids.has(f.id)),
    next: was.next,
  });
};

// Base64 by chunks: `String.fromCharCode` over a whole file would overflow
// the call stack.
const base64Of = (bytes: Uint8Array): string => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** Each pending file as the answer's request carries it. */
export const uploadsOf = (files: ReadonlyArray<PendingFile>) =>
  Effect.forEach(files, (f) =>
    Effect.map(
      Effect.promise(() => f.file.arrayBuffer()),
      (buffer): AttachmentUpload => ({
        name: f.name,
        type: f.type,
        data: base64Of(new Uint8Array(buffer)),
      }),
    ),
  );

/**
 * Where the page reads a kept file back from (serve's
 * `/api/attachments/<inbox>/<hash>/<name>`): the last three segments of its
 * path. Undefined for a path not shaped as one.
 */
export const attachmentUrl = (a: Attachment): string | undefined => {
  const parts = a.path.split('/').slice(-3);
  if (parts.length < 3 || parts.some((p) => p === '')) return undefined;
  return `/api/attachments/${parts.map(encodeURIComponent).join('/')}`;
};

/**
 * The files to show in the strip under a question's body: all of them but
 * those the body already shows in place. `bodyImages` names those (serve
 * reads them from the body's markdown, core's `renderedQuestionBody`), and
 * each name is drawn from the first image of that name
 * (`imageAttachmentNamed`), as serve draws it. Where the page cannot read a
 * file back (`readable` false, or a path `attachmentUrl` cannot read), the
 * body cannot draw it, so it stays in the strip.
 */
export const attachmentsBesideBody = (
  bodyImages: ReadonlyArray<string>,
  attachments: ReadonlyArray<Attachment>,
  readable: boolean,
): ReadonlyArray<Attachment> => {
  if (!readable || bodyImages.length === 0) return attachments;
  const inline = new Set(
    bodyImages.flatMap((name) => {
      const file = imageAttachmentNamed(attachments, name);
      return file === undefined || attachmentUrl(file) === undefined
        ? []
        : [file];
    }),
  );
  return attachments.filter((a) => !inline.has(a));
};

/**
 * The image a question's body shows in place that is open whole over the
 * page, by the question's key: the name the body's image gives it
 * (`data-attachment-image`), or undefined while none is.
 */
export const bodyImageOpenAtom = Atom.family((_key: string) =>
  Atom.make<string | undefined>(undefined),
);

/** Files are being dragged over the box at the foot. */
export const dragOverAtom = Atom.make(false);
