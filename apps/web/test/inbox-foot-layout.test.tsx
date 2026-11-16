import { fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { A, mounted, useInboxPage } from './inbox-page-harness';

// The reader's foot on a phone: how close the line of buttons sits over the
// answer box, and what draws over what. The breakpoint is CSS's (`compact:`)
// and happy-dom lays nothing out, so these read the classes that ask for it.

useInboxPage();

const control = () => document.querySelector('[data-readout-control]');
// The line over the answer box: listen mode's control is its first child.
const line = () => control()?.parentElement ?? null;

describe('the line over the answer box', () => {
  it('keeps no strip for listen mode’s bar while listen mode is off', async () => {
    await mounted(`/inbox/${A}`);
    await waitFor(() => expect(control()).not.toBeNull());
    expect(line()?.className).not.toMatch(/compact:p[tb]-5/);
  });

  it('gives the bar a strip over the buttons while listen mode is on', async () => {
    await mounted(`/inbox/${A}`);
    await waitFor(() => expect(control()).not.toBeNull());
    fireEvent.click(
      document.querySelector('[data-readout-toggle]') as HTMLElement,
    );
    await waitFor(() => expect(line()?.className).toContain('compact:pt-5'));
    expect(line()?.className).not.toContain('compact:pb-5');
  });
});

describe('the read-aloud band', () => {
  // The band is drawn in the list at `z-1`; the foot must sit over it, or a
  // line read under the foot paints its band over the answer box.
  it('sits under the reader’s foot', async () => {
    await mounted(`/inbox/${A}`);
    const layer = await waitFor(() => {
      const el = document.querySelector('[data-readout-layer]');
      if (el === null) throw new Error('no layer');
      return el;
    });
    const z = (el: Element | null | undefined) =>
      Number(/(?:^| )z-(\d+)(?: |$)/.exec(el?.className ?? '')?.[1] ?? 0);
    const foot = document
      .querySelector('[data-zen-answer]')
      ?.closest('.absolute.bottom-0');
    expect(foot).not.toBeNull();
    expect(foot?.contains(layer)).toBe(false);
    expect(z(foot)).toBeGreaterThan(z(layer));
  });
});
