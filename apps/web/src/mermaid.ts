import { Effect } from 'effect';
import { Atom } from 'effect/reactivity';

// Mermaid diagrams in inbox question bodies. The
// library is loaded with a dynamic import the first time a diagram is opened,
// so it is its own chunk and costs nothing on a page with no open diagram.
//
// A diagram is drawn to SVG text and shown as an `<img>` with a `data:` URL,
// as a ```svg fence is: an SVG loaded as an image runs no script and fetches
// nothing. Mermaid's own `strict` security level cleans its input too. Labels
// are drawn as SVG text, not HTML, because an image does not lay out HTML.

// Mermaid needs a fresh element id for each drawing.
let drawn = 0;

const prefersDark = (): boolean =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-color-scheme: dark)').matches;

// Fixed sizes rather than "100% of the container", so the image has a size
// of its own: the card scales it down, the full-screen view scales it up.
const fixedSize = { useMaxWidth: false, htmlLabels: false };

// What the reader is told when the library itself does not load. The usual
// cause is a page opened before a rebuild asking for a file the build has
// since removed (the build keeps a few earlier builds' files; see
// `keepEarlierBuilds` in vite.config.ts). A reload fetches the current build.
export const mermaidLoadFailure = (e: unknown): string =>
  `Mermaid did not load (${String(e)}). The app may have been rebuilt since this page opened: reload the page.`;

const loadMermaid = Effect.tryPromise({
  try: () => import('mermaid'),
  catch: mermaidLoadFailure,
}).pipe(
  Effect.map(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: prefersDark() ? 'dark' : 'default',
      htmlLabels: false,
      flowchart: fixedSize,
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false },
    });
    return mermaid;
  }),
);

/** SVG text as a `data:` URL an `<img>` can show. */
export const svgDataUrl = (svg: string): string => {
  let binary = '';
  for (const b of new TextEncoder().encode(svg))
    binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

// One drawing per diagram source: the image's `data:` URL, or the reason
// Mermaid could not draw it. Read only while a diagram is open.
export const mermaidImageAtom = Atom.family((source: string) =>
  Atom.make(
    Effect.gen(function* () {
      const mermaid = yield* loadMermaid;
      drawn += 1;
      const { svg } = yield* Effect.tryPromise({
        try: () => mermaid.render(`operator-inbox-mermaid-${drawn}`, source),
        catch: (e) => (e instanceof Error ? e.message : String(e)),
      });
      return svgDataUrl(svg);
    }),
  ),
);
