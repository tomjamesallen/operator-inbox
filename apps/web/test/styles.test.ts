import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

// By path, as pwa.test.ts reads its files.
const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '..', 'src', 'index.css');
// Tailwind's package root: up from its entry point to its package.json.
const tailwindDir = (() => {
  let dir = dirname(createRequire(import.meta.url).resolve('tailwindcss'));
  while (!existsSync(resolve(dir, 'package.json'))) dir = dirname(dir);
  return dir;
})();

// The stylesheet as Tailwind compiles it, so a test reads what the build
// emits rather than the text that asks for it.
const build = async (candidates: string[]): Promise<string> => {
  const compiler = await compile(readFileSync(cssPath, 'utf8'), {
    base: dirname(cssPath),
    loadStylesheet: async (id, base) => {
      // `tailwindcss` itself, and any relative import index.css adds (Tailwind's
      // own stylesheets import nothing). Anything else is a new import this
      // loader must be taught, said as that rather than as a missing file.
      const path =
        id === 'tailwindcss'
          ? resolve(tailwindDir, 'index.css')
          : id.startsWith('.')
            ? resolve(base, id)
            : undefined;
      if (path === undefined)
        throw new Error(`styles.test.ts cannot load @import "${id}"; add it`);
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
  });
  return compiler.build(candidates);
};

describe('the stylesheet', () => {
  // Tailwind v4 puts `hover:` and `group-hover:` inside `@media (hover:
  // hover)`, where a touch screen never matches. The minimap's labels are
  // revealed by `group-hover:`, so a hover utility wrapped that way would
  // leave a tap no way to reach them.
  it('emits hover: and group-hover: as plain :hover, with no hover media query', async () => {
    const css = await build(['hover:text-blue', 'group-hover:opacity-100']);
    expect(css).toMatch(/\.hover\\:text-blue:hover/);
    expect(css).toMatch(
      /:is\(:where\(\.group\):hover \.group-hover\\:opacity-100\)/,
    );
    expect(css).not.toMatch(/@media \(hover/);
  });

  // A greyed machine's fade (`FADED`) halves
  // a greyed part, focus ring and all, so a part holding keyboard focus is
  // left at full strength while it does: on itself, or on a control inside.
  it('leaves a greyed part holding keyboard focus at full strength', async () => {
    const css = await build([
      'group-data-greyed/greyed:not-focus-visible:not-has-focus-visible:opacity-50',
    ]);
    expect(css).toContain(
      ':is(:where(.group\\/greyed)[data-greyed] .group-data-greyed\\/greyed\\:not-focus-visible\\:not-has-focus-visible\\:opacity-50):not(:focus-visible):not(:has(:focus-visible)) {\n    opacity: 50%;',
    );
  });

  // The card stack and the ask list: their height, their rows' first line,
  // and the soft edge drawn from a theme token, never a bracketed literal.
  it('draws the card stack’s and the ask list’s tokens', async () => {
    const css = await build([
      'max-h-cards',
      'h-field',
      'py-field-pad',
      'scroll-my-fade',
      'data-fade-top:mask-t-from-(--fade-from)',
      'data-fade-bottom:mask-b-from-(--fade-from)',
    ]);
    expect(css).toContain('max-height: var(--max-height-cards)');
    expect(css).toContain('height: var(--spacing-field)');
    expect(css).toContain('var(--spacing-field-pad)');
    expect(css).toContain('scroll-margin-block: var(--spacing-fade)');
    expect(css).toMatch(
      /\[data-fade-top\][\s\S]*--tw-mask-top-from-position: var\(--fade-from\)/,
    );
    expect(css).toMatch(
      /\[data-fade-bottom\][\s\S]*--tw-mask-bottom-from-position: var\(--fade-from\)/,
    );
  });

  // A question's table scrolls sideways in core's `data-table-scroll` div,
  // and on a phone its columns keep a minimum width rather than breaking
  // words mid-word to fit the screen.
  it('scrolls a wide table in its box, with readable columns on a phone', async () => {
    const css = await build([]);
    expect(css).toMatch(
      /\[data-question-body\] \[data-table-scroll\] \{\s*overflow-x: auto;/,
    );
    expect(css).toMatch(
      /@media \(width < 48rem\) \{\s*\[data-question-body\] :is\(th, td\) \{\s*min-width: var\(--container-cell\);/,
    );
    expect(css).toContain('--container-cell: 12ch');
    expect(css).not.toMatch(
      /\[data-question-body\] table \{[^}]*overflow-wrap: anywhere/,
    );
  });
});
