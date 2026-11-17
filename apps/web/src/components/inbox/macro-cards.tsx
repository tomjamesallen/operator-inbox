import { NumberField } from '@base-ui/react/number-field';
import { Popover } from '@base-ui/react/popover';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import {
  useAtom,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@effect/atom-react';
import {
  type InboxId,
  type InboxOperatorQuestionDto,
  isMacroValueFilled,
  type MacroConfig,
  type MacroDraftValue,
  type MacroParam,
  missingMacroParams,
} from '@operator-inbox/core/api';
import type { KeyboardEvent } from 'react';
import { pendingFilesAtom, pickerAskedAtom } from '../../attachments';
import { removeCardAtom } from '../../card-undo';
import { commentStop, commentsInOrderAtom } from '../../comments';
import { answerPlaceOf, boxFocusAskedAtom } from '../../inbox-reader';
import { keyHintAtom } from '../../keymap';
import {
  ATTACH_DESCRIPTION,
  askMacroFocusAtom,
  cardRefOf,
  entryName,
  type MacroCard,
  type MacroFocus,
  type MenuEntry,
  macroCardsAtom,
  macroFocusAskedAtom,
  macroHeldAtom,
  macroInfoOpenAtom,
  macroMenuAtom,
  macrosAtom,
  macrosSourceAtom,
  menuEntries,
  missingKeyOf,
  signatureOf,
  slashAt,
  toggledIn,
  withArg,
  withCard,
} from '../../macros';
import { FileCards } from './attachments';
import { CardShell } from './card-shell';
import { CommentCard } from './comment-card';
import { edgeFade, fadeEdges } from './edge-fade';

// The macros of the answer box and the ask box: the `/` menu over it and a
// card per macro invoked under it. A card is its header (`/name`, the "i", its description,
// ×) and a labelled row per parameter in Base UI's own controls: a radio group
// for a one-of, a toggle group for a many-of, a number field, an input. Tab
// walks the fields; Esc shuts the "i", then goes back to the text; ⌘⌫ removes
// the card. The keys are in the help sheet's Macros section, not in the box.

type QuestionNumber = InboxOperatorQuestionDto['number'];

export const MACRO_MENU_ID = 'macro-menu';
const optionId = (name: string) => `macro-option-${name}`;

/** Where the caret goes for a card's first stop: its first field, or itself. */
const firstStopOf = (card: MacroCard): MacroFocus =>
  card.macro.params.length > 0
    ? { _tag: 'Field', card: card.id, index: 0 }
    : { _tag: 'Card', card: card.id };

// Inside double quotes an attribute value needs only `"` and `\` escaped, and
// an answer key (`<inbox id>/<number>`) or an ask's (`ask:<inbox id>`) holds
// neither.
const stopSelector = (key: string, to: MacroFocus): string | undefined =>
  to._tag === 'Field'
    ? `[data-macro-stop="${key}#${to.card}:${to.index}"]`
    : to._tag === 'Card'
      ? `[data-macro-card="${cardRefOf(key, to.card)}"]`
      : undefined;

// A group (radios, toggles) carries the mark; its roving stop takes the focus.
const focusStop = (el: HTMLElement): void => {
  const target = el.matches('input, textarea, button, [tabindex]')
    ? el
    : (el.querySelector<HTMLElement>('[tabindex="0"]') ??
      el.querySelector<HTMLElement>('input, button'));
  target?.focus({ preventScroll: true });
};

/**
 * The `/` menu of the box at the foot: its state lives in `macroMenuAtom`,
 * and this reads the box's text and caret into it, takes the menu's keys
 * first, and acts on a pick. `/attach` opens the box's file picker; a macro,
 * offered in the answer box and the ask box, becomes a card under it.
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
  const [menu, setMenu] = useAtom(macroMenuAtom);
  const loaded = useAtomValue(macrosAtom);
  const source = useAtomValue(macrosSourceAtom);
  const [cards, setCards] = useAtom(
    macroCardsAtom(item.macros?.key ?? item.place),
  );
  const askFocus = useAtomSet(askMacroFocusAtom);
  const askPicker = useAtomSet(pickerAskedAtom);
  const macros = item.macros === undefined ? [] : loaded;
  const items = menu === undefined ? [] : menuEntries(macros, menu.query);
  const failed =
    item.macros !== undefined && source._tag === 'Failed'
      ? source.message
      : undefined;
  const open =
    menu !== undefined &&
    !menu.shut &&
    (items.length > 0 || failed !== undefined);

  const refresh = (el: HTMLTextAreaElement) => {
    // `/attach` is always offered, so `/` at a word's start is always the
    // menu; one that matches nothing shows none.
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
    item.setText(item.text.slice(0, start) + item.text.slice(el.selectionEnd));
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
  };

  /** The menu's keys, first in the box's own handler; true when it took one. */
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

  const active = open ? items[menu?.active ?? 0] : undefined;
  const combobox = {
    active: active === undefined ? undefined : optionId(entryName(active)),
    expanded: open,
    controls: MACRO_MENU_ID,
  };

  return { open, items, failed, active, refresh, pick, onKeyDown, combobox };
};

/** The list of macros over the box, as the inbox picker's list is. */
export const MacroMenuList = ({
  items,
  active,
  failed,
  onPick,
}: {
  readonly items: ReadonlyArray<MenuEntry>;
  readonly active: MenuEntry | undefined;
  readonly failed: string | undefined;
  readonly onPick: (entry: MenuEntry) => void;
}) => (
  <div
    id={MACRO_MENU_ID}
    role="listbox"
    aria-label="Macros"
    className="absolute inset-x-0 bottom-full z-30 mb-s1 flex flex-col border border-fg/20 bg-bg py-s1 font-zen text-12 shadow-lg"
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
          id={optionId(name)}
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

const pill =
  'inline-flex h-field cursor-pointer items-center border border-fg/15 px-s2 text-fg/55 outline-none select-none hover:text-fg/85 focus-visible:border-fg/70 focus-visible:text-fg';

const Field = ({
  stop,
  param,
  value,
  set,
}: {
  readonly stop: string;
  readonly param: MacroParam;
  readonly value: MacroDraftValue | undefined;
  readonly set: (v: MacroDraftValue | undefined) => void;
}) => {
  switch (param.type) {
    case 'text':
      return (
        // A textarea, not an input: a value often runs to several lines, so it
        // wraps and grows as the answer box does. Enter is a new line, whatever
        // config.json's `sendKey` says; Send's keybinding reaches the page as
        // it does from the answer box.
        <textarea
          data-macro-stop={stop}
          aria-label={param.name}
          rows={1}
          value={typeof value === 'string' ? value : ''}
          placeholder={param.placeholder ?? ''}
          onChange={(e) =>
            set(e.target.value === '' ? undefined : e.target.value)
          }
          className="field-sizing-content block max-h-body w-full resize-none border-b border-fg/20 bg-transparent py-field-pad font-reading text-13 leading-card text-fg outline-none placeholder:text-fg/25 focus:border-fg/60 pointer-coarse:text-field"
        />
      );
    case 'number':
      return (
        <NumberField.Root
          value={typeof value === 'number' ? value : null}
          onValueChange={(v) => set(v ?? undefined)}
          {...(param.min === undefined ? {} : { min: param.min })}
          {...(param.max === undefined ? {} : { max: param.max })}
        >
          <NumberField.Group className="flex h-field w-fit items-center border border-fg/15 focus-within:border-fg/60">
            <NumberField.Decrement
              tabIndex={-1}
              aria-label={`Less ${param.name}`}
              className="cursor-pointer px-s1 text-fg/40 hover:text-fg"
            >
              −
            </NumberField.Decrement>
            <NumberField.Input
              data-macro-stop={stop}
              aria-label={param.name}
              className="w-10 bg-transparent text-center font-reading text-13 text-fg outline-none pointer-coarse:text-field"
            />
            <NumberField.Increment
              tabIndex={-1}
              aria-label={`More ${param.name}`}
              className="cursor-pointer px-s1 text-fg/40 hover:text-fg"
            >
              +
            </NumberField.Increment>
          </NumberField.Group>
        </NumberField.Root>
      );
    case 'enum':
      return param.multiple === true ? (
        <ToggleGroup
          data-macro-stop={stop}
          multiple
          aria-label={param.name}
          value={Array.isArray(value) ? [...value] : []}
          onValueChange={(v) => set(v.length === 0 ? undefined : v)}
          className="flex flex-wrap gap-1"
        >
          {param.options.map((o) => (
            <Toggle
              key={o}
              value={o}
              className={`${pill} data-pressed:border-fg/60 data-pressed:bg-fg data-pressed:text-bg`}
            >
              {o}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : (
        <RadioGroup
          data-macro-stop={stop}
          aria-label={param.name}
          value={typeof value === 'string' ? value : null}
          onValueChange={(v) => set(typeof v === 'string' ? v : undefined)}
          className="flex flex-wrap gap-1"
        >
          {param.options.map((o) => (
            <Radio.Root
              key={o}
              value={o}
              className={`${pill} data-checked:border-fg/60 data-checked:bg-fg data-checked:text-bg`}
            >
              {o}
            </Radio.Root>
          ))}
        </RadioGroup>
      );
  }
};

// The "i": what the macro tells the agent, in a popover that opens on hover
// and stays open on a click. ⌥I (the keymap's `toggle_macro_info`) toggles it
// from anywhere in the card; it is not a tab stop.
const Info = ({ cardRef, macro }: { cardRef: string; macro: MacroConfig }) => {
  const [openRefs, setOpen] = useAtom(macroInfoOpenAtom);
  const hint = useAtomValue(keyHintAtom('toggle_macro_info'));
  return (
    <Popover.Root
      open={openRefs.includes(cardRef)}
      onOpenChange={(next) => setOpen(toggledIn(openRefs, cardRef, next))}
    >
      <Popover.Trigger
        openOnHover
        delay={150}
        closeDelay={150}
        tabIndex={-1}
        aria-label={`What /${macro.name} tells the agent${hint.first === undefined ? '' : ` (${hint.first})`}`}
        onMouseDown={(e) => e.preventDefault()}
        data-macro-info
        className="inline-grid size-3.5 shrink-0 cursor-pointer place-items-center self-center rounded-full border border-fg/25 font-reading text-10 leading-none text-fg/45 italic outline-none hover:text-fg data-popup-open:border-fg data-popup-open:text-fg"
      >
        i
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          className="z-40"
        >
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            data-macro-instruction
            className="max-w-subtitle border border-fg/20 bg-bg px-s2 py-s1 font-zen text-11 leading-card text-fg/85 shadow-lg outline-none"
          >
            <span className="text-fg/45">Tells the agent: </span>
            {macro.instruction}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const Card = ({
  itemKey,
  card,
  held,
  setArg,
  remove,
}: {
  readonly itemKey: string;
  readonly card: MacroCard;
  // A send is held on this card's empty fields.
  readonly held: boolean;
  readonly setArg: (name: string, v: MacroDraftValue | undefined) => void;
  readonly remove: () => void;
}) => {
  const { macro } = card;
  const ref = cardRefOf(itemKey, card.id);
  const [openRefs, setOpen] = useAtom(macroInfoOpenAtom);
  const sendHint = useAtomValue(keyHintAtom('send_response'));
  const missing = missingMacroParams(macro, card.args);
  const waiting = held && missing.length > 0;
  const bare = macro.params.length === 0;
  return (
    <CardShell
      cardRef={ref}
      label={`/${macro.name}`}
      stop={bare}
      waiting={waiting}
      remove={remove}
      // The first Esc shuts the "i"; the next goes back to the text.
      onEscape={() => {
        if (!openRefs.includes(ref)) return false;
        setOpen(toggledIn(openRefs, ref, false));
        return true;
      }}
    >
      <header className="flex items-baseline gap-s2">
        <span className="shrink-0 font-medium text-fg/85">/{macro.name}</span>
        <Info cardRef={ref} macro={macro} />
        {waiting ? (
          <output className="min-w-0 flex-1 truncate text-orange">
            needs {missing.map((p) => p.name).join(' and ')} ·{' '}
            {sendHint.first ?? 'Send'} again sends it as it is
          </output>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg/40">
            {macro.description}
          </span>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Remove /${macro.name}`}
          title="Remove (⌘⌫)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={remove}
          className="cursor-pointer text-fg/30 hover:text-fg"
        >
          ×
        </button>
      </header>
      {!bare && (
        <div className="mt-s1 flex flex-col gap-s1">
          {macro.params.map((param, index) => {
            const empty = !isMacroValueFilled(card.args[param.name]);
            return (
              // Label and control share a first row of `h-field`, so the
              // label sits level with the control's first line.
              <div key={param.name} className="flex items-start gap-s2">
                <span
                  className={`flex h-field w-20 shrink-0 items-center ${waiting && empty && param.required !== false ? 'text-orange' : 'text-fg/40'}`}
                >
                  {param.name}
                </span>
                <div className="min-w-0 flex-1">
                  <Field
                    stop={`${ref}:${index}`}
                    param={param}
                    value={card.args[param.name]}
                    set={(v) => setArg(param.name, v)}
                  />
                </div>
                {param.required === false && (
                  <span className="flex h-field shrink-0 items-center text-fg/25">
                    optional
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
};

/**
 * The cards of one answer, or one ask, under its box, one stack scrolling once
 * taller than its token: the comments on the Question (in body order; an ask
 * has none), then the macros, then the files waiting to be sent
 * (`FileCards`), side by side. Every card is the same kind of stop, so Tab,
 * Esc, ⌘⌫ and the focus a removal leaves behind are the same for both.
 */
export const MacroCards = ({
  itemKey,
  inboxId,
  number,
  place = answerPlaceOf(itemKey),
}: {
  readonly itemKey: string;
  readonly inboxId: InboxId;
  // The answer's question; an ask's cards name none.
  readonly number?: QuestionNumber;
  // The box's place, whose files the stack shows: the answer's by default.
  readonly place?: string;
}) => {
  const [cards, setCards] = useAtom(macroCardsAtom(itemKey));
  const comments = useAtomValue(commentsInOrderAtom(itemKey));
  const files = useAtomValue(pendingFilesAtom(place));
  // A removal is kept to undo (`card-undo.ts`).
  const removeCard = useAtomSet(removeCardAtom);
  const heldOn = useAtomValue(macroHeldAtom(itemKey));
  const askFocus = useAtomSet(askMacroFocusAtom);
  const bumpBoxFocus = useAtomSet(boxFocusAskedAtom);
  // A focus asked for (a held send, a pick, a removal) lands once drawn.
  useAtomSubscribe(macroFocusAskedAtom, ({ key, to }) => {
    if (key !== itemKey) return;
    if (to._tag === 'Text') {
      bumpBoxFocus((n) => n + 1);
      return;
    }
    const selector = stopSelector(itemKey, to);
    setTimeout(() => {
      const el =
        selector === undefined
          ? null
          : document.querySelector<HTMLElement>(selector);
      if (el !== null) focusStop(el);
    });
  });
  if (cards.length === 0 && comments.length === 0 && files.length === 0)
    return null;
  const held = heldOn !== undefined && heldOn === missingKeyOf(cards);
  const questioned = number === undefined ? {} : { number };
  const write = (next: ReadonlyArray<MacroCard>) =>
    setCards({ inboxId, ...questioned, cards: next });
  const stops = stackStops(cards, comments);
  // The next card down takes the focus, else the one above, else the text.
  const focusAfter = (at: number) => {
    const rest = stops.filter((_, i) => i !== at);
    const next = rest[at] ?? rest[at - 1];
    askFocus({ key: itemKey, to: next ?? { _tag: 'Text' } });
  };
  return (
    <div
      ref={fadeEdges}
      className={`mt-s1 flex max-h-cards flex-col gap-s1 overflow-y-auto ${edgeFade}`}
      data-macro-cards
    >
      {comments.map((c, at) => (
        <CommentCard
          key={`c${c.id}`}
          itemKey={itemKey}
          comment={c}
          number={at + 1}
          remove={() => {
            removeCard({ key: itemKey, card: { _tag: 'Comment', id: c.id } });
            focusAfter(at);
          }}
        />
      ))}
      {cards.map((card, at) => (
        <Card
          key={card.id}
          itemKey={itemKey}
          card={card}
          held={held}
          setArg={(name, v) => write(withArg(cards, card.id, name, v))}
          remove={() => {
            removeCard({
              key: itemKey,
              card: { _tag: 'Macro', id: card.id, inboxId, ...questioned },
            });
            focusAfter(comments.length + at);
          }}
        />
      ))}
      <FileCards place={place} />
    </div>
  );
};

/** Each card's first stop, top to bottom, as the stack draws them. */
const stackStops = (
  cards: ReadonlyArray<MacroCard>,
  comments: ReadonlyArray<{ readonly id: number }>,
): ReadonlyArray<MacroFocus> => [
  ...comments.map((c) => commentStop(c.id)),
  ...cards.map(firstStopOf),
];

/** Tab from the text, while there are cards, goes to the first card's first stop. */
export const firstCardStop = (
  cards: ReadonlyArray<MacroCard>,
  comments: ReadonlyArray<{ readonly id: number }> = [],
): MacroFocus | undefined => stackStops(cards, comments)[0];
