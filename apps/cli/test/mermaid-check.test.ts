import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { refuseInvalidMermaid } from '../src/commands/inbox';
import { checkMermaid, isSyntaxError } from '../src/mermaid-check';

// `ask` and `edit` parse each ```mermaid fence with Mermaid itself, and
// refuse a body whose diagram the page would show as an error.

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

const body = (...sources: ReadonlyArray<string>) =>
  [
    'Some context, with a "quote" and a; semicolon.',
    ...sources.map(fence),
    'The question.',
  ].join('\n\n');

// A message that carries on onto a line of its own, which Mermaid's sequence
// grammar reads as a message with no arrow.
const BROKEN = [
  'sequenceDiagram',
  '  participant A',
  '  participant S',
  '  A->>S: take it',
  '  "Then a second waits and no lock bypass."',
].join('\n');

// One valid diagram of each kind an agent is likely to draw, including those
// whose parse sanitises labels and so needs a window.
const VALID = [
  'flowchart LR\n  a["A <b>bold</b>"] --> b{B}\n  b -->|yes| c',
  'sequenceDiagram\n  autonumber\n  participant A as Agent\n  A->>B: first line<br/>second line\n  Note over A,B: a semicolon as #59; is fine\n  alt ok\n    B-->>A: fine\n  else\n    B--xA: no\n  end',
  'classDiagram\n  class Animal{\n    +int age\n  }\n  Animal <|-- Duck',
  'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving: push\n  Moving --> [*]',
  'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  'gantt\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 3d',
  'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  'gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev',
  'mindmap\n  root((r))\n    a\n    b',
  'timeline\n  2025 : a\n  2026 : b',
];

describe('the Mermaid check', () => {
  it.effect('passes a body with no diagram', () =>
    Effect.gen(function* () {
      expect(
        yield* checkMermaid('Just *markdown*.\n\n```ts\nconst a = 1;\n```'),
      ).toEqual({
        invalid: [],
        unchecked: [],
      });
    }),
  );

  it.effect('passes a valid diagram of each common kind', () =>
    Effect.gen(function* () {
      expect(yield* checkMermaid(body(...VALID))).toEqual({
        invalid: [],
        unchecked: [],
      });
    }),
  );

  it.effect(
    'names the fence Mermaid cannot parse, with Mermaid’s own message',
    () =>
      Effect.gen(function* () {
        const { invalid, unchecked } = yield* checkMermaid(
          body(VALID[0] ?? '', BROKEN),
        );
        expect(unchecked).toEqual([]);
        expect(invalid).toHaveLength(1);
        expect(invalid[0]?.fence).toBe(2);
        expect(invalid[0]?.message).toContain('Parse error on line 5');
        expect(invalid[0]?.message).toContain('...and no lock bypass."');
      }),
  );

  it.effect(
    'finds a statement split by a semicolon, and a fence of no known type',
    () =>
      Effect.gen(function* () {
        const split =
          'sequenceDiagram\n  A->>B: one writer; and no lock bypass';
        const { invalid } = yield* checkMermaid(
          body(split, 'notADiagram\n  x'),
        );
        expect(invalid.map((i) => i.fence)).toEqual([1, 2]);
      }),
  );

  it.effect('an ask refuses the body, naming the fence and the line', () =>
    Effect.gen(function* () {
      const e = yield* Effect.flip(refuseInvalidMermaid('ask', body(BROKEN)));
      expect(e._tag).toBe('InputError');
      expect(e.message).toMatch(
        /^inbox ask: Mermaid cannot parse a diagram in the body/,
      );
      expect(e.message).toContain('Nothing was posted');
      expect(e.message).toContain('mermaid fence 1: Parse error on line 5');
    }),
  );

  it.effect('an edit with a valid diagram goes through', () =>
    refuseInvalidMermaid('edit', body(VALID[1] ?? '')),
  );

  it('counts only Mermaid’s syntax errors as syntax errors', () => {
    expect(
      isSyntaxError(Object.assign(new Error('Parse error'), { hash: {} })),
    ).toBe(true);
    expect(
      isSyntaxError(
        Object.assign(new Error('x'), { name: 'UnknownDiagramError' }),
      ),
    ).toBe(true);
    expect(
      isSyntaxError(new Error('Parsing failed: Lexer error on line 2')),
    ).toBe(true);
    expect(
      isSyntaxError(new TypeError('DOMPurify.addHook is not a function')),
    ).toBe(false);
    expect(isSyntaxError('Parse error')).toBe(false);
  });
});
