import { Input } from '@base-ui/react/input';
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
import { boxFocusAskedAtom } from '../../inbox-reader';
import { keyHintAtom } from '../../keymap';
import {
  askMacroFocusAtom,
  cardRefOf,
  focusedMacroCardAtom,
  type MacroCard,
  type MacroFocus,
  macroCardsAtom,
  macroFocusAskedAtom,
  macroHeldAtom,
  macroInfoOpenAtom,
  macroMenuAtom,
  macrosAtom,
  macrosSourceAtom,
  matchingMacros,
  missingKeyOf,
  signatureOf,
  slashAt,
  toggledIn,
  withArg,
  withCard,
} from '../../macros';

// The macros of the answer box: the `/` menu over it and a card per macro
// invoked under it. A card is its header (`/name`, the "i", its description,
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
// an answer key (`<inbox id>/<number>`) holds neither.
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
 * The answer box's `/` menu: its state lives in `macroMenuAtom`, and this
 * reads the box's text and caret into it, takes the menu's keys first, and
 * turns a pick into a card.
 */
export const useMacroMenu = (item: {
  readonly key: string;
  readonly inboxId: InboxId;
  readonly number: QuestionNumber;
  readonly text: string;
  readonly setText: (text: string) => void;
}) => {
  const [menu, setMenu] = useAtom(macroMenuAtom);
  const macros = useAtomValue(macrosAtom);
  const source = useAtomValue(macrosSourceAtom);
  const [cards, setCards] = useAtom(macroCardsAtom(item.key));
  const askFocus = useAtomSet(askMacroFocusAtom);
  const items = menu === undefined ? [] : matchingMacros(macros, menu.query);
  const failed = source._tag === 'Failed' ? source.message : undefined;
  const open =
    menu !== undefined &&
    !menu.shut &&
    (items.length > 0 || failed !== undefined);

  const refresh = (el: HTMLTextAreaElement) => {
    // No file, or one still loading, is no menu: `/` simply types.
    const at =
      (macros.length > 0 || failed !== undefined) &&
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

  const pick = (macro: MacroConfig, el: HTMLTextAreaElement | null) => {
    if (menu === undefined || el === null) return;
    const { start } = menu;
    setMenu(undefined);
    item.setText(item.text.slice(0, start) + item.text.slice(el.selectionEnd));
    const added = withCard(cards, macro);
    setCards({
      inboxId: item.inboxId,
      number: item.number,
      cards: added.cards,
    });
    if (macro.params.length > 0)
      askFocus({
        key: item.key,
        to: { _tag: 'Field', card: added.id, index: 0 },
      });
    // A card with nothing to fill leaves the caret where the slash was.
    else
      setTimeout(() => {
        el.focus({ preventScroll: true });
        el.setSelectionRange(start, start);
      });
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
      const macro = items[menu.active];
      if (macro === undefined) return false;
      pick(macro, e.currentTarget);
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const active = open ? items[menu?.active ?? 0] : undefined;
  const combobox = {
    active: active === undefined ? undefined : optionId(active.name),
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
  readonly items: ReadonlyArray<MacroConfig>;
  readonly active: MacroConfig | undefined;
  readonly failed: string | undefined;
  readonly onPick: (macro: MacroConfig) => void;
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
    {items.map((m) => (
      <div
        key={m.name}
        id={optionId(m.name)}
        role="option"
        tabIndex={-1}
        aria-selected={m === active}
        // A press keeps the caret in the box.
        onMouseDown={(e) => {
          e.preventDefault();
          onPick(m);
        }}
        className={`flex cursor-pointer items-baseline gap-s2 px-s2 py-0.5 ${m === active ? 'bg-fg/8 text-fg' : 'text-fg/55 hover:text-fg/85'}`}
      >
        <span className="shrink-0 font-medium">/{m.name}</span>
        <span className="shrink-0 text-fg/40">{signatureOf(m)}</span>
        <span className="min-w-0 truncate text-fg/35">{m.description}</span>
      </div>
    ))}
  </div>
);

const pill =
  'cursor-pointer border border-fg/15 px-s2 py-0.5 text-fg/55 outline-none select-none hover:text-fg/85 focus-visible:border-fg/70 focus-visible:text-fg';

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
        <Input
          data-macro-stop={stop}
          aria-label={param.name}
          value={typeof value === 'string' ? value : ''}
          placeholder={param.placeholder ?? ''}
          onValueChange={(v) => set(v === '' ? undefined : v)}
          className="w-full border-b border-fg/20 bg-transparent py-0.5 font-reading text-13 text-fg outline-none placeholder:text-fg/25 focus:border-fg/60 pointer-coarse:text-field"
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
          <NumberField.Group className="flex w-fit items-center border border-fg/15 focus-within:border-fg/60">
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
  const setFocused = useAtomSet(focusedMacroCardAtom);
  const bumpBoxFocus = useAtomSet(boxFocusAskedAtom);
  const sendHint = useAtomValue(keyHintAtom('send_response'));
  const missing = missingMacroParams(macro, card.args);
  const waiting = held && missing.length > 0;
  const bare = macro.params.length === 0;
  return (
    <section
      data-macro-card={ref}
      data-macro-held={waiting || undefined}
      aria-label={`/${macro.name}`}
      // A card with nothing to fill is still a stop, so ⌘⌫ can reach it.
      tabIndex={bare ? 0 : undefined}
      onFocus={() => setFocused(ref)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused((at) => (at === ref ? undefined : at));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // The first Esc shuts the "i"; the next goes back to the text.
          if (openRefs.includes(ref)) setOpen(toggledIn(openRefs, ref, false));
          else bumpBoxFocus((n) => n + 1);
        } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) remove();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className={`relative border px-s2 py-s1 font-zen text-12 outline-none ${waiting ? 'border-orange' : 'border-fg/12 focus-within:border-fg/30 focus-visible:border-fg/50'}`}
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
              <div key={param.name} className="flex items-baseline gap-s2">
                <span
                  className={`w-20 shrink-0 ${waiting && empty && param.required !== false ? 'text-orange' : 'text-fg/40'}`}
                >
                  {param.name}
                  {param.required === false && (
                    <span className="text-fg/25"> optional</span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <Field
                    stop={`${ref}:${index}`}
                    param={param}
                    value={card.args[param.name]}
                    set={(v) => setArg(param.name, v)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

/** The cards of one answer, under its box, scrolling once taller than the body. */
export const MacroCards = ({
  itemKey,
  inboxId,
  number,
}: {
  readonly itemKey: string;
  readonly inboxId: InboxId;
  readonly number: QuestionNumber;
}) => {
  const [cards, setCards] = useAtom(macroCardsAtom(itemKey));
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
  if (cards.length === 0) return null;
  const held = heldOn !== undefined && heldOn === missingKeyOf(cards);
  const write = (next: ReadonlyArray<MacroCard>) =>
    setCards({ inboxId, number, cards: next });
  return (
    <div
      className="mt-s1 flex max-h-body flex-col gap-s1 overflow-y-auto"
      data-macro-cards
    >
      {cards.map((card, at) => (
        <Card
          key={card.id}
          itemKey={itemKey}
          card={card}
          held={held}
          setArg={(name, v) => write(withArg(cards, card.id, name, v))}
          remove={() => {
            const rest = cards.filter((c) => c.id !== card.id);
            write(rest);
            // The next card down takes the focus, else the one above, else
            // the text.
            const next = rest[at] ?? rest[at - 1];
            askFocus({
              key: itemKey,
              to: next === undefined ? { _tag: 'Text' } : firstStopOf(next),
            });
          }}
        />
      ))}
    </div>
  );
};

/** Tab from the text, while there are cards, goes to the first card's first stop. */
export const firstCardStop = (
  cards: ReadonlyArray<MacroCard>,
): MacroFocus | undefined => {
  const [first] = cards;
  return first === undefined ? undefined : firstStopOf(first);
};
