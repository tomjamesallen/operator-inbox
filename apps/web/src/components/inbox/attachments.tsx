import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
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
  pendingFilesAtom,
  pendingRefusalAtom,
  removeFileAtom,
} from '../../attachments';
import { Icon } from './icon';

// Files on an answer: the box's drop zone and its "Attach" link, the chips
// of what waits to be sent, and the files an answered card shows.

const ICON_ATTACH =
  'M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9';

// Only a drag that carries files is the drop zone's: dragged text or a link
// goes into the box as the browser would put it there.
const carriesFiles = (e: DragEvent): boolean =>
  e.dataTransfer.types.includes('Files');

/** The box at the foot, as a place files can be dropped on. */
export const AttachDrop = ({
  place,
  children,
}: {
  readonly place: string;
  readonly children: ReactNode;
}) => {
  const [over, setOver] = useAtom(dragOverAtom);
  const add = useAtomSet(addFilesAtom);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only catches a drop of files; the "Attach" link under it is the keyboard's way in.
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
 * The line under a box that takes no files (nothing to answer, a send on
 * its way, an Inbox being picked): the "Attach" link's line, kept with the
 * link hidden, so the box never moves as the link comes and goes.
 */
export const AttachRowSpace = () => (
  <div
    aria-hidden="true"
    className="invisible mt-s1 flex items-center gap-s1 text-11"
    data-zen-attach-space
  >
    <span className="flex items-center gap-s1 py-s1 pr-s1">
      <Icon d={ICON_ATTACH} />
      Attach
    </span>
  </div>
);

/**
 * The line under the box: the "Attach" link, which opens the file picker,
 * then a chip for each file waiting to be sent, each with its own ×.
 */
export const AttachRow = ({ place }: { readonly place: string }) => {
  const files = useAtomValue(pendingFilesAtom(place));
  const refused = useAtomValue(pendingRefusalAtom(place));
  const add = useAtomSet(addFilesAtom);
  const remove = useAtomSet(removeFileAtom);
  const picker = useRef<HTMLInputElement | null>(null);
  return (
    <div className="mt-s1 flex flex-wrap items-center gap-s1 text-11 text-fg/40">
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          add({ place, files: [...(e.target.files ?? [])] });
          // The same file picked again is a change too.
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => picker.current?.click()}
        className="flex cursor-pointer items-center gap-s1 py-s1 pr-s1 hover:text-fg"
        data-zen-attach
      >
        <Icon d={ICON_ATTACH} />
        Attach
      </button>
      {files.map((f) => (
        <span
          key={f.id}
          className="flex max-w-60 items-center gap-s1 border border-fg/12 py-px pr-px pl-s1 text-fg/70"
          data-zen-pending-file
        >
          {f.preview !== undefined && (
            <img src={f.preview} alt="" className="size-4 object-cover" />
          )}
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="shrink-0 text-fg/35">{attachmentSize(f.bytes)}</span>
          <button
            type="button"
            aria-label={`Remove ${f.name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => remove({ place, id: f.id })}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-fg/35 hover:bg-fg/7 hover:text-fg"
          >
            <Icon d="M7 7l10 10M17 7L7 17" />
          </button>
        </span>
      ))}
      {refused !== undefined && (
        <output className="text-orange">{refused}</output>
      )}
    </div>
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
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              title={`${a.name} (${attachmentSize(a.bytes)})`}
              className="block border border-fg/12 hover:border-fg/40"
            >
              <img
                src={url}
                alt={a.name}
                loading="lazy"
                className="block max-h-40 max-w-60 object-contain"
              />
            </a>
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
