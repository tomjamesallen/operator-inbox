import { Formatter, SchemaIssue } from 'effect';

// The schema-issue wording the app prints, in ONE place: a parse error becomes
// `{ path, message }` issues that say `is missing` for an absent key and
// `Expected X, actual Y` for a wrong type, the wording the wire's 400 bodies
// and the CLI's messages are pinned in, where Effect 4's default says
// `Missing key` and `Expected X, got Y`. Every other leaf keeps Effect 4's
// default message.
//
// Decode with `{ reportInput: true }` so a message can say what was there:
// Effect 4 leaves the input out of an issue unless asked, and the message is
// then `Expected X` alone.
//
// Pure Effect, no node import: `api/api.ts` (a browser-safe subpath,
// guarded by test/browser-safe.test.ts) imports it.
const leafMessage: SchemaIssue.LeafHook = (issue) => {
  switch (issue._tag) {
    case 'MissingKey':
      return 'is missing';
    case 'InvalidType': {
      const expected = SchemaIssue.defaultLeafHook(
        new SchemaIssue.InvalidType(issue.ast),
      );
      return SchemaIssue.hasInput(issue)
        ? `${expected}, actual ${Formatter.format(issue.input)}`
        : expected;
    }
    default:
      return SchemaIssue.defaultLeafHook(issue);
  }
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: leafMessage,
});

export interface SchemaIssueItem {
  /** Path segments to the offending key; empty at the root. */
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

// A Standard Schema path segment is a bare key or a `{ key }` object.
const segmentKey = (
  segment: PropertyKey | { readonly key: PropertyKey },
): PropertyKey => (typeof segment === 'object' ? segment.key : segment);

// A path as `a.b.0`, the form every message of the app prints. Takes Effect 4's
// raw Standard Schema path too, for a caller that formats with its own hook.
export const joinSchemaIssuePath = (
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>,
): string => path.map((segment) => String(segmentKey(segment))).join('.');

// One `{ path, message }` per issue, in the app's wording.
export const formatSchemaIssues = (
  issue: SchemaIssue.Issue,
): ReadonlyArray<SchemaIssueItem> =>
  formatIssues(issue).issues.map((i) => ({
    path: (i.path ?? []).map(segmentKey),
    message: i.message,
  }));

// One line per issue, `path.to.key: message` (or the message alone at the
// root).
export const schemaIssueLines = (
  issue: SchemaIssue.Issue,
): ReadonlyArray<string> =>
  formatSchemaIssues(issue).map((i) =>
    i.path.length > 0
      ? `${joinSchemaIssuePath(i.path)}: ${i.message}`
      : i.message,
  );
