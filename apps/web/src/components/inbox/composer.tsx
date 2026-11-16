import {
  useAtom,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@effect/atom-react';
import type { InboxId } from '@operator-inbox/core/api';
import { AsyncResult } from 'effect/reactivity';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useRef,
} from 'react';
import { addFilesAtom, pendingFilesAtom } from '../../attachments';
import { commentsAtom, commentsInOrderAtom, isCommented } from '../../comments';
import { failureText, refusalText } from '../../failure';
import {
  askDraftAtom,
  askQueryAtom,
  drawnBoardAtom,
  followUpDraftAtom,
  isTextEntry,
  responseDraftAtom,
  selectedInboxAtom,
} from '../../inbox';
import type { InboxItem } from '../../inbox-queues';
import {
  activeQueueAtom,
  answerDrawingConflictsAtom,
  answerPlaceOf,
  askChoicesAtom,
  askPlaceOf,
  askProgressAtom,
  askSteppedAtom,
  boxFocusAskedAtom,
  composerAtom,
  type FootTone,
  followUpPlaceOf,
  footNoteOf,
  forgetAskStepAtom,
  highlightReplyAtom,
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
import { askMacroFocusAtom, macroCardsAtom } from '../../macros';
import { listenOnAtom } from '../../readout/readout';
import { AttachDrop, AttachRow } from './attachments';
import { InboxActions, LitActions } from './colophon';
import { edgeFade, fadeEdges } from './edge-fade';
import { Icon, Tip } from './icon';
import { ListenControl } from './listen-control';
import {
  firstCardStop,
  MacroCards,
  MacroMenuList,
  useMacroMenu,
} from './macro-cards';
import { InboxMenuButton } from './row-menu';
import { UndoNotice } from './undo-notice';

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
  onSelect,
  combobox,
  boxRef,
  attachTo,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly onChange: (text: string, el: HTMLTextAreaElement) => void;
  readonly onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  // The caret moved: the macro menu reads where it is.
  readonly onSelect?: (el: HTMLTextAreaElement) => void;
  readonly combobox?: {
    readonly active: string | undefined;
    // The list it controls, and whether it shows: the Inbox list by default,
    // which shows the whole time the box is picking.
    readonly expanded?: boolean;
    readonly controls?: string;
  };
  readonly boxRef?: { current: HTMLTextAreaElement | null };
  // The box's place, when files pasted into it are attached to it.
  readonly attachTo?: string;
}) => {
  const self = useRef<HTMLTextAreaElement | null>(null);
  const addFiles = useAtomSet(addFilesAtom);
  // A paste that carries files, an image copied from the screen most often,
  // attaches them; text pasted with them still goes in as text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachTo === undefined || e.clipboardData.files.length === 0) return;
    if (e.clipboardData.getData('text/plain') === '') e.preventDefault();
    addFiles({ place: attachTo, files: [...e.clipboardData.files] });
  };
  // Stable, or each render would run it and take the focus back.
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      self.current = el;
      if (boxRef !== undefined) boxRef.current = el;
      takeFocus(el);
    },
    [boxRef],
  );
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
            'aria-expanded': combobox.expanded ?? true,
            'aria-controls': combobox.controls ?? PICK_LIST_ID,
            'aria-activedescendant': combobox.active,
          })}
      onChange={(e) => onChange(e.target.value, e.target)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      {...(onSelect === undefined
        ? {}
        : { onSelect: (e) => onSelect(e.currentTarget) })}
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
  deferReady = true,
}: {
  readonly label: string;
  readonly ready: boolean;
  readonly deferrable?: boolean;
  // Whether "Leave it to the agent" may send now.
  readonly deferReady?: boolean;
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
            disabled={!deferReady}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => send(true)}
            className={`flex size-7 items-center justify-center ${deferReady ? 'cursor-pointer text-fg/35 hover:bg-fg/7 hover:text-fg' : 'pointer-events-none text-fg/15'}`}
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

// The box's border: the highlight's yellow while the reply is to be
// highlighted, as a highlighted question's outline is. The border is the
// switch's only sign: it is a key's alone (`toggle_highlight_reply`).
const Frame = ({
  children,
  place,
}: {
  readonly children: ReactNode;
  // The box's "Highlight reply" switch, for a box that sends to an agent.
  readonly place?: string;
}) => {
  const on = useAtomValue(highlightReplyAtom(place ?? ''));
  const lit = place !== undefined && on;
  return (
    <div
      data-zen-frame
      data-highlight-reply={lit || undefined}
      className={`flex items-end gap-s2 border p-s2 ${lit ? 'border-yellow' : 'border-fg/12 focus-within:border-fg/25'}`}
    >
      {children}
    </div>
  );
};

// The answer, with its macros: `/` at a word's start opens the menu over the
// box, and each macro picked is a card under it (`macro-cards.tsx`).
const AnswerBox = ({
  item,
  held,
}: {
  readonly item: InboxItem;
  readonly held: boolean;
}) => {
  const [draft, setDraft] = useAtom(responseDraftAtom(item.key));
  const cards = useAtomValue(macroCardsAtom(item.key));
  // The comments' cards head the stack Tab goes into, and a written comment
  // can be the whole answer.
  const comments = useAtomValue(commentsInOrderAtom(item.key));
  const commented = isCommented(useAtomValue(commentsAtom(item.key)));
  const askFocus = useAtomSet(askMacroFocusAtom);
  const self = useRef<HTMLTextAreaElement | null>(null);
  const place = answerPlaceOf(item.key);
  const files = useAtomValue(pendingFilesAtom(place));
  // A drawing waiting on the operator's choice holds both sends.
  const free = useAtomValue(answerDrawingConflictsAtom).length === 0;
  const setText = (text: string) =>
    setDraft({ inboxId: item.inboxId, number: item.question.number, text });
  const menu = useMacroMenu({
    key: item.key,
    inboxId: item.inboxId,
    number: item.question.number,
    text: draft,
    setText,
  });
  return (
    <div className="relative">
      {menu.open && (
        <MacroMenuList
          items={menu.items}
          active={menu.active}
          failed={menu.failed}
          onPick={(m) => menu.pick(m, self.current)}
        />
      )}
      <AttachDrop place={place}>
        <Frame place={place}>
          <Box
            boxRef={self}
            attachTo={place}
            value={draft}
            placeholder="Write your answer"
            combobox={menu.combobox}
            onChange={(text, el) => {
              setText(text);
              menu.refresh(el);
            }}
            onSelect={menu.refresh}
            onKeyDown={(e) => {
              if (menu.onKeyDown(e)) return;
              // Tab goes from the text into the cards, while there are any.
              const first = firstCardStop(cards, comments);
              if (
                e.key === 'Tab' &&
                !e.shiftKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                first !== undefined
              ) {
                e.preventDefault();
                askFocus({ key: item.key, to: first });
              }
            }}
          />
          <Actions
            label="Send"
            ready={
              !held &&
              free &&
              (draft.trim() !== '' ||
                cards.length > 0 ||
                commented ||
                files.length > 0)
            }
            deferrable={!held}
            deferReady={free}
          />
        </Frame>
      </AttachDrop>
      <AttachRow place={place} />
      <MacroCards
        itemKey={item.key}
        inboxId={item.inboxId}
        number={item.question.number}
      />
    </div>
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
  const files = useAtomValue(pendingFilesAtom(place));
  return (
    <>
      <AskFailure place={place} inboxId={inboxId} />
      <AttachDrop place={place}>
        <Frame place={place}>
          <Box
            value={draft}
            placeholder="Add a follow-up"
            onChange={setDraft}
            attachTo={place}
          />
          <Actions
            label="Send"
            ready={
              !held && !waiting && (draft.trim() !== '' || files.length > 0)
            }
          />
        </Frame>
      </AttachDrop>
      <AttachRow place={place} />
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
      <AttachDrop place={place}>
        <Frame place={place}>
          <Box
            value={draft}
            placeholder="What do you want to ask?"
            onChange={setDraft}
            attachTo={place}
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
      </AttachDrop>
      <AttachRow place={place} />
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
  const forgetStep = useAtomSet(forgetAskStepAtom);
  const machined = (board?.machines?.length ?? 0) > 1;
  // The list scrolls once longer than the body, so the row a key moves to is
  // brought into sight once it is drawn lit. Only a key's step does it: a row
  // lit by the pointer is already in sight, and scrolling it would light the
  // next row under the pointer, and so on.
  useAtomSubscribe(askSteppedAtom, ({ inboxId }) => {
    if (inboxId === undefined) return;
    requestAnimationFrame(() =>
      document
        .getElementById(pickChoiceId(inboxId))
        ?.scrollIntoView({ block: 'nearest' }),
    );
  });
  return (
    <div
      id={PICK_LIST_ID}
      role="listbox"
      aria-label="Inboxes to ask in"
      ref={fadeEdges}
      className={`mt-s4 flex max-h-body flex-col gap-s1 overflow-y-auto font-reading text-14 ${edgeFade}`}
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
          onClick={() => {
            forgetStep();
            pick(c.inboxId);
          }}
          onMouseEnter={() => {
            forgetStep();
            send({ type: 'AskCursorSet', inboxId: c.inboxId });
          }}
          className={`flex scroll-my-fade cursor-pointer items-baseline gap-s2 text-left ${c.inboxId === cursor?.inboxId ? 'text-fg' : 'text-fg/35 hover:text-fg/70'}`}
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
  const drawingConflicts = useAtomValue(answerDrawingConflictsAtom);
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
    drawingConflicts,
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

// The line over the answer box: listen mode's control on the left, and the
// lit Question's actions and place on the right. The page's scope is shown in
// each Question's breadcrumb (`scope-crumb.tsx`), not here, so nothing on
// this line moves when listen mode is toggled or the scope changes. On a
// phone listen mode's bar has a strip of its own over the buttons, there only
// while listen mode is on: the foot grows upwards, so the buttons and the box
// stay where they are, and with listen mode off the buttons sit as close over
// the box as they do on a wider screen.
const TitleLine = () => {
  const listening = useAtomValue(listenOnAtom);
  const queue = useAtomValue(activeQueueAtom);
  const items = useAtomValue(shownQueuesAtom)[queue];
  const lit = useAtomValue(litKeyAtom);
  const selected = useAtomValue(selectedInboxAtom);
  const at = items.findIndex((i) => i.key === lit);
  const item = items[at];
  // Narrowed to nothing, an Inbox's own session and metadata sit here, with
  // no question to carry them.
  if (item === undefined)
    return selected === undefined ? null : (
      <div className="mb-s1 flex items-center justify-end gap-s2 text-11 text-fg/40">
        <InboxActions inboxId={selected} />
        <InboxMenuButton inboxId={selected} />
      </div>
    );
  return (
    // The lit question is plain on the page, so its title is not repeated here.
    <div
      className={`relative mb-s1 flex items-center justify-end gap-s2 text-11 text-fg/40 ${listening ? 'compact:pt-5' : ''}`}
    >
      <ListenControl />
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
          className={`relative mx-auto max-w-measure ${introFade(intro)}`}
        >
          <UndoNotice />
          <FootNote composer={composer} />
          {!asking && <TitleLine />}
          <BoxFor key={boxKeyOf(composer)} composer={composer} />
        </div>
      </div>
    </>
  );
};
