import { Result, Schema } from 'effect';
import { DesktopSessionId, SessionId } from './schema/identifiers';

// An Inbox's and a Question's metadata, and the rules this machine holds for
// it. BROWSER-SAFE (see `api/api.ts`): the web app reads the same
// rules to decide what it shows.
//
// A value is a primitive, a list of primitives, an object of more values or a
// list of such objects. The rules are data in metadata.json, compiled into a
// Schema when they are used: `SchemaRepresentation` can store a Schema, but as
// a document nobody can write by hand, and a custom annotation ends up inside
// its checks. The rules bind what the CLI writes and never what
// the log already holds: config is per machine, and a replay must not depend
// on it.

export type MetadataPrimitive = string | number | boolean;

export interface MetadataObject {
  readonly [key: string]: MetadataValue;
}

export type MetadataValue =
  | MetadataPrimitive
  | ReadonlyArray<MetadataPrimitive>
  | MetadataObject
  | ReadonlyArray<MetadataObject>;

const Primitive = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);

export const MetadataValue: Schema.Codec<MetadataValue> = Schema.Union([
  Primitive,
  Schema.Array(Primitive),
  Schema.suspend(() => Metadata),
  Schema.Array(Schema.suspend(() => Metadata)),
]).annotate({ identifier: 'MetadataValue' });

// A metadata dictionary on an Inbox and on each Question, whose values may
// nest. An event that holds only strings, as the earliest events do, still
// decodes.
export const Metadata: Schema.Codec<MetadataObject> = Schema.Record(
  Schema.String,
  Schema.suspend(() => MetadataValue),
).annotate({ identifier: 'Metadata' });
export type Metadata = MetadataObject;

export const emptyMetadata: Metadata = {};

/** The key the web app filters a Question's group on: always a string. */
export const GROUP_KEY = 'group';

const isObject = (value: MetadataValue | undefined): value is MetadataObject =>
  typeof value === 'object' && !Array.isArray(value);

const hasKey = (metadata: Metadata, key: string) =>
  Object.hasOwn(metadata, key);

/** Whether two values say the same thing, whatever order their keys are in. */
export const metadataEquals = (a: MetadataValue, b: MetadataValue): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, i) => metadataEquals(item, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return a === b;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => {
      const other = b[key];
      const value = a[key];
      return (
        hasKey(b, key) &&
        value !== undefined &&
        other !== undefined &&
        metadataEquals(value, other)
      );
    })
  );
};

/** `over` laid on `base`: objects merge key by key, anything else replaces. */
export const mergeMetadata = (base: Metadata, over: Metadata): Metadata => {
  const next: Record<string, MetadataValue> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = next[key];
    next[key] =
      isObject(current) && isObject(value)
        ? mergeMetadata(current, value)
        : value;
  }
  return next;
};

// `path` taken out of `metadata`; a parent the removal empties goes too.
const withoutPath = (
  metadata: Metadata,
  [head, ...rest]: ReadonlyArray<string>,
): Metadata => {
  if (head === undefined || !hasKey(metadata, head)) return metadata;
  const { [head]: value, ...others } = metadata;
  if (rest.length === 0) return others;
  if (!isObject(value)) return metadata;
  const inner = withoutPath(value, rest);
  return Object.keys(inner).length === 0
    ? others
    : { ...others, [head]: inner };
};

const hasPath = (
  metadata: Metadata,
  [head, ...rest]: ReadonlyArray<string>,
): boolean => {
  if (head === undefined || !hasKey(metadata, head)) return false;
  if (rest.length === 0) return true;
  const value = metadata[head];
  return isObject(value) && hasPath(value, rest);
};

/**
 * A change as the log records it, whole top-level keys, from a change as it
 * was asked: `set` merged into what is there and `unset` paths taken out. A
 * dotted path reaches into objects, unless a key spelled that way is already
 * there: keys written before nesting keep their names.
 */
export const metadataPatch = (
  current: Metadata,
  set: Metadata,
  unset: ReadonlyArray<string>,
): Result.Result<
  { readonly set: Metadata; readonly unset: ReadonlyArray<string> },
  string
> => {
  const pathOf = (key: string) =>
    hasKey(current, key) ? [key] : key.split('.');
  const both = unset.find((key) => hasPath(set, pathOf(key)));
  if (both !== undefined)
    return Result.fail(`metadata key "${both}" cannot be both set and removed`);
  const after = unset.reduce(
    (metadata, key) => withoutPath(metadata, pathOf(key)),
    mergeMetadata(current, set),
  );
  const changedKeys = Object.keys(after).filter((key) => {
    const was = current[key];
    const now = after[key];
    return was === undefined || now === undefined || !metadataEquals(was, now);
  });
  return Result.succeed({
    set: Object.fromEntries(
      changedKeys.flatMap((key) => {
        const value = after[key];
        return value === undefined ? [] : [[key, value] as const];
      }),
    ),
    unset: Object.keys(current).filter((key) => !hasKey(after, key)),
  });
};

/** A value as one line of text: a string as it is, anything else as JSON. */
export const metadataText = (value: MetadataValue | undefined): string =>
  value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

// --- the session link ---------------------------------------------------------------

/** The key that holds the id of the session working an Inbox. */
export const SESSION_KEY = 'session';

/** The key that holds the link to the desktop session working an Inbox. */
export const SESSION_LINK_KEY = 'sessionLink';

/** The key that holds that session's title, as its sidebar shows it. */
export const SESSION_TITLE_KEY = 'sessionTitle';

// The Claude desktop app's link to one of its sessions. Undocumented,
// so this is what was measured, and nothing looser: the rule's `pattern` and the
// page's check are this one string, since a write through serve skips the rules
// and the page must not make a link of whatever an agent wrote.
export const SESSION_LINK_PATTERN =
  '^claude://claude\\.ai/epitaxy/local_[A-Za-z0-9-]{1,64}$';

export const SessionLink = Schema.String.check(
  Schema.isPattern(new RegExp(SESSION_LINK_PATTERN, 'u')),
).pipe(Schema.brand('SessionLink'));
export type SessionLink = typeof SessionLink.Type;

export const isSessionLink = Schema.is(SessionLink);

// The three keys of a desktop session's file this reads. The file holds the
// session's other settings too, and those must not reach the Inbox. `title` is
// unknown here so a bad one costs the title and not the link.
const DesktopSessionFile = Schema.fromJsonString(
  Schema.Struct({
    sessionId: DesktopSessionId,
    cliSessionId: SessionId,
    title: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeDesktopSessionFile = Schema.decodeUnknownResult(DesktopSessionFile);

/** What an Inbox learns of the desktop session working it. */
export interface WorkingSession {
  readonly link: SessionLink;
  readonly title?: string;
}

/**
 * The session in one desktop session file, when the file is `cliSessionId`'s.
 * Anything else says nothing: another session's file, one that does not decode,
 * or an id that would not make a link.
 */
export const desktopSessionOfFile = (
  content: string,
  cliSessionId: SessionId,
): WorkingSession | undefined => {
  const file = decodeDesktopSessionFile(content);
  if (Result.isFailure(file) || file.success.cliSessionId !== cliSessionId)
    return undefined;
  const link = `claude://claude.ai/epitaxy/${file.success.sessionId}`;
  if (!isSessionLink(link)) return undefined;
  const { title } = file.success;
  return typeof title === 'string' && title.trim() !== ''
    ? { link, title }
    : { link };
};

/** `metadata` with the link filled in. A value the agent passed wins. */
export const withSessionLink = (
  metadata: Metadata | undefined,
  link: SessionLink | undefined,
): Metadata | undefined =>
  link === undefined ||
  (metadata !== undefined && hasKey(metadata, SESSION_LINK_KEY))
    ? metadata
    : { ...metadata, [SESSION_LINK_KEY]: link };

/** `metadata` with the title filled in. A value the agent passed wins. */
export const withSessionTitle = (
  metadata: Metadata | undefined,
  title: string | undefined,
): Metadata | undefined =>
  title === undefined ||
  (metadata !== undefined && hasKey(metadata, SESSION_TITLE_KEY))
    ? metadata
    : { ...metadata, [SESSION_TITLE_KEY]: title };

// --- the rules --------------------------------------------------------------------

export const METADATA_KEY_TYPES = [
  'string',
  'number',
  'boolean',
  'array',
  'object',
] as const;

const PRIMITIVE_TYPES = ['string', 'number', 'boolean'] as const;

export type MetadataPresence = 'required' | 'expected' | 'optional';

export const METADATA_LEVELS = ['inbox', 'question'] as const;

export type MetadataLevel = (typeof METADATA_LEVELS)[number];

// One key: `required` refuses a write without it, `expected` warns, `optional`
// says nothing. The page lists every key alike, in the card behind `<>`, in the
// rules' order. `of` is what a list holds, and `keys` what an object holds, for
// `object` and for a list of objects. `level` says which of an Inbox
// and a Question `presence` asks it of, top-level keys only: unset is both. It
// never decides where a value may be written.
export interface MetadataKey {
  readonly key: string;
  readonly description: string;
  readonly presence: MetadataPresence;
  readonly type: (typeof METADATA_KEY_TYPES)[number];
  readonly of?: (typeof PRIMITIVE_TYPES)[number] | 'object';
  readonly keys?: ReadonlyArray<MetadataKey>;
  readonly pattern?: string;
  readonly level?: MetadataLevel;
}

export const MetadataKey: Schema.Codec<MetadataKey> = Schema.Struct({
  key: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  presence: Schema.Literals(['required', 'expected', 'optional']),
  type: Schema.Literals(METADATA_KEY_TYPES),
  of: Schema.optionalKey(Schema.Literals([...PRIMITIVE_TYPES, 'object'])),
  keys: Schema.optionalKey(Schema.Array(Schema.suspend(() => MetadataKey))),
  pattern: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Literals(METADATA_LEVELS)),
}).annotate({ identifier: 'MetadataKey' });

// The whole rule set. `extras` is what a key the list does not name gets, at
// any depth: `allow` keeps it, shown only on expansion; `refuse` refuses it.
export const InboxMetadataRules = Schema.Struct({
  keys: Schema.Array(MetadataKey),
  extras: Schema.Literals(['allow', 'refuse']),
});
export type InboxMetadataRules = typeof InboxMetadataRules.Type;

// Every session is expected to say who it is, how to reach it and what it is
// called, on every machine, so these three are not config's to set. A
// metadata.json that still lists one is overruled. The page opens the link
// from an icon beside the copy button, shows the title under the Inbox's name
// in the inbox picker and the empty state's list, and the card behind `<>`
// lists all three as text.
export const BUILT_IN_METADATA_KEYS: ReadonlyArray<MetadataKey> = [
  {
    key: SESSION_KEY,
    description: 'The Claude session id',
    presence: 'expected',
    type: 'string',
    level: 'inbox',
  },
  {
    key: SESSION_LINK_KEY,
    description:
      'The link that opens the session working this Inbox; the CLI fills it in a desktop session',
    presence: 'expected',
    type: 'string',
    pattern: SESSION_LINK_PATTERN,
    level: 'inbox',
  },
  {
    key: SESSION_TITLE_KEY,
    description:
      'The title of the desktop session working this Inbox; the CLI fills it in a desktop session',
    presence: 'expected',
    type: 'string',
    level: 'inbox',
  },
];

/** `rules` with the built-in keys in force, whatever they said of them. */
export const withBuiltInKeys = (
  rules: InboxMetadataRules,
): InboxMetadataRules => ({
  ...rules,
  keys: [
    ...rules.keys.filter(
      (rule) => !BUILT_IN_METADATA_KEYS.some((k) => k.key === rule.key),
    ),
    ...BUILT_IN_METADATA_KEYS,
  ],
});

const defaultKey = (key: string, description: string): MetadataKey => ({
  key,
  description,
  presence: 'expected',
  type: 'string',
});

// The rules in force when there is no metadata.json: the built-in keys, and
// where the work is. Any other key is an extra, and allowed: a metadata.json
// declares the keys a user's own workflow asks for.
export const DEFAULT_INBOX_METADATA: InboxMetadataRules = withBuiltInKeys({
  keys: [
    defaultKey('repo', 'The repo, as owner/repo'),
    defaultKey('branch', 'The branch'),
    defaultKey('pr', 'The pull request, as a number or URL'),
  ],
  extras: 'allow',
});

const compiles = (pattern: string) => {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
};

const keyProblems = (
  keys: ReadonlyArray<MetadataKey>,
  prefix: string,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  return keys.flatMap((key) => {
    const at = `${prefix}${key.key}`;
    const problems: Array<string> = [];
    if (seen.has(key.key)) problems.push(`${at} is listed twice`);
    seen.add(key.key);
    if (key.key.includes('.') || key.key.trim() !== key.key)
      problems.push(
        `${at} is not a key name: no dots, and no space at either end`,
      );
    if (key.type === 'array' && key.of === undefined)
      problems.push(`${at} is an array, so it needs \`of\``);
    if (key.type !== 'array' && key.of !== undefined)
      problems.push(`${at} has \`of\`, which only an array takes`);
    const holdsObjects =
      key.type === 'object' || (key.type === 'array' && key.of === 'object');
    if (holdsObjects && key.keys === undefined)
      problems.push(`${at} holds objects, so it needs \`keys\``);
    if (!holdsObjects && key.keys !== undefined)
      problems.push(`${at} has \`keys\`, which only objects take`);
    if (key.pattern !== undefined) {
      if (key.type !== 'string')
        problems.push(`${at} has \`pattern\`, which only a string takes`);
      else if (!compiles(key.pattern))
        problems.push(
          `${at} has a \`pattern\` that is not a regular expression`,
        );
    }
    if (prefix !== '' && key.level !== undefined)
      problems.push(`${at} has \`level\`, which only a top-level key takes`);
    if (prefix === '' && key.key === GROUP_KEY && key.type !== 'string')
      problems.push(`${at} is the page's group filter, so it must be a string`);
    return key.keys === undefined
      ? problems
      : [...problems, ...keyProblems(key.keys, `${at}.`)];
  });
};

/** What is wrong with rules that decode: each problem names its key. */
export const metadataRulesProblems = (
  rules: InboxMetadataRules,
): ReadonlyArray<string> => keyProblems(rules.keys, '');

const primitiveSchema = (type: (typeof PRIMITIVE_TYPES)[number]) => {
  switch (type) {
    case 'string':
      return Schema.String;
    case 'number':
      return Schema.Finite;
    case 'boolean':
      return Schema.Boolean;
  }
};

const valueSchema = (
  key: MetadataKey,
  extras: InboxMetadataRules['extras'],
): Schema.Top => {
  const keys = key.keys ?? [];
  switch (key.type) {
    case 'string':
      return key.pattern === undefined
        ? Schema.String
        : Schema.String.check(Schema.isPattern(new RegExp(key.pattern, 'u')));
    case 'number':
    case 'boolean':
      return primitiveSchema(key.type);
    case 'object':
      return objectSchema(keys, extras);
    case 'array':
      return key.of === undefined || key.of === 'object'
        ? Schema.Array(objectSchema(keys, extras))
        : Schema.Array(primitiveSchema(key.of));
  }
};

// Every key is optional here: presence is `missingMetadata`'s, because a change
// to one key of an older Inbox must not fail on a key it never had.
const objectSchema = (
  keys: ReadonlyArray<MetadataKey>,
  extras: InboxMetadataRules['extras'],
): Schema.Top => {
  const struct = Schema.Struct(
    Object.fromEntries(
      keys.map((key) => [
        key.key,
        Schema.optionalKey(valueSchema(key, extras)),
      ]),
    ),
  );
  return extras === 'allow'
    ? Schema.StructWithRest(struct, [
        Schema.Record(Schema.String, MetadataValue),
      ])
    : struct;
};

/**
 * The Schema these rules compile to, and what it says of `metadata`: undefined
 * when it fits, otherwise the sentence naming each value that does not.
 */
export const metadataValueProblem = (
  rules: InboxMetadataRules,
  metadata: Metadata,
): string | undefined => {
  const decoded = Schema.decodeUnknownResult(
    objectSchema(rules.keys, rules.extras) as Schema.Codec<unknown>,
    { errors: 'all', onExcessProperty: 'error' },
  )(metadata);
  return Result.isFailure(decoded) ? decoded.failure.message : undefined;
};

const isBlank = (value: MetadataValue | undefined) =>
  value === undefined ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/** The keys `presence` counts at one level: `level` left unset is both. */
export const keysAtLevel = (
  keys: ReadonlyArray<MetadataKey>,
  level: MetadataLevel,
): ReadonlyArray<MetadataKey> =>
  keys.filter((key) => key.level === undefined || key.level === level);

/**
 * The keys of one presence that `metadata` lacks, in the rules' order, each
 * once, as paths: `model.chapter`, or `links[].url` for a key of a list's
 * objects. A nested key counts only where its parent is there, and a blank
 * value says nothing, so it counts as not set.
 */
export const missingMetadata = (
  keys: ReadonlyArray<MetadataKey>,
  metadata: Metadata,
  presence: MetadataPresence,
  prefix = '',
): ReadonlyArray<string> => [
  ...new Set(
    keys.flatMap((key) => {
      const path = `${prefix}${key.key}`;
      const value = hasKey(metadata, key.key) ? metadata[key.key] : undefined;
      if (isBlank(value)) return key.presence === presence ? [path] : [];
      if (key.keys === undefined) return [];
      const inner = key.keys;
      if (isObject(value))
        return missingMetadata(inner, value, presence, `${path}.`);
      return Array.isArray(value)
        ? value.flatMap((item: MetadataValue) =>
            isObject(item)
              ? missingMetadata(inner, item, presence, `${path}[].`)
              : [],
          )
        : [];
    }),
  ),
];

// --- from the command line --------------------------------------------------------

const declaredAt = (
  keys: ReadonlyArray<MetadataKey>,
  [head, ...rest]: ReadonlyArray<string>,
): MetadataKey | undefined => {
  const key = keys.find((k) => k.key === head);
  if (key === undefined || rest.length === 0) return key;
  return declaredAt(key.keys ?? [], rest);
};

const coercedPrimitive = (
  type: (typeof PRIMITIVE_TYPES)[number],
  text: string,
): MetadataPrimitive => {
  if (type === 'number' && text.trim() !== '' && Number.isFinite(Number(text)))
    return Number(text);
  if (type === 'boolean' && (text === 'true' || text === 'false'))
    return text === 'true';
  return text;
};

// Text as the rules type it. Text that cannot be that type stays text, for the
// compiled Schema to refuse in a sentence naming the key.
const coerced = (key: MetadataKey | undefined, text: string): MetadataValue => {
  if (key === undefined) return text;
  switch (key.type) {
    case 'number':
    case 'boolean':
      return coercedPrimitive(key.type, text);
    case 'array':
      return key.of === undefined || key.of === 'object'
        ? text
        : [coercedPrimitive(key.of, text)];
    default:
      return text;
  }
};

const nested = (
  [head, ...rest]: ReadonlyArray<string>,
  value: MetadataValue,
): Metadata => ({
  [head ?? '']: rest.length === 0 ? value : nested(rest, value),
});

const decodeValue = Schema.decodeUnknownResult(MetadataValue);

/**
 * `--meta path=text` and `--meta-json path=json` as one dictionary. A dot
 * reaches into an object, and the rules give text its type; a path the rules do
 * not name stays text. `rules` left out, every value stays text.
 */
export const metadataFromFlags = (
  text: Readonly<Record<string, string>>,
  json: Readonly<Record<string, string>>,
  rules?: InboxMetadataRules,
): Result.Result<Metadata, string> => {
  let out: Metadata = emptyMetadata;
  const paths = [...Object.keys(text), ...Object.keys(json)];
  for (const path of paths) {
    const steps = path.split('.').map((step) => step.trim());
    if (steps.some((step) => step === ''))
      return Result.fail(`metadata path "${path}" has an empty step`);
    const clash = paths.find((other) => other.startsWith(`${path}.`));
    if (clash !== undefined)
      return Result.fail(`metadata paths "${path}" and "${clash}" overlap`);
    let value: MetadataValue;
    const given = json[path];
    if (given !== undefined && Object.hasOwn(json, path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(given);
      } catch {
        return Result.fail(`--meta-json ${path} is not valid JSON`);
      }
      const decoded = decodeValue(parsed);
      if (Result.isFailure(decoded))
        return Result.fail(
          `--meta-json ${path} is not a metadata value: strings, numbers, booleans, lists and objects only`,
        );
      value = decoded.success;
    } else {
      value = coerced(declaredAt(rules?.keys ?? [], steps), text[path] ?? '');
    }
    out = mergeMetadata(out, nested(steps, value));
  }
  return Result.succeed(out);
};
