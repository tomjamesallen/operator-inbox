// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  EXCALIDRAW_ASSETS,
  excalidrawFonts,
  LIBRARY_DOORS,
  lazyLibraryChunks,
  PUBLIC_SHELL,
  serviceWorker,
} from '../vite.config';

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

  // Excalidraw comes in through an app module of its own, which imports it
  // and its stylesheet (and the stylesheet names fonts): all of it is loaded
  // on demand, so none of it is the shell's.
  it('leaves out a library door’s chunk, the library behind it, and the stylesheet and fonts they bring', () => {
    const door = LIBRARY_DOORS[0];
    const bundle = {
      'assets/index-b2.js': {
        type: 'chunk',
        isEntry: true,
        facadeModuleId: '/app/src/main.tsx',
        imports: ['assets/shared-s1.js'],
        dynamicImports: ['assets/drawing-canvas-d1.js'],
        viteMetadata: { importedCss: new Set(['assets/index-a1.css']) },
      },
      'assets/shared-s1.js': { type: 'chunk', facadeModuleId: null },
      'assets/drawing-canvas-d1.js': {
        type: 'chunk',
        facadeModuleId: `/app${door}`,
        imports: ['assets/shared-s1.js', 'assets/chunk-x1.js'],
        dynamicImports: ['assets/locale-l1.js'],
        viteMetadata: {
          importedCss: new Set(['assets/drawing-canvas-c1.css']),
          importedAssets: new Set(['assets/Assistant-Regular-f1.woff2']),
        },
      },
      'assets/chunk-x1.js': { type: 'chunk', facadeModuleId: null },
      'assets/locale-l1.js': {
        type: 'chunk',
        facadeModuleId:
          '/app/node_modules/@excalidraw/excalidraw/dist/prod/locales/fr.js',
      },
      'assets/index-a1.css': { type: 'asset' },
      'assets/drawing-canvas-c1.css': { type: 'asset' },
      'assets/Assistant-Regular-f1.woff2': { type: 'asset' },
      'index.html': { type: 'asset' },
    };
    expect([...lazyLibraryChunks(bundle)].sort()).toEqual([
      'assets/Assistant-Regular-f1.woff2',
      'assets/chunk-x1.js',
      'assets/drawing-canvas-c1.css',
      'assets/drawing-canvas-d1.js',
      'assets/locale-l1.js',
    ]);
    expect(constantsOf(emit(bundle).source).SHELL).toEqual([
      '/',
      '/assets/index-a1.css',
      '/assets/index-b2.js',
      '/assets/shared-s1.js',
      ...PUBLIC_SHELL,
    ]);
  });

  it('keeps a stylesheet a kept chunk brings in, even when a lazy one brings it too', () => {
    const bundle = {
      'assets/index-b2.js': {
        type: 'chunk',
        isEntry: true,
        facadeModuleId: '/app/src/main.tsx',
        dynamicImports: ['assets/lib-l1.js'],
        viteMetadata: { importedCss: new Set(['assets/shared-a1.css']) },
      },
      'assets/lib-l1.js': {
        type: 'chunk',
        facadeModuleId: '/app/node_modules/lib/index.js',
        viteMetadata: { importedCss: new Set(['assets/shared-a1.css']) },
      },
      'assets/shared-a1.css': { type: 'asset' },
    };
    expect([...lazyLibraryChunks(bundle)]).toEqual(['assets/lib-l1.js']);
  });

  it('leaves the rest of the template as it is', () => {
    const { source } = emit(BUNDLE);
    const tail = (s: string) => s.slice(s.indexOf('// One cache per build.'));
    expect(tail(source)).toBe(tail(TEMPLATE));
  });
});

// Excalidraw's fonts, self-hosted: the build copies every one into
// `dist/excalidraw/fonts`, outside `assets/`, which is where the page tells
// Excalidraw to look (`EXCALIDRAW_ASSET_PATH`) and where the worker's shell
// never reaches.
describe('the Excalidraw fonts build step', () => {
  it('copies the package’s fonts under excalidraw/fonts, none into assets/', () => {
    const emitFile = vi.fn();
    const hook = excalidrawFonts().generateBundle;
    if (typeof hook !== 'function') throw new Error('no generateBundle');
    hook.call({ emitFile } as never, {} as never, {} as never, false);
    const names = emitFile.mock.calls.map(
      ([file]) => (file as { fileName: string }).fileName,
    );
    expect(EXCALIDRAW_ASSETS).toBe('excalidraw/');
    expect(names.length).toBeGreaterThan(8);
    expect(names.every((n) => n.startsWith('excalidraw/fonts/'))).toBe(true);
    expect(
      names.some((n) => /^excalidraw\/fonts\/Excalifont\/.+\.woff2$/.test(n)),
    ).toBe(true);
    expect(names.some((n) => n.startsWith('excalidraw/fonts/Virgil/'))).toBe(
      true,
    );
    const shell = constantsOf(
      emit(Object.fromEntries(names.map((n) => [n, { type: 'asset' }]))).source,
    ).SHELL;
    expect(shell.some((f) => f.includes('excalidraw'))).toBe(false);
  });
});

describe('the Excalidraw fonts under the dev server', () => {
  // The middleware the plugin mounts, at the path it mounts it.
  const middleware = () => {
    const use = vi.fn();
    const hook = excalidrawFonts().configureServer;
    if (typeof hook !== 'function') throw new Error('no configureServer');
    hook.call({} as never, { middlewares: { use } } as never);
    const [path, handler] = use.mock.calls[0] ?? [];
    return {
      path,
      handler: handler as (
        req: { url: string },
        res: unknown,
        next: () => void,
      ) => void,
    };
  };

  it('serves a font from the package at the path the page asks for', async () => {
    const { path, handler } = middleware();
    expect(path).toBe(`/${EXCALIDRAW_ASSETS}fonts`);
    const headers: Record<string, string> = {};
    const res = Object.assign(new PassThrough(), {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
    });
    const body = new Promise<number>((done) => {
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
      });
      res.on('end', () => done(n));
    });
    const next = vi.fn();
    handler({ url: '/Virgil/Virgil-Regular.woff2' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(await body).toBeGreaterThan(1000);
    expect(headers['content-type']).toBe('font/woff2');
  });

  it('passes on a name it does not hold, or one that climbs out of the fonts', () => {
    const { handler } = middleware();
    for (const url of [
      '/Virgil/nothing.woff2',
      '/../index.js',
      '/%2e%2e/package.json',
      '/Virgil',
    ]) {
      const next = vi.fn();
      handler({ url }, {}, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });
});
