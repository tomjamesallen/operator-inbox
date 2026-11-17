import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tip } from '../src/components/inbox/icon';
import { mounted, openRail, useInboxPage } from './inbox-page-harness';

// A touch-only device (`touch-only:` in index.css) shows no key hints: it has
// no keys to press. happy-dom draws no media query, so the class stands for
// it. Most hints are checked where their own tests reach them; these are the
// ones with nowhere else to go.

useInboxPage();

describe('key hints on a touch-only device', () => {
  it('leaves a tooltip’s keys out, and keeps its label', async () => {
    render(
      <Tip label="Send" keys="⌘↵">
        <button type="button">go</button>
      </Tip>,
    );
    const trigger = screen.getByRole('button', { name: 'go' })
      .parentElement as HTMLElement;
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseMove(trigger);
    const keys = await waitFor(() => screen.getByText('⌘↵'), { timeout: 2000 });
    expect(keys.classList).toContain('touch-only:hidden');
    expect(keys.parentElement?.textContent).toBe('Send⌘↵');
    expect(keys.parentElement?.classList).not.toContain('touch-only:hidden');
  });

  it('hides the sidebar’s ?, the door to the key bindings sheet', async () => {
    await mounted();
    await openRail();
    const help = document.querySelector('[data-sidebar-help]');
    expect(help?.getAttribute('aria-label')).toBe(
      'Keyboard shortcuts and help',
    );
    expect(help?.classList).toContain('touch-only:hidden');
  });
});
