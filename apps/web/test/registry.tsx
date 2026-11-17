import {
  RegistryContext,
  type RegistryProvider,
  scheduleTask,
} from '@effect/atom-react';
import { cleanup } from '@testing-library/react';
import { AtomRegistry } from 'effect/reactivity';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { afterEach } from 'vitest';

// `RegistryProvider`, with the registry's end in the test's hands.
// `RegistryProvider` disposes its registry on a 500ms timer once it unmounts,
// and the atoms' finalizers run then (a `popstate` or `resize` listener taken
// off `window`). After a file's last test that timer can outlive the page:
// the environment is torn down, `window` is gone, and the finalizer throws an
// unhandled "window is not defined" into a run whose tests all passed. Here
// every registry is disposed as its test ends, while the page is still there.

const live = new Set<AtomRegistry.AtomRegistry>();

export const TestRegistry = ({
  children,
  initialValues,
}: {
  readonly children?: ReactNode;
  readonly initialValues?: ComponentProps<
    typeof RegistryProvider
  >['initialValues'];
}) => {
  const [registry] = useState(() => {
    const made = AtomRegistry.make({
      scheduleTask,
      ...(initialValues === undefined ? {} : { initialValues }),
    });
    live.add(made);
    return made;
  });
  return (
    <RegistryContext.Provider value={registry}>
      {children}
    </RegistryContext.Provider>
  );
};

// Unmounted first, so nothing still subscribed reads a disposed registry: a
// file's own `cleanup` may run before or after this one, and a second is a
// no-op.
afterEach(() => {
  cleanup();
  for (const registry of live) registry.dispose();
  live.clear();
});
