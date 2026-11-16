import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';
import { VENDOR_SOURCES } from './src/vendor-files';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Bundle the workspace core so the globally-linked bin is self-contained.
  noExternal: [/^@operator-inbox\//],
  // ESM bundle: shebang + a real `require` so bundled CJS deps and node
  // builtins resolve instead of hitting esbuild's throwing __require shim.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __operatorInboxCreateRequire } from 'node:module';",
      'const require = __operatorInboxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  // What the bin reads beside its code, found relative to it
  // (`src/package-paths.ts`): the assets, and the web build when there is one.
  onSuccess: async () => {
    cpSync('assets', 'dist/assets', { recursive: true });
    // The libraries an HTML block may load, served under /vendor/
    // (`src/serve-vendor.ts`).
    for (const [name, source] of Object.entries(VENDOR_SOURCES)) {
      const to = path.join('dist', 'vendor', name);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(path.join('node_modules', source), to);
    }
    if (existsSync('../web/dist/index.html')) {
      cpSync('../web/dist', 'dist/web', { recursive: true });
    }
  },
});
