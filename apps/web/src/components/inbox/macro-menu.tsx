import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import type {
  InboxId,
  InboxOperatorQuestionDto,
} from '@operator-inbox/core/api';
import type { Atom } from 'effect/reactivity';
import type { KeyboardEvent } from 'react';
import { pickerAskedAtom } from '../../attachments';
import { commentCardRef, commentMacroMenuAtom } from '../../comments';
import {
  ATTACH_DESCRIPTION,
  askMacroFocusAtom,
  commentMacroCardId,
  entryName,
  type MacroCard,
  type MacroMenu,
  type MenuEntry,
  macroCardsAtom,
  macroMenuAtom,
  macrosAtom,
  macrosSourceAtom,
  matchingMacros,
  menuEntries,
  signatureOf,
  slashAt,
  withCard,
} from '../../macros';

// The `/` menu: over the answer box, the ask box and the follow-up box, and
// over a comment's field. `/` at a word's start opens it, whichever field it
// is in; its keys (↑↓, Ctrl+N and Ctrl+P, ↩ or Tab to pick, Esc) are the same
// in each. A pick in the answer or the ask box is a card under it, and in a
// comment's field a card nested under the comment (`macro-cards.tsx`).

type QuestionNumber = InboxOperatorQuestionDto['number'];

export const MACRO_MENU_ID = 'macro-menu';
// The answer box's options keep their ids; a comment's list prefixes its own.
const optionId = (listId: string, name: string) =>
  listId === MACRO_MENU_ID
    ? `macro-option-${name}`
    : `${listId}-option-${name}`;

/**
 * A `/` menu over a field: its state lives in `menuAtom`, and this reads the
 * field's text and caret into it, takes the menu's keys first, and on a pick
 * takes the `/query` out of the text and hands the entry to `onPick`, with
 * where the slash was. The answer box, the ask box and a comment's field
 * each use it, so `/` opens it, and its keys act, the same way in all three.
 */
const useSlashMenu = (opts: {
  readonly menuAtom: Atom.Writable<MacroMenu | undefined>;
  readonly entries: (query: string) => ReadonlyArray<MenuEntry>;
  readonly failed: string | undefined;
  // The list's id, for the field's `aria-controls` and its options' ids.
  readonly listId: string;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly onPick: (
    entry: MenuEntry,
    el: HTMLTextAreaElement,
    start: number,
  ) => void;
}) => {
  const [menu, setMenu] = useAtom(opts.menuAtom);
  const items = menu === undefined ? [] : opts.entries(menu.query);
  const open =
    menu !== undefined &&
    !menu.shut &&
    (items.length > 0 || opts.failed !== undefined);

  const refresh = (el: HTMLTextAreaElement) => {
    // `/` at a word's start is the menu; one that matches nothing shows none.
    const at =
      el.selectionStart === el.selectionEnd
        ? slashAt(el.value, el.selectionStart)
        : undefined;
    if (at === undefined) {
      if (menu !== undefined) setMenu(undefined);
      return;
    }
    if (menu !== undefined && menu.start === at.start) {
      if (menu.query !== at.query)
        setMenu({ ...menu, query: at.query, active: 0 });
      return;
    }
    setMenu({ start: at.start, query: at.query, active: 0, shut: false });
  };

  const pick = (entry: MenuEntry, el: HTMLTextAreaElement | null) => {
    if (menu === undefined || el === null) return;
    const { start } = menu;
    setMenu(undefined);
    opts.setText(opts.text.slice(0, start) + opts.text.slice(el.selectionEnd));
    opts.onPick(entry, el, start);
  };

  /** The menu's keys, first in the field's own handler; true when it took one. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || menu === undefined) return false;
    const n = items.length;
    if (e.key === 'Escape') setMenu({ ...menu, shut: true });
    else if (n === 0) return false;
    else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey))
      setMenu({ ...menu, active: (menu.active + 1) % n });
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey))
      setMenu({ ...menu, active: (menu.active - 1 + n) % n });
    else if (
      (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) ||
      (e.key === 'Tab' && !e.shiftKey)
    ) {
      const entry = items[menu.active];
      if (entry === undefined) return false;
      pick(entry, e.currentTarget);
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  /** Shut the menu for this slash, as Esc does. */
  const shut = () => {
    if (menu !== undefined && !menu.shut) setMenu({ ...menu, shut: true });
  };

  const active = open ? items[menu?.active ?? 0] : undefined;
  const combobox = {
    active:
      active === undefined
        ? undefined
        : optionId(opts.listId, entryName(active)),
    expanded: open,
    controls: opts.listId,
  };

  return {
    open,
    items,
    failed: opts.failed,
    active,
    refresh,
    pick,
    onKeyDown,
    shut,
    combobox,
  };
};

/**
 * The `/` menu of the box at the foot: its state lives in `macroMenuAtom`.
 * `/attach` opens the box's file picker; a macro, offered in the answer box
 * and the ask box, becomes a card under it.
 */
export const useMacroMenu = (item: {
  // The box's place, whose picker `/attach` opens (`attachments.ts`).
  readonly place: string;
  readonly text: string;
  readonly setText: (text: string) => void;
  // The answer, or the ask, the macros' cards belong to: an ask's names no
  // question. Left out (a follow-up), the menu offers `/attach` alone.
  readonly macros?: {
    readonly key: string;
    readonly inboxId: InboxId;
    readonly number?: QuestionNumber;
  };
}) => {
  const loaded = useAtomValue(macrosAtom);
  const source = useAtomValue(macrosSourceAtom);
  const [cards, setCards] = useAtom(
    macroCardsAtom(item.macros?.key ?? item.place),
  );
  const askFocus = useAtomSet(askMacroFocusAtom);
  const askPicker = useAtomSet(pickerAskedAtom);
  const macros = item.macros === undefined ? [] : loaded;
  return useSlashMenu({
    menuAtom: macroMenuAtom,
    // `/attach` is always offered, so `/` at a word's start is always the
    // menu.
    entries: (query) => menuEntries(macros, query),
    failed:
      item.macros !== undefined && source._tag === 'Failed'
        ? source.message
        : undefined,
    listId: MACRO_MENU_ID,
    text: item.text,
    setText: item.setText,
    onPick: (entry, el, start) => {
      const keepCaret = () =>
        setTimeout(() => {
          el.focus({ preventScroll: true });
          el.setSelectionRange(start, start);
        });
      if (entry._tag === 'Attach') {
        // In the same key press, so the browser lets the picker open.
        askPicker({ place: item.place });
        keepCaret();
        return;
      }
      if (item.macros === undefined) return;
      const { macro } = entry;
      const added = withCard(cards, macro);
      setCards({
        inboxId: item.macros.inboxId,
        ...(item.macros.number === undefined
          ? {}
          : { number: item.macros.number }),
        cards: added.cards,
      });
      if (macro.params.length > 0)
        askFocus({
          key: item.macros.key,
          to: { _tag: 'Field', card: added.id, index: 0 },
        });
      // A card with nothing to fill leaves the caret where the slash was.
      else keepCaret();
    },
  });
};

/**
 * The `/` menu of a comment's field: every macro, as the answer box offers
 * them, and no `/attach` (a file goes with the answer, not with a span of the
 * question). A pick is a card nested under the comment.
 */
export const useCommentMacroMenu = (comment: {
  readonly itemKey: string;
  readonly id: number;
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly macros: ReadonlyArray<MacroCard>;
  readonly setMacros: (macros: ReadonlyArray<MacroCard>) => void;
}) => {
  const loaded = useAtomValue(macrosAtom);
  const source = useAtomValue(macrosSourceAtom);
  const askFocus = useAtomSet(askMacroFocusAtom);
  return useSlashMenu({
    menuAtom: commentMacroMenuAtom(commentCardRef(comment.itemKey, comment.id)),
    entries: (query) =>
      matchingMacros(loaded, query).map((macro) => ({
        _tag: 'Macro' as const,
        macro,
      })),
    failed: source._tag === 'Failed' ? source.message : undefined,
    listId: commentMenuId(comment.id),
    text: comment.text,
    setText: comment.setText,
    onPick: (entry, el, start) => {
      if (entry._tag !== 'Macro') return;
      const { macro } = entry;
      const added = withCard(comment.macros, macro);
      comment.setMacros(added.cards);
      if (macro.params.length > 0)
        askFocus({
          key: comment.itemKey,
          to: {
            _tag: 'Field',
            card: commentMacroCardId(comment.id, added.id),
            index: 0,
          },
        });
      // A card with nothing to fill leaves the caret where the slash was.
      else
        setTimeout(() => {
          el.focus({ preventScroll: true });
          el.setSelectionRange(start, start);
        });
    },
  });
};

/** The list id of comment `id`'s menu: one per comment, never the answer box's. */
const commentMenuId = (id: number): string => `comment-${id}-macro-menu`;

/** The list of macros over the box, as the inbox picker's list is. */
export const MacroMenuList = ({
  items,
  active,
  failed,
  onPick,
  id = MACRO_MENU_ID,
  floating = false,
}: {
  readonly items: ReadonlyArray<MenuEntry>;
  readonly active: MenuEntry | undefined;
  readonly failed: string | undefined;
  readonly onPick: (entry: MenuEntry) => void;
  readonly id?: string;
  // In a popup of its own (a comment's), which places it: not over its box.
  readonly floating?: boolean;
}) => (
  <div
    id={id}
    role="listbox"
    aria-label="Macros"
    className={`${floating ? '' : 'absolute inset-x-0 bottom-full z-30 mb-s1'} flex flex-col border border-fg/20 bg-bg py-s1 font-zen text-12 shadow-lg`}
  >
    {failed !== undefined && (
      <p className="px-s2 py-0.5 text-red" role="alert" data-macro-failed>
        No macros: {failed}
      </p>
    )}
    {items.map((m) => {
      const name = entryName(m);
      return (
        <div
          key={`${m._tag}:${name}`}
          id={optionId(id, name)}
          role="option"
          tabIndex={-1}
          aria-selected={m === active}
          // A press keeps the caret in the box, and is the gesture the
          // file picker needs to open.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(m);
          }}
          className={`flex cursor-pointer items-baseline gap-s2 px-s2 py-0.5 ${m === active ? 'bg-fg/8 text-fg' : 'text-fg/55 hover:text-fg/85'}`}
        >
          <span className="shrink-0 font-medium">/{name}</span>
          {m._tag === 'Macro' && (
            <span className="shrink-0 text-fg/40">{signatureOf(m.macro)}</span>
          )}
          <span className="min-w-0 truncate text-fg/35">
            {m._tag === 'Macro' ? m.macro.description : ATTACH_DESCRIPTION}
          </span>
        </div>
      );
    })}
  </div>
);
