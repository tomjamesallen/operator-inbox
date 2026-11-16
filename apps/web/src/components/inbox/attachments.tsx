import { Dialog } from '@base-ui/react/dialog';
import {
  useAtom,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@effect/atom-react';
import {
  type Attachment,
  attachmentSize,
  isImageAttachment,
} from '@operator-inbox/core/api';
import { type DragEvent, type ReactNode, useRef } from 'react';
import {
  addFilesAtom,
  attachmentUrl,
  dragOverAtom,
  type PendingFile,
  pendingFilesAtom,
  pendingRefusalAtom,
  pickerAskedAtom,
  removeFileAtom,
} from '../../attachments';
import { focusRing, headerButton, label } from '../styles';
import { edgeFade, fadeEdges } from './edge-fade';
import { ICON_EXTERNAL, Icon } from './icon';

// Files on an answer: the box's drop zone and its file picker, which `/attach`
// in the box's menu opens; a card per file waiting to be sent, in the strip
// of cards under the box; and the files an answered card shows.

const ICON_ATTACH =
  'M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9';
const ICON_FILE =
  'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5';
const ICON_REMOVE = 'M7 7l10 10M17 7L7 17';

// Only a drag that carries files is the drop zone's: dragged text or a link
// goes into the box as the browser would put it there.
const carriesFiles = (e: DragEvent): boolean =>
  e.dataTransfer.types.includes('Files');

/**
 * The box at the foot, as a place files can be dropped on, with its hidden
 * file picker (several files at once), which opens when `/attach` asks for
 * this place (`pickerAskedAtom`).
 */
export const AttachDrop = ({
  place,
  children,
}: {
  readonly place: string;
  readonly children: ReactNode;
}) => {
  const [over, setOver] = useAtom(dragOverAtom);
  const add = useAtomSet(addFilesAtom);
  const picker = useRef<HTMLInputElement | null>(null);
  // Synchronous with the pick, so it is still the key press or the click the
  // browser needs before it opens a picker.
  useAtomSubscribe(pickerAskedAtom, (asked) => {
    if (asked?.place === place) picker.current?.click();
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only catches a drop of files; `/attach` in the box is the keyboard's way in.
    <div
      className="relative"
      data-zen-drop
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // Leaving for a child of the zone is still over it.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setOver(false);
        add({ place, files: [...e.dataTransfer.files] });
      }}
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-zen-picker
        onChange={(e) => {
          add({ place, files: [...(e.target.files ?? [])] });
          // The same file picked again is a change too.
          e.target.value = '';
        }}
      />
      {children}
      {over && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center border border-dashed border-fg/40 bg-bg/90 text-11 text-fg/60"
        >
          Drop to attach
        </div>
      )}
    </div>
  );
};

/**
 * A file waiting to be sent, as a card in the strip under the box: its
 * picture, or a file's mark, over its name and size, and × to take it off.
 */
const FileCard = ({
  place,
  file,
}: {
  readonly place: string;
  readonly file: PendingFile;
}) => {
  const remove = useAtomSet(removeFileAtom);
  return (
    <section
      aria-label={`/attach ${file.name}`}
      title={`${file.name} (${attachmentSize(file.bytes)})`}
      className="relative flex w-28 shrink-0 flex-col border border-fg/12 font-zen text-11"
      data-zen-pending-file
    >
      {file.preview !== undefined ? (
        <img src={file.preview} alt="" className="h-16 w-full object-cover" />
      ) : (
        <span className="flex h-16 w-full items-center justify-center bg-fg/4 text-fg/35">
          <Icon d={ICON_FILE} />
        </span>
      )}
      <span className="truncate px-s1 pt-0.5 text-fg/75" data-zen-file-name>
        {file.name}
      </span>
      <span className="px-s1 pb-0.5 text-fg/35">
        {attachmentSize(file.bytes)}
      </span>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        title="Remove"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => remove({ place, id: file.id })}
        className={`absolute top-0.5 right-0.5 flex size-4 cursor-pointer items-center justify-center bg-bg/90 text-fg/40 hover:text-fg ${focusRing}`}
      >
        <Icon d={ICON_REMOVE} />
      </button>
    </section>
  );
};

/**
 * The cards of the files waiting in a box, side by side, wrapping: one row
 * of the strip of cards under the box (`MacroCards`, or `FileStrip` under a
 * box with no other cards). Nothing when there are none.
 */
export const FileCards = ({ place }: { readonly place: string }) => {
  const files = useAtomValue(pendingFilesAtom(place));
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-s1" data-zen-file-cards>
      {files.map((f) => (
        <FileCard key={f.id} place={place} file={f} />
      ))}
    </div>
  );
};

/**
 * The strip of cards under a box whose only cards are files (a follow-up,
 * an ask): the answer box's strip, with its height and its faded edges.
 */
export const FileStrip = ({ place }: { readonly place: string }) => {
  const files = useAtomValue(pendingFilesAtom(place));
  if (files.length === 0) return null;
  return (
    <div
      ref={fadeEdges}
      className={`mt-s1 flex max-h-cards flex-col gap-s1 overflow-y-auto ${edgeFade}`}
      data-macro-cards
    >
      <FileCards place={place} />
    </div>
  );
};

/** Why the last files added to the box were not all taken, under it. */
export const AttachRefusal = ({ place }: { readonly place: string }) => {
  const refused = useAtomValue(pendingRefusalAtom(place));
  return refused === undefined ? null : (
    <output className="mt-s1 block text-11 text-orange">{refused}</output>
  );
};

/**
 * The files an answer or a question carries, on its card: an image as a
 * thumbnail that opens whole in a new tab, anything else as its name. A
 * file held on another machine cannot be read from here, so it is its name
 * only (`readable` false).
 */
export const AttachmentList = ({
  attachments,
  readable,
}: {
  readonly attachments: ReadonlyArray<Attachment>;
  readonly readable: boolean;
}) => (
  <ul
    className="mt-s2 flex flex-wrap items-end gap-s2 text-11 text-fg/60"
    aria-label="Attached files"
    data-zen-attachments
  >
    {attachments.map((a) => {
      const url = readable ? attachmentUrl(a) : undefined;
      const image = url !== undefined && isImageAttachment(a.type);
      return (
        <li key={a.path} className="min-w-0">
          {image ? (
            <ImageLightbox attachment={a} url={url} />
          ) : (
            <a
              {...(url === undefined ? {} : { href: url, download: a.name })}
              title={a.path}
              className={`flex max-w-60 items-center gap-s1 border border-fg/12 px-s1 py-px ${url === undefined ? '' : 'hover:border-fg/40 hover:text-fg'}`}
            >
              <Icon d={ICON_ATTACH} />
              <span className="min-w-0 truncate">{a.name}</span>
              <span className="shrink-0 text-fg/35">
                {attachmentSize(a.bytes)}
              </span>
            </a>
          )}
        </li>
      );
    })}
  </ul>
);

/**
 * An attached image: its thumbnail, which opens the image over the page,
 * fitted to the window. Escape, a click on the backdrop and CLOSE dismiss
 * it; "Open original" opens the file itself in a new tab. One for every
 * card that shows files: an answer's, a follow-up's and an operator's
 * question's.
 */
export const ImageLightbox = ({
  attachment,
  url,
}: {
  readonly attachment: Attachment;
  readonly url: string;
}) => (
  <Dialog.Root>
    <Dialog.Trigger
      // The card under it lights on a click; the image is not the card's.
      onClick={(e) => e.stopPropagation()}
      aria-label={`Show ${attachment.name}`}
      title={`${attachment.name} (${attachmentSize(attachment.bytes)})`}
      className={`block cursor-zoom-in border border-fg/12 hover:border-fg/40 ${focusRing}`}
      data-zen-thumbnail
    >
      <img
        src={url}
        alt={attachment.name}
        loading="lazy"
        className="block max-h-40 max-w-60 object-contain"
      />
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
      <Dialog.Popup
        className="fixed inset-s4 z-40 flex flex-col border border-fg/20 bg-bg p-s3"
        data-zen-lightbox
      >
        <div className="flex items-center gap-s3">
          <Dialog.Title className={`min-w-0 flex-1 truncate ${label}`}>
            {attachment.name}
          </Dialog.Title>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={`flex shrink-0 items-center gap-s1 text-11 text-fg/40 hover:text-fg ${focusRing}`}
          >
            <Icon d={ICON_EXTERNAL} />
            Open original
          </a>
          <Dialog.Close className={`${headerButton()} ${focusRing}`}>
            CLOSE
          </Dialog.Close>
        </div>
        {/* A click beside the image, inside the frame, dismisses it too. */}
        <Dialog.Close
          render={<div />}
          nativeButton={false}
          className="mt-s2 flex min-h-0 flex-1 cursor-zoom-out items-center justify-center"
          aria-label={`Close ${attachment.name}`}
        >
          <img
            src={url}
            alt={attachment.name}
            className="max-h-full max-w-full object-contain"
          />
        </Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);
