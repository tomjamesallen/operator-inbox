// A page left open keeps running the build it loaded. A phone rarely reloads
// one: a Safari tab or a home-screen app comes back from the background as it
// was, so after the server moves to a new build it can go on showing the old
// interface over current data for days. So each time the page comes back into
// view it asks the service worker to look for a new build. The worker takes
// over at once when there is one (`sw/sw.js`: `skipWaiting`, then
// `clients.claim`), and the page reloads onto it. Drafts live in
// sessionStorage, so a reload keeps them.

/** The parts of `navigator.serviceWorker` this needs. */
export interface WorkerContainer {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

/** The parts of the registration this needs. */
export interface WorkerRegistration {
  update(): Promise<unknown>;
}

/** The parts of `document` this needs. */
export interface VisibleDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

export const refreshOnNewBuild = ({
  container,
  registration,
  doc,
  reload,
}: {
  readonly container: WorkerContainer;
  readonly registration: WorkerRegistration;
  readonly doc: VisibleDocument;
  readonly reload: () => void;
}): void => {
  // The first worker to install also takes control of the page, and that is
  // no new build: the page already runs what it caches.
  let controlled = container.controller !== null;
  let reloading = false;
  container.addEventListener('controllerchange', () => {
    if (controlled && !reloading) {
      reloading = true;
      reload();
    }
    controlled = true;
  });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') return;
    registration.update().catch(() => {
      // Offline or the server is down: the next return to view tries again.
    });
  });
};
