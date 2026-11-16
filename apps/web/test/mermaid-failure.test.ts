import { waitFor, within } from '@testing-library/react';
import { Cause } from 'effect';
import { AsyncResult, AtomRegistry } from 'effect/reactivity';
import { describe, expect, it } from 'vitest';
import { mermaidImageAtom } from '../src/mermaid';
import {
  asked,
  board,
  lit,
  mount,
  serve,
  useInboxPage,
  VIEW_A,
} from './inbox-page-harness';

// A diagram Mermaid cannot parse, drawn by the real library: its drawing
// fails with Mermaid's own message, the error shows in the diagram's own
// frame, and nothing of Mermaid's is left anywhere else on the page.
// Mermaid's default on a parse error is to draw its error picture into a
// scratch element on `document.body` and then throw without removing it, so
// the picture would sit at the foot of the page, outside every frame.

useInboxPage();

// A sequence diagram whose message carries on onto a line of its own: the
// shape that reads as a message with no arrow.
const BROKEN = [
  'sequenceDiagram',
  '  participant A',
  '  participant S',
  '  A->>S: take it',
  '  "Then a second waits and no lock bypass."',
].join('\n');

// Mermaid's error picture, and its scratch elements, by their marks.
const leftByMermaid = (outside: Element | null = null): ReadonlyArray<string> =>
  [...document.body.children]
    .filter((child) => child !== outside)
    .flatMap((child) => [
      ...(child.textContent?.includes('Syntax error in text')
        ? ['the error picture']
        : []),
      ...(child.id.includes('operator-inbox-mermaid') ? [child.id] : []),
    ]);

describe('a diagram Mermaid cannot parse', () => {
  it('fails with Mermaid’s message and leaves nothing on the page', async () => {
    const registry = AtomRegistry.make();
    const atom = mermaidImageAtom(BROKEN);
    const unmount = registry.mount(atom);
    await waitFor(
      () => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true),
      { timeout: 10_000 },
    );
    const result = registry.get(atom);
    const message = AsyncResult.isFailure(result)
      ? String(Cause.squash(result.cause))
      : '';
    expect(message).toContain('Parse error on line 5');
    expect(document.body.children).toHaveLength(0);
    unmount();
  }, 20_000);

  it('shows its error only in its own frame on the page', async () => {
    // Its own source, so the drawing above is not reused.
    const source = `${BROKEN}\n  "and again."`;
    serve.board = board([
      {
        ...VIEW_A,
        awaitingOperator: [
          {
            ...asked(1, 'First', 2),
            bodyParts: [
              { kind: 'html', html: '<p>Before.</p>' },
              { kind: 'mermaid', source },
              { kind: 'html', html: '<p>After.</p>' },
            ],
          },
        ],
      },
    ]);
    const { container } = mount();
    await waitFor(() => expect(lit()).not.toBeNull());
    const alert = await within(lit()).findByRole(
      'alert',
      {},
      { timeout: 10_000 },
    );
    expect(alert.closest('[data-mermaid]')).not.toBeNull();
    expect(alert.textContent).toContain('Parse error on line 5');
    expect(alert.textContent).toContain('no lock bypass');
    expect(leftByMermaid(container)).toEqual([]);
  }, 20_000);
});
