import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { strayWritesAtom } from '../../inbox';
import {
  goToQuestionAtom,
  type SideNote,
  sideNotesAtom,
} from '../../inbox-rail';

const TONES = { red: 'bg-red', orange: 'bg-orange' } as const;

const Note = ({ note }: { readonly note: SideNote }) => {
  const go = useAtomSet(goToQuestionAtom);
  const [stray, setStray] = useAtom(strayWritesAtom);
  const { go: key, stray: strayId } = note;
  return (
    <li className="flex items-baseline gap-s1 text-11" data-note={note.kind}>
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 translate-y-px rounded-full ${TONES[note.tone]}`}
      />
      <div className="min-w-0 flex-1 wrap-break-word text-fg/70">
        {key === undefined ? (
          <p className="first-letter:uppercase">{note.text}</p>
        ) : (
          <button
            type="button"
            onClick={() => go(key)}
            className="cursor-pointer text-left underline decoration-fg/25 first-letter:uppercase hover:text-fg"
          >
            {note.text}
          </button>
        )}
        {note.more !== undefined && (
          <p className="text-fg/45 first-letter:uppercase">{note.more}</p>
        )}
      </div>
      {strayId !== undefined && (
        <button
          type="button"
          onClick={() => setStray(stray.filter((w) => w.id !== strayId))}
          className="shrink-0 cursor-pointer text-fg/40 hover:text-fg"
        >
          Clear
        </button>
      )}
    </li>
  );
};

/** What is wrong beyond one machine, in full, above the machines. */
export const SideNotes = () => {
  const notes = useAtomValue(sideNotesAtom);
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-s2 px-s3 pb-s3" data-zen-side-notes>
      {notes.map((n) => (
        <Note key={n.id} note={n} />
      ))}
    </ul>
  );
};
