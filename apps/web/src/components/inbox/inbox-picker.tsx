import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { TriangleAlert } from 'lucide-react';
import { type RefObject, useRef } from 'react';
import { needsAttention } from '../../inbox-elsewhere';
import {
  inboxPickerLitAtom,
  inboxPickerOpenAtom,
  inboxPickerQueryAtom,
  inboxPickerRowsAtom,
  openPickedSessionAtom,
  opensSession,
  type PickerRow,
  pickInboxRowAtom,
  setInboxPickerOpenAtom,
} from '../../inbox-picker';
import { modalField, modalPanel } from '../styles';
import { ICON_EXTERNAL, Icon } from './icon';
import { freshMark, MarkStack } from './marks';
import { PriorityFlag } from './priority';

// The inbox picker: the ⌘P question search's modal, field and list, over every
// Inbox and its session. Base UI's Autocomplete inline in a Dialog, as the
// search is: the arrows move, Enter selects the lit Inbox, Ctrl+Enter or
// ⌘Enter opens its session and stays open, Escape closes.

const ITEM =
  'flex cursor-pointer items-baseline gap-s2 px-s3 py-0.75 text-12 text-fg/80 data-highlighted:bg-fg/8 data-highlighted:text-fg';

const InboxRow = ({
  row,
}: {
  readonly row: Extract<PickerRow, { _tag: 'Inbox' }>;
}) => {
  const pick = useAtomSet(pickInboxRowAtom);
  const openSession = useAtomSet(openPickedSessionAtom);
  const { row: inbox } = row;
  const target = inbox.target;
  const tags = [
    row.machine,
    row.muted ? 'muted' : undefined,
    row.archived ? 'archived' : undefined,
  ].filter((t) => t !== undefined);
  return (
    <Autocomplete.Item
      value={row}
      onClick={() => pick(row)}
      className={`${ITEM} ${row.muted || row.archived ? 'text-fg/45' : ''}`}
      data-testid="inbox-picker-row"
      data-key={row.key}
      data-session={opensSession(row) || undefined}
    >
      <span className="w-8 shrink-0 text-11 text-fg/45" data-picker-code>
        {row.code === undefined ? '' : `@${row.code}`}
      </span>
      <span className="flex min-w-1/3 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-s1">
          <span className="truncate" data-picker-label>
            {inbox.label}
          </span>
          {inbox.priority && <PriorityFlag inboxId={inbox.inboxId} />}
        </span>
        {(inbox.session !== undefined || tags.length > 0) && (
          <span className="truncate text-10 text-fg/45">
            {inbox.session !== undefined && (
              <span data-picker-session>{inbox.session}</span>
            )}
            {inbox.session !== undefined && tags.length > 0 && ' · '}
            {tags.join(' · ')}
          </span>
        )}
      </span>
      {/* The chase button's warning, small: this Inbox is one it counts. */}
      {needsAttention(inbox) && (
        <span
          data-attention
          role="img"
          aria-label="Needs attention"
          title="Needs attention: a question has sat with the agent too long"
          className="flex shrink-0 items-center self-center text-orange"
        >
          <TriangleAlert aria-hidden className="size-3" />
        </span>
      )}
      <span className="w-4 shrink-0 text-right text-11 text-fg/50 tabular-nums">
        {inbox.count === 0 ? '' : inbox.count}
      </span>
      {inbox.fresh === undefined ? (
        <span className="size-1.5 shrink-0" />
      ) : (
        <MarkStack marks={[freshMark(inbox.fresh)]} />
      )}
      {/* The session icon the page uses everywhere: it opens the session as
          Ctrl+Enter does, and neither selects the row nor shuts the modal. A
          session on another machine cannot open here, so it stays greyed. */}
      {target === undefined ? (
        <span className="size-3.5 shrink-0" />
      ) : (
        <button
          type="button"
          aria-label={
            target._tag === 'Here'
              ? `Open the session for ${inbox.label}`
              : `Session on ${target.machine}`
          }
          title={
            target._tag === 'Here'
              ? `Open the session for ${inbox.label}`
              : `Session on ${target.machine}`
          }
          disabled={target._tag !== 'Here'}
          tabIndex={-1}
          data-picker-open-session
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            openSession(row);
          }}
          className={`flex shrink-0 items-center self-center ${target._tag === 'Here' ? 'cursor-pointer text-fg/30 hover:text-fg' : 'cursor-default text-fg/15'}`}
        >
          <Icon d={ICON_EXTERNAL} />
        </button>
      )}
    </Autocomplete.Item>
  );
};

const AllRow = ({ row }: { readonly row: PickerRow }) => {
  const pick = useAtomSet(pickInboxRowAtom);
  return (
    <Autocomplete.Item
      value={row}
      onClick={() => pick(row)}
      className={ITEM}
      data-testid="inbox-picker-row"
      data-key={row.key}
    >
      <span className="w-8 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-fg/60">
        Show all inbox items
      </span>
    </Autocomplete.Item>
  );
};

// The field takes the dialog's first focus, so typing starts at once.
const PickerBody = ({
  field,
}: {
  readonly field: RefObject<HTMLInputElement | null>;
}) => {
  const [query, setQuery] = useAtom(inboxPickerQueryAtom);
  const rows = useAtomValue(inboxPickerRowsAtom);
  const [lit, setLit] = useAtom(inboxPickerLitAtom);
  const openSession = useAtomSet(openPickedSessionAtom);
  return (
    <Autocomplete.Root
      open
      inline
      items={rows}
      filter={null}
      value={query}
      onValueChange={(next) => setQuery(next)}
      onItemHighlighted={(row) => setLit(row)}
      itemToStringValue={(row: PickerRow) =>
        row._tag === 'All' ? row.label : row.row.label
      }
      autoHighlight="always"
      keepHighlight
    >
      <Autocomplete.Input
        ref={field}
        className={modalField}
        aria-label="Pick an inbox"
        placeholder="An inbox or a session, or @abc for an inbox’s code"
        autoComplete="off"
        data-testid="inbox-picker-field"
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
          // Ctrl+Enter is the session's, and the modal stays: Enter on the
          // same row can follow.
          e.preventBaseUIHandler();
          e.preventDefault();
          e.stopPropagation();
          if (lit !== undefined) openSession(lit);
        }}
      />
      {rows.length === 0 && (
        <p className="px-s3 py-s2 text-12 text-fg/45">
          No inbox matches “{query.trim()}”.
        </p>
      )}
      <Autocomplete.List className="max-h-body overflow-y-auto py-s1">
        {(row: PickerRow) =>
          row._tag === 'All' ? (
            <AllRow key={row.key} row={row} />
          ) : (
            <InboxRow key={row.key} row={row} />
          )
        }
      </Autocomplete.List>
      <p className="border-t border-fg/13 px-s3 py-s1 text-10 text-fg/40">
        ↩ select the inbox · Ctrl+↩ open its session
      </p>
    </Autocomplete.Root>
  );
};

export const InboxPicker = () => {
  const open = useAtomValue(inboxPickerOpenAtom);
  const setOpen = useAtomSet(setInboxPickerOpenAtom);
  const field = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-30 bg-fg/20" />
        <Dialog.Popup
          initialFocus={field}
          className={modalPanel}
          data-testid="inbox-picker"
        >
          <Dialog.Title className="sr-only">Pick an inbox</Dialog.Title>
          <PickerBody field={field} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
