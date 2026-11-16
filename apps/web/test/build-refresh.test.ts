import { describe, expect, it, vi } from 'vitest';
import { refreshOnNewBuild } from '../src/build-refresh';

// A page left open, against stand-ins for the worker container, its
// registration and the document.
const page = ({ controlled }: { controlled: boolean }) => {
  let onControllerChange = () => {};
  let onVisibility = () => {};
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_: 'visibilitychange', f: () => void) => {
      onVisibility = f;
    },
  };
  const registration = { update: vi.fn(async () => undefined) };
  const reload = vi.fn();
  refreshOnNewBuild({
    container: {
      controller: controlled ? {} : null,
      addEventListener: (_: 'controllerchange', f: () => void) => {
        onControllerChange = f;
      },
    },
    registration,
    doc,
    reload,
  });
  return {
    registration,
    reload,
    show: () => {
      doc.visibilityState = 'visible';
      onVisibility();
    },
    hide: () => {
      doc.visibilityState = 'hidden';
      onVisibility();
    },
    newWorker: () => onControllerChange(),
  };
};

describe('a page left open', () => {
  it('looks for a new build each time it comes back into view, and not as it goes', () => {
    const p = page({ controlled: true });
    p.hide();
    expect(p.registration.update).not.toHaveBeenCalled();
    p.show();
    expect(p.registration.update).toHaveBeenCalledTimes(1);
  });

  it('reloads once when a new build’s worker takes it over', () => {
    const p = page({ controlled: true });
    p.newWorker();
    p.newWorker();
    expect(p.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the first worker takes control of a fresh page', () => {
    const p = page({ controlled: false });
    p.newWorker();
    expect(p.reload).not.toHaveBeenCalled();
    p.newWorker();
    expect(p.reload).toHaveBeenCalledTimes(1);
  });

  it('shrugs off a failed check', async () => {
    const p = page({ controlled: true });
    p.registration.update.mockRejectedValueOnce(new Error('offline'));
    p.show();
    await Promise.resolve();
    expect(p.reload).not.toHaveBeenCalled();
  });
});
