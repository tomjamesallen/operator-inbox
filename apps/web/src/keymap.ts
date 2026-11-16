import { InboxId } from '@operator-inbox/core/api';
import {
  type Binding,
  type Chord,
  type Keymap,
  keysAria,
  keysLabel,
  remainingLabel,
  resolveKeymap,
  stepKeymap,
} from '@operator-inbox/core/keymap';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import { failureText } from './failure';
import {
  archiveAtom,
  copyQuestionAtom,
  DEFAULT_GROUP,
  dismissHighlightAtom,
  drawnBoardAtom,
  groupsInForce,
  inboxBoardAtom,
  inboxRowOrder,
  isTextEntry,
  machineSectionsOf,
  openInboxSessionAtom,
  pinAtom,
  pinKey,
  questionClipText,
  screenStateAtom,
  selectedInboxAtom,
  selectSidebarAtom,
  sessionTargetOf,
  sidebarPinnedOnlyAtom,
} from './inbox';
import { focusYourInboxAtom } from './inbox-elsewhere';
import { inboxPickerOpenAtom, setInboxPickerOpenAtom } from './inbox-picker';
import {
  openRenameAtom,
  type RailFocus,
  railFocusAskedAtom,
} from './inbox-rail';
import {
  activeQueueAtom,
  askingAtom,
  colophonOpenAtom,
  composerAtom,
  flowStepAskedAtom,
  highlightPlaceOf,
  isSending,
  railStateAtom,
  readerSnapshotAtom,
  sendComposerAtom,
  stepAskAtom,
  toggleAskAtom,
  toggleHighlightReplyAtom,
} from './inbox-reader';
import { composerOf, inboxReaderAtoms, litOf } from './inbox-reader-machine';
import { stepViewAtom } from './inbox-swipe';
import {
  focusedMacroCardAtom,
  macroInfoOpenAtom,
  macrosFileAtom,
  toggledIn,
} from './macros';
import {
  clearSelectionByKey,
  questionSearchOpenAtom,
  toggleSearchByKey,
} from './question-search';

// The inbox screen's keymap: the defaults from
// `@operator-inbox/core/keymap`, with the operator's keybindings file applied, read
// through serve. One listener on the document runs every binding; a press
// that is not bound, or whose action declines it (Enter away from a card), is
// left to the browser.

// The file as serve read it. Refreshed with the board (`refresh`), so an edit
// takes effect on the next Ctrl+R as well as on a reload.
export const keybindingsFileAtom = InboxClient.query('keybindings', 'read', {});

/** Where the keymap came from, for the help to say. */
export type KeymapSource =
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Defaults'; readonly path: string }
  | { readonly _tag: 'File'; readonly path: string }
  | { readonly _tag: 'Failed'; readonly message: string };

export const keymapSourceAtom = Atom.make((get): KeymapSource => {
  const result = get(keybindingsFileAtom);
  if (AsyncResult.isFailure(result))
    return { _tag: 'Failed', message: failureText(result.cause).message };
  const file = Option.getOrUndefined(AsyncResult.value(result));
  if (file === undefined) return { _tag: 'Loading' };
  return file.text === null
    ? { _tag: 'Defaults', path: file.path }
    : { _tag: 'File', path: file.path };
});

// Until the file has loaded, and when it cannot be, the defaults bind.
export const keymapAtom = Atom.make((get): Keymap => {
  const file = Option.getOrUndefined(
    AsyncResult.value(get(keybindingsFileAtom)),
  );
  return resolveKeymap(file?.text ?? undefined);
}).pipe(Atom.keepAlive);

/**
 * What the page says an action's keys are, from the keymap as it is now, so a
 * rebind shows in every hint: `all` for a title (`⌘B / Ctrl+B`), `first` for
 * a placeholder, `aria` for `aria-keyshortcuts`. Each is `undefined` while
 * nothing binds the action, and the hint leaves the keys out.
 */
export interface KeyHint {
  readonly all: string | undefined;
  readonly first: string | undefined;
  readonly aria: string | undefined;
}

export const keyHintAtom = Atom.family((id: string) =>
  Atom.make((get): KeyHint => {
    const keymap = get(keymapAtom);
    return {
      all: keysLabel(keymap, id),
      first: keysLabel(keymap, id, 1),
      aria: keysAria(keymap, id),
    };
  }),
);

/** ` (⌘B / Ctrl+B)` after a title, or nothing while the action is unbound. */
export const inParens = (keys: string | undefined): string =>
  keys === undefined ? '' : ` (${keys})`;

// The chords of a sequence typed so far: the header shows the prefix waiting.
export const keymapPendingAtom = Atom.make<ReadonlyArray<Chord>>([]).pipe(
  Atom.keepAlive,
);

// While a sequence waits, what is left to press for an action on the page:
// `0` beside All once the prefix is down. Undefined the rest of the time, so a
// badge shows only between the prefix and the chord that completes it.
export const keyBadgeAtom = Atom.family((id: string) =>
  Atom.make((get): string | undefined =>
    remainingLabel(get(keymapAtom), get(keymapPendingAtom), { id }),
  ),
);

// The same for an Inbox in the sidebar, by its slot for goto_inbox.
export const inboxBadgeAtom = Atom.family((inboxId: InboxId) =>
  Atom.make((get): string | undefined => {
    const pending = get(keymapPendingAtom);
    if (pending.length === 0) return undefined;
    const board = get(drawnBoardAtom);
    const slot =
      board === undefined ? -1 : sidebarOrderOf(board).indexOf(inboxId);
    return slot === -1
      ? undefined
      : remainingLabel(get(keymapAtom), pending, {
          id: 'goto_inbox',
          param: slot + 1,
        });
  }),
);

export const keymapHelpOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

// What the help sheet is filtered by. Closing the sheet clears it.
export const keymapHelpQueryAtom = Atom.make('').pipe(Atom.keepAlive);

// --- the actions --------------------------------------------------------------

// A handler sends the machine an event or sets an Atom, and answers whether it
// took the press. What needs an element to do it (a caret, a scroll) is the
// component's: the keymap never looks anything up in the page.

const send = (
  get: Atom.AtomContext,
  event: Parameters<typeof inboxReaderAtoms.send.write>[1],
): true => {
  get.set(inboxReaderAtoms.send, event);
  return true;
};

const boardOf = (get: Atom.AtomContext) => get.once(drawnBoardAtom);

// A modal holds the keyboard: nothing behind it is the key's to act on.
const dialogOpen = (get: Atom.AtomContext): boolean =>
  get.once(keymapHelpOpenAtom) ||
  get.once(questionSearchOpenAtom) ||
  get.once(inboxPickerOpenAtom);

// The answer box, and the fields of the macro cards under it: Send's chord
// sends from either.
const isComposerBox = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.dataset.zenBox !== undefined ||
    target.closest('[data-macro-card]') !== null);

// A single chord pressed in a field that is not the answer box belongs to that
// field: Ctrl+Enter in a rename must not send the draft. A sequence has no
// meaning to a field, so it runs from anywhere.
const otherFieldKeeps = (binding: Binding, e: KeyboardEvent): boolean =>
  binding.sequence.length === 1 &&
  isTextEntry(e.target) &&
  !isComposerBox(e.target);

// The caret lives in the answer box, so a guard against every field would leave
// Ctrl+A or Cmd+Up dead on this page. While the box holds text the operator is
// typing and the chord stays the platform's (Ctrl+A "line start", Cmd+Up "start
// of the text"); a sequence still runs. Every other field keeps the chord, and
// a modal keeps both.
const typingKeeps = (
  get: Atom.AtomContext,
  binding: Binding,
  e: KeyboardEvent,
): boolean => {
  if (dialogOpen(get)) return true;
  if (binding.sequence.length > 1 || !isTextEntry(e.target)) return false;
  return !(
    e.target instanceof HTMLTextAreaElement &&
    isComposerBox(e.target) &&
    e.target.value === ''
  );
};

// The sidebar's open Inboxes in its own order: machine by machine, pinned
// first, muted last, archived left out (they sit folded under Archived).
const sidebarOrder = (get: Atom.AtomContext): ReadonlyArray<InboxId> => {
  const board = boardOf(get);
  return board === undefined ? [] : sidebarOrderOf(board);
};

function sidebarOrderOf(
  board: NonNullable<ReturnType<typeof boardOf>>,
): ReadonlyArray<InboxId> {
  return machineSectionsOf(board).flatMap((s) =>
    inboxRowOrder(s.inboxes.filter((i) => !i.archived)).map((i) => i.inboxId),
  );
}

// Stepping leaves the sidebar as it is, so a reader going round the Inboxes with
// it out can see where they are.
const selectInbox = (
  get: Atom.AtomContext,
  inboxId: InboxId | undefined,
): boolean => {
  get.set(selectSidebarAtom, { inboxId, groups: [] });
  return true;
};

// Next and previous go round All and the open Inboxes, as tmux's next-window
// goes round its windows.
const stepInbox = (get: Atom.AtomContext, step: -1 | 1): boolean => {
  const ring: ReadonlyArray<InboxId | undefined> = [
    undefined,
    ...sidebarOrder(get),
  ];
  const at = ring.indexOf(get.once(selectedInboxAtom));
  const next = at === -1 ? 1 : (at + step + ring.length) % ring.length;
  return selectInbox(get, ring[Math.min(next, ring.length - 1)]);
};

// The sidebar comes out if it must, and the element takes the focus once drawn.
const focusRail = (get: Atom.AtomContext, at: RailFocus): boolean => {
  get.set(railFocusAskedAtom, at);
  return send(get, { type: 'RailFocused' });
};

// Along the views as a swipe goes, so Ask sits left of the queues.
// Landing on Your inbox while it shows the empty state's list, the list takes
// the focus.
const stepView = (get: Atom.AtomContext, by: 1 | -1): boolean => {
  get.set(focusYourInboxAtom, { orBox: false });
  get.set(stepViewAtom, by);
  return true;
};

// The list moves by a step, from the box too: this chord is no platform's. While
// asking it is not on screen, and the ask's own list takes the press instead,
// text in the box or not, in all cases. A modal and another field still keep
// it.
const stepFlow = (
  get: Atom.AtomContext,
  e: KeyboardEvent,
  binding: Binding,
  by: 1 | -1,
): boolean => {
  if (dialogOpen(get) || otherFieldKeeps(binding, e)) return false;
  if (get.once(askingAtom)) get.set(stepAskAtom, by);
  else
    get.set(flowStepAskedAtom, { id: get.once(flowStepAskedAtom).id + 1, by });
  return true;
};

// To an end of the queue. Cmd+Up and Cmd+Down: asking they are the ask's list's,
// in all cases as above, and over text they stay the platform's.
const toEnd = (
  get: Atom.AtomContext,
  e: KeyboardEvent,
  binding: Binding,
  end: 'first' | 'last',
): boolean => {
  if (get.once(askingAtom))
    return stepFlow(get, e, binding, end === 'first' ? -1 : 1);
  return typingKeeps(get, binding, e)
    ? false
    : send(get, { type: 'MovedToEnd', end });
};

// Esc shuts what lies over the page. A modal and an open menu see to themselves.
const closeOver = (get: Atom.AtomContext, e: KeyboardEvent): boolean => {
  const inMenu =
    e.target instanceof Element &&
    e.target.closest('[role="menu"], [role="dialog"]') !== null;
  if (dialogOpen(get) || inMenu) return false;
  if (get.once(askingAtom)) return send(get, { type: 'AskClosed' });
  const rail = get.once(railStateAtom);
  return rail === 'drawer' || rail === 'peeking'
    ? send(get, { type: 'RailDismissed' })
    : false;
};

// The question on screen. While asking, the page shows the ask instead.
const litItem = (get: Atom.AtomContext) => {
  const snapshot = get.once(readerSnapshotAtom);
  return snapshot === undefined || get.once(askingAtom)
    ? undefined
    : litOf(snapshot);
};

// Space on a group in the sidebar: shift-click's work, for the keyboard. In
// the Inbox already selected it adds the group or takes it away; elsewhere it
// selects that group alone.
const toggleGroup = (get: Atom.AtomContext, e: KeyboardEvent): boolean => {
  const link = e.target;
  if (!(link instanceof HTMLElement)) return false;
  const { railGroup, inbox } = link.dataset;
  if (railGroup === undefined || inbox === undefined) return false;
  const inboxId = InboxId.make(inbox);
  const view = boardOf(get)?.views.find((v) => v.inboxId === inboxId);
  if (get.once(selectedInboxAtom) !== inboxId || view === undefined) {
    get.set(selectSidebarAtom, { inboxId, groups: [railGroup] });
    return true;
  }
  const inForce = groupsInForce(view, get.once(screenStateAtom).groups);
  get.set(selectSidebarAtom, {
    inboxId,
    groups: inForce.includes(railGroup)
      ? inForce.filter((g) => g !== railGroup)
      : [...inForce, railGroup],
  });
  return true;
};

// The Inbox a key acts on: the one selected, and in All the lit question's.
const viewInHand = (get: Atom.AtomContext) => {
  const inboxId = get.once(selectedInboxAtom) ?? litItem(get)?.inboxId;
  return inboxId === undefined
    ? undefined
    : boardOf(get)?.views.find((v) => v.inboxId === inboxId);
};

// The sidebar is shut, so no row is there to say how a key's write ended.
const rowUnseen = (get: Atom.AtomContext): boolean =>
  get.once(railStateAtom) === 'shut';

// Pin the Inbox in hand, or its group when exactly one named group is in force
// on its own view, as the sidebar's pin beside that row would.
const togglePin = (get: Atom.AtomContext): boolean => {
  const view = viewInHand(get);
  const board = boardOf(get);
  if (view === undefined || board === undefined) return false;
  const selected = get.once(selectedInboxAtom) === view.inboxId;
  const groups = selected
    ? groupsInForce(view, get.once(screenStateAtom).groups)
    : [];
  const [only] = groups;
  if (groups.length === 1 && only !== undefined && only !== DEFAULT_GROUP) {
    const pinned = view.pinnedGroups.includes(only);
    get.set(pinAtom(pinKey(view.inboxId, only)), {
      inboxId: view.inboxId,
      pinned: !pinned,
      group: only,
      placeless: rowUnseen(get),
    });
    return true;
  }
  const pinned =
    board.inboxes.find((i) => i.inboxId === view.inboxId)?.pinned ?? false;
  get.set(pinAtom(pinKey(view.inboxId)), {
    inboxId: view.inboxId,
    pinned: !pinned,
    placeless: rowUnseen(get),
  });
  return true;
};

type Handler = (
  get: Atom.AtomContext,
  e: KeyboardEvent,
  binding: Binding,
) => boolean;

// Every action in core's registry has its handler here: a test holds them level.
const HANDLERS: Readonly<Record<string, Handler>> = {
  toggle_sidebar: (get) => send(get, { type: 'RailToggled' }),
  close_drawer: (get, e) => closeOver(get, e),
  focus_sidebar: (get) => focusRail(get, 'row'),
  focus_inbox_column: (get) => {
    send(get, { type: 'QueueChosen', queue: 'inbox' });
    send(get, { type: 'RailDismissed' });
    get.set(focusYourInboxAtom, { orBox: true });
    return true;
  },
  focus_sidebar_search: (get) => focusRail(get, 'search'),
  next_inbox: (get) => stepInbox(get, 1),
  previous_inbox: (get) => stepInbox(get, -1),
  all_inboxes: (get) => selectInbox(get, undefined),
  goto_inbox: (get, _e, { action }) => {
    const inboxId = sidebarOrder(get)[(action.param ?? 1) - 1];
    return inboxId === undefined ? false : selectInbox(get, inboxId);
  },
  go_to_session: (get) => {
    const open = get.once(inboxPickerOpenAtom);
    if (!open && dialogOpen(get)) return false;
    get.set(setInboxPickerOpenAtom, !open);
    return true;
  },
  previous_queue: (get) => stepView(get, -1),
  next_queue: (get) => stepView(get, 1),
  search_questions: (get) => toggleSearchByKey(get),
  previous_question: (get) => send(get, { type: 'Moved', by: -1 }),
  next_question: (get) => send(get, { type: 'Moved', by: 1 }),
  previous_highlighted: (get) =>
    send(get, { type: 'MovedToHighlight', by: -1 }),
  next_highlighted: (get) => send(get, { type: 'MovedToHighlight', by: 1 }),
  first_question: (get, e, binding) => toEnd(get, e, binding, 'first'),
  last_question: (get, e, binding) => toEnd(get, e, binding, 'last'),
  scroll_up: (get, e, binding) => stepFlow(get, e, binding, -1),
  scroll_down: (get, e, binding) => stepFlow(get, e, binding, 1),
  toggle_metadata: (get) => {
    get.set(colophonOpenAtom, !get.once(colophonOpenAtom));
    return true;
  },
  clear_selection: (get) => clearSelectionByKey(get),
  send_response: (get, e, binding) => {
    if (dialogOpen(get) || otherFieldKeeps(binding, e)) return false;
    get.set(sendComposerAtom, false);
    return true;
  },
  defer_to_agent: (get, e, binding) => {
    if (dialogOpen(get) || otherFieldKeeps(binding, e)) return false;
    if (get.once(composerAtom)._tag !== 'Answer') return false;
    get.set(sendComposerAtom, true);
    return true;
  },
  // The box on screen asks for its reply highlighted, or stops. Nothing while
  // a modal holds the keyboard, or no box sends to an agent.
  toggle_highlight_reply: (get) => {
    const snapshot = get.once(readerSnapshotAtom);
    if (
      dialogOpen(get) ||
      snapshot === undefined ||
      highlightPlaceOf(composerOf(snapshot)) === undefined
    )
      return false;
    get.set(toggleHighlightReplyAtom, undefined);
    return true;
  },
  // The card the focus is in shows what its macro tells the agent, or stops.
  toggle_macro_info: (get) => {
    const card = get.once(focusedMacroCardAtom);
    if (dialogOpen(get) || card === undefined) return false;
    const open = get.once(macroInfoOpenAtom);
    get.set(macroInfoOpenAtom, toggledIn(open, card, !open.includes(card)));
    return true;
  },
  copy_question: (get) => {
    const item = litItem(get);
    if (item === undefined) return false;
    get.set(
      copyQuestionAtom(item.key),
      questionClipText(item.inboxId, item.question),
    );
    return true;
  },
  open_session: (get) => {
    const inboxId = litItem(get)?.inboxId ?? get.once(selectedInboxAtom);
    if (inboxId === undefined) return false;
    const target = sessionTargetOf(get.once(drawnBoardAtom), inboxId);
    if (target?._tag !== 'Here') return false;
    get.set(openInboxSessionAtom, inboxId);
    return true;
  },
  dismiss_highlight: (get) => {
    const item = litItem(get);
    if (
      item === undefined ||
      isSending(item) ||
      !('highlight' in item.question) ||
      item.question.highlight === undefined
    )
      return false;
    get.set(dismissHighlightAtom(item.key), {
      inboxId: item.inboxId,
      number: item.question.number,
    });
    return true;
  },
  ask_agent: (get, e, binding) => {
    if (typingKeeps(get, binding, e)) return false;
    get.set(toggleAskAtom, undefined);
    return true;
  },
  refresh: (get) => {
    get.refresh(keybindingsFileAtom);
    get.refresh(macrosFileAtom);
    get.refresh(inboxBoardAtom);
    return true;
  },
  toggle_group: (get, e) => toggleGroup(get, e),
  toggle_pin: (get) => togglePin(get),
  toggle_pinned_only: (get) => {
    get.set(sidebarPinnedOnlyAtom, !get.once(sidebarPinnedOnlyAtom));
    return true;
  },
  rename_inbox: (get) => {
    const view = viewInHand(get);
    if (view === undefined) return false;
    get.set(openRenameAtom, view.inboxId);
    return true;
  },
  toggle_archive: (get) => {
    const view = viewInHand(get);
    if (view === undefined) return false;
    get.set(archiveAtom(view.inboxId), {
      archived: !view.archived,
      placeless: rowUnseen(get),
    });
    return true;
  },
  show_help: (get) => {
    get.set(keymapHelpOpenAtom, !get.once(keymapHelpOpenAtom));
    return true;
  },
};

/** Whether the page runs an action, for the test that holds core level with it. */
export const isActionHandled = (id: string): boolean =>
  Object.hasOwn(HANDLERS, id);

/**
 * Whether a key's target is in a drawing's full-screen editor, or in one of
 * the dialogs Excalidraw draws for it at the end of the page (each in an
 * element of its own `.excalidraw` class).
 */
export const inDrawingEditor = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('[data-drawing-editor], .excalidraw') !== null;

// The one listener. A sequence's earlier keys are always the keymap's; its
// last runs the action, and the browser keeps the key only when the action
// declines it. The listener lives and dies with the Atom node. It reads the
// keymap at each press rather than depending on it, so a keymap that changes
// (the file loading, or a refresh re-reading it) never rebuilds this node, and
// an action's own writes never run through a node already torn down.
export const keymapKeyAtom: Atom.Atom<void> = Atom.readable((get) => {
  if (typeof document === 'undefined') return;
  get.mount(keymapAtom);
  const onKey = (e: KeyboardEvent) => {
    // A drawing's full-screen editor has keys of its own: its tools are
    // letters, its nudges arrows.
    if (inDrawingEditor(e.target)) return;
    const step = stepKeymap(
      get.once(keymapAtom),
      get.once(keymapPendingAtom),
      e,
    );
    switch (step._tag) {
      case 'pass':
      case 'hold':
        return;
      case 'wait':
        e.preventDefault();
        get.set(keymapPendingAtom, step.pending);
        return;
      case 'cancel':
        e.preventDefault();
        get.set(keymapPendingAtom, []);
        return;
      case 'run': {
        const sequence = step.binding.sequence.length > 1;
        if (sequence) get.set(keymapPendingAtom, []);
        const handler = HANDLERS[step.binding.action.id];
        const done = handler?.(get, e, step.binding) ?? false;
        if (done || sequence) e.preventDefault();
      }
    }
  };
  document.addEventListener('keydown', onKey);
  get.addFinalizer(() => document.removeEventListener('keydown', onKey));
});
