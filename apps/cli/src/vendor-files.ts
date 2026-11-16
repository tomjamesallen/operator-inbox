// The vendored libraries `serve` hands an HTML block's frame under
// `/vendor/`, each by the name it is served under and the file in its npm
// package it is (`three` and `d3`, pinned exactly in the workspace catalog).
// Dependency-free, so the build's config reads it too: the build copies each
// into `dist/vendor/` (`tsup.config.ts`), and a run from source serves it
// from the package's `node_modules`. The names match core's
// `HTML_BLOCK_VENDOR_FILES`, which a test holds them to.
export const VENDOR_SOURCES = {
  'three.module.js': 'three/build/three.module.js',
  'three.core.js': 'three/build/three.core.js',
  'three-addons/controls/OrbitControls.js':
    'three/examples/jsm/controls/OrbitControls.js',
  'd3.min.js': 'd3/dist/d3.min.js',
} as const;

export type VendorFile = keyof typeof VENDOR_SOURCES;

export const isVendorFile = (name: string): name is VendorFile =>
  Object.hasOwn(VENDOR_SOURCES, name);
