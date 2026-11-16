import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { type RefObject, useRef } from 'react';
import { DEFAULT_GROUP } from '../inbox';
import { unreadNowAtom } from '../inbox-rail';
import {
  openSearchEntryAtom,
  questionSearchOpenAtom,
  questionSearchQueryAtom,
  questionSearchResultsAtom,
  type SearchEntry,
  type SearchSection,
  setQuestionSearchOpenAtom,
} from '../question-search';
import { modalField, modalPanel } from './styles';

// The ⌘P / Ctrl+P question search: a field over every question the board
// holds, the matches under Your inbox, With the agent and Processed, in that
// order. Base UI's Autocomplete, inline in a Dialog near the top of the
// window, as a find palette is. Arrows move, Enter opens
// the highlighted match, Escape closes.

const SearchItem = ({ entry }: { readonly entry: SearchEntry }) => {
  const open = useAtomSet(openSearchEntryAtom);
  return (
    <Autocomplete.Item
      value={entry}
      onClick={() => open(entry)}
      className="flex cursor-pointer items-baseline gap-s2 px-s3 py-0.75 text-12 text-fg/80 data-highlighted:bg-fg/8 data-highlighted:text-fg"
      data-testid="search-hit"
      data-key={entry.key}
    >
      <span className="shrink-0 text-11 text-fg/45">#{entry.number}</span>
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
      <span className="w-1/3 shrink-0 truncate text-right text-11 text-fg/45">
        {entry.machine === undefined ? '' : `${entry.machine} · `}
        {entry.label} ·{' '}
        {entry.group === DEFAULT_GROUP ? 'Default' : entry.group}
        {entry.archived ? ' · archived' : ''}
      </span>
    </Autocomplete.Item>
  );
};

// The field takes the dialog's first focus, so typing starts at once.
const SearchBody = ({
  field,
}: {
  readonly field: RefObject<HTMLInputElement | null>;
}) => {
  const [query, setQuery] = useAtom(questionSearchQueryAtom);
  const sections = useAtomValue(questionSearchResultsAtom);
  const unread = useAtomValue(unreadNowAtom);
  const blank = query.trim() === '';
  return (
    <Autocomplete.Root
      open
      inline
      items={sections}
      filter={null}
      value={query}
      onValueChange={(next) => setQuery(next)}
      itemToStringValue={(entry: SearchEntry) => entry.title}
      autoHighlight="always"
      keepHighlight
    >
      <Autocomplete.Input
        ref={field}
        className={modalField}
        aria-label="Search questions"
        placeholder="#330, or words from a title or body"
        autoComplete="off"
        data-testid="search-field"
      />
      {blank ? null : sections.length === 0 ? (
        <p className="px-s3 py-s2 text-12 text-fg/45">
          No question matches “{query.trim()}”.
        </p>
      ) : null}
      {unread.length > 0 && (
        <p className="px-s3 pt-s2 text-11 text-fg/45" data-search-not-searched>
          {unread.map((m) => m.label).join(' and ')} not searched: cannot be
          reached.
        </p>
      )}
      <Autocomplete.List className="max-h-body overflow-y-auto py-s1">
        {(section: SearchSection) => (
          <Autocomplete.Group
            key={section.column}
            items={section.items}
            data-testid="search-section"
            data-column={section.column}
          >
            <Autocomplete.GroupLabel className="px-s3 pt-s2 pb-s1 text-10 tracking-label text-fg/45 uppercase">
              {section.heading}
            </Autocomplete.GroupLabel>
            <Autocomplete.Collection>
              {(entry: SearchEntry) => (
                <SearchItem key={entry.key} entry={entry} />
              )}
            </Autocomplete.Collection>
          </Autocomplete.Group>
        )}
      </Autocomplete.List>
    </Autocomplete.Root>
  );
};

export const QuestionSearch = () => {
  const open = useAtomValue(questionSearchOpenAtom);
  const setOpen = useAtomSet(setQuestionSearchOpenAtom);
  const field = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-30 bg-fg/20"
          data-testid="modal-backdrop"
        />
        <Dialog.Popup
          initialFocus={field}
          className={modalPanel}
          data-testid="question-search"
        >
          <Dialog.Title className="sr-only">Search questions</Dialog.Title>
          <SearchBody field={field} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
