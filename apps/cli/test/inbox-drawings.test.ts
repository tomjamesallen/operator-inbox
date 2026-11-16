import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  compactToScene,
  decideAnswer,
  InboxId,
  QuestionNumber,
  SessionId,
} from '@operator-inbox/core';
import { Effect, Option, Result } from 'effect';
import {
  dispatchAnswers,
  dispatchAsk,
  dispatchDrawing,
  dispatchEdit,
  dispatchOpen,
  drawingsOf,
} from '../src/commands/inbox';
import { checkedScenes, keepScenes } from '../src/inbox-drawings';
import {
  decideAndAppend,
  type InboxLog,
  InboxLogInMemory,
} from '../src/inbox-store';

// Drawings through the CLI: `ask --drawing` and `edit --drawing` read each
// file and convert the compact form, `answers` names the drawings the
// operator changed, and `drawing` prints one back, whole or summarised.

const ID = InboxId.make('01INBOXDRAWAAAAAAAAAAAAAAA');

const provide = <A, E>(effect: Effect.Effect<A, E, InboxLog>) =>
  effect.pipe(Effect.provide(InboxLogInMemory));

const open = dispatchOpen({
  session: Option.some({ sessionId: SessionId.make('s'), cwd: '/w/app' }),
  inbox: Option.none(),
  label: Option.some('app'),
  freshId: ID,
  cwd: '/w',
});

const WIREFRAME = [
  'rect page 0 0 400 300',
  'rect nav 0 0 400 40 "Header"',
  'rect main 0 60 400 200 "Cards"',
  'arrow down nav -> main',
].join('\n');

const sceneOf = (elements: ReadonlyArray<unknown>) =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements });

// The operator's edit, as the page sends it: a full scene, bound text as its
// own element.
const EDITED = sceneOf([
  {
    type: 'rectangle',
    id: 'page',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    version: 3,
  },
  {
    type: 'rectangle',
    id: 'nav',
    x: 0,
    y: 0,
    width: 400,
    height: 60,
    version: 4,
  },
  {
    type: 'text',
    id: 'navLabel',
    x: 10,
    y: 10,
    text: 'Header',
    containerId: 'nav',
    fontSize: 16,
    version: 2,
  },
  {
    type: 'rectangle',
    id: 'main',
    x: 0,
    y: 80,
    width: 400,
    height: 200,
    version: 2,
    isDeleted: true,
  },
]);

// An answer as the server takes it: each scene checked and kept in the blob
// table first (`answerQuestion`), then decided.
const answer = (drawings: Record<string, string> | undefined) =>
  Effect.gen(function* () {
    const checked =
      drawings === undefined ? undefined : checkedScenes(drawings);
    if (checked !== undefined && Result.isFailure(checked))
      return yield* Effect.die(checked.failure);
    const kept =
      checked === undefined ? undefined : yield* keepScenes(checked.success);
    return yield* decideAndAppend(ID, (state) =>
      Result.map(
        decideAnswer(state, {
          inboxId: ID,
          number: QuestionNumber.make(1),
          response: 'Taller header, no cards.',
          ...(kept === undefined ? {} : { drawings: kept }),
        }),
        (event) => ({ events: [event], result: undefined }),
      ),
    );
  });

describe('reading --drawing files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oi-drawings-'));
  const file = (name: string, text: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it.effect('converts the compact form and keeps a scene as given', () =>
    Effect.gen(function* () {
      const read = yield* drawingsOf(
        'ask',
        Option.some({
          layout: file('layout.txt', WIREFRAME),
          given: file(
            'given.json',
            `${sceneOf([{ type: 'ellipse', id: 'e' }])}\n`,
          ),
        }),
      );
      expect(Object.keys(read ?? {})).toStrictEqual(['layout', 'given']);
      expect(JSON.parse(read?.layout ?? '').elements[1]).toMatchObject({
        id: 'nav',
        label: { text: 'Header' },
      });
      expect(read?.given).toBe(sceneOf([{ type: 'ellipse', id: 'e' }]));
      expect(yield* drawingsOf('ask', Option.none())).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect('names the file and every bad line', () =>
    Effect.gen(function* () {
      const bad = file('bad.txt', 'rect a 0 0\nblob');
      const e = yield* Effect.flip(drawingsOf('ask', Option.some({ a: bad })));
      expect(e.message).toBe(
        `inbox ask: drawing a (${bad}) is not one the inbox can read:\n  line 1: rect needs <id> <x> <y> <w> <h>\n  line 2: "blob" is not rect, ellipse, diamond, text, arrow or line`,
      );
      const missing = yield* Effect.flip(
        drawingsOf('edit', Option.some({ a: path.join(dir, 'nope') })),
      );
      expect(missing.message).toContain(
        'inbox edit: cannot read the drawing a',
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe('drawings through ask, answers and drawing', () => {
  it.effect('an ask refuses a drawing the inbox cannot keep', () =>
    provide(
      Effect.gen(function* () {
        yield* open;
        const failure = yield* Effect.flip(
          dispatchAsk({
            inboxId: ID,
            title: 'Is this the layout?',
            body: '<Excalidraw id="layout"/>',
            drawings: { layout: '{"elements":[{"type":"image","id":"i"}]}' },
          }),
        );
        expect(failure.message).toContain('images are not allowed');
      }),
    ),
  );

  const asked = (compact: string) =>
    Effect.gen(function* () {
      yield* open;
      const scene = Result.getOrThrow(compactToScene(compact));
      yield* dispatchAsk({
        inboxId: ID,
        title: 'Is this the layout?',
        body: '<Excalidraw id="layout"/>',
        drawings: { layout: scene },
      });
      return scene;
    });

  it.effect('drawing prints the agent’s own until the operator sends one', () =>
    provide(
      Effect.gen(function* () {
        const scene = yield* asked(WIREFRAME);
        expect(
          yield* dispatchDrawing({
            inboxId: ID,
            number: 1,
            id: 'layout',
            compact: false,
          }),
        ).toBe(scene);
        const compact = yield* dispatchDrawing({
          inboxId: ID,
          number: 1,
          id: 'layout',
          compact: true,
        });
        expect(compact.split('\n')[0]).toBe(
          'drawing layout of #1: yours, as asked; the operator has not changed it',
        );
        expect(compact).toContain('- box "Header" [nav] at 0,0 size 400×40');
        expect(compact).toContain('- "Header" → "Cards" [down]');
        const none = yield* Effect.flip(
          dispatchDrawing({
            inboxId: ID,
            number: 1,
            id: 'flow',
            compact: true,
          }),
        );
        expect(none.message).toBe(
          'inbox drawing: #1 has no drawing named "flow"; it has layout',
        );
        const noQuestion = yield* Effect.flip(
          dispatchDrawing({
            inboxId: ID,
            number: 9,
            id: 'layout',
            compact: true,
          }),
        );
        expect(noQuestion.message).toBe(
          'inbox drawing: there is no question #9',
        );
      }),
    ),
  );

  it.effect(
    'answers names a changed drawing, and drawing prints the operator’s',
    () =>
      provide(
        Effect.gen(function* () {
          yield* asked(WIREFRAME);
          yield* answer({ layout: EDITED });
          expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
            [
              '#1 Is this the layout?',
              '  DRAWING CHANGED: layout (3 elements); read it with: operator-inbox drawing 1 layout --compact',
              '  Taller header, no cards.',
            ].join('\n'),
          );
          const json = JSON.parse(
            yield* dispatchAnswers({ inboxId: ID, json: true }),
          );
          expect(json[0].drawings).toStrictEqual({
            layout: JSON.parse(EDITED),
          });
          const compact = yield* dispatchDrawing({
            inboxId: ID,
            number: 1,
            id: 'layout',
            compact: true,
          });
          expect(compact).toBe(
            [
              "drawing layout of #1: the operator's, sent with their answer",
              'scene: 3 elements, spanning 0,0 to 400,300 (x right, y down; positions are top-left corners)',
              '- box [page] at 0,0 size 400×300',
              '  - box "Header" [nav] at 0,0 size 400×60',
            ].join('\n'),
          );
        }),
      ),
  );

  it.effect(
    'reads an Alt-drag duplicate back with the agent’s id on the shape that stayed',
    () =>
      provide(
        Effect.gen(function* () {
          yield* asked(WIREFRAME);
          // As the page sent it before it put the ids right itself: "nav"
          // dragged down a copy, the clone left in its place with a new id,
          // and the arrow moved onto the clone.
          const CLONE = 'Kq7wE2rT9yU4iO1pA6sDf';
          const shape = (id: string, y: number, bound: string) => ({
            type: 'rectangle',
            id,
            x: 0,
            y,
            width: 400,
            height: 40,
            strokeStyle: 'solid',
            boundElements: [{ id: bound, type: 'text' }],
            version: 3,
          });
          const label = (id: string, container: string, y: number) => ({
            type: 'text',
            id,
            x: 170,
            y: y + 10,
            text: 'Header',
            originalText: 'Header',
            containerId: container,
            fontSize: 16,
            version: 3,
          });
          const duplicated = sceneOf([
            { ...shape('page', 0, 'none'), height: 300, boundElements: [] },
            shape(CLONE, 0, 'cloneLabel'),
            label('cloneLabel', CLONE, 0),
            {
              type: 'rectangle',
              id: 'main',
              x: 0,
              y: 60,
              width: 400,
              height: 200,
              version: 2,
            },
            {
              type: 'arrow',
              id: 'down',
              x: 200,
              y: 40,
              points: [
                [0, 0],
                [0, 20],
              ],
              startBinding: { elementId: CLONE },
              endBinding: { elementId: 'main' },
              version: 3,
            },
            shape('nav', 400, 'navLabel'),
            label('navLabel', 'nav', 400),
          ]);
          yield* answer({ layout: duplicated });
          const compact = yield* dispatchDrawing({
            inboxId: ID,
            number: 1,
            id: 'layout',
            compact: true,
          });
          expect(compact).toContain(
            '  - box "Header" [nav] at 0,0 size 400×40',
          );
          expect(compact).toContain('- "Header" → [main] [down]');
          expect(compact).toContain('- box "Header" [Kq7wE2] at 0,400');
          const json = JSON.parse(
            yield* dispatchAnswers({ inboxId: ID, json: true }),
          );
          const nav = json[0].drawings.layout.elements.find(
            (e: { id: string }) => e.id === 'nav',
          );
          expect(nav).toMatchObject({ x: 0, y: 0 });
        }),
      ),
  );

  it.effect('an answer with no drawing changed adds no line', () =>
    provide(
      Effect.gen(function* () {
        yield* asked(WIREFRAME);
        yield* answer(undefined);
        const text = yield* dispatchAnswers({ inboxId: ID, json: false });
        expect(text).not.toContain('DRAWING CHANGED');
        expect(
          JSON.parse(yield* dispatchAnswers({ inboxId: ID, json: true }))[0],
        ).not.toHaveProperty('drawings');
      }),
    ),
  );

  it.effect('edit sets a drawing and refuses one that changes nothing', () =>
    provide(
      Effect.gen(function* () {
        const scene = yield* asked(WIREFRAME);
        const same = yield* Effect.flip(
          dispatchEdit({ inboxId: ID, number: 1, drawings: { layout: scene } }),
        );
        expect(same.message).toContain('already says that');
        expect(
          yield* dispatchEdit({
            inboxId: ID,
            number: 1,
            drawings: { layout: EDITED },
          }),
        ).toBe('edited #1');
        expect(
          yield* dispatchDrawing({
            inboxId: ID,
            number: 1,
            id: 'layout',
            compact: false,
          }),
        ).toBe(EDITED);
      }),
    ),
  );
});
