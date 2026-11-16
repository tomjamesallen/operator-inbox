import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// The PWA's pieces as they ship: the service worker's source run as a script
// against a stand-in worker scope, the manifest, and the page's theme colours.

// By path, not `new URL(rel, import.meta.url)`: under happy-dom the global
// `URL` is the DOM's, which does not resolve against a file URL.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
  readFileSync(resolve(here, '..', rel), 'utf8');

type Listener = (event: unknown) => void;

// Runs `sw/sw.js` with a fake `self` and answers its listeners and its
// routing function.
const loadWorker = () => {
  const listeners = new Map<string, Listener>();
  const caches = {
    open: vi.fn(async () => ({ addAll: vi.fn(), put: vi.fn() })),
    match: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const fetch = vi.fn(async () => new Response('net'));
  const self = {
    location: { origin: 'http://127.0.0.1:7184' },
    addEventListener: (type: string, f: Listener) => listeners.set(type, f),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const scope: Record<string, unknown> = {
    self,
    caches,
    fetch,
    URL,
    Response,
    Promise,
  };
  runInNewContext(read('sw/sw.js'), scope);
  const routeOf = scope.routeOf as (
    url: URL,
    method: string,
    mode: string,
    origin: string,
  ) => string;
  const isShellPage = scope.isShellPage as (
    url: URL,
    contentType: string | null,
  ) => boolean;
  return { listeners, routeOf, isShellPage, caches, fetch };
};

// A fetch event the worker either answers (`respondWith`) or leaves alone.
const fetchEvent = (url: string, mode = 'cors', method = 'GET') => {
  const respondWith = vi.fn();
  return {
    event: { request: { url, method, mode }, respondWith },
    respondWith,
  };
};

describe('the service worker', () => {
  const ORIGIN = 'http://127.0.0.1:7184';

  it('never intercepts /api — the data always comes from the network', () => {
    const { listeners, caches, fetch } = loadWorker();
    const onFetch = listeners.get('fetch');
    if (onFetch === undefined) throw new Error('no fetch listener');
    for (const path of ['/api/inbox-board', '/api', '/api/x?y=1']) {
      for (const mode of ['cors', 'navigate', 'same-origin']) {
        const { event, respondWith } = fetchEvent(`${ORIGIN}${path}`, mode);
        onFetch(event);
        expect(respondWith, `${path} ${mode}`).not.toHaveBeenCalled();
      }
    }
    expect(caches.match).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes a page load network-first, a built asset from the shell cache, and passes the rest', () => {
    const { routeOf } = loadWorker();
    const at = (p: string) => new URL(`${ORIGIN}${p}`);
    expect(routeOf(at('/'), 'GET', 'navigate', ORIGIN)).toBe('navigate');
    expect(routeOf(at('/#{"view":"board"}'), 'GET', 'navigate', ORIGIN)).toBe(
      'navigate',
    );
    expect(routeOf(at('/assets/index-abc.js'), 'GET', 'cors', ORIGIN)).toBe(
      'shell',
    );
    expect(routeOf(at('/api/inbox-board'), 'GET', 'cors', ORIGIN)).toBe('pass');
    expect(routeOf(at('/api/inbox-board'), 'GET', 'navigate', ORIGIN)).toBe(
      'pass',
    );
    expect(routeOf(at('/assets/x.js'), 'POST', 'cors', ORIGIN)).toBe('pass');
    expect(
      routeOf(
        new URL('https://example.com/assets/x.js'),
        'GET',
        'cors',
        ORIGIN,
      ),
    ).toBe('pass');
    expect(routeOf(at('/elsewhere.txt'), 'GET', 'cors', ORIGIN)).toBe('pass');
  });

  it('keeps a page load as the offline shell only when it is an HTML page, never a file or /api', () => {
    const { isShellPage } = loadWorker();
    const at = (p: string) => new URL(`${ORIGIN}${p}`);
    const html = 'text/html; charset=utf-8';
    expect(isShellPage(at('/'), html)).toBe(true);
    expect(isShellPage(at('/#{"view":"board"}'), html)).toBe(true);
    expect(isShellPage(at('/?q=1'), 'text/html')).toBe(true);
    expect(isShellPage(at('/some/page'), 'TEXT/HTML')).toBe(true);
    // A file opened in a tab is a navigation too, and must not replace it.
    for (const p of [
      '/manifest.webmanifest',
      '/icons/icon-192.png',
      '/sw.js',
      '/assets/index-abc.js',
    ])
      expect(isShellPage(at(p), html), p).toBe(false);
    expect(isShellPage(at('/'), 'application/json')).toBe(false);
    expect(isShellPage(at('/'), null)).toBe(false);
    expect(isShellPage(at('/api/inbox-board'), html)).toBe(false);
    expect(isShellPage(at('/api'), html)).toBe(false);
  });

  it('stores a non-HTML navigation nowhere', async () => {
    const { listeners, caches, fetch } = loadWorker();
    fetch.mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/manifest+json' },
      }),
    );
    const { event, respondWith } = fetchEvent(
      `${ORIGIN}/manifest.webmanifest`,
      'navigate',
    );
    listeners.get('fetch')?.(event);
    await respondWith.mock.calls[0]?.[0];
    expect(caches.open).not.toHaveBeenCalled();
  });

  it('stores an HTML navigation as the shell', async () => {
    const { listeners, caches, fetch } = loadWorker();
    fetch.mockResolvedValue(
      new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    const { event, respondWith } = fetchEvent(`${ORIGIN}/`, 'navigate');
    listeners.get('fetch')?.(event);
    await respondWith.mock.calls[0]?.[0];
    expect(caches.open).toHaveBeenCalledTimes(1);
  });

  it('answers a page load from the network', () => {
    const { listeners, fetch } = loadWorker();
    const { event, respondWith } = fetchEvent(`${ORIGIN}/`, 'navigate');
    listeners.get('fetch')?.(event);
    expect(respondWith).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('deletes every older shell cache when it activates, and nothing else', async () => {
    const { listeners, caches } = loadWorker();
    caches.keys.mockResolvedValue([
      'operator-inbox-shell-__BUILD__',
      'operator-inbox-shell-old',
      'someone-elses-cache',
    ] as never);
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('activate')?.({
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
    });
    await done;
    expect(caches.delete).toHaveBeenCalledTimes(1);
    expect(caches.delete).toHaveBeenCalledWith('operator-inbox-shell-old');
  });
});

describe('the manifest and the theme colour', () => {
  it('is installable: a name, standalone, rooted at /, and a 192 and a 512 PNG', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'));
    expect(m.name).toBe('Operator Inbox');
    expect(m.short_name).toBeTruthy();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    const sizes = m.icons
      .filter((i: { type: string }) => i.type === 'image/png')
      .map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(
      m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable'),
    ).toBe(true);
  });

  it("matches the page's own background in each colour scheme", () => {
    const css = read('src/index.css');
    const html = read('index.html');
    // The page's background is the `bg` token: light in the @theme block,
    // dark in the prefers-color-scheme block that swaps it.
    expect(html).toMatch(/<body\s+class="[^"]*\bbg-bg\b/);
    const block = (opener: RegExp): string => {
      const at = css.search(opener);
      if (at < 0) throw new Error(`no block ${opener}`);
      return css.slice(at, css.indexOf('}', at));
    };
    // A colour as its three channels, from rgb(r g b) or #rrggbb.
    const rgbOf = (block: string): number[] => {
      const v = /--color-bg:\s*rgb\((\d+) (\d+) (\d+)\);/.exec(block);
      if (v === null) throw new Error('no --color-bg');
      return v.slice(1).map(Number);
    };
    const hexOf = (hex: string): number[] =>
      [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const light = rgbOf(block(/@theme\s*\{/));
    const dark = rgbOf(block(/@media \(prefers-color-scheme: dark\)\s*\{/));
    expect([light, dark]).toEqual([
      [253, 252, 250],
      [0, 0, 0],
    ]);
    const meta = (scheme: string): number[] => {
      const m = new RegExp(
        `<meta name="theme-color" media="\\(prefers-color-scheme: ${scheme}\\)" content="(#[0-9a-f]{6})" />`,
        'i',
      ).exec(html);
      if (m === null) throw new Error(`no ${scheme} theme-color meta`);
      return hexOf(m[1] ?? '');
    };
    expect(meta('light')).toEqual(light);
    expect(meta('dark')).toEqual(dark);
    const m = JSON.parse(read('public/manifest.webmanifest'));
    expect(hexOf(m.theme_color)).toEqual(light);
    expect(hexOf(m.background_color)).toEqual(light);
    expect(html).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" />',
    );
  });
});
