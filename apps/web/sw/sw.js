// The app's service worker. It exists so the app installs as a PWA
// and opens without a network round trip for its SHELL — and for nothing
// else. It NEVER caches the data: `/api/*` passes straight through to
// `operator-inbox serve`, untouched, because current data is the whole point of the
// served app.
//
// A template: `vite build` (the `operator-inbox-service-worker` plugin in
// `vite.config.ts`) writes `dist/sw.js` from it, replacing BUILD with an id
// of this build and SHELL with the built files. Plain script, no
// `importScripts`, so a test can run it as it ships.

const BUILD = '__BUILD__';
const SHELL = /* @shell */ ['/'];

// One cache per build. A new build installs beside the old one, and the old
// one is deleted when the new worker activates.
const PREFIX = 'operator-inbox-shell-';
const CACHE = PREFIX + BUILD;

// What the worker does with a request — the routing decision, pure:
// - 'pass':     not ours; the browser fetches it as if there were no worker.
//               Every `/api` request, every non-GET, every other origin.
// - 'navigate': a page load. Network first, so a new build is picked up the
//               moment it is served; the cached shell only when offline.
// - 'shell':    a built asset or a shell file. Cache first: Vite names its
//               assets by content hash, and a new build is a new cache.
function routeOf(url, method, mode, origin) {
  if (method !== 'GET') return 'pass';
  if (url.origin !== origin) return 'pass';
  if (url.pathname === '/api' || url.pathname.startsWith('/api/'))
    return 'pass';
  if (mode === 'navigate') return 'navigate';
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    return 'shell';
  }
  return 'pass';
}

// Whether a page load's response may become the offline shell — pure. A tab
// can navigate to any file (the manifest, an icon, this worker, a built
// asset), and storing that as '/' would replace the app with it. So only an
// HTML response, for a URL with no file extension in its last segment, and
// never `/api`.
function isShellPage(url, contentType) {
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  if (last.includes('.')) return false;
  return (contentType || '').toLowerCase().startsWith('text/html');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const route = routeOf(
    new URL(req.url),
    req.method,
    req.mode,
    self.location.origin,
  );
  if (route === 'pass') return;
  if (route === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (
            res.ok &&
            isShellPage(new URL(req.url), res.headers.get('content-type'))
          ) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error())),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
