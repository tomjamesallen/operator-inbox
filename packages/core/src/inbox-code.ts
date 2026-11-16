import { InboxCode, type InboxId } from './schema/identifiers';

// Question codes: `xyz#12`, a Question's handle the operator and an agent can
// both quote. `xyz` is its Inbox's code: three lower-case letters drawn at
// random, unique across the machine's Inboxes, assigned once by
// `InboxCodeAssigned` (`inbox.ts`), so a rename leaves it alone. `#12` is the
// Question's number in that Inbox.
//
// Codes once had two letters from the Inbox's name in front, `ab-xyz`. An
// Inbox given one of those is moved to its three letters by
// `InboxCodeChanged` (serve does it at start-up), and the old form is still
// read wherever a code is taken, so an older transcript's `ab-xyz#12` finds
// its question.
//
// Pure: the letters come in from the CLI edge, drawn there (a new Inbox) or
// derived from the Inbox's id (`derivedCodes`, for an Inbox opened before
// codes, or one whose letters another Inbox already holds). Nothing here
// draws one.
//
// BROWSER-SAFE: the page formats and parses question codes too, so this
// module imports only core's own pure schema modules.

// How many codes there are: 26³.
export const CODE_COUNT = 26 ** 3;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * The code numbered `n`, from 0 to `CODE_COUNT - 1`: three lower-case
 * letters, `aaa` first. A number outside that range wraps.
 */
export const codeAt = (n: number): InboxCode => {
  const i = ((Math.trunc(n) % CODE_COUNT) + CODE_COUNT) % CODE_COUNT;
  return InboxCode.make(
    [676, 26, 1].map((place) => LETTERS[Math.floor(i / place) % 26]).join(''),
  );
};

// A code as the app gives them now, and as it gave them before (`ab-xyz`).
const CODE = /^[a-z]{3}$/;
const NAMED_CODE = /^[a-z]{2}-([a-z]{3})$/;

/**
 * The three letters a code in the older named form (`ab-xyz`) keeps when it
 * is moved to the current form (`xyz`); undefined for any other code.
 */
export const lettersOfNamedCode = (code: string): InboxCode | undefined => {
  const letters = NAMED_CODE.exec(code)?.[1];
  return letters === undefined ? undefined : InboxCode.make(letters);
};

/**
 * The text as an Inbox's code, if it is one (any case, spaces trimmed): the
 * current form, `xyz`, or the older named one, `ab-xyz`, kept as given so a
 * lookup finds the Inbox that held it.
 */
export const parseInboxCode = (text: string): InboxCode | undefined => {
  const code = text.trim().toLowerCase();
  return CODE.test(code) || NAMED_CODE.test(code)
    ? InboxCode.make(code)
    : undefined;
};

/** A Question's code: its Inbox's code and its number, `xyz#12`. */
export const questionCode = (code: string, number: number): string =>
  `${code}#${number}`;

/**
 * How a Question is named in a line meant for the agent or the operator: its
 * code when its Inbox has one, else `#n` as before codes.
 */
export const questionRef = (
  code: string | undefined,
  number: number,
): string => (code === undefined ? `#${number}` : questionCode(code, number));

const QUESTION_CODE = /^((?:[a-z]{2}-)?[a-z]{3})#([1-9][0-9]*)$/;

/**
 * The text as a Question's code, if it is one (any case, spaces trimmed):
 * `xyz#12`, or the older `ab-xyz#12`.
 */
export const parseQuestionCode = (
  text: string,
): { readonly code: InboxCode; readonly number: number } | undefined => {
  const match = QUESTION_CODE.exec(text.trim().toLowerCase());
  if (match === null) return undefined;
  const [, code, number] = match;
  if (code === undefined || number === undefined) return undefined;
  const n = Number(number);
  return Number.isSafeInteger(n)
    ? { code: InboxCode.make(code), number: n }
    : undefined;
};

/** FNV-1a, 32 bits, over the UTF-16 code units of `text`. */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * The codes an Inbox tries when the edge draws none for it, in order, `count`
 * of them: a hash of its id and the attempt's index. The same log therefore
 * gives every such Inbox the same code wherever and however often the
 * assignment runs, a copy of the log included. A clash moves on to the next.
 */
export const derivedCodes = (
  inboxId: InboxId,
  count: number,
): ReadonlyArray<InboxCode> =>
  Array.from({ length: count }, (_, attempt) =>
    codeAt(fnv1a(`${inboxId}:${attempt}`)),
  );
