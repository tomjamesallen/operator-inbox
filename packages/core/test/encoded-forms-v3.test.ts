import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import * as AST from 'effect/SchemaAST';
import {
  AnswerPayload,
  AnswerRefused,
  ArchivePayload,
  ArchiveRefused,
  AskRefused,
  HighlightRefused,
  HttpApiDecodeError,
  InboxBoardDto,
  InboxConfigUnreadable,
  InboxIndexDto,
  InboxNotFound,
  InboxUnavailable,
  KeybindingsUnreadable,
  MuteRefused,
  OpenSessionRefused,
  OperatorInboxApi,
  PinPayload,
  PinRefused,
  RenamePayload,
  RenameRefused,
} from '../src/api';
import {
  InboxEvent,
  type InboxEventTag,
  QuestionNumber,
  QuestionRevision,
} from '../src/inbox';
import { InboxCode, InboxId, SessionId } from '../src/schema';

// Golden fixtures for every inbox form core encodes or decodes, in the v3
// encoding: a clean type-check cannot see a silent change to the bytes. Each
// golden under `golden/v3/` holds the exact bytes of the literal input beside
// it here. Every build must write the same bytes and read them back to the
// same value. A golden edited to make a build pass is a defect, not a fix
// (see `golden/v3/README.md`).
//
// biome must never format `test/golden/` (its `files.includes` excludes it):
// a formatted golden is no longer the pinned bytes.

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'golden',
  'v3',
);
const golden = (name: string): string =>
  readFileSync(path.join(GOLDEN_DIR, name), 'utf8');
const expectGolden = (name: string, actual: string): void => {
  expect(actual).toBe(golden(name));
};

// --- fixed synthetic identities -------------------------------------------------

const INBOX_A = InboxId.make('01J00000000000000000000IA1');
const INBOX_B = InboxId.make('01J00000000000000000000IB1');
const SESSION = SessionId.make('00000000-0000-4000-8000-00000000c0de');
const q = QuestionNumber.make;
const rev = QuestionRevision.make;

// ================================================================================
// InboxEvent — one line of the inbox log: `Schema.fromJsonString(InboxEvent)`, the
// schema `apps/cli/src/inbox-store.ts` builds its `EventJson` from.
// ================================================================================

const EventJson = Schema.fromJsonString(InboxEvent);
const encodeEvent = Schema.encodeSync(EventJson);
const decodeEvent = Schema.decodeUnknownSync(EventJson);

const EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'InboxOpened',
    inboxId: INBOX_A,
    label: 'Example inbox',
    sessionId: SESSION,
    cwd: '/work/example',
    metadata: { topic: 'example-topic', repo: 'example-owner/example-repo' },
  },
  // Every `optionalWith({ exact: true })` key absent: none is written.
  { _tag: 'InboxOpened', inboxId: INBOX_B, label: 'Bare inbox' },
  { _tag: 'InboxAdopted', inboxId: INBOX_A, sessionId: SESSION },
  {
    _tag: 'InboxRenamed',
    inboxId: INBOX_A,
    label: 'Renamed inbox',
    previousLabel: 'Example inbox',
  },
  { _tag: 'InboxRenamed', inboxId: INBOX_B, label: 'Renamed bare inbox' },
  { _tag: 'InboxArchived', inboxId: INBOX_B },
  { _tag: 'InboxUnarchived', inboxId: INBOX_B },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(1),
    title: 'First question',
    body: 'A body with **markdown**, a "quote" and a\nsecond line.',
    metadata: { group: 'alpha' },
  },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(2),
    title: 'Second question',
    body: 'Unicode: café — ✓',
  },
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(1),
    response: 'Yes, go ahead.',
  },
  { _tag: 'AnswerProcessed', inboxId: INBOX_A, number: q(1) },
  {
    _tag: 'QuestionEdited',
    inboxId: INBOX_A,
    number: q(2),
    title: 'Second question, edited',
    body: 'Edited body.',
  },
  {
    _tag: 'QuestionWithdrawn',
    inboxId: INBOX_A,
    number: q(2),
    reason: 'No longer relevant.',
  },
  // `reason` is `{ default: () => '' }`: the empty reason is still written.
  { _tag: 'QuestionWithdrawn', inboxId: INBOX_A, number: q(3), reason: '' },
  {
    _tag: 'InboxMetadataChanged',
    inboxId: INBOX_A,
    set: { team: 'example-team' },
    unset: ['repo'],
  },
  {
    _tag: 'QuestionMetadataChanged',
    inboxId: INBOX_A,
    number: q(1),
    set: {},
    unset: [],
  },
  {
    _tag: 'QuestionHighlighted',
    inboxId: INBOX_A,
    number: q(4),
    note: 'Related to the release.',
  },
  { _tag: 'QuestionHighlighted', inboxId: INBOX_A, number: q(5) },
  {
    _tag: 'QuestionHighlightDismissed',
    inboxId: INBOX_A,
    number: q(4),
    by: 'operator',
  },
  {
    _tag: 'QuestionHighlightDismissed',
    inboxId: INBOX_A,
    number: q(5),
    by: 'agent',
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(6),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Moved question',
      body: 'Moved body.',
      revision: rev(2),
      metadata: { group: 'beta' },
      state: 'processed',
      response: 'Done.',
      withdrawn: false,
      reason: 'Carried reason.',
      highlight: {
        note: 'Carried note.',
        stamp: { seq: 40, at: '2026-01-02T03:04:05.000Z' },
      },
      askedStamp: { seq: 10, at: '2026-01-01T00:00:00.000Z' },
      answeredStamp: { seq: 20 },
      processedStamp: { seq: 30, at: '2026-01-01T02:00:00.000Z' },
    },
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(7),
    toInboxId: INBOX_B,
    toNumber: q(2),
    question: {
      title: 'Bare moved question',
      body: '',
      revision: rev(1),
      metadata: {},
      state: 'awaiting-operator',
      withdrawn: false,
      highlight: {},
    },
  },
  { _tag: 'InboxPinned', inboxId: INBOX_A },
  { _tag: 'InboxUnpinned', inboxId: INBOX_A },
  { _tag: 'GroupPinned', inboxId: INBOX_A, group: 'alpha' },
  { _tag: 'GroupUnpinned', inboxId: INBOX_A, group: 'alpha' },
];

describe('InboxEvent as stored in the log', () => {
  it('every variant encodes to the golden JSON lines', () => {
    const lines = EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-events.jsonl', lines);
  });

  it('the golden JSON lines decode to the same events', () => {
    const lines = golden('inbox-events.jsonl').split('\n').filter(Boolean);
    expect(lines.map((l) => decodeEvent(l))).toStrictEqual(EVENTS);
  });

  it('covers every tag of the union', () => {
    // A `Record` over the tag union, so tsc fails when a variant is added.
    // Inbox mode's two events and the mutes are not in the v3 encoding, so
    // they have no v3 golden. `InboxCodeAssigned` came after this golden was
    // pinned, so it has its own (`inbox-code-events.jsonl`, below) and this
    // one stays byte for byte as it was.
    const every: Record<
      Exclude<
        InboxEventTag,
        | 'InboxModeOn'
        | 'InboxModeOff'
        | 'InboxMuted'
        | 'InboxUnmuted'
        | 'InboxCodeAssigned'
      >,
      true
    > = {
      InboxOpened: true,
      InboxAdopted: true,
      InboxRenamed: true,
      InboxArchived: true,
      InboxUnarchived: true,
      QuestionAsked: true,
      QuestionAnswered: true,
      AnswerProcessed: true,
      QuestionEdited: true,
      QuestionWithdrawn: true,
      InboxMetadataChanged: true,
      QuestionMetadataChanged: true,
      QuestionHighlighted: true,
      QuestionHighlightDismissed: true,
      QuestionMoved: true,
      InboxPinned: true,
      InboxUnpinned: true,
      GroupPinned: true,
      GroupUnpinned: true,
    };
    const tags = new Set(EVENTS.map((e) => e._tag));
    expect([...tags].sort()).toStrictEqual(Object.keys(every).sort());
  });

  it('QuestionWithdrawn with no `reason` key decodes to the default ""', () => {
    // A log may hold a withdrawal with no `reason` key. Input, not a golden:
    // the encoder always writes one.
    const legacy = `{"_tag":"QuestionWithdrawn","inboxId":"${INBOX_A}","number":3}`;
    expect(decodeEvent(legacy)).toStrictEqual({
      _tag: 'QuestionWithdrawn',
      inboxId: INBOX_A,
      number: 3,
      reason: '',
    });
  });

  it('an exact optional key absent on decode stays absent (no undefined key)', () => {
    const decoded = decodeEvent(
      `{"_tag":"InboxOpened","inboxId":"${INBOX_B}","label":"Bare inbox"}`,
    );
    expect(Object.keys(decoded)).toStrictEqual(['_tag', 'inboxId', 'label']);
  });
});

// `InboxCodeAssigned`, pinned on its own so the golden above is untouched.
const CODE_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'InboxCodeAssigned',
    inboxId: INBOX_A,
    code: InboxCode.make('ex-abc'),
  },
];

describe('InboxCodeAssigned as stored in the log', () => {
  it('encodes to its golden JSON line and decodes back', () => {
    const lines = CODE_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-code-events.jsonl', lines);
    const read = golden('inbox-code-events.jsonl').split('\n').filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(CODE_EVENTS);
  });
});

// ================================================================================
// Frontmatter — what the `plan*` builders hand `serialiseFrontmatter`, the
// production write path of every `new-*` command, and what `parseFrontmatter`
// plus the entity schema read back.
// ================================================================================

// ================================================================================
// HTTP DTOs — `@operator-inbox/core/api`. The server encodes each success
// schema and sends `JSON.stringify` of it; the client decodes it.
// ================================================================================

const SUMMARY_A = {
  inboxId: INBOX_A,
  label: 'Example inbox',
  archived: false,
  pinned: true,
  awaitingOperator: 1,
  awaitingAgent: 1,
  processed: 2,
  lastActivityAt: '2026-01-02T03:04:05.000Z',
};
const SUMMARY_B = {
  inboxId: INBOX_B,
  label: 'Bare inbox',
  archived: true,
  pinned: false,
  awaitingOperator: 0,
  awaitingAgent: 0,
  processed: 0,
};

const INBOX_BOARD: InboxBoardDto = {
  inboxes: [SUMMARY_A, SUMMARY_B],
  totalAwaitingOperator: 1,
  views: [
    {
      inboxId: INBOX_A,
      label: 'Example inbox',
      metadata: { topic: 'example-topic' },
      archived: false,
      pinnedGroups: ['alpha'],
      awaitingOperator: [
        {
          number: q(3),
          revision: rev(2),
          metadata: { group: 'alpha' },
          title: 'Waiting question',
          body: 'Body with a diagram.',
          bodyHtml: '<p>Body with a diagram.</p>',
          bodyParts: [
            { kind: 'html', html: '<p>Body with a diagram.</p>' },
            { kind: 'mermaid', source: 'graph TD; A-->B' },
          ],
          askedSeq: 30,
          askedAt: '2026-01-02T03:00:00.000Z',
          highlight: { note: 'Urgent.', seq: 31 },
        },
        {
          number: q(4),
          revision: rev(1),
          metadata: {},
          title: 'Bare waiting question',
          body: '',
          bodyHtml: '',
          askedSeq: 32,
          highlight: { seq: 33 },
        },
      ],
      awaitingAgent: [
        {
          number: q(2),
          revision: rev(1),
          metadata: {},
          title: 'Answered question',
          body: 'Body.',
          bodyHtml: '<p>Body.</p>',
          response: 'An answer.',
          answeredSeq: 20,
          answeredAt: '2026-01-02T02:00:00.000Z',
          askedAt: '2026-01-02T01:00:00.000Z',
        },
      ],
      processed: [
        {
          number: q(1),
          revision: rev(1),
          metadata: {},
          title: 'Processed question',
          body: 'Body.',
          bodyHtml: '<p>Body.</p>',
          response: 'Done.',
          withdrawn: false,
          processedSeq: 12,
          processedAt: '2026-01-01T03:00:00.000Z',
          askedAt: '2026-01-01T01:00:00.000Z',
          answeredAt: '2026-01-01T02:00:00.000Z',
        },
        {
          number: q(5),
          revision: rev(1),
          metadata: {},
          title: 'Withdrawn question',
          body: 'Body.',
          bodyHtml: '<p>Body.</p>',
          withdrawn: true,
          reason: '',
          processedSeq: 13,
        },
      ],
    },
    {
      inboxId: INBOX_B,
      label: 'Bare inbox',
      metadata: {},
      archived: true,
      pinnedGroups: [],
      awaitingOperator: [],
      awaitingAgent: [],
      processed: [],
    },
  ],
};

// The same reads with an Inbox's code on its row and its view, in goldens of
// their own, so the two above stay as they were pinned.
const INBOX_BOARD_CODED: InboxBoardDto = {
  inboxes: [{ ...SUMMARY_B, code: InboxCode.make('ba-xyz') }],
  totalAwaitingOperator: 0,
  views: [
    {
      inboxId: INBOX_B,
      label: 'Bare inbox',
      code: InboxCode.make('ba-xyz'),
      metadata: {},
      archived: true,
      pinnedGroups: [],
      awaitingOperator: [],
      awaitingAgent: [],
      processed: [],
    },
  ],
};

const INBOX_INDEX: InboxIndexDto = {
  inboxes: [SUMMARY_A, SUMMARY_B],
  totalAwaitingOperator: 1,
};

// One DTO case: the golden, its schema and the literal value it holds. A
// helper rather than a tuple table so each case keeps its own schema type.
const dtoCase = <T, E>(name: string, schema: Schema.Codec<T, E>, value: T) => ({
  name,
  check: () => {
    expectGolden(name, JSON.stringify(Schema.encodeSync(schema)(value)));
    expect(
      Schema.decodeUnknownSync(schema)(JSON.parse(golden(name))),
    ).toStrictEqual(value);
  },
});

const DTOS = [
  dtoCase('dto-inbox-board.json', InboxBoardDto, INBOX_BOARD),
  dtoCase('dto-inbox-index.json', InboxIndexDto, INBOX_INDEX),
  dtoCase('dto-inbox-board-coded.json', InboxBoardDto, INBOX_BOARD_CODED),
  dtoCase('dto-payload-answer.json', AnswerPayload, {
    response: 'An answer.',
    seenRevision: rev(2),
  }),
  dtoCase('dto-payload-pin-group.json', PinPayload, {
    pinned: true,
    group: 'alpha',
  }),
  dtoCase('dto-payload-pin-inbox.json', PinPayload, { pinned: false }),
  dtoCase('dto-payload-archive.json', ArchivePayload, { archived: true }),
  dtoCase('dto-payload-rename.json', RenamePayload, { label: 'New name' }),
];

describe('HTTP DTOs', () => {
  for (const { name, check } of DTOS) {
    it(`${name}: encodes to the golden JSON and decodes back`, check);
  }
});

// One wire error: its schema and a literal instance.
const errorCase = <T extends { readonly _tag: string }, E>(
  schema: Schema.Codec<T, E>,
  value: T,
) => ({
  tag: value._tag,
  ast: schema.ast,
  encode: () => Schema.encodeSync(schema)(value),
  expectDecodes: (body: unknown) =>
    expect(Schema.decodeUnknownSync(schema)(body)).toStrictEqual(value),
});

// The errors that cross the wire: each one's encoded body, and the status
// the HttpApi reads off it.
const ERRORS = [
  errorCase(
    InboxNotFound,
    new InboxNotFound({ message: 'No Inbox has this id.' }),
  ),
  errorCase(
    AnswerRefused,
    new AnswerRefused({ message: 'Question 1 is already answered.' }),
  ),
  errorCase(
    AskRefused,
    new AskRefused({ message: 'a question cannot be empty' }),
  ),
  errorCase(
    RenameRefused,
    new RenameRefused({
      message: 'Another Inbox holds that name.',
      conflictingInboxId: INBOX_B,
    }),
  ),
  errorCase(
    HighlightRefused,
    new HighlightRefused({ message: 'Question 4 is not highlighted.' }),
  ),
  errorCase(
    PinRefused,
    new PinRefused({ message: 'The Inbox is already pinned.' }),
  ),
  errorCase(
    ArchiveRefused,
    new ArchiveRefused({ message: 'The Inbox is already archived.' }),
  ),
  errorCase(
    MuteRefused,
    new MuteRefused({ message: 'The Inbox is already muted.' }),
  ),
  errorCase(
    OpenSessionRefused,
    new OpenSessionRefused({
      message: 'the Claude app did not take the link',
    }),
  ),
  errorCase(
    InboxUnavailable,
    new InboxUnavailable({ message: 'The inbox store could not be opened.' }),
  ),
  errorCase(
    InboxConfigUnreadable,
    new InboxConfigUnreadable({
      message:
        'config.json at /c/operator-inbox/config.json is not valid JSON.',
    }),
  ),
  errorCase(
    KeybindingsUnreadable,
    new KeybindingsUnreadable({
      message: 'Could not read /c/operator-inbox/keybindings.',
    }),
  ),
];

// An error schema's name, as its encoded `_tag` literal.
const tagOf = (ast: AST.AST): string => {
  const encoded = AST.toEncoded(ast);
  if (AST.isObjects(encoded)) {
    const tag = encoded.propertySignatures.find((p) => p.name === '_tag');
    if (tag !== undefined && AST.isLiteral(tag.type))
      return String(tag.type.literal);
  }
  return AST.resolveIdentifier(ast) ?? ast._tag;
};

// The status an error schema declares, read as the HttpApi reads it: its
// `httpApiStatus` annotation, else 500.
const statusOf = (ast: AST.AST): number =>
  AST.resolveAt<number>('httpApiStatus')(ast) ?? 500;

describe('HTTP errors', () => {
  it('each error body encodes to the golden JSON and decodes back', () => {
    const bodies = Object.fromEntries(ERRORS.map((e) => [e.tag, e.encode()]));
    expectGolden('http-error-bodies.json', JSON.stringify(bodies, null, 2));
    const parsed = JSON.parse(golden('http-error-bodies.json'));
    for (const e of ERRORS) e.expectDecodes(parsed[e.tag]);
    // `conflictingInboxId` is exact-optional: absent stays absent.
    expect(
      Schema.encodeSync(RenameRefused)(new RenameRefused({ message: 'x' })),
    ).toStrictEqual({ _tag: 'RenameRefused', message: 'x' });
  });

  it('the status of every error, and of every endpoint, matches the golden', () => {
    const errors = Object.fromEntries(
      [...ERRORS.map((e) => e.ast), HttpApiDecodeError.ast]
        .map((ast) => [tagOf(ast), statusOf(ast)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const endpoints: Array<unknown> = [];
    HttpApi.reflect(OperatorInboxApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint, successes, errors: errs }) => {
        endpoints.push({
          endpoint: `${group.identifier}.${endpoint.identifier}`,
          method: endpoint.method,
          path: endpoint.path,
          successes: [...successes.keys()].sort(),
          errors: Object.fromEntries(
            [...errs.entries()]
              .sort(([a], [b]) => a - b)
              .map(([status, schemas]) => [
                status,
                schemas
                  .flatMap((s) => (AST.isUnion(s.ast) ? s.ast.types : [s.ast]))
                  .map(tagOf)
                  .sort(),
              ]),
          ),
        });
      },
    });
    expectGolden(
      'http-status.json',
      JSON.stringify({ errors, endpoints }, null, 2),
    );
  });
});
