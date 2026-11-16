import { createHash } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Result } from 'effect';
import {
  checkDrawings,
  checkScene,
  compactToScene,
  DRAWING_EXPORT_PADDING,
  DRAWING_MAX_BYTES,
  DRAWINGS_MAX,
  decideAnswer,
  decideAsk,
  decideEdit,
  decideMove,
  drawingBox,
  drawingFileToScene,
  drawingFormat,
  type InboxEvent,
  InboxId,
  inboxState,
  QuestionNumber,
  QuestionRevision,
  renderQuestionParts,
  sceneElementCount,
  summariseScene,
} from '../src';

const A = InboxId.make('01J00000000000000000000IA1');
const B = InboxId.make('01J00000000000000000000IB1');
const n = QuestionNumber.make;

const scene = (elements: ReadonlyArray<unknown>) =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements });
const BOX = scene([
  { type: 'rectangle', id: 'a', x: 0, y: 0, width: 100, height: 50 },
]);
const MOVED = scene([
  { type: 'rectangle', id: 'a', x: 40, y: 0, width: 100, height: 50 },
]);
const OTHER = scene([
  { type: 'ellipse', id: 'b', x: 0, y: 0, width: 20, height: 20 },
]);

const opened: InboxEvent = { _tag: 'InboxOpened', inboxId: A, label: 'one' };

const ok = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(String(r.failure));
  return r.success;
};

const refusal = <A, E>(r: Result.Result<A, E>): E => {
  if (Result.isSuccess(r)) throw new Error('expected a refusal');
  return r.failure;
};

describe('drawing tags in the body', () => {
  it('splits a tag on a line of its own into an excalidraw part', () => {
    expect(
      renderQuestionParts('Move it.\n\n<Excalidraw id="layout"/>\n\nThen say.'),
    ).toStrictEqual([
      { kind: 'html', html: '<p>Move it.</p>\n' },
      { kind: 'excalidraw', id: 'layout' },
      { kind: 'html', html: '<p>Then say.</p>\n' },
    ]);
  });

  it('leaves a tag inline, with another attribute or a bad id as escaped text', () => {
    for (const body of [
      'See <Excalidraw id="layout"/> here.',
      '<Excalidraw id="layout" width="3"/>',
      '<Excalidraw id="Bad_Id"/>',
    ]) {
      const parts = renderQuestionParts(body);
      expect(parts.some((p) => p.kind === 'excalidraw')).toBe(false);
      expect(
        parts.map((p) => (p.kind === 'html' ? p.html : '')).join(''),
      ).toContain('&lt;Excalidraw');
    }
  });
});

describe('checkScene and checkDrawings', () => {
  it('keeps a scene, and wraps a bare array of elements as one', () => {
    expect(ok(checkScene('a', BOX))).toBe(BOX);
    expect(
      JSON.parse(ok(checkScene('a', '[{"type":"text","id":"t"}]'))),
    ).toStrictEqual({
      type: 'excalidraw',
      version: 2,
      elements: [{ type: 'text', id: 't' }],
    });
  });

  it('refuses a bad id, non-JSON, files, images, and an element with no type', () => {
    expect(refusal(checkScene('Bad', BOX))).toContain("a drawing's id");
    expect(refusal(checkScene('a', 'nope'))).toContain(
      'not an Excalidraw scene',
    );
    expect(
      refusal(
        checkScene('a', JSON.stringify({ elements: [], files: { f: {} } })),
      ),
    ).toContain('carries files');
    expect(
      refusal(checkScene('a', scene([{ type: 'image', id: 'i' }]))),
    ).toContain('image element');
    expect(refusal(checkScene('a', scene([{ id: 'x' }])))).toContain(
      'no "type"',
    );
  });

  it('accepts a scene of exactly the limit and refuses one byte more', () => {
    const base = scene([{ type: 'text', id: 't', text: '' }]);
    const fill = DRAWING_MAX_BYTES - base.length;
    const at = scene([{ type: 'text', id: 't', text: 'x'.repeat(fill) }]);
    expect(at.length).toBe(DRAWING_MAX_BYTES);
    expect(Result.isSuccess(checkScene('a', at))).toBe(true);
    const over = scene([{ type: 'text', id: 't', text: 'x'.repeat(fill + 1) }]);
    expect(refusal(checkScene('a', over))).toContain('at most 200 KiB');
  });

  it(`allows ${DRAWINGS_MAX} drawings and refuses one more`, () => {
    const set = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`d${i}`, BOX]),
      );
    expect(Result.isSuccess(checkDrawings(set(DRAWINGS_MAX)))).toBe(true);
    expect(refusal(checkDrawings(set(DRAWINGS_MAX + 1)))).toContain(
      `at most ${DRAWINGS_MAX} drawings`,
    );
  });
});

describe('the forms', () => {
  it('tells compact, skeleton and full scene apart', () => {
    expect(drawingFormat('rect a 0 0 10 10')).toBe('compact');
    expect(drawingFormat(BOX)).toBe('skeleton');
    expect(drawingFormat('[{"type":"rectangle"}]')).toBe('skeleton');
    expect(
      drawingFormat(scene([{ type: 'rectangle', id: 'a', version: 1 }])),
    ).toBe('scene');
    expect(drawingFileToScene(` ${BOX}\n`)).toStrictEqual(Result.succeed(BOX));
  });

  it('converts the compact form to a skeleton, deterministically, ids kept', () => {
    const src = [
      '# a wireframe',
      'rect page 0 0 400 300 rounded',
      'rect nav 0 0 400 40 "Header" fill=#eeeeee',
      'ellipse dot 20 100 40 40',
      'diamond ok 200 100 80 60 "Yes?"',
      'text note 20 200 "Free text" size=12',
      'arrow go dot -> ok "next" dashed',
      'line rule 0 250 400 250 dotted',
    ].join('\n');
    const first = ok(compactToScene(src));
    expect(ok(compactToScene(src))).toBe(first);
    const els = JSON.parse(first).elements as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(els.map((e) => e.id)).toStrictEqual([
      'page',
      'nav',
      'dot',
      'ok',
      'note',
      'rule',
      'go',
    ]);
    expect(els[1]).toMatchObject({
      type: 'rectangle',
      backgroundColor: '#eeeeee',
      label: { text: 'Header', fontSize: 16 },
    });
    expect(els[0]).toMatchObject({ roundness: { type: 3 } });
    expect(els[6]).toMatchObject({
      type: 'arrow',
      start: { id: 'dot' },
      end: { id: 'ok' },
      strokeStyle: 'dashed',
      label: { text: 'next' },
    });
    // Straight, from the circle's edge to the diamond's.
    expect(els[6]?.x).toBeCloseTo(60, 0);
    expect(drawingFormat(first)).toBe('skeleton');
  });

  it('grows a box whose label needs more room', () => {
    const els = JSON.parse(
      ok(
        compactToScene(
          'rect a 0 0 60 20 "a label that wraps over several lines"',
        ),
      ),
    ).elements;
    expect(els[0].height).toBeGreaterThan(20);
  });

  it('names every line it cannot read', () => {
    const errors = refusal(
      compactToScene(
        [
          'rect a 0 0 x 10',
          'blob b',
          'arrow c a -> nowhere',
          'rect a 0 0 1 1',
        ].join('\n'),
      ),
    );
    expect(errors).toStrictEqual([
      'line 1: rect needs <id> <x> <y> <w> <h>',
      'line 2: "blob" is not rect, ellipse, diamond, text, arrow or line',
      'line 4: the id "a" is used twice',
      'line 3: arrow c joins "a", which is not a rect, ellipse or diamond here',
    ]);
    expect(refusal(compactToScene('# nothing'))).toStrictEqual([
      'the drawing has no elements',
    ]);
  });
});

describe('drawingBox', () => {
  it('is the elements’ span plus the export padding, arrows by their points', () => {
    const s = scene([
      { type: 'rectangle', id: 'a', x: 10, y: 20, width: 100, height: 50 },
      {
        type: 'arrow',
        id: 'b',
        x: 110,
        y: 45,
        points: [
          [0, 0],
          [90, 30],
        ],
      },
      {
        type: 'rectangle',
        id: 'gone',
        x: 900,
        y: 900,
        width: 1,
        height: 1,
        isDeleted: true,
      },
    ]);
    expect(drawingBox(s)).toStrictEqual({
      width: 190 + 2 * DRAWING_EXPORT_PADDING,
      height: 55 + 2 * DRAWING_EXPORT_PADDING,
    });
    expect(drawingBox(scene([]))).toBeUndefined();
    expect(drawingBox('nope')).toBeUndefined();
  });
});

describe('summariseScene', () => {
  // A full scene as Excalidraw saves it: bound text as its own element.
  const FULL = scene([
    {
      type: 'rectangle',
      id: 'page',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      version: 2,
    },
    {
      type: 'rectangle',
      id: 'card',
      x: 20,
      y: 20,
      width: 100,
      height: 60,
      version: 2,
      backgroundColor: '#ffeeee',
    },
    {
      type: 'text',
      id: 'cardText',
      x: 30,
      y: 40,
      text: 'Card',
      originalText: 'Card',
      containerId: 'card',
      fontSize: 16,
      version: 2,
    },
    {
      type: 'rectangle',
      id: 'side',
      x: 200,
      y: 20,
      width: 100,
      height: 60,
      version: 2,
      strokeStyle: 'dashed',
    },
    {
      type: 'rectangle',
      id: 'old',
      x: 0,
      y: 500,
      width: 10,
      height: 10,
      version: 2,
      isDeleted: true,
    },
    {
      type: 'arrow',
      id: 'link',
      x: 120,
      y: 50,
      points: [
        [0, 0],
        [80, 0],
      ],
      startBinding: { elementId: 'card' },
      endBinding: { elementId: 'side' },
      version: 2,
    },
  ]);

  it('nests, folds bound text, drops deleted, lists arrows by what they join', () => {
    expect(summariseScene(FULL)).toBe(
      [
        'scene: 5 elements, spanning 0,0 to 400,300 (x right, y down; positions are top-left corners)',
        '- box [page] at 0,0 size 400×300',
        '  - box "Card" [card] at 20,20 size 100×60 (fill #ffeeee)',
        '  - box [side] at 200,20 size 100×60 (dashed)',
        'arrows:',
        '- "Card" → [side] [link] 120,50 to 200,50',
        '',
      ].join('\n'),
    );
  });

  it('reads the skeleton the compact form makes, labels and ends included', () => {
    const s = ok(
      compactToScene(
        'rect a 0 0 100 40 "From"\nrect b 200 0 100 40 "To"\narrow x a -> b',
      ),
    );
    const text = summariseScene(s);
    expect(text).toContain('- box "From" [a] at 0,0 size 100×40');
    expect(text).toContain('- "From" → "To" [x]');
  });

  it('cuts long random ids to a unique prefix', () => {
    const s = scene([
      {
        type: 'rectangle',
        id: 'Abcdefghijklmnopqrstu',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
      {
        type: 'rectangle',
        id: 'Abcdefzzzzzzzzzzzzzzz',
        x: 5,
        y: 0,
        width: 1,
        height: 1,
      },
    ]);
    const text = summariseScene(s);
    expect(text).toContain('[Abcdef]');
    expect(text).toContain('[Abcdefz]');
  });

  it('counts live elements', () => {
    expect(sceneElementCount(FULL)).toBe(5);
  });
});

describe('drawings on the log', () => {
  // A scene as a decision takes it: its text and its blob's ref.
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const refOf = (text: string) => ({
    sha: sha(text),
    bytes: new TextEncoder().encode(text).length,
  });
  const inputs = (scenes: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(scenes).map(([id, text]) => [
        id,
        { scene: text, ref: refOf(text) },
      ]),
    );
  const asked = (drawings?: Record<string, string>) =>
    ok(
      decideAsk(inboxState([opened]), {
        inboxId: A,
        title: 'Layout?',
        body: '<Excalidraw id="layout"/>',
        ...(drawings === undefined ? {} : { drawings: inputs(drawings) }),
      }),
    );
  // A Question asked before scenes moved to the blob table: its scenes on
  // the event itself.
  const askedInline = (drawings: Record<string, string>): InboxEvent => ({
    _tag: 'QuestionAsked',
    inboxId: A,
    number: n(1),
    title: 'Layout?',
    body: '<Excalidraw id="layout"/>',
    drawings,
  });

  it('an ask carries a ref per drawing, never the scene, and the fold holds it at revision 1', () => {
    const e = asked({ layout: BOX });
    expect(e.drawingRefs).toStrictEqual({ layout: refOf(BOX) });
    expect(e).not.toHaveProperty('drawings');
    const q = inboxState([opened, e]).questions[0];
    expect(q?.drawings).toStrictEqual({
      layout: { stored: refOf(BOX), revision: 1 },
    });
    expect(asked()).not.toHaveProperty('drawingRefs');
    expect(asked({})).not.toHaveProperty('drawingRefs');
  });

  it('an older ask with its scenes inline folds as it always did', () => {
    const q = inboxState([opened, askedInline({ layout: BOX })]).questions[0];
    expect(q?.drawings).toStrictEqual({
      layout: { stored: BOX, revision: 1 },
    });
  });

  it('an ask with a bad drawing is refused', () => {
    const r = decideAsk(inboxState([opened]), {
      inboxId: A,
      title: 'T',
      body: '',
      drawings: { layout: { scene: 'nope', ref: refOf('nope') } },
    });
    expect(refusal(r).reason).toBe('bad-drawing');
  });

  it("an ask whose ref is not a SHA-256, or not the scene's size, is refused", () => {
    const ask = (ref: { sha: string; bytes: number }) =>
      decideAsk(inboxState([opened]), {
        inboxId: A,
        title: 'T',
        body: '',
        drawings: { layout: { scene: BOX, ref } },
      });
    expect(refusal(ask({ sha: 'abc', bytes: refOf(BOX).bytes })).message).toBe(
      'drawing "layout" names no scene: its hash is not a SHA-256',
    );
    expect(refusal(ask({ sha: sha(BOX), bytes: 3 })).reason).toBe(
      'bad-drawing',
    );
  });

  it('an edit sets only the changed drawings, and only a changed one moves revision', () => {
    const events: Array<InboxEvent> = [
      opened,
      asked({ layout: BOX, flow: OTHER }),
    ];
    const edited = ok(
      decideEdit(inboxState(events), {
        inboxId: A,
        number: n(1),
        drawings: inputs({ layout: MOVED, flow: OTHER }),
      }),
    );
    expect(edited.drawingRefs).toStrictEqual({ layout: refOf(MOVED) });
    expect(edited).not.toHaveProperty('drawings');
    const q = inboxState([...events, edited]).questions[0];
    expect(q?.revision).toBe(2);
    expect(q?.drawings).toStrictEqual({
      flow: { stored: refOf(OTHER), revision: 1 },
      layout: { stored: refOf(MOVED), revision: 2 },
    });
    // An edit of the title alone keeps every drawing where it was.
    const titled = ok(
      decideEdit(inboxState([...events, edited]), {
        inboxId: A,
        number: n(1),
        title: 'New',
      }),
    );
    expect(titled).not.toHaveProperty('drawingRefs');
    expect(
      inboxState([...events, edited, titled]).questions[0]?.drawings,
    ).toStrictEqual(q?.drawings);
  });

  it('an edit over an older inline drawing leaves the others inline, at their revision', () => {
    const events: Array<InboxEvent> = [
      opened,
      askedInline({ layout: BOX, flow: OTHER }),
    ];
    const edited = ok(
      decideEdit(inboxState(events), {
        inboxId: A,
        number: n(1),
        // The same text as the inline `flow`: no change.
        drawings: inputs({ layout: MOVED, flow: OTHER }),
      }),
    );
    expect(edited.drawingRefs).toStrictEqual({ layout: refOf(MOVED) });
    const q = inboxState([...events, edited]).questions[0];
    expect(q?.drawings).toStrictEqual({
      flow: { stored: OTHER, revision: 1 },
      layout: { stored: refOf(MOVED), revision: 2 },
    });
    // And an older edit, whose `drawings` is the whole set, still folds so.
    const olderEdit: InboxEvent = {
      _tag: 'QuestionEdited',
      inboxId: A,
      number: n(1),
      title: 'Layout?',
      body: '',
      drawings: { layout: OTHER },
    };
    expect(
      inboxState([...events, olderEdit]).questions[0]?.drawings,
    ).toStrictEqual({ layout: { stored: OTHER, revision: 2 } });
  });

  it('an edit that changes nothing, drawings included, is refused', () => {
    for (const ask of [asked({ layout: BOX }), askedInline({ layout: BOX })]) {
      const r = decideEdit(inboxState([opened, ask]), {
        inboxId: A,
        number: n(1),
        drawings: inputs({ layout: BOX }),
      });
      expect(refusal(r).reason).toBe('unchanged');
    }
  });

  it('an edit that takes the set past the limit is refused', () => {
    const many = Object.fromEntries(
      Array.from({ length: DRAWINGS_MAX }, (_, i) => [`d${i}`, BOX]),
    );
    const events: Array<InboxEvent> = [opened, asked(many)];
    const r = decideEdit(inboxState(events), {
      inboxId: A,
      number: n(1),
      drawings: inputs({ extra: BOX }),
    });
    expect(refusal(r).reason).toBe('bad-drawing');
    expect(refusal(r).message).toBe(
      `a question may carry at most ${DRAWINGS_MAX} drawings; this one would have ${DRAWINGS_MAX + 1}`,
    );
  });

  it('an answer carries a ref per changed drawing, and refuses an id the Question lacks', () => {
    const state = inboxState([opened, asked({ layout: BOX })]);
    const answered = ok(
      decideAnswer(state, {
        inboxId: A,
        number: n(1),
        response: 'Moved',
        seenRevision: QuestionRevision.make(1),
        drawings: inputs({ layout: MOVED }),
      }),
    );
    expect(answered.drawingRefs).toStrictEqual({ layout: refOf(MOVED) });
    expect(answered).not.toHaveProperty('drawings');
    const q = inboxState([opened, asked({ layout: BOX }), answered])
      .questions[0];
    expect(q?.sentDrawings).toStrictEqual({ layout: refOf(MOVED) });
    expect(q?.drawings?.layout?.stored).toStrictEqual(refOf(BOX));
    const r = decideAnswer(state, {
      inboxId: A,
      number: n(1),
      response: 'x',
      drawings: inputs({ other: MOVED }),
    });
    expect(refusal(r).message).toContain('no drawing named "other"');
  });

  it('an answer to an older inline drawing may send it as a blob', () => {
    const events: Array<InboxEvent> = [opened, askedInline({ layout: BOX })];
    const answered = ok(
      decideAnswer(inboxState(events), {
        inboxId: A,
        number: n(1),
        response: 'Moved',
        drawings: inputs({ layout: MOVED }),
      }),
    );
    const q = inboxState([...events, answered]).questions[0];
    expect(q?.drawings?.layout?.stored).toBe(BOX);
    expect(q?.sentDrawings).toStrictEqual({ layout: refOf(MOVED) });
  });

  it('a deferral carries drawings too', () => {
    const state = inboxState([opened, asked({ layout: BOX })]);
    const deferred = ok(
      decideAnswer(state, {
        inboxId: A,
        number: n(1),
        response: '',
        deferred: true,
        drawings: inputs({ layout: MOVED }),
      }),
    );
    expect(deferred).toMatchObject({
      deferred: true,
      drawingRefs: { layout: refOf(MOVED) },
    });
  });

  const openedB: InboxEvent = {
    _tag: 'InboxOpened',
    inboxId: B,
    label: 'two',
  };

  it('a move carries the drawings and the sent ones whole', () => {
    const events: Array<InboxEvent> = [
      opened,
      asked({ layout: BOX }),
      {
        _tag: 'QuestionAnswered',
        inboxId: A,
        number: n(1),
        response: 'Moved',
        drawingRefs: { layout: refOf(MOVED) },
      },
    ];
    const moved = ok(
      decideMove(inboxState(events), inboxState([openedB]), {
        inboxId: A,
        numbers: [n(1)],
        toInboxId: B,
      }),
    );
    expect(
      moved[0]?._tag === 'QuestionMoved' && moved[0].question,
    ).toMatchObject({
      drawingRefs: { layout: { ...refOf(BOX), revision: 1 } },
      sentDrawingRefs: { layout: refOf(MOVED) },
    });
    const there = inboxState([openedB, ...moved]).questions[0];
    expect(there?.drawings).toStrictEqual({
      layout: { stored: refOf(BOX), revision: 1 },
    });
    expect(there?.sentDrawings).toStrictEqual({ layout: refOf(MOVED) });
  });

  it('a move carries an older inline drawing inline, beside a blob one', () => {
    const events: Array<InboxEvent> = [
      opened,
      askedInline({ layout: BOX }),
      {
        _tag: 'QuestionEdited',
        inboxId: A,
        number: n(1),
        title: 'Layout?',
        body: '',
        drawingRefs: { flow: refOf(OTHER) },
      },
      {
        _tag: 'QuestionAnswered',
        inboxId: A,
        number: n(1),
        response: 'Moved',
        drawings: { layout: MOVED },
      },
    ];
    const moved = ok(
      decideMove(inboxState(events), inboxState([openedB]), {
        inboxId: A,
        numbers: [n(1)],
        toInboxId: B,
      }),
    );
    const question =
      moved[0]?._tag === 'QuestionMoved' ? moved[0].question : undefined;
    expect(question?.drawings).toStrictEqual({
      layout: { scene: BOX, revision: 1 },
    });
    expect(question?.drawingRefs).toStrictEqual({
      flow: { ...refOf(OTHER), revision: 2 },
    });
    expect(question?.sentDrawings).toStrictEqual({ layout: MOVED });
    expect(question).not.toHaveProperty('sentDrawingRefs');
    const there = inboxState([openedB, ...moved]).questions[0];
    expect(there?.drawings).toStrictEqual({
      layout: { stored: BOX, revision: 1 },
      flow: { stored: refOf(OTHER), revision: 2 },
    });
    expect(there?.sentDrawings).toStrictEqual({ layout: MOVED });
  });
});
