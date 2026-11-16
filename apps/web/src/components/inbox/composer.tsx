import {
  useAtom,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@effect/atom-react';
import type { InboxId } from '@operator-inbox/core/api';
import { AsyncResult } from 'effect/reactivity';
import { type KeyboardEvent, type ReactNode, useCallback, useRef } from 'react';
import { failureText, refusalText } from '../../failure';
import {
  askDraftAtom,
  askQueryAtom,
  drawnBoardAtom,
  followUpDraftAtom,
  isTextEntry,
  responseDraftAtom,
  scopeLine,
  screenStateAtom,
  selectedInboxAtom,
  sidebarPinnedOnlyAtom,
} from '../../inbox';
import type { InboxItem } from '../../inbox-queues';
import {
  activeQueueAtom,
  askChoicesAtom,
  askPlaceOf,
  askProgressAtom,
  boxFocusAskedAtom,
  composerAtom,
  type FootTone,
  followUpPlaceOf,
  footNoteOf,
  litKeyAtom,
  pickAskInboxAtom,
  railStateAtom,
  readerAskAtom,
  readerIntroAtom,
  sendComposerAtom,
  shownQueuesAtom,
  stepAskAtom,
  troublesAtom,
} from '../../inbox-reader';
import {
  type Composer as ComposerState,
  inboxReaderAtoms,
} from '../../inbox-reader-machine';
import { keyHintAtom } from '../../keymap';
import { InboxActions, LitActions } from './colophon';
import { Icon, Tip } from './icon';
import { InboxMenuButton } from './row-menu';

// The box at the foot. It belongs to the lit question, and the machine says how
// (`composerOf`): an answer, a follow-up, a question for the agent, or nothing
// to write. Its drafts live in Atoms, so a box that goes keeps what was typed.

/** The first load's fade, on what comes in as the tabs do. */
export const introFade = (intro: boolean): string =>
  `transition-opacity ease-fade ${intro ? 'opacity-0' : 'opacity-100 delay-800 duration-700'}`;

// The box holds focus through every move, with the caret after the draft. Each
// new box is a new element, so this runs once for it. It leaves a field the
// reader is typing in alone, and a phone's keyboard shut.
const onPhone = (): boolean =>
  window.matchMedia?.('(pointer: coarse)').matches === true;

const takeFocus = (el: HTMLTextAreaElement | null): void => {
  if (el === null || isTextEntry(document.activeElement) || onPhone()) return;
  el.focus({ preventScroll: true });
  el.setSelectionRange(el.value.length, el.value.length);
};

// A sidebar going takes the focus inside it along, to nowhere, and the box was
// never remounted to take it back. A focus anywhere else is not the sidebar's.
const lostToRail = (): boolean => {
  const at = document.activeElement;
  return (
    at === null ||
    at === document.body ||
    at.closest('[data-inbox-sidebar]') !== null
  );
};

// What makes the picking box a combobox over the list above it.
const PICK_LIST_ID = 'ask-choices';
const pickChoiceId = (inboxId: InboxId): string => `ask-choice-${inboxId}`;

const Box = ({
  value,
  placeholder,
  disabled = false,
  onChange,
  onKeyDown,
  combobox,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onChange: (text: string) => void;
  readonly onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly combobox?: { readonly active: string | undefined };
}) => {
  const self = useRef<HTMLTextAreaElement | null>(null);
  // Stable, or each render would run it and take the focus back.
  const attach = useCallback((el: HTMLTextAreaElement | null) => {
    self.current = el;
    takeFocus(el);
  }, []);
  // A key asks for the caret from anywhere, another field included.
  useAtomSubscribe(boxFocusAskedAtom, () =>
    self.current?.focus({ preventScroll: true }),
  );
  useAtomSubscribe(railStateAtom, (rail) => {
    if (rail === 'shut' && lostToRail() && !onPhone())
      self.current?.focus({ preventScroll: true });
  });
  return (
    <textarea
      ref={attach}
      value={value}
      disabled={disabled}
      aria-label={placeholder === '' ? 'Nothing to answer' : placeholder}
      data-zen-box
      {...(combobox === undefined
        ? {}
        : {
            role: 'combobox',
            'aria-autocomplete': 'list',
            'aria-expanded': true,
            'aria-controls': PICK_LIST_ID,
            'aria-activedescendant': combobox.active,
          })}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className="field-sizing-content max-h-body w-full resize-none bg-transparent py-s1 font-reading text-14 leading-card text-fg outline-none placeholder:text-fg/30 pointer-coarse:text-field"
    />
  );
};

// Both sit in fixed places, so nothing moves as a draft starts or empties. A
// press keeps the caret in the box. Each names its keys, the first binding only.
const Actions = ({
  label,
  ready,
  deferrable = false,
}: {
  readonly label: string;
  readonly ready: boolean;
  readonly deferrable?: boolean;
}) => {
  const send = useAtomSet(sendComposerAtom);
  const sendHint = useAtomValue(keyHintAtom('send_response'));
  const deferHint = useAtomValue(keyHintAtom('defer_to_agent'));
  return (
    <div className="flex shrink-0 gap-s1">
      {deferrable && (
        <Tip label="Leave it to the agent" keys={deferHint.first}>
          <button
            type="button"
            aria-label="Leave it to the agent"
            aria-keyshortcuts={deferHint.aria}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => send(true)}
            className="flex size-7 cursor-pointer items-center justify-center text-fg/35 hover:bg-fg/7 hover:text-fg"
          >
            <Icon d="M12 3l1.9 5.6a2 2 0 0 0 1.3 1.3L21 12l-5.8 2.1a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.6a2 2 0 0 0-1.3-1.3L3 12l5.8-2.1a2 2 0 0 0 1.3-1.3z" />
          </button>
        </Tip>
      )}
      <Tip label={label} keys={sendHint.first}>
        <button
          type="button"
          aria-label={label}
          aria-keyshortcuts={sendHint.aria}
          disabled={!ready}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => send(false)}
          className={`flex size-7 items-center justify-center ${ready ? 'cursor-pointer bg-fg text-bg hover:bg-fg/80' : 'pointer-events-none bg-fg/7 text-fg/25'}`}
        >
          <Icon d="M12 19V5M5 12l7-7 7 7" />
        </button>
      </Tip>
    </div>
  );
};

const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex items-end gap-s2 border border-fg/12 p-s2 focus-within:border-fg/25">
    {children}
  </div>
);

const AnswerBox = ({
  item,
  held,
}: {
  readonly item: InboxItem;
  readonly held: boolean;
}) => {
  const [draft, setDraft] = useAtom(responseDraftAtom(item.key));
  return (
    <Frame>
      <Box
        value={draft}
        placeholder="Write your answer"
        onChange={(text) =>
          setDraft({
            inboxId: item.inboxId,
            number: item.question.number,
            text,
          })
        }
      />
      <Actions
        label="Send"
        ready={!held && draft.trim() !== ''}
        deferrable={!held}
      />
    </Frame>
  );
};

// The write's own state, for the box that sent it.
const AskFailure = ({
  place,
  inboxId,
}: {
  readonly place: string;
  readonly inboxId: InboxId;
}) => {
  const result = useAtomValue(readerAskAtom(place));
  return AsyncResult.isFailure(result) ? (
    <p className="mb-s1 text-11 text-red" role="alert" data-zen-ask-failure>
      {refusalText(
        'Not sent',
        failureText(result.cause),
        inboxId,
        'AskRefused',
      )}
    </p>
  ) : null;
};

const FollowUpBox = ({
  itemKey,
  inboxId,
  held,
}: {
  readonly itemKey: string;
  readonly inboxId: InboxId;
  readonly held: boolean;
}) => {
  const [draft, setDraft] = useAtom(followUpDraftAtom(itemKey));
  const place = followUpPlaceOf(itemKey);
  const { waiting } = useAtomValue(readerAskAtom(place));
  return (
    <>
      <AskFailure place={place} inboxId={inboxId} />
      <Frame>
        <Box value={draft} placeholder="Add a follow-up" onChange={setDraft} />
        <Actions
          label="Send"
          ready={!held && !waiting && draft.trim() !== ''}
        />
      </Frame>
    </>
  );
};

const AskBox = ({ inboxId }: { readonly inboxId: InboxId }) => {
  const [draft, setDraft] = useAtom(askDraftAtom(inboxId));
  const send = useAtomSet(inboxReaderAtoms.send);
  const step = useAtomSet(stepAskAtom);
  const place = askPlaceOf(inboxId);
  const { waiting } = useAtomValue(readerAskAtom(place));
  return (
    <>
      <AskFailure place={place} inboxId={inboxId} />
      <Frame>
        <Box
          value={draft}
          placeholder="What do you want to ask?"
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === 'Escape') send({ type: 'AskClosed' });
            else if (e.metaKey || draft !== '') return;
            // An empty box has no line for the arrows to move between.
            else if (e.key === 'ArrowDown') step(1);
            else if (e.key === 'ArrowUp') step(-1);
          }}
        />
        <Actions label="Ask" ready={!waiting && draft.trim() !== ''} />
      </Frame>
    </>
  );
};

const PickBox = () => {
  const [query, setQuery] = useAtom(askQueryAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  const pick = useAtomSet(pickAskInboxAtom);
  const step = useAtomSet(stepAskAtom);
  const { cursor } = useAtomValue(askChoicesAtom);
  return (
    <Frame>
      <Box
        value={query}
        placeholder="Which inbox?"
        onChange={setQuery}
        combobox={{
          active:
            cursor === undefined ? undefined : pickChoiceId(cursor.inboxId),
        }}
        onKeyDown={(e) => {
          // ⌘↑ and ⌘↓ are the keymap's, which does the same.
          if (e.metaKey) return;
          if (e.key === 'ArrowDown') step(1);
          else if (e.key === 'ArrowUp') step(-1);
          else if (e.key === 'Escape') send({ type: 'AskClosed' });
          else if (e.key === 'Enter' && cursor !== undefined)
            pick(cursor.inboxId);
          else return;
          e.preventDefault();
        }}
      />
      <Actions label="Ask" ready={false} />
    </Frame>
  );
};

const NoBox = () => (
  <Frame>
    <Box value="" placeholder="" disabled onChange={() => undefined} />
    <Actions label="Send" ready={false} />
  </Frame>
);

/** The list of Inboxes to ask in, where the question would be. */
export const AskPicker = () => {
  const board = useAtomValue(drawnBoardAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  const pick = useAtomSet(pickAskInboxAtom);
  const { choices, cursor } = useAtomValue(askChoicesAtom);
  const machined = (board?.machines?.length ?? 0) > 1;
  return (
    <div
      id={PICK_LIST_ID}
      role="listbox"
      aria-label="Inboxes to ask in"
      className="mt-s4 flex max-h-body flex-col gap-s1 overflow-y-auto font-reading text-14"
    >
      {choices.length === 0 && <p className="text-fg/30">No inbox matches.</p>}
      {choices.map((c) => (
        <button
          type="button"
          key={c.inboxId}
          id={pickChoiceId(c.inboxId)}
          role="option"
          aria-selected={c.inboxId === cursor?.inboxId}
          tabIndex={-1}
          data-zen-choice={c.inboxId === cursor?.inboxId || undefined}
          // A press keeps the caret in the box.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(c.inboxId)}
          onMouseEnter={() =>
            send({ type: 'AskCursorSet', inboxId: c.inboxId })
          }
          className={`flex cursor-pointer items-baseline gap-s2 text-left ${c.inboxId === cursor?.inboxId ? 'text-fg' : 'text-fg/35 hover:text-fg/70'}`}
        >
          <span className="min-w-0 truncate">{c.label}</span>
          {machined && c.machine !== 'Local' && (
            <span className="shrink-0 font-zen text-11 text-fg/40">
              {c.machine}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};

/** Where an ask is going, over its heading. */
export const AskPlace = () => {
  const composer = useAtomValue(composerAtom);
  const board = useAtomValue(drawnBoardAtom);
  const send = useAtomSet(inboxReaderAtoms.send);
  if (composer._tag !== 'Asking')
    return <p className="text-11 text-fg/40">Which inbox?</p>;
  const row = board?.inboxes.find((i) => i.inboxId === composer.inboxId);
  return (
    <p className="text-11 text-fg/40">
      In {row?.label}
      {row?.machine !== undefined && ` on ${row.machine.label}`}
      <button
        type="button"
        className="ml-s2 cursor-pointer text-fg/40 hover:text-fg"
        onClick={() => send({ type: 'AskInboxCleared' })}
      >
        Change
      </button>
    </p>
  );
};

const FOOT_TONES: Readonly<Record<FootTone, string>> = {
  red: 'text-red',
  orange: 'text-orange',
  quiet: 'text-fg/50',
};

// One line, only when the answer may not do what it looks like it will. It is
// always on the page, since a live region that arrives holding its text is
// often not announced.
const FootNote = ({ composer }: { readonly composer: ComposerState }) => {
  const board = useAtomValue(drawnBoardAtom);
  const troubles = useAtomValue(troublesAtom);
  const progress = useAtomValue(askProgressAtom);
  const asking = composer._tag === 'Asking' ? composer.inboxId : undefined;
  const note = footNoteOf(
    composer,
    troubles,
    {
      greyed: board?.greyed ?? new Set(),
      labelOf: (key) =>
        board?.machines?.find((m) => m.key === key)?.label ?? 'Its machine',
      machined: (board?.machines?.length ?? 0) > 1,
    },
    board?.inboxes.find((i) => i.inboxId === asking)?.machine?.key,
    progress,
  );
  return (
    <output
      className={`block text-11 ${note === undefined ? '' : `mb-s1 ${FOOT_TONES[note.tone]}`}`}
      data-zen-foot-note
    >
      {note?.text}
    </output>
  );
};

// What the page is narrowed to, beside the count, while it is narrowed.
const useScope = (): string | undefined => {
  const board = useAtomValue(drawnBoardAtom);
  const selected = useAtomValue(selectedInboxAtom);
  const { inboxes, groups } = useAtomValue(screenStateAtom);
  const onlyPinned = useAtomValue(sidebarPinnedOnlyAtom);
  if (
    board === undefined ||
    (selected === undefined && inboxes.length === 0 && !onlyPinned)
  )
    return undefined;
  const scope = scopeLine(board, selected, inboxes, groups, onlyPinned);
  return onlyPinned ? `${scope}, pinned` : scope;
};

const TitleLine = () => {
  const queue = useAtomValue(activeQueueAtom);
  const items = useAtomValue(shownQueuesAtom)[queue];
  const lit = useAtomValue(litKeyAtom);
  const scope = useScope();
  const selected = useAtomValue(selectedInboxAtom);
  const at = items.findIndex((i) => i.key === lit);
  const item = items[at];
  // Narrowed to nothing, the scope says why, and an Inbox's own session and
  // metadata sit beside its name, with no question to carry them.
  if (item === undefined)
    return scope === undefined ? null : (
      <div className="mb-s1 flex items-center justify-end gap-s2 text-11 text-fg/40">
        <span className="min-w-0 truncate" data-zen-scope>
          {scope}
        </span>
        {selected !== undefined && <InboxActions inboxId={selected} />}
        {selected !== undefined && <InboxMenuButton inboxId={selected} />}
      </div>
    );
  return (
    // The lit question is plain on the page, so its title is not repeated here.
    <div className="mb-s1 flex items-center justify-end gap-s2 text-11 text-fg/40">
      {scope !== undefined && (
        <span className="min-w-0 truncate" data-zen-scope>
          {scope}
        </span>
      )}
      <LitActions inboxId={item.inboxId} />
      <InboxMenuButton inboxId={item.inboxId} lit />
      <span className="shrink-0 tabular-nums">
        {at + 1} of {items.length}
      </span>
    </div>
  );
};

const boxKeyOf = (composer: ComposerState): string => {
  switch (composer._tag) {
    case 'Empty':
    case 'Picking':
      return composer._tag;
    case 'Asking':
      return `ask:${composer.inboxId}`;
    default:
      return `${composer._tag}:${composer.item.key}`;
  }
};

const BoxFor = ({ composer }: { readonly composer: ComposerState }) => {
  switch (composer._tag) {
    case 'Empty':
    case 'Sending':
      return <NoBox />;
    case 'Picking':
      return <PickBox />;
    case 'Asking':
      return <AskBox inboxId={composer.inboxId} />;
    case 'Answer':
      return <AnswerBox item={composer.item} held={false} />;
    case 'Held':
      return <AnswerBox item={composer.item} held />;
    case 'FollowUp':
      return (
        <FollowUpBox
          itemKey={composer.item.key}
          inboxId={composer.item.inboxId}
          held={composer.held}
        />
      );
  }
};

export const Composer = () => {
  const composer = useAtomValue(composerAtom);
  const intro = useAtomValue(readerIntroAtom);
  const asking = composer._tag === 'Asking' || composer._tag === 'Picking';
  return (
    <>
      {/* A short fade, so the question runs right up to the answer. */}
      <div className="pointer-events-none h-6 bg-linear-to-t from-bg to-transparent" />
      <div className="bg-bg px-s5 pt-s2 pb-s4">
        <div
          data-zen-answer
          className={`mx-auto max-w-measure ${introFade(intro)}`}
        >
          <FootNote composer={composer} />
          {!asking && <TitleLine />}
          <BoxFor key={boxKeyOf(composer)} composer={composer} />
        </div>
      </div>
    </>
  );
};
