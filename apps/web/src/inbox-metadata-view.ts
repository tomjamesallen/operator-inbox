import {
  GROUP_KEY,
  type InboxMetadataRules,
  type Metadata,
  type MetadataObject,
  type MetadataValue,
  metadataEquals,
} from '@operator-inbox/core/api';

// What the metadata card lists of an Inbox's or a Question's metadata, as pure
// data: the keys the rules name (`GET /api/inbox-config`) in their
// order, then any others by name.

export interface MetaPair {
  readonly key: string;
  readonly value: MetadataValue;
}

const isObject = (value: MetadataValue): value is MetadataObject =>
  typeof value === 'object' && !Array.isArray(value);

const WEB_ADDRESS = /^https?:\/\/\S+$/;

const isWebAddress = (value: MetadataValue | undefined): value is string =>
  typeof value === 'string' && WEB_ADDRESS.test(value);

/** One level's metadata, listed. `group` is left out: the eyebrow says it. */
export const metaPairsOf = (
  rules: Pick<InboxMetadataRules, 'keys'>,
  metadata: Metadata,
): ReadonlyArray<MetaPair> => {
  const ruled = rules.keys.map((rule) => rule.key as string);
  const extras = Object.keys(metadata)
    .filter((key) => !ruled.includes(key))
    .sort();
  return [...ruled, ...extras].flatMap((key) => {
    const value = metadata[key];
    return value === undefined || key === GROUP_KEY ? [] : [{ key, value }];
  });
};

/** A Question's own metadata: what it adds to its Inbox's or changes. */
export const questionOnlyOf = (
  question: Metadata,
  inbox: Metadata,
): Metadata => {
  const own: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(question)) {
    const there = inbox[key];
    if (there === undefined || !metadataEquals(there, value)) own[key] = value;
  }
  return own;
};

// --- a value, to draw -----------------------------------------------------------

export type MetaNode =
  | { readonly _tag: 'Text'; readonly text: string }
  | { readonly _tag: 'Link'; readonly text: string; readonly href: string }
  | { readonly _tag: 'List'; readonly items: ReadonlyArray<MetaNode> }
  | {
      readonly _tag: 'Fields';
      readonly fields: ReadonlyArray<{
        readonly key: string;
        readonly node: MetaNode;
      }>;
    };

const fieldsOf = (
  entries: ReadonlyArray<[string, MetadataValue]>,
): MetaNode => ({
  _tag: 'Fields',
  fields: entries.map(([key, inner]) => ({ key, node: metaNodeOf(inner) })),
});

/**
 * How a value draws, at any depth: a web address is a link, an object with a
 * `url` is a link under its `title` followed by whatever else it holds, an
 * object is its keys and values (`model  chapter C02`), and a list is its items.
 * Only a web address links, so an agent's value never becomes a `javascript:`
 * link.
 */
export function metaNodeOf(value: MetadataValue): MetaNode {
  if (Array.isArray(value))
    return {
      _tag: 'List',
      items: (value as ReadonlyArray<MetadataValue>).map((item) =>
        metaNodeOf(item),
      ),
    };
  if (isObject(value)) {
    const { url, title } = value;
    if (!isWebAddress(url)) return fieldsOf(Object.entries(value));
    const titled = typeof title === 'string';
    const link: MetaNode = {
      _tag: 'Link',
      href: url,
      text: titled ? title : url,
    };
    const rest = Object.entries(value).filter(
      ([key]) => key !== 'url' && !(titled && key === 'title'),
    );
    return rest.length === 0
      ? link
      : { _tag: 'List', items: [link, fieldsOf(rest)] };
  }
  return isWebAddress(value)
    ? { _tag: 'Link', href: value, text: value }
    : { _tag: 'Text', text: String(value) };
}
