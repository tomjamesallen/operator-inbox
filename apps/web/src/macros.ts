import {
  decodeMacrosFile,
  type InboxBoardDto,
  InboxId,
  InboxOperatorQuestionDto,
  initialMacroArgs,
  type MacroConfig,
  MacroConfig as MacroConfigSchema,
  type MacroDraftValue,
  type MacroInvoked,
  macroInvokedOf,
  missingMacroParams,
} from '@operator-inbox/core/api';
import { Option, Result, Schema } from 'effect';
import { KeyValueStore } from 'effect/persistence';
import { AsyncResult, Atom } from 'effect/reactivity';
import { InboxClient } from './api';
import { failureText } from './failure';
import { inboxBoardAtom } from './inbox';
import { answerKey } from './inbox-queues';

// Macros in the answer box and the ask box: the operator's `macros.json` as
// serve read it, the cards of the macros invoked on each answer or ask (its
// draft, kept as its text is), and what the cards reveal. `/` at a word's start opens the menu;
// each macro picked becomes a card under the box, one field per parameter.
// A send with a required field empty is held once, on that field; a second
// send with the same fields empty sends them as `null`, for the agent.

// --- the file ------------------------------------------------------------------

// Refreshed with the board (`refresh`), so an edit takes effect on the next
// Ctrl+R as well as on a reload.
export const macrosFileAtom = InboxClient.query('macros', 'read', {});

/** Where the macros came from, for the help and the menu to say. */
export type MacrosSource =
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'None'; readonly path: string }
  | {
      readonly _tag: 'Loaded';
      readonly path: string;
      readonly macros: ReadonlyArray<MacroConfig>;
    }
  | { readonly _tag: 'Failed'; readonly message: string };

export const macrosSourceAtom = Atom.make((get): MacrosSource => {
  const result = get(macrosFileAtom);
  if (AsyncResult.isFailure(result))
    return { _tag: 'Failed', message: failureText(result.cause).message };
  const file = Option.getOrUndefined(AsyncResult.value(result));
  if (file === undefined) return { _tag: 'Loading' };
  if (file.text === null) return { _tag: 'None', path: file.path };
  const decoded = decodeMacrosFile(file.text, file.path);
  return Result.isFailure(decoded)
    ? { _tag: 'Failed', message: decoded.failure }
    : { _tag: 'Loaded', path: file.path, macros: decoded.success.macros };
});

/** The macros the menu offers: none while loading, with no file, or a bad one. */
export const macrosAtom = Atom.make((get): ReadonlyArray<MacroConfig> => {
  const source = get(macrosSourceAtom);
  return source._tag === 'Loaded' ? source.macros : [];
}).pipe(Atom.keepAlive);

// --- the menu ------------------------------------------------------------------

/** A `/word` being typed just before the caret, at a word's start. */
export const slashAt = (
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | undefined => {
  const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (match === null) return undefined;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
};

/** The macros a `/query` offers: by name first, then by description. */
export const matchingMacros = (
  macros: ReadonlyArray<MacroConfig>,
  query: string,
): ReadonlyArray<MacroConfig> => {
  const q = query.toLowerCase();
  const byName = macros.filter((m) => m.name.startsWith(q));
  const byText = macros.filter(
    (m) => !byName.includes(m) && m.description.toLowerCase().includes(q),
  );
  return [...byName, ...byText];
};

/**
 * One row of the `/` menu: the app's own `/attach`, which opens the file
 * picker, or one of the operator's macros, which adds a card.
 */
export type MenuEntry =
  | { readonly _tag: 'Attach' }
  | { readonly _tag: 'Macro'; readonly macro: MacroConfig };

export const ATTACH_NAME = 'attach';
export const ATTACH_DESCRIPTION =
  'Attach files, or drop or paste them on the box';

/**
 * What a `/query` offers: `/attach` first when it matches, as a macro would
 * (by name, then by description), then the macros that match. A macro the
 * operator named `attach` is offered after it under its own name.
 */
export const menuEntries = (
  macros: ReadonlyArray<MacroConfig>,
  query: string,
): ReadonlyArray<MenuEntry> => {
  const q = query.toLowerCase();
  const attach =
    ATTACH_NAME.startsWith(q) || ATTACH_DESCRIPTION.toLowerCase().includes(q);
  return [
    ...(attach ? [{ _tag: 'Attach' as const }] : []),
    ...matchingMacros(macros, query).map((macro) => ({
      _tag: 'Macro' as const,
      macro,
    })),
  ];
};

/** The name a menu row shows after its `/`. */
export const entryName = (e: MenuEntry): string =>
  e._tag === 'Attach' ? ATTACH_NAME : e.macro.name;

/** A one-line signature: `‹person› ‹item›`, `[priority]` when optional. */
export const signatureOf = (m: MacroConfig): string =>
  m.params
    .map((p) => {
      const n =
        p.type === 'enum' && p.multiple === true ? `${p.name}…` : p.name;
      return p.required === false ? `[${n}]` : `‹${n}›`;
    })
    .join(' ');

/**
 * The menu over the box at the foot: where its slash is, what follows it,
 * and the row lit. Escape shuts it for that slash. One box is on screen at a
 * time.
 */
export interface MacroMenu {
  readonly start: number;
  readonly query: string;
  readonly active: number;
  readonly shut: boolean;
}

export const macroMenuAtom = Atom.make<MacroMenu | undefined>(undefined).pipe(
  Atom.keepAlive,
);

// --- the cards: each answer's draft ------------------------------------------------

// A card keeps the macro as the config held it when it was picked, so a file
// edited while the card is open never changes what the card asks for or what
// its "i" said would be sent.
const DraftValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Array(Schema.String),
]);

export const MacroCard = Schema.Struct({
  id: Schema.Int,
  macro: MacroConfigSchema,
  args: Schema.Record(Schema.String, DraftValue),
});
export type MacroCard = typeof MacroCard.Type;

// One answer's cards, naming its own Inbox and question as a response draft
// does (`ResponseDraft` in `inbox.ts`), and kept the same way: in this tab's
// sessionStorage, dropped when the cards are emptied, when the answer is sent,
// and when the board no longer has the question waiting on the operator. An
// ask's cards name its Inbox and no question (`number` left out), and are
// kept as its text is (`askDraftAtom`): until they are emptied or sent.
export const MacroDraft = Schema.Struct({
  inboxId: InboxId,
  number: Schema.optionalKey(InboxOperatorQuestionDto.fields.number),
  cards: Schema.Array(MacroCard),
});
export type MacroDraft = typeof MacroDraft.Type;

/**
 * The key of the ask box's cards for `inboxId`: the ask box's own place
 * (`askPlaceOf` in `inbox-reader.ts`), so its files and its cards share one.
 */
export const askCardsKeyOf = (inboxId: InboxId): string =>
  `${ASK_CARDS_PREFIX}${inboxId}`;
export const ASK_CARDS_PREFIX = 'ask:';

/** The key a draft's cards are found by: its answer's, or its ask's. */
const draftKeyOf = (d: MacroDraft): string =>
  d.number === undefined
    ? askCardsKeyOf(d.inboxId)
    : answerKey(d.inboxId, d.number);

/** The drafts whose question still waits on the operator, as far as `board` can say. */
export const macroDraftsStillWaiting = (
  drafts: ReadonlyArray<MacroDraft>,
  board: Pick<typeof InboxBoardDto.Type, 'views'>,
): ReadonlyArray<MacroDraft> => {
  const onBoard = new Set<string>(board.views.map((v) => v.inboxId));
  const waiting = new Set(
    board.views.flatMap((v) =>
      v.awaitingOperator.map((q) => answerKey(v.inboxId, q.number)),
    ),
  );
  const kept = drafts.filter(
    (d) =>
      d.number === undefined ||
      !onBoard.has(d.inboxId) ||
      waiting.has(answerKey(d.inboxId, d.number)),
  );
  return kept.length === drafts.length ? drafts : kept;
};

const tabStorage = Atom.runtime(
  KeyValueStore.layerStorage(() => sessionStorage),
);

const storedMacroDraftsAtom = Atom.kvs({
  runtime: tabStorage,
  key: 'operator-inbox:inbox-macro-drafts',
  schema: Schema.Array(MacroDraft),
  defaultValue: (): ReadonlyArray<MacroDraft> => [],
}).pipe(Atom.keepAlive);

const macroDraftsAtom = Atom.make((get): ReadonlyArray<MacroDraft> => {
  const drafts = get(storedMacroDraftsAtom);
  const board = Option.getOrUndefined(AsyncResult.value(get(inboxBoardAtom)));
  return board === undefined ? drafts : macroDraftsStillWaiting(drafts, board);
}).pipe(Atom.keepAlive);

/**
 * One answer's cards, or one ask's, by its key (`answerKey`, `askCardsKeyOf`);
 * writing an empty list drops the draft.
 */
export const macroCardsAtom = Atom.family((key: string) =>
  Atom.writable(
    (get): ReadonlyArray<MacroCard> =>
      get(macroDraftsAtom).find((d) => draftKeyOf(d) === key)?.cards ?? [],
    (ctx, draft: MacroDraft) => {
      const rest = ctx
        .get(macroDraftsAtom)
        .filter((d) => draftKeyOf(d) !== key);
      ctx.set(
        storedMacroDraftsAtom,
        draft.cards.length === 0 ? rest : [...rest, draft],
      );
    },
  ),
);

/**
 * `moved` put after `cards`, each numbered past the others, as cards added
 * one by one would be: an ask's cards going with its text to another Inbox.
 */
export const withCards = (
  cards: ReadonlyArray<MacroCard>,
  moved: ReadonlyArray<MacroCard>,
): ReadonlyArray<MacroCard> => {
  const top = cards.reduce((n, c) => Math.max(n, c.id), 0);
  return [...cards, ...moved.map((c, i) => ({ ...c, id: top + i + 1 }))];
};

/** A card for `macro` at the end of the stack, numbered past the others. */
export const withCard = (
  cards: ReadonlyArray<MacroCard>,
  macro: MacroConfig,
): { readonly cards: ReadonlyArray<MacroCard>; readonly id: number } => {
  const id = cards.reduce((top, c) => Math.max(top, c.id), 0) + 1;
  return {
    cards: [...cards, { id, macro, args: initialMacroArgs(macro) }],
    id,
  };
};

export const withArg = (
  cards: ReadonlyArray<MacroCard>,
  id: number,
  name: string,
  value: MacroDraftValue | undefined,
): ReadonlyArray<MacroCard> =>
  cards.map((c) => {
    if (c.id !== id) return c;
    const { [name]: _, ...rest } = c.args;
    return {
      ...c,
      args: value === undefined ? rest : { ...rest, [name]: value },
    };
  });

/** What the answer carries for its cards, in their order. */
export const macrosToSend = (
  cards: ReadonlyArray<MacroCard>,
): ReadonlyArray<MacroInvoked> =>
  cards.map((c) => macroInvokedOf(c.macro, c.args));

// --- the held send ------------------------------------------------------------------

/**
 * The required fields still empty across the cards, as one key: the same
 * key a held send was held on lets the next send through. Undefined when
 * every required field is filled.
 */
export const missingKeyOf = (
  cards: ReadonlyArray<MacroCard>,
): string | undefined => {
  const parts = cards.flatMap((c) => {
    const missing = missingMacroParams(c.macro, c.args);
    return missing.length === 0
      ? []
      : [`${c.id}:${missing.map((p) => p.name).join(',')}`];
  });
  return parts.length === 0 ? undefined : parts.join('|');
};

/** The first empty required field, in the cards' order. */
export const firstMissingOf = (
  cards: ReadonlyArray<MacroCard>,
): { readonly card: number; readonly index: number } | undefined => {
  for (const c of cards) {
    const missing = missingMacroParams(c.macro, c.args);
    const index = c.macro.params.findIndex((p) => missing.includes(p));
    if (index >= 0) return { card: c.id, index };
  }
  return undefined;
};

/**
 * The missing-fields key a send was held on, by answer key. Memory only: a
 * reload asks again. A card shows the held note while the key still matches,
 * so filling a field clears it.
 */
export const macroHeldAtom = Atom.family((_key: string) =>
  Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive),
);

// --- focus, and what a card reveals -----------------------------------------------------

/**
 * A card in the stack under the answer box: a macro's by its number, a
 * comment's as `c<n>` (`comments.ts`), so the two never meet.
 */
export type CardId = number | `c${number}`;

/** Where the caret is asked to go: a card's field, the card itself, or the text. */
export type MacroFocus =
  | { readonly _tag: 'Field'; readonly card: CardId; readonly index: number }
  | { readonly _tag: 'Card'; readonly card: CardId }
  | { readonly _tag: 'Text' };

/** Bumped with where to go; the box on screen moves the focus once drawn. */
export const macroFocusAskedAtom = Atom.make<{
  readonly seq: number;
  readonly key: string;
  readonly to: MacroFocus;
}>({ seq: 0, key: '', to: { _tag: 'Text' } }).pipe(Atom.keepAlive);

/** Ask the focus to go to `to` in the box of answer `key`. */
export const askMacroFocusAtom = Atom.writable(
  () => undefined,
  (ctx, req: { readonly key: string; readonly to: MacroFocus }): void => {
    ctx.set(macroFocusAskedAtom, {
      seq: ctx.get(macroFocusAskedAtom).seq + 1,
      ...req,
    });
  },
);

/** A card, across answers: `<answer key>#<card id>`. */
export const cardRefOf = (key: string, id: CardId): string => `${key}#${id}`;

/** The cards whose instruction shows now. */
export const macroInfoOpenAtom = Atom.make<ReadonlyArray<string>>([]).pipe(
  Atom.keepAlive,
);

export const toggledIn = (
  refs: ReadonlyArray<string>,
  ref: string,
  open: boolean,
): ReadonlyArray<string> => [
  ...refs.filter((r) => r !== ref),
  ...(open ? [ref] : []),
];

/** The card the focus is in, for the keymap's `toggle_macro_info`. */
export const focusedMacroCardAtom = Atom.make<string | undefined>(
  undefined,
).pipe(Atom.keepAlive);
