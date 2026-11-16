// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { lazyLibraryChunks, PUBLIC_SHELL, serviceWorker } from '../vite.config';

// The `operator-inbox-service-worker` plugin's substitutions, run for real: its
// `generateBundle` is handed a stand-in bundle (cheaper than a whole build,
// and the same code path), and the `sw.js` it emits is run as the worker
// would run it, so the test reads SHELL and BUILD as the shipped file holds
// them. Node, not happy-dom: the plugin resolves its template against
// `import.meta.url`, which the DOM's `URL` cannot.

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(resolve(here, '..', 'sw', 'sw.js'), 'utf8');

const BUNDLE = {
  'assets/index-b2.js': {},
  'assets/index-a1.css': {},
  'index.html': {},
};

// Runs the plugin's `generateBundle` over `bundle` and answers the emitted
// file and any error it raised.
const emit = (bundle: Record<string, unknown>) => {
  const emitFile = vi.fn();
  const error = vi.fn((m: string) => {
    throw new Error(m);
  });
  const hook = serviceWorker().generateBundle;
  if (typeof hook !== 'function') throw new Error('no generateBundle');
  hook.call({ emitFile, error } as never, {} as never, bundle as never, false);
  expect(emitFile).toHaveBeenCalledTimes(1);
  return emitFile.mock.calls[0]?.[0] as {
    readonly type: string;
    readonly fileName: string;
    readonly source: string;
  };
};

// The emitted worker's SHELL and BUILD, read by running it.
const constantsOf = (source: string) => {
  const scope: Record<string, unknown> = {
    self: { addEventListener: () => {}, location: { origin: 'x' } },
  };
  runInNewContext(
    `${source}\n;globalThis.__out = { SHELL, BUILD, CACHE };`,
    scope,
  );
  return scope.__out as {
    readonly SHELL: readonly string[];
    readonly BUILD: string;
    readonly CACHE: string;
  };
};

describe('the service worker build step', () => {
  it('writes sw.js with the real shell list: /, every built asset, and the public shell files', () => {
    const out = emit(BUNDLE);
    expect(out.type).toBe('asset');
    expect(out.fileName).toBe('sw.js');
    const { SHELL } = constantsOf(out.source);
    expect(SHELL).toEqual([
      '/',
      '/assets/index-a1.css',
      '/assets/index-b2.js',
      ...PUBLIC_SHELL,
    ]);
  });

  it('stamps a build id that is no placeholder, and changes when the shell does', () => {
    const one = emit(BUNDLE);
    const { BUILD, CACHE } = constantsOf(one.source);
    expect(BUILD).toMatch(/^[0-9a-f]{12}$/);
    expect(CACHE).toBe(`operator-inbox-shell-${BUILD}`);
    expect(one.source).not.toContain('__BUILD__');
    expect(one.source).not.toContain('@shell');
    // The same inputs give the same id; another asset gives another.
    expect(constantsOf(emit(BUNDLE).source).BUILD).toBe(BUILD);
    const other = emit({ ...BUNDLE, 'assets/search-c3.js': {} });
    expect(constantsOf(other.source).BUILD).not.toBe(BUILD);
  });

  it('leaves out the chunks a library loads on demand, and keeps the app’s own', () => {
    const bundle = {
      'assets/index-b2.js': {
        type: 'chunk',
        isEntry: true,
        facadeModuleId: '/app/src/main.tsx',
        imports: ['assets/shared-s1.js'],
        dynamicImports: ['assets/search-c3.js', 'assets/mermaid.core-m1.js'],
      },
      'assets/shared-s1.js': { type: 'chunk', facadeModuleId: null },
      'assets/search-c3.js': {
        type: 'chunk',
        facadeModuleId: '/app/src/components/search.tsx',
        imports: ['assets/shared-s1.js'],
      },
      'assets/mermaid.core-m1.js': {
        type: 'chunk',
        facadeModuleId: '/app/node_modules/mermaid/dist/mermaid.core.mjs',
        imports: ['assets/shared-s1.js'],
        dynamicImports: ['assets/flowDiagram-f1.js'],
      },
      'assets/flowDiagram-f1.js': {
        type: 'chunk',
        facadeModuleId: '/app/node_modules/mermaid/dist/flowDiagram.mjs',
      },
      'assets/index-a1.css': { type: 'asset' },
      'index.html': { type: 'asset' },
    };
    expect([...lazyLibraryChunks(bundle)].sort()).toEqual([
      'assets/flowDiagram-f1.js',
      'assets/mermaid.core-m1.js',
    ]);
    expect(constantsOf(emit(bundle).source).SHELL).toEqual([
      '/',
      '/assets/index-a1.css',
      '/assets/index-b2.js',
      '/assets/search-c3.js',
      '/assets/shared-s1.js',
      ...PUBLIC_SHELL,
    ]);
  });

  it('leaves the rest of the template as it is', () => {
    const { source } = emit(BUNDLE);
    const tail = (s: string) => s.slice(s.indexOf('// One cache per build.'));
    expect(tail(source)).toBe(tail(TEMPLATE));
  });
});
