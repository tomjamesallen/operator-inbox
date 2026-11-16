import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  DRAWING_BLOB_KIND,
  type InboxEvent,
  InboxId,
  inboxStateStamped,
  QuestionNumber,
  QuestionRevision,
  SessionId,
} from '@operator-inbox/core';
import { Effect, FileSystem, Layer, Option, Ref, Result } from 'effect';
import {
  dispatchAnswers,
  dispatchAsk,
  dispatchDrawing,
  dispatchEdit,
  dispatchOpen,
} from '../src/commands/inbox';
import { importLog } from '../src/import-log';
import { sha256Hex } from '../src/inbox-blobs';
import { STORE_CONFIG } from '../src/inbox-database';
import {
  connectInboxLog,
  decideAndAppend,
  InboxLog,
  InboxLogInMemory,
} from '../src/inbox-store';
import {
  answerQuestion,
  questionDrawings,
  toInboxView,
} from '../src/serve-inbox-api';

// Drawings in the blob table: `ask --drawing`, `edit --drawing` and the
// operator's answer each keep a scene as a blob, kind `drawing`, BEFORE the
// event that names it is appended, and the event carries its hash and size
// only. The board carries the hashes; the page reads the scenes through
// `drawings`. A log whose events carry scenes inline is read as it is.

const ID = InboxId.make('01INBOXDRAWBLOBAAAAAAAAAAA');
const n = QuestionNumber.make;

const open = dispatchOpen({
  session: Option.some({ sessionId: SessionId.make('s'), cwd: '/w/app' }),
  inbox: Option.none(),
  label: Option.some('app'),
  freshId: ID,
  cwd: '/w',
});

const sceneOf = (elements: ReadonlyArray<unknown>) =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements });
const BOX = sceneOf([
  { type: 'rectangle', id: 'box', x: 0, y: 0, width: 100, height: 50 },
]);
const MOVED = sceneOf([
  {
    type: 'rectangle',
    id: 'box',
    x: 40,
    y: 0,
    width: 100,
    height: 50,
    version: 2,
  },
]);
const FLOW = sceneOf([
  { type: 'ellipse', id: 'flow', x: 0, y: 0, width: 20, height: 20 },
]);

const refOf = (scene: string) => {
  const bytes = new TextEncoder().encode(scene);
  return { sha: sha256Hex(bytes), bytes: bytes.byteLength };
};

// Events appended as they are, as an older build logged them.
const appendRaw = (events: ReadonlyArray<InboxEvent>) =>
  decideAndAppend(ID, () =>
    Result.succeed({ events: [...events], result: undefined }),
  );

const viewOf = Effect.gen(function* () {
  const log = yield* InboxLog;
  const { stamped } = yield* log.read(ID);
  return toInboxView(ID, inboxStateStamped(stamped));
});

describe('drawings kept as blobs', () => {
  it.effect(
    'an ask keeps the scene first, then appends an event carrying only its hash',
    () =>
      Effect.gen(function* () {
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const recording = Layer.effect(
          InboxLog,
          Effect.map(InboxLog, (base) =>
            InboxLog.of({
              ...base,
              putBlob: (blob) =>
                Effect.andThen(
                  Ref.update(order, (o) => [...o, `blob ${blob.kind}`]),
                  base.putBlob(blob),
                ),
              append: (events, guard) =>
                Effect.andThen(
                  Ref.update(order, (o) => [
                    ...o,
                    ...events.map((e) => `event ${e._tag}`),
                  ]),
                  base.append(events, guard),
                ),
            }),
          ),
        ).pipe(Layer.provide(InboxLogInMemory));
        yield* Effect.gen(function* () {
          yield* open;
          yield* Ref.set(order, []);
          yield* dispatchAsk({
            inboxId: ID,
            title: 'Is this the layout?',
            body: '<Excalidraw id="layout"/>',
            drawings: { layout: BOX },
          });
          const log = yield* InboxLog;
          const { events } = yield* log.read(ID);
          const asked = events.find((e) => e._tag === 'QuestionAsked');
          expect(asked).toMatchObject({ drawingRefs: { layout: refOf(BOX) } });
          expect(asked).not.toHaveProperty('drawings');
          expect(JSON.stringify(asked)).not.toContain('rectangle');
          const kept = yield* log.readBlobs([refOf(BOX).sha]);
          expect(kept.get(refOf(BOX).sha)?.kind).toBe(DRAWING_BLOB_KIND);
        }).pipe(Effect.provide(recording));
        expect(yield* Ref.get(order)).toStrictEqual([
          'blob drawing',
          'event QuestionAsked',
        ]);
      }),
  );

  it.effect('a scene the inbox refuses is never written', () =>
    Effect.gen(function* () {
      yield* open;
      const image = '{"elements":[{"type":"image","id":"i"}]}';
      const failure = yield* Effect.flip(
        dispatchAsk({
          inboxId: ID,
          title: 'T',
          body: '',
          drawings: { layout: image },
        }),
      );
      expect(failure.message).toContain('images are not allowed');
      const log = yield* InboxLog;
      expect((yield* log.readBlobs([refOf(image).sha])).size).toBe(0);
    }).pipe(Effect.provide(InboxLogInMemory)),
  );

  it.effect(
    'the board carries hashes alone, and the scenes come per Question',
    () =>
      Effect.gen(function* () {
        yield* open;
        yield* dispatchAsk({
          inboxId: ID,
          title: 'Is this the layout?',
          body: '<Excalidraw id="layout"/>',
          drawings: { layout: BOX },
        });
        // An edit adds a drawing and leaves the other where it was.
        yield* dispatchEdit({
          inboxId: ID,
          number: 1,
          drawings: { flow: FLOW },
        });
        const view = yield* viewOf;
        expect(view.awaitingOperator[0]?.drawingRefs).toStrictEqual({
          layout: { ...refOf(BOX), revision: 1 },
          flow: { ...refOf(FLOW), revision: 2 },
        });
        expect(view.awaitingOperator[0]).not.toHaveProperty('drawings');
        expect(JSON.stringify(view)).not.toContain('rectangle');
        expect(yield* questionDrawings(ID, n(1))).toStrictEqual({
          drawings: {
            layout: { sha: refOf(BOX).sha, scene: BOX },
            flow: { sha: refOf(FLOW).sha, scene: FLOW },
          },
          sent: {},
        });
        expect(yield* questionDrawings(ID, n(9))).toStrictEqual({
          drawings: {},
          sent: {},
        });
      }).pipe(Effect.provide(InboxLogInMemory)),
  );

  it.effect(
    'the operator’s edit is kept as a blob, and answers and drawing read it back',
    () =>
      Effect.gen(function* () {
        yield* open;
        yield* dispatchAsk({
          inboxId: ID,
          title: 'Is this the layout?',
          body: '<Excalidraw id="layout"/>',
          drawings: { layout: BOX },
        });
        yield* answerQuestion(
          ID,
          n(1),
          'Moved it.',
          QuestionRevision.make(1),
          undefined,
          undefined,
          { layout: MOVED },
        );
        const log = yield* InboxLog;
        const { events } = yield* log.read(ID);
        const answered = events.find((e) => e._tag === 'QuestionAnswered');
        expect(answered).toMatchObject({
          drawingRefs: { layout: refOf(MOVED) },
        });
        expect(answered).not.toHaveProperty('drawings');
        const view = yield* viewOf;
        expect(view.awaitingAgent[0]?.sentDrawingRefs).toStrictEqual({
          layout: refOf(MOVED),
        });
        expect((yield* questionDrawings(ID, n(1))).sent).toStrictEqual({
          layout: { sha: refOf(MOVED).sha, scene: MOVED },
        });
        expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toContain(
          'DRAWING CHANGED: layout (1 elements)',
        );
        expect(
          JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true }))[0]
            .drawings,
        ).toStrictEqual({ layout: JSON.parse(MOVED) });
        expect(
          yield* dispatchDrawing({
            inboxId: ID,
            number: 1,
            id: 'layout',
            compact: false,
          }),
        ).toBe(MOVED);
      }).pipe(
        Effect.provide(InboxLogInMemory),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect('an answer with a scene the inbox refuses writes nothing', () =>
    Effect.gen(function* () {
      yield* open;
      yield* dispatchAsk({
        inboxId: ID,
        title: 'Is this the layout?',
        body: '<Excalidraw id="layout"/>',
        drawings: { layout: BOX },
      });
      const image = '{"elements":[{"type":"image","id":"i"}]}';
      const failure = yield* Effect.flip(
        answerQuestion(
          ID,
          n(1),
          'x',
          QuestionRevision.make(1),
          undefined,
          undefined,
          { layout: image },
        ),
      );
      expect(failure._tag).toBe('AnswerRefused');
      const log = yield* InboxLog;
      expect((yield* log.readBlobs([refOf(image).sha])).size).toBe(0);
    }).pipe(
      Effect.provide(InboxLogInMemory),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe('a log with its scenes inline', () => {
  const olderLog: ReadonlyArray<InboxEvent> = [
    {
      _tag: 'QuestionAsked',
      inboxId: ID,
      number: n(1),
      title: 'Is this the layout?',
      body: '<Excalidraw id="layout"/>',
      drawings: { layout: BOX },
    },
    {
      _tag: 'QuestionAnswered',
      inboxId: ID,
      number: n(1),
      response: 'Moved it.',
      drawings: { layout: MOVED },
    },
  ];

  it.effect('is read as it was logged, its hashes made from its text', () =>
    Effect.gen(function* () {
      yield* open;
      yield* appendRaw(olderLog);
      const view = yield* viewOf;
      expect(view.awaitingAgent[0]?.drawingRefs).toStrictEqual({
        layout: { ...refOf(BOX), revision: 1 },
      });
      expect(view.awaitingAgent[0]?.sentDrawingRefs).toStrictEqual({
        layout: refOf(MOVED),
      });
      expect(JSON.stringify(view)).not.toContain('rectangle');
      expect(yield* questionDrawings(ID, n(1))).toStrictEqual({
        drawings: { layout: { sha: refOf(BOX).sha, scene: BOX } },
        sent: { layout: { sha: refOf(MOVED).sha, scene: MOVED } },
      });
      expect(
        yield* dispatchDrawing({
          inboxId: ID,
          number: 1,
          id: 'layout',
          compact: false,
        }),
      ).toBe(MOVED);
      expect(
        JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true }))[0]
          .drawings,
      ).toStrictEqual({ layout: JSON.parse(MOVED) });
      // Nothing was written to the blob table to read it.
      const log = yield* InboxLog;
      expect(
        (yield* log.readBlobs([refOf(BOX).sha, refOf(MOVED).sha])).size,
      ).toBe(0);
    }).pipe(Effect.provide(InboxLogInMemory)),
  );

  it.effect(
    'an edit over it adds a blob and leaves the inline drawing inline',
    () =>
      Effect.gen(function* () {
        yield* open;
        yield* appendRaw(olderLog.slice(0, 1));
        yield* dispatchEdit({
          inboxId: ID,
          number: 1,
          drawings: { layout: BOX, flow: FLOW },
        });
        const log = yield* InboxLog;
        const { events } = yield* log.read(ID);
        expect(events.at(-1)).toMatchObject({
          _tag: 'QuestionEdited',
          drawingRefs: { flow: refOf(FLOW) },
        });
        expect(events.at(-1)).not.toHaveProperty('drawingRefs.layout');
        const view = yield* viewOf;
        expect(view.awaitingOperator[0]?.drawingRefs).toStrictEqual({
          layout: { ...refOf(BOX), revision: 1 },
          flow: { ...refOf(FLOW), revision: 2 },
        });
      }).pipe(Effect.provide(InboxLogInMemory)),
  );
});

describe('import-log with drawings', () => {
  it.effect(
    'carries the drawing blobs, and the copy reads both shapes of drawing',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped();
        const from = path.join(base, 'source', 'inbox.sqlite');
        const target = path.join(
          base,
          'state',
          'operator-inbox',
          'inbox.sqlite',
        );
        yield* fs.makeDirectory(path.dirname(from), { recursive: true });
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        // A source with an older Question, its scene inline, and a newer
        // one whose scene is a blob.
        yield* Effect.gen(function* () {
          yield* open;
          yield* appendRaw([
            {
              _tag: 'QuestionAsked',
              inboxId: ID,
              number: n(1),
              title: 'Older',
              body: '<Excalidraw id="layout"/>',
              drawings: { layout: BOX },
            },
          ]);
          yield* dispatchAsk({
            inboxId: ID,
            title: 'Newer',
            body: '<Excalidraw id="flow"/>',
            drawings: { flow: FLOW },
          });
        }).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: from })),
          Effect.scoped,
        );
        const summary = yield* importLog({
          from,
          fromPrefix: STORE_CONFIG.tablePrefix,
          dryRun: false,
          target: { source: 'env', path: target },
        });
        expect(summary.blobs).toBe(1);
        const read = yield* Effect.all([
          questionDrawings(ID, n(1)),
          questionDrawings(ID, n(2)),
        ]).pipe(
          Effect.provide(connectInboxLog({ source: 'env', path: target })),
          Effect.scoped,
        );
        expect(read[0].drawings).toStrictEqual({
          layout: { sha: refOf(BOX).sha, scene: BOX },
        });
        expect(read[1].drawings).toStrictEqual({
          flow: { sha: refOf(FLOW).sha, scene: FLOW },
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
