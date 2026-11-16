import { SERVE_DEFAULT_PORT } from '@operator-inbox/core/api';
import { describe, expect, it } from 'vitest';
import { EXCALIDRAW_ASSET_PATH } from '../src/drawings';
import config, { EXCALIDRAW_ASSETS } from '../vite.config';

// The dev server's /api proxy to `operator-inbox serve`. Nothing else exercises it
// in a test, and each setting below breaks the dev app in a way no other test
// would notice.
describe('the dev server proxy', () => {
  const api = config.server?.proxy?.['/api'];

  it('targets serve on its default port, on 127.0.0.1', () => {
    expect(typeof api).toBe('object');
    if (typeof api !== 'object') return;
    expect(api.target).toBe(`http://127.0.0.1:${SERVE_DEFAULT_PORT}`);
  });

  // Without `changeOrigin` the browser's Host (the dev server's) is forwarded,
  // and serve's DNS-rebinding guard answers every request 421.
  it('rewrites Host to the target (changeOrigin)', () => {
    expect(typeof api).toBe('object');
    if (typeof api !== 'object') return;
    expect(api.changeOrigin).toBe(true);
  });
});

// The page tells Excalidraw where its fonts are; the build puts them there.
describe('Excalidraw’s fonts', () => {
  it('are looked for where the build copies them', () => {
    expect(EXCALIDRAW_ASSET_PATH).toBe(`/${EXCALIDRAW_ASSETS}`);
  });
});
