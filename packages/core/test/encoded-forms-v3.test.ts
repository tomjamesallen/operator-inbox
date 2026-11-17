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
  AskPayload,
  AskRefused,
  GroupArchivePayload,
  HighlightRefused,
  HttpApiDecodeError,
  InboxBoardDto,
  InboxConfigUnreadable,
  InboxIndexDto,
  InboxNotFound,
  InboxUnavailable,
  KeybindingsUnreadable,
  MacrosUnreadable,
  MuteRefused,
  OpenSessionRefused,
  OperatorInboxApi,
  PinPayload,
  PinRefused,
  PriorityPayload,
  PriorityRefused,
  RenamePayload,
  RenameRefused,
} from '../src/api';
import {
  InboxEvent,
  type InboxEventTag,
  MovedQuestion,
  QuestionAnswered,
  QuestionAsked,
  QuestionEdited,
  QuestionMoved,
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
    // they have no v3 golden. `InboxCodeAssigned` and `InboxCodeChanged` came
    // after this golden was pinned, so they have their own
    // (`inbox-code-events.jsonl` and `inbox-code-change-events.jsonl`, below)
    // and this one stays byte for byte as it was; so do `GroupArchived` and
    // `GroupUnarchived` (`inbox-group-archive-events.jsonl`), and the priority
    // marks (`inbox-priority-events.jsonl`).
    const every: Record<
      Exclude<
        InboxEventTag,
        | 'InboxModeOn'
        | 'InboxModeOff'
        | 'InboxMuted'
        | 'InboxUnmuted'
        | 'InboxCodeAssigned'
        | 'InboxCodeChanged'
        | 'GroupArchived'
        | 'GroupUnarchived'
        | 'InboxPriorityMarked'
        | 'InboxPriorityCleared'
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

// `InboxCodeChanged`, which came after `InboxCodeAssigned` was pinned, so it
// has its own golden and that one stays as it was. The current form of an
// assignment (three letters) is pinned beside it.
const CODE_CHANGE_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'InboxCodeChanged',
    inboxId: INBOX_A,
    from: InboxCode.make('ex-abc'),
    code: InboxCode.make('abc'),
  },
  {
    _tag: 'InboxCodeAssigned',
    inboxId: INBOX_B,
    code: InboxCode.make('xyz'),
  },
];

describe('InboxCodeChanged as stored in the log', () => {
  it('encodes to its golden JSON line and decodes back', () => {
    const lines = CODE_CHANGE_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-code-change-events.jsonl', lines);
    const read = golden('inbox-code-change-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(CODE_CHANGE_EVENTS);
  });
});

// `highlightReply`, which came after the goldens above were pinned, so it has
// its own and they stay as they were: on an answer, on an operator's question,
// and carried by a move.
const HIGHLIGHT_REPLY_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(1),
    response: 'Yes, go ahead.',
    highlightReply: true,
  },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(2),
    title: 'Can you check X?',
    body: 'Can you check X?',
    operatorQuestion: true,
    highlightReply: true,
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(1),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Moved question',
      body: '',
      revision: rev(1),
      metadata: {},
      state: 'awaiting-agent',
      response: 'Yes, go ahead.',
      withdrawn: false,
      highlightReply: true,
    },
  },
];

describe('highlightReply as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = HIGHLIGHT_REPLY_EVENTS.map((e) => `${encodeEvent(e)}\n`).join(
      '',
    );
    expectGolden('inbox-highlight-reply-events.jsonl', lines);
    const read = golden('inbox-highlight-reply-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(
      HIGHLIGHT_REPLY_EVENTS,
    );
  });

  it('reads an answer logged before it with no flag', () => {
    const decoded = decodeEvent(
      `{"_tag":"QuestionAnswered","inboxId":"${INBOX_A}","number":1,"response":"Yes"}`,
    );
    expect(decoded).not.toHaveProperty('highlightReply');
  });
});

// Drawings: on an ask, an edit, an answer and a move, which came after the
// event goldens above were pinned and so have their own file.
const SCENE =
  '{"type":"excalidraw","version":2,"elements":[{"type":"rectangle","id":"a","x":0,"y":0,"width":100,"height":50}]}';
const EDITED_SCENE =
  '{"type":"excalidraw","version":2,"elements":[{"type":"rectangle","id":"a","x":40,"y":0,"width":100,"height":50,"version":3}]}';

const DRAWING_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(1),
    title: 'Is this the layout?',
    body: 'Move the box.\n\n<Excalidraw id="layout"/>\n',
    drawings: { layout: SCENE },
  },
  {
    _tag: 'QuestionEdited',
    inboxId: INBOX_A,
    number: q(1),
    title: 'Is this the layout?',
    body: 'Move the box.\n\n<Excalidraw id="layout"/>\n',
    drawings: { layout: EDITED_SCENE },
  },
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(1),
    response: 'Moved it.',
    drawings: { layout: EDITED_SCENE },
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(1),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Is this the layout?',
      body: '<Excalidraw id="layout"/>',
      revision: rev(2),
      metadata: {},
      state: 'awaiting-agent',
      response: 'Moved it.',
      withdrawn: false,
      drawings: { layout: { scene: SCENE, revision: 2 } },
      sentDrawings: { layout: EDITED_SCENE },
    },
  },
];

describe('drawings as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = DRAWING_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-drawing-events.jsonl', lines);
    const read = golden('inbox-drawing-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(DRAWING_EVENTS);
  });

  it('reads an ask, an edit and an answer logged before drawings with none', () => {
    for (const line of [
      `{"_tag":"QuestionAsked","inboxId":"${INBOX_A}","number":1,"title":"T","body":"B"}`,
      `{"_tag":"QuestionEdited","inboxId":"${INBOX_A}","number":1,"title":"T","body":"B2"}`,
      `{"_tag":"QuestionAnswered","inboxId":"${INBOX_A}","number":1,"response":"Yes"}`,
    ])
      expect(decodeEvent(line)).not.toHaveProperty('drawings');
  });
});

// HTML blocks: on an ask, an edit and a move, each a document's hash and
// size, never the document, which is a blob row. They came after the event
// goldens above were pinned and so have their own file.
const CHART_SHA =
  '9f2c3b1e6a7d4c5b8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f';
const SCENE_SHA =
  '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

const HTML_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(1),
    title: 'Which curve?',
    body: 'The two runs.\n\n<Html id="chart" width="wide"/>\n',
    htmls: { chart: { sha: CHART_SHA, bytes: 4096 } },
  },
  {
    _tag: 'QuestionEdited',
    inboxId: INBOX_A,
    number: q(1),
    title: 'Which curve?',
    body: '<Html id="chart"/>\n\n<Html id="scene" width="full"/>\n',
    htmls: {
      chart: { sha: CHART_SHA, bytes: 4096 },
      scene: { sha: SCENE_SHA, bytes: 20480 },
    },
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(1),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Which curve?',
      body: '<Html id="chart"/>',
      revision: rev(2),
      metadata: {},
      state: 'awaiting-operator',
      withdrawn: false,
      htmls: { chart: { sha: CHART_SHA, bytes: 4096 } },
    },
  },
];

describe('HTML blocks as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = HTML_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-html-events.jsonl', lines);
    const read = golden('inbox-html-events.jsonl').split('\n').filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(HTML_EVENTS);
  });

  it('reads an ask and an edit logged before HTML blocks with none', () => {
    for (const line of [
      `{"_tag":"QuestionAsked","inboxId":"${INBOX_A}","number":1,"title":"T","body":"B"}`,
      `{"_tag":"QuestionEdited","inboxId":"${INBOX_A}","number":1,"title":"T","body":"B2"}`,
    ])
      expect(decodeEvent(line)).not.toHaveProperty('htmls');
  });
});

// Drawings as blobs: on an ask, an edit (only the drawing it set) and an
// answer, each a scene's hash and size under `drawingRefs`, never the scene,
// which is a blob row; and a move carrying a drawing logged as text beside
// one logged as a blob. They came after the drawing golden above was pinned,
// which still reads as it did, and so have their own file.
const LAYOUT_SHA =
  '4e1d7c0b9a8f6e5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2918f7e6d5c';
const EDITED_SHA =
  'c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4';
const FLOW_SHA =
  '17283940a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';

const DRAWING_REF_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(1),
    title: 'Is this the layout?',
    body: 'The boxes.\n\n<Excalidraw id="layout"/>\n',
    drawingRefs: { layout: { sha: LAYOUT_SHA, bytes: 812 } },
  },
  {
    _tag: 'QuestionEdited',
    inboxId: INBOX_A,
    number: q(1),
    title: 'Is this the layout?',
    body: '<Excalidraw id="layout"/>\n\n<Excalidraw id="flow"/>\n',
    drawingRefs: { flow: { sha: FLOW_SHA, bytes: 1024 } },
  },
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(1),
    response: 'Moved it.',
    drawingRefs: { layout: { sha: EDITED_SHA, bytes: 830 } },
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(1),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Is this the layout?',
      body: '<Excalidraw id="layout"/>\n\n<Excalidraw id="flow"/>',
      revision: rev(2),
      metadata: {},
      state: 'awaiting-agent',
      response: 'Moved it.',
      withdrawn: false,
      drawings: { layout: { scene: SCENE, revision: 1 } },
      drawingRefs: { flow: { sha: FLOW_SHA, bytes: 1024, revision: 2 } },
      sentDrawingRefs: { layout: { sha: EDITED_SHA, bytes: 830 } },
    },
  },
];

describe('drawings as blobs in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = DRAWING_REF_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-drawing-ref-events.jsonl', lines);
    const read = golden('inbox-drawing-ref-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(DRAWING_REF_EVENTS);
  });

  it('carries no scene text on an event', () => {
    for (const line of golden('inbox-drawing-ref-events.jsonl')
      .split('\n')
      .filter((l) => l.length > 0 && !l.includes('QuestionMoved')))
      expect(line).not.toContain('"elements"');
  });

  // The schemas of a build from before `drawingRefs`: these events with
  // that key, and a moved Question's two, taken out, and nothing else
  // changed, as Effect Schema reads a struct by default (an unknown key is
  // dropped, never refused).
  const without = <F extends Record<string, unknown>, K extends string>(
    fields: F,
    ...keys: ReadonlyArray<K>
  ): Omit<F, K> =>
    Object.fromEntries(
      Object.entries(fields).filter(([k]) => !keys.includes(k as K)),
    ) as Omit<F, K>;
  const { _tag: _a, ...askedFields } = QuestionAsked.fields;
  const { _tag: _e, ...editedFields } = QuestionEdited.fields;
  const { _tag: _n, ...answeredFields } = QuestionAnswered.fields;
  const { _tag: _m, ...movedFields } = QuestionMoved.fields;
  const OlderEvent = Schema.fromJsonString(
    Schema.Union([
      Schema.TaggedStruct('QuestionAsked', without(askedFields, 'drawingRefs')),
      Schema.TaggedStruct(
        'QuestionEdited',
        without(editedFields, 'drawingRefs'),
      ),
      Schema.TaggedStruct(
        'QuestionAnswered',
        without(answeredFields, 'drawingRefs'),
      ),
      Schema.TaggedStruct('QuestionMoved', {
        ...movedFields,
        question: Schema.Struct(
          without(MovedQuestion.fields, 'drawingRefs', 'sentDrawingRefs'),
        ),
      }),
    ]),
  );

  it('an older build reads every new line, dropping the refs, never failing', () => {
    const lines = golden('inbox-drawing-ref-events.jsonl')
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      const read = Schema.decodeUnknownSync(OlderEvent)(line);
      expect(read).not.toHaveProperty('drawingRefs');
      if (read._tag === 'QuestionMoved') {
        expect(read.question).not.toHaveProperty('drawingRefs');
        expect(read.question).not.toHaveProperty('sentDrawingRefs');
        // The drawing logged as text still moves with it.
        expect(read.question.drawings).toStrictEqual({
          layout: { scene: SCENE, revision: 1 },
        });
      }
    }
    // The probe can fail: refs under the old `drawings` key would break
    // such a build's read of the whole log.
    const first = lines[0] ?? '';
    expect(() =>
      Schema.decodeUnknownSync(OlderEvent)(
        first.replace('"drawingRefs"', '"drawings"'),
      ),
    ).toThrow();
  });

  it('reads the older inline drawings as they were logged', () => {
    const read = golden('inbox-drawing-events.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((l) => decodeEvent(l));
    for (const e of read) expect(e).not.toHaveProperty('drawingRefs');
  });
});

// Attachments: the files the operator attached, each where it is kept on
// disk, on an answer that is files alone, on an operator's question, and
// carried by a move. They came after the event goldens above were pinned,
// and so have their own file. The bytes are never on an event.
const SHOT = {
  path: '/state/operator-inbox/attachments/01J00000000000000000000IA1/0123456789abcdef/screenshot.png',
  name: 'screenshot.png',
  type: 'image/png',
  bytes: 41_234,
};
const LOG = {
  path: '/state/operator-inbox/attachments/01J00000000000000000000IA1/fedcba9876543210/build.log',
  name: 'build.log',
  type: 'text/plain',
  bytes: 812,
};

const ATTACHMENT_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(1),
    response: '',
    attachments: [SHOT, LOG],
  },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(2),
    title: 'Why does this fail?',
    body: 'Why does this fail?',
    operatorQuestion: true,
    attachments: [LOG],
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(1),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Which one?',
      body: 'Pick one.',
      revision: rev(1),
      metadata: {},
      state: 'awaiting-agent',
      response: '',
      withdrawn: false,
      attachments: [SHOT],
    },
  },
];

describe('attachments in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = ATTACHMENT_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-attachment-events.jsonl', lines);
    const read = golden('inbox-attachment-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(ATTACHMENT_EVENTS);
  });

  it('reads every event logged before attachments with none', () => {
    for (const name of ['inbox-events.jsonl', 'inbox-macro-events.jsonl'])
      for (const line of golden(name).split('\n').filter(Boolean))
        expect(decodeEvent(line)).not.toHaveProperty('attachments');
  });

  // The schemas of a build from before `attachments`: these events with the
  // key taken out, and nothing else changed, as Effect Schema reads a struct
  // by default (an unknown key is dropped, never refused).
  const { _tag: _a, attachments: _aa, ...askedFields } = QuestionAsked.fields;
  const {
    _tag: _n,
    attachments: _na,
    ...answeredFields
  } = QuestionAnswered.fields;
  const { _tag: _m, ...movedFields } = QuestionMoved.fields;
  const { attachments: _ma, ...movedQuestionFields } = MovedQuestion.fields;
  const OlderEvent = Schema.fromJsonString(
    Schema.Union([
      Schema.TaggedStruct('QuestionAsked', askedFields),
      Schema.TaggedStruct('QuestionAnswered', answeredFields),
      Schema.TaggedStruct('QuestionMoved', {
        ...movedFields,
        question: Schema.Struct(movedQuestionFields),
      }),
    ]),
  );

  it('an older build reads every new line, dropping the files, never failing', () => {
    for (const line of golden('inbox-attachment-events.jsonl')
      .split('\n')
      .filter(Boolean)) {
      const read = Schema.decodeUnknownSync(OlderEvent)(line);
      expect(read).not.toHaveProperty('attachments');
      if (read._tag === 'QuestionMoved')
        expect(read.question).not.toHaveProperty('attachments');
    }
  });
});

// The agent's own files: on its `QuestionAsked`, on a `QuestionEdited` (the
// whole new set), and carried by a move as `askedAttachments`. They came
// after `inbox-attachment-events.jsonl` was pinned, and so have their own
// file.
const AGENT_ATTACHMENT_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(3),
    title: 'Does this look right?',
    body: '![the page](attachment:screenshot.png)',
    attachments: [SHOT],
  },
  {
    _tag: 'QuestionEdited',
    inboxId: INBOX_A,
    number: q(3),
    title: 'Does this look right?',
    body: '![the page](attachment:screenshot.png)',
    attachments: [SHOT, LOG],
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(3),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Does this look right?',
      body: '![the page](attachment:screenshot.png)',
      revision: rev(2),
      metadata: {},
      state: 'awaiting-operator',
      withdrawn: false,
      askedAttachments: [SHOT, LOG],
    },
  },
];

describe("the agent's files in the log", () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = AGENT_ATTACHMENT_EVENTS.map(
      (e) => `${encodeEvent(e)}\n`,
    ).join('');
    expectGolden('inbox-agent-attachment-events.jsonl', lines);
    const read = golden('inbox-agent-attachment-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(
      AGENT_ATTACHMENT_EVENTS,
    );
  });

  it('reads every edit and move logged before them with none', () => {
    for (const name of [
      'inbox-events.jsonl',
      'inbox-attachment-events.jsonl',
      'inbox-html-events.jsonl',
    ])
      for (const line of golden(name).split('\n').filter(Boolean)) {
        const read = decodeEvent(line);
        if (read._tag === 'QuestionEdited')
          expect(read).not.toHaveProperty('attachments');
        if (read._tag === 'QuestionMoved')
          expect(read.question).not.toHaveProperty('askedAttachments');
      }
  });

  // The schemas of a build from before them: these events with the keys
  // taken out, as Effect Schema reads a struct by default.
  const { _tag: _a, attachments: _aa, ...askedFields } = QuestionAsked.fields;
  const { _tag: _e, attachments: _ea, ...editedFields } = QuestionEdited.fields;
  const { _tag: _m, ...movedFields } = QuestionMoved.fields;
  const {
    attachments: _ma,
    askedAttachments: _mb,
    ...movedQuestionFields
  } = MovedQuestion.fields;
  const OlderEvent = Schema.fromJsonString(
    Schema.Union([
      Schema.TaggedStruct('QuestionAsked', askedFields),
      Schema.TaggedStruct('QuestionEdited', editedFields),
      Schema.TaggedStruct('QuestionMoved', {
        ...movedFields,
        question: Schema.Struct(movedQuestionFields),
      }),
    ]),
  );

  it('an older build reads every new line, dropping the files, never failing', () => {
    for (const line of golden('inbox-agent-attachment-events.jsonl')
      .split('\n')
      .filter(Boolean)) {
      const read = Schema.decodeUnknownSync(OlderEvent)(line);
      expect(read).not.toHaveProperty('attachments');
      if (read._tag === 'QuestionMoved')
        expect(read.question).not.toHaveProperty('askedAttachments');
    }
  });
});

// Macros: on an answer, on a deferral with no note, and carried by a move,
// which came after the event goldens above were pinned and so have their own
// file.
const AGENDA = {
  macro: 'agenda',
  instruction:
    'Add the item to the named person’s agenda. Do not message them.',
  args: { person: 'Mira', item: 'Confirm the opening date' },
};
const LABEL = {
  macro: 'label',
  instruction: 'Apply these labels to the work this question belongs to.',
  args: { labels: ['blocked', 'quick-win'], note: null, weight: 2 },
};
const PARK = {
  macro: 'park',
  instruction: 'Stop work on this thread until the operator asks.',
  args: {},
};

const MACRO_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(1),
    response: 'Go ahead with the rota first.',
    macros: [AGENDA, LABEL],
  },
  {
    _tag: 'QuestionAnswered',
    inboxId: INBOX_A,
    number: q(2),
    response: '',
    deferred: true,
    macros: [PARK],
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(1),
    toInboxId: INBOX_B,
    toNumber: q(1),
    question: {
      title: 'Moved question',
      body: '',
      revision: rev(1),
      metadata: {},
      state: 'awaiting-agent',
      response: 'Go ahead with the rota first.',
      withdrawn: false,
      macros: [AGENDA],
    },
  },
];

describe('macros as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = MACRO_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-macro-events.jsonl', lines);
    const read = golden('inbox-macro-events.jsonl').split('\n').filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(MACRO_EVENTS);
  });

  it('reads an answer logged before macros with none', () => {
    const decoded = decodeEvent(
      `{"_tag":"QuestionAnswered","inboxId":"${INBOX_A}","number":1,"response":"Yes"}`,
    );
    expect(decoded).not.toHaveProperty('macros');
  });
});

// Macros on an operator's own question: with its text, and alone (an empty
// body, titled by its macros), and carried by a move, which came after
// `inbox-macro-events.jsonl` was pinned and so have their own file.
const ASK_MACRO_EVENTS: ReadonlyArray<InboxEvent> = [
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(3),
    title: 'Can you check the rota?',
    body: 'Can you check the rota?',
    operatorQuestion: true,
    macros: [AGENDA, LABEL],
  },
  {
    _tag: 'QuestionAsked',
    inboxId: INBOX_A,
    number: q(4),
    title: '/park',
    body: '',
    operatorQuestion: true,
    macros: [PARK],
  },
  {
    _tag: 'QuestionMoved',
    inboxId: INBOX_A,
    number: q(4),
    toInboxId: INBOX_B,
    toNumber: q(2),
    question: {
      title: '/park',
      body: '',
      revision: rev(1),
      metadata: {},
      state: 'awaiting-agent',
      response: '',
      withdrawn: false,
      operatorQuestion: true,
      macros: [PARK],
    },
  },
];

describe('macros on an operator’s question as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = ASK_MACRO_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-ask-macro-events.jsonl', lines);
    const read = golden('inbox-ask-macro-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(ASK_MACRO_EVENTS);
  });

  it('reads an operator’s question logged before macros with none', () => {
    const decoded = decodeEvent(
      `{"_tag":"QuestionAsked","inboxId":"${INBOX_A}","number":3,"title":"Why?","body":"Why?","operatorQuestion":true}`,
    );
    expect(decoded).not.toHaveProperty('macros');
  });
});

// Group archives, which came after the event goldens above were pinned and so
// have their own file.
const GROUP_ARCHIVE_EVENTS: ReadonlyArray<InboxEvent> = [
  { _tag: 'GroupArchived', inboxId: INBOX_A, group: 'alpha' },
  { _tag: 'GroupUnarchived', inboxId: INBOX_A, group: 'alpha' },
];

describe('group archives as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = GROUP_ARCHIVE_EVENTS.map((e) => `${encodeEvent(e)}\n`).join(
      '',
    );
    expectGolden('inbox-group-archive-events.jsonl', lines);
    const read = golden('inbox-group-archive-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(GROUP_ARCHIVE_EVENTS);
  });
});

// The priority marks, which came after the event goldens above were pinned
// and so have their own file: a mark, a mark replacing it (the holder's
// clearing first, as one append writes them), and a clearing.
const PRIORITY_EVENTS: ReadonlyArray<InboxEvent> = [
  { _tag: 'InboxPriorityMarked', inboxId: INBOX_A },
  { _tag: 'InboxPriorityCleared', inboxId: INBOX_A },
  { _tag: 'InboxPriorityMarked', inboxId: INBOX_B },
  { _tag: 'InboxPriorityCleared', inboxId: INBOX_B },
];

describe('priority marks as stored in the log', () => {
  it('encodes to its golden JSON lines and decodes back', () => {
    const lines = PRIORITY_EVENTS.map((e) => `${encodeEvent(e)}\n`).join('');
    expectGolden('inbox-priority-events.jsonl', lines);
    const read = golden('inbox-priority-events.jsonl')
      .split('\n')
      .filter(Boolean);
    expect(read.map((l) => decodeEvent(l))).toStrictEqual(PRIORITY_EVENTS);
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

// The board read with a view's archived groups, in a golden of its own, so the
// ones above stay as they were pinned.
const INBOX_BOARD_ARCHIVED_GROUPS: InboxBoardDto = {
  inboxes: [SUMMARY_B],
  totalAwaitingOperator: 0,
  views: [
    {
      inboxId: INBOX_B,
      label: 'Bare inbox',
      metadata: {},
      archived: true,
      pinnedGroups: [],
      archivedGroups: ['alpha', 'beta'],
      awaitingOperator: [],
      awaitingAgent: [],
      processed: [],
    },
  ],
};

// The board read with the priority Inbox on its row, in a golden of its own,
// so the ones above stay as they were pinned.
const INBOX_BOARD_PRIORITY: InboxBoardDto = {
  inboxes: [{ ...SUMMARY_B, priority: true }],
  totalAwaitingOperator: 0,
  views: [
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
  dtoCase(
    'dto-inbox-board-archived-groups.json',
    InboxBoardDto,
    INBOX_BOARD_ARCHIVED_GROUPS,
  ),
  dtoCase('dto-inbox-board-priority.json', InboxBoardDto, INBOX_BOARD_PRIORITY),
  dtoCase('dto-payload-answer.json', AnswerPayload, {
    response: 'An answer.',
    seenRevision: rev(2),
  }),
  dtoCase('dto-payload-answer-highlight-reply.json', AnswerPayload, {
    response: 'An answer.',
    seenRevision: rev(2),
    highlightReply: true,
  }),
  dtoCase('dto-payload-answer-drawings.json', AnswerPayload, {
    response: 'Moved it.',
    seenRevision: rev(2),
    drawings: { layout: EDITED_SCENE },
  }),
  dtoCase('dto-payload-answer-macros.json', AnswerPayload, {
    response: '',
    seenRevision: rev(1),
    macros: [AGENDA, PARK],
  }),
  dtoCase('dto-payload-ask-highlight-reply.json', AskPayload, {
    text: 'Can you check X?',
    highlightReply: true,
  }),
  dtoCase('dto-payload-ask-macros.json', AskPayload, {
    text: '',
    macros: [AGENDA, PARK],
  }),
  dtoCase('dto-payload-pin-group.json', PinPayload, {
    pinned: true,
    group: 'alpha',
  }),
  dtoCase('dto-payload-pin-inbox.json', PinPayload, { pinned: false }),
  dtoCase('dto-payload-archive.json', ArchivePayload, { archived: true }),
  dtoCase('dto-payload-archive-group.json', GroupArchivePayload, {
    group: 'alpha',
    archived: true,
  }),
  dtoCase('dto-payload-rename.json', RenamePayload, { label: 'New name' }),
  dtoCase('dto-payload-priority.json', PriorityPayload, { priority: true }),
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
    PriorityRefused,
    new PriorityRefused({
      message: 'The Inbox is already the priority inbox.',
    }),
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
  errorCase(
    MacrosUnreadable,
    new MacrosUnreadable({
      message: 'Could not read /c/operator-inbox/macros.json.',
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
