import { Dialog } from '@base-ui/react/dialog';
import { Input } from '@base-ui/react/input';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { type RefObject, useRef } from 'react';
import {
  goToSessionOpenAtom,
  goToSessionQueryAtom,
  pickSessionAtom,
  type SessionChoice,
  sessionChoicesAtom,
  setGoToSessionOpenAtom,
  setSessionCursorAtom,
  stepSessionAtom,
} from '../../go-to-session';
import { drawnBoardAtom } from '../../inbox';
import { modalField, modalPanel } from '../styles';

// The ask's list of Inboxes, in the search's modal: type to filter, the arrows
// move, Enter or a click opens the session, Escape closes.

const LIST_ID = 'go-to-session-list';
const rowId = (inboxId: string) => `go-to-session-${inboxId}`;

const Field = ({
  field,
}: {
  readonly field: RefObject<HTMLInputElement | null>;
}) => {
  const [query, setQuery] = useAtom(goToSessionQueryAtom);
  const step = useAtomSet(stepSessionAtom);
  const pick = useAtomSet(pickSessionAtom);
  const { cursor } = useAtomValue(sessionChoicesAtom);
  return (
    <Input
      ref={field}
      value={query}
      onValueChange={setQuery}
      className={modalField}
      role="combobox"
      aria-label="Which session?"
      aria-expanded
      aria-controls={LIST_ID}
      aria-activedescendant={
        cursor === undefined ? undefined : rowId(cursor.inboxId)
      }
      placeholder="Which session?"
      autoComplete="off"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') step(1);
        else if (e.key === 'ArrowUp') step(-1);
        else if (e.key === 'Enter' && cursor?.link !== undefined)
          pick(cursor.link);
        else return;
        e.preventDefault();
      }}
    />
  );
};

const Row = ({
  choice,
  lit,
  machined,
}: {
  readonly choice: SessionChoice;
  readonly lit: boolean;
  readonly machined: boolean;
}) => {
  const pick = useAtomSet(pickSessionAtom);
  const setCursor = useAtomSet(setSessionCursorAtom);
  const { archived, inboxId, label, link, machine } = choice;
  const tone =
    link === undefined
      ? 'cursor-default text-fg/15'
      : lit
        ? 'cursor-pointer text-fg'
        : 'cursor-pointer text-fg/35 hover:text-fg/70';
  return (
    <button
      type="button"
      id={rowId(inboxId)}
      role="option"
      aria-selected={lit}
      aria-disabled={link === undefined}
      tabIndex={-1}
      ref={lit ? (row) => row?.scrollIntoView({ block: 'nearest' }) : undefined}
      // A press keeps the caret in the box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (link !== undefined) pick(link);
      }}
      onMouseEnter={() => {
        if (link !== undefined) setCursor(inboxId);
      }}
      className={`flex items-baseline gap-s2 text-left ${tone}`}
    >
      <span className="min-w-0 truncate">{label}</span>
      {machined && machine !== 'Local' && (
        <span className="shrink-0 font-zen text-11 text-fg/40">{machine}</span>
      )}
      {archived && (
        <span className="shrink-0 font-zen text-11 text-fg/40">archived</span>
      )}
    </button>
  );
};

const List = () => {
  const board = useAtomValue(drawnBoardAtom);
  const query = useAtomValue(goToSessionQueryAtom);
  const { choices, cursor } = useAtomValue(sessionChoicesAtom);
  const machined = (board?.machines?.length ?? 0) > 1;
  return (
    <div
      id={LIST_ID}
      role="listbox"
      aria-label="Inboxes with a session"
      className="flex max-h-body flex-col gap-s1 overflow-y-auto px-s3 py-s2 font-reading text-14"
    >
      {choices.length === 0 && (
        <p className="text-fg/30">
          {query.trim() === ''
            ? 'No inbox has a session.'
            : 'No session matches.'}
        </p>
      )}
      {choices.map((c) => (
        <Row
          key={c.inboxId}
          choice={c}
          lit={c.inboxId === cursor?.inboxId}
          machined={machined}
        />
      ))}
    </div>
  );
};

export const GoToSession = () => {
  const open = useAtomValue(goToSessionOpenAtom);
  const setOpen = useAtomSet(setGoToSessionOpenAtom);
  const field = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
        <Dialog.Popup
          initialFocus={field}
          className={modalPanel}
          data-go-to-session
        >
          <Dialog.Title className="sr-only">Go to session</Dialog.Title>
          <Field field={field} />
          <List />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
