// Checks each ```mermaid fence in a question's body with Mermaid's own
// parser, so `ask` and `edit` refuse a diagram the page could not draw: the
// agent finds out as it asks, not the operator as they read.
//
// The fences are the ones the page draws, split by core's
// `renderQuestionParts`, and the parser is the same Mermaid the page bundles.
// Mermaid sanitises labels with DOMPurify as it parses most diagram types,
// and DOMPurify needs a `window`, so a happy-dom window stands in, installed
// once before Mermaid first loads. A body with no fence loads neither.
//
// Only a syntax error refuses. Anything else Mermaid throws here may be this
// stand-in's failing rather than the diagram's, so it is reported as a
// diagram that could not be checked, and the question is still asked.

import { renderQuestionParts } from '@operator-inbox/core';
import { Effect } from 'effect';

/** What the check found in one body. */
export interface MermaidCheck {
  /** Each fence Mermaid could not parse: its place among the fences (from 1) and Mermaid's message. */
  readonly invalid: ReadonlyArray<{
    readonly fence: number;
    readonly message: string;
  }>;
  /** Why fences went unchecked, when the parser could not be run on them. */
  readonly unchecked: ReadonlyArray<string>;
}

const NOTHING: MermaidCheck = { invalid: [], unchecked: [] };

interface Parser {
  readonly parse: (text: string) => Promise<unknown>;
}

// Mermaid's syntax errors, by the grammar that throws them: a jison grammar's
// error carries its parse `hash`, a Langium grammar's message opens with
// "Parsing failed", and a fence of no known type is an UnknownDiagramError.
export const isSyntaxError = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const { hash, name, message } = e as {
    readonly hash?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
  };
  return (
    (typeof hash === 'object' && hash !== null) ||
    name === 'UnknownDiagramError' ||
    (typeof message === 'string' && message.startsWith('Parsing failed'))
  );
};

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// One parser for the process: Mermaid binds DOMPurify to the window it first
// finds, so the window is installed once, before Mermaid's first import.
let parser: Promise<Parser> | undefined;

const loadParser = (): Promise<Parser> => {
  parser ??= (async () => {
    const scope = globalThis as { window?: unknown; document?: unknown };
    if (scope.window === undefined) {
      const { Window } = await import('happy-dom');
      const window = new Window();
      scope.window = window;
      scope.document = window.document;
    }
    const { default: mermaid } = await import('mermaid');
    return mermaid;
  })();
  return parser;
};

/** Parse every ```mermaid fence in `body`. Never fails: what it could not do is in `unchecked`. */
export const checkMermaid = (body: string): Effect.Effect<MermaidCheck> => {
  const sources = renderQuestionParts(body).flatMap((part) =>
    part.kind === 'mermaid' ? [part.source] : [],
  );
  if (sources.length === 0) return Effect.succeed(NOTHING);
  return Effect.promise(async (): Promise<MermaidCheck> => {
    let mermaid: Parser;
    try {
      mermaid = await loadParser();
    } catch (e) {
      return {
        invalid: [],
        unchecked: [`Mermaid did not load (${messageOf(e)})`],
      };
    }
    const invalid: Array<{ fence: number; message: string }> = [];
    const unchecked: Array<string> = [];
    for (const [i, source] of sources.entries()) {
      try {
        await mermaid.parse(source);
      } catch (e) {
        if (isSyntaxError(e))
          invalid.push({ fence: i + 1, message: messageOf(e) });
        else unchecked.push(`mermaid fence ${i + 1}: ${messageOf(e)}`);
      }
    }
    return { invalid, unchecked };
  });
};

/** The refusal for a body with fences Mermaid cannot parse, as one message. */
export const mermaidRefusal = (
  verb: string,
  invalid: MermaidCheck['invalid'],
): string =>
  [
    `inbox ${verb}: Mermaid cannot parse ${invalid.length === 1 ? 'a diagram' : `${invalid.length} diagrams`} in the body, so the page would show an error in place of ${invalid.length === 1 ? 'it' : 'them'}. Nothing was posted; fix the fence and try again (line numbers count from the fence's first line):`,
    ...invalid.map(
      ({ fence, message }) =>
        `  mermaid fence ${fence}: ${message.split('\n').join('\n    ')}`,
    ),
  ].join('\n');
