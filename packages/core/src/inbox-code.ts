import { InboxCode, type InboxId } from './schema/identifiers';

// Question codes: `ab-xyz#12`, a Question's handle the operator and an agent
// can both quote. `ab-xyz` is its Inbox's code, assigned once by
// `InboxCodeAssigned` (`inbox.ts`) and never changed, so a rename leaves it
// alone: two letters from the name the Inbox had then, a hyphen, and three
// letters drawn at random. `#12` is the Question's number in that Inbox.
//
// Pure: the three letters come in from the CLI edge, drawn there (a new
// Inbox) or derived from the Inbox's id (`derivedCodeSuffixes`, for an Inbox
// opened before codes). Nothing here draws one.
//
// BROWSER-SAFE: the page formats question codes too, so this module imports
// only core's own pure schema modules.

// The prefix of an Inbox whose name holds fewer than two ASCII letters.
export const FALLBACK_CODE_PREFIX = 'ib';

// How many three-letter suffixes one prefix has: 26³.
export const CODE_SUFFIX_COUNT = 26 ** 3;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * The two letters a new Inbox's code starts with: the first two ASCII letters
 * of its name, lower-cased, after accents are taken off (`Écrire` gives `ec`).
 * A name with fewer than two gives `FALLBACK_CODE_PREFIX`.
 */
export const inboxCodePrefix = (label: string): string => {
  const letters = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return letters.length >= 2 ? letters.slice(0, 2) : FALLBACK_CODE_PREFIX;
};

/**
 * The suffix numbered `n`, from 0 to `CODE_SUFFIX_COUNT - 1`: three
 * lower-case letters, `aaa` first. A number outside that range wraps.
 */
export const codeSuffixAt = (n: number): string => {
  const i =
    ((Math.trunc(n) % CODE_SUFFIX_COUNT) + CODE_SUFFIX_COUNT) %
    CODE_SUFFIX_COUNT;
  return [676, 26, 1]
    .map((place) => LETTERS[Math.floor(i / place) % 26])
    .join('');
};

const INBOX_CODE = /^[a-z]{2}-[a-z]{3}$/;

/** An Inbox's code from its prefix and a three-letter suffix. */
export const inboxCodeOf = (prefix: string, suffix: string): InboxCode =>
  InboxCode.make(`${prefix}-${suffix}`);

/** The text as an Inbox's code, if it is one (any case, spaces trimmed). */
export const parseInboxCode = (text: string): InboxCode | undefined => {
  const code = text.trim().toLowerCase();
  return INBOX_CODE.test(code) ? InboxCode.make(code) : undefined;
};

/** A Question's code: its Inbox's code and its number, `ab-xyz#12`. */
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

const QUESTION_CODE = /^([a-z]{2}-[a-z]{3})#([1-9][0-9]*)$/;

/** The text as a Question's code, if it is one (any case, spaces trimmed). */
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
 * The suffixes an Inbox opened before codes tries, in order, `count` of them:
 * a hash of its id and the attempt's index. The same log therefore gives
 * every such Inbox the same code wherever and however often the assignment
 * runs, a copy of the log included. A clash moves on to the next one.
 */
export const derivedCodeSuffixes = (
  inboxId: InboxId,
  count: number,
): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, attempt) =>
    codeSuffixAt(fnv1a(`${inboxId}:${attempt}`)),
  );
