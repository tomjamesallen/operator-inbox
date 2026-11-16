import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// The local app's client. `operator-inbox serve` hosts the built `dist/`
// itself; under the Vite dev server, /api is proxied to serve.
//
// The port is core's `SERVE_DEFAULT_PORT` (`@operator-inbox/core/api`),
// repeated here because a Vite config is loaded by node, which cannot import a
// workspace package's TypeScript source. A serve started on another `--port`
// needs this edited to match: no env override, because the repo reads env
// through Effect `Config` only.
const SERVE_PORT = 7184;
const SERVE_TARGET = `http://127.0.0.1:${SERVE_PORT}`;

// The files under `public/` the shell needs offline: the manifest and its
// icons. Vite copies them as they are, so they are not in the bundle.
export const PUBLIC_SHELL = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
] as const;

type BundleEntry = {
  readonly type?: string;
  readonly isEntry?: boolean;
  readonly facadeModuleId?: string | null;
  readonly imports?: ReadonlyArray<string>;
  readonly dynamicImports?: ReadonlyArray<string>;
};

/**
 * The chunks a library loads only on demand: those reached only through a
 * dynamic import of a package (a chunk whose own module is under
 * `node_modules`), such as Mermaid's hundred diagram chunks behind
 * `import('mermaid')`. The shell leaves them out, so installing the worker
 * does not download megabytes nobody has asked for; the worker caches each
 * one the first time it is fetched. The app's own dynamic imports stay in.
 */
export const lazyLibraryChunks = (
  bundle: Readonly<Record<string, BundleEntry>>,
): ReadonlySet<string> => {
  const chunks = Object.entries(bundle).filter(([, c]) => c.type === 'chunk');
  const isLibrary = (file: string) =>
    (bundle[file]?.facadeModuleId ?? '').includes('/node_modules/');
  const kept = new Set<string>();
  const visit = (file: string) => {
    if (kept.has(file)) return;
    kept.add(file);
    const chunk = bundle[file];
    for (const next of chunk?.imports ?? []) visit(next);
    for (const next of chunk?.dynamicImports ?? [])
      if (!isLibrary(next)) visit(next);
  };
  for (const [file, chunk] of chunks) if (chunk.isEntry === true) visit(file);
  return new Set(
    chunks.map(([file]) => file).filter((file) => !kept.has(file)),
  );
};

// Writes `dist/sw.js` from the `sw/sw.js` template: SHELL becomes `/`, every
// built asset except a library's on-demand chunks (`lazyLibraryChunks`) and
// `PUBLIC_SHELL`; BUILD becomes a hash of that list and the
// template, so a build that changes anything the worker caches gets a cache
// of its own, and the old one is deleted when it activates.
export const serviceWorker = (): Plugin => ({
  name: 'operator-inbox-service-worker',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const template = readFileSync(
      new URL('./sw/sw.js', import.meta.url),
      'utf8',
    );
    const lazy = lazyLibraryChunks(bundle);
    const assets = Object.keys(bundle)
      .filter((f) => f.startsWith('assets/') && !lazy.has(f))
      .sort()
      .map((f) => `/${f}`);
    const shell = ['/', ...assets, ...PUBLIC_SHELL];
    const build = createHash('sha256')
      .update(template)
      .update(shell.join('\n'))
      .digest('hex')
      .slice(0, 12);
    const marked = /\/\* @shell \*\/ \[[^\]]*\]/;
    if (!marked.test(template) || !template.includes("'__BUILD__'"))
      this.error('sw/sw.js has lost its SHELL or BUILD placeholder');
    this.emitFile({
      type: 'asset',
      fileName: 'sw.js',
      source: template
        .replace("'__BUILD__'", JSON.stringify(build))
        .replace(marked, JSON.stringify(shell)),
    });
  },
});

// How many builds' assets stay in `dist/assets`: this one and the ones before.
export const BUILDS_KEPT = 5;

// Where the kept builds are listed, inside `dist`.
const BUILDS_FILE = '.builds.json';

/**
 * Which builds' assets to keep, newest first — pure. `current` goes first; a
 * build that lists exactly the same files as the newest kept one (a rebuild
 * with nothing changed) is not counted twice.
 */
export const keptBuilds = (
  previous: ReadonlyArray<ReadonlyArray<string>>,
  current: ReadonlyArray<string>,
  keep: number = BUILDS_KEPT,
): ReadonlyArray<ReadonlyArray<string>> => {
  const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
    a.length === b.length && a.every((f, i) => f === b[i]);
  const sorted = [...current].sort();
  const earlier = previous.filter((b) => b.length > 0 && !same(b, sorted));
  return [sorted, ...earlier].slice(0, keep);
};

/** The files on disk that no kept build lists — pure. */
export const staleAssets = (
  onDisk: ReadonlyArray<string>,
  builds: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const kept = new Set(builds.flat());
  return onDisk.filter((f) => !kept.has(f));
};

/**
 * Keeps the assets of the last few builds in `dist/assets`, not only this
 * one's. A page opened before a rebuild still runs the old build's code, and
 * that code asks for the old build's file names when it loads a chunk on
 * demand (Mermaid, the first time a diagram is opened). Vite's default
 * empties `dist` on every build, so the old names answer 404 and the import
 * fails ("Importing a module script failed" in Safari). So `dist` is not
 * emptied, and this step deletes only the assets of builds older than the
 * last `BUILDS_KEPT`. `index.html`, `sw.js` and the public files are written
 * over by each build as before.
 */
export const keepEarlierBuilds = (): Plugin => ({
  name: 'operator-inbox-keep-earlier-builds',
  apply: 'build',
  writeBundle(options, bundle) {
    const dir = options.dir;
    if (dir === undefined) return;
    const assetsDir = join(dir, 'assets');
    const listFile = join(dir, BUILDS_FILE);
    const current = Object.keys(bundle).filter((f) => f.startsWith('assets/'));
    const onDisk = existsSync(assetsDir)
      ? readdirSync(assetsDir).map((f) => `assets/${f}`)
      : [];
    // No list yet (the first build with this step): what is already on disk
    // from the build before counts as one earlier build, so it is kept too.
    const previous: ReadonlyArray<ReadonlyArray<string>> = existsSync(listFile)
      ? JSON.parse(readFileSync(listFile, 'utf8'))
      : [onDisk.filter((f) => !current.includes(f)).sort()];
    const builds = keptBuilds(previous, current);
    for (const file of staleAssets(onDisk, builds))
      rmSync(join(dir, file), { force: true });
    writeFileSync(listFile, `${JSON.stringify(builds, null, 2)}\n`);
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker(), keepEarlierBuilds()],
  build: {
    // `keepEarlierBuilds` clears out old assets instead; see there.
    emptyOutDir: false,
  },
  server: {
    // The dev server is as local as the API it fronts.
    host: '127.0.0.1',
    proxy: {
      // `changeOrigin` rewrites the forwarded `Host` to the target's own
      // `127.0.0.1:<port>`. It is required: `operator-inbox serve` answers only a
      // request whose `Host` names it (its DNS-rebinding guard), and the
      // browser's `Host` here is the dev server's.
      //
      // `Origin` needs the same treatment for writes: a browser sends it on
      // every POST, same-origin included, and serve refuses (403) any `Origin`
      // that is not its own. So a request whose `Origin` is THIS dev server's
      // own origin is forwarded as coming from the target. Any other `Origin`
      // passes through untouched, so serve still refuses a cross-site page
      // that reaches it through the dev server. Serve's allowed list is not
      // widened (see its `localOnly`).
      '/api': {
        target: SERVE_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin;
            const host = req.headers.host;
            if (origin !== undefined && origin === `http://${host}`)
              proxyReq.setHeader('origin', SERVE_TARGET);
          });
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    // An http origin, as the served app has: the typed client resolves its
    // relative `/api/…` against `location`, which is about:blank otherwise.
    environmentOptions: { happyDOM: { url: 'http://127.0.0.1:5173/' } },
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
