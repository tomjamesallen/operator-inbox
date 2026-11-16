import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  A,
  box,
  mounted,
  prefix,
  press,
  serve,
  type,
  useInboxPage,
} from './inbox-page-harness';

// Highlight reply: Ctrl+Space h asks the agent to highlight the question it
// asks in reply. The box's border turns the highlight's yellow, the send
// carries `highlightReply`, and a send that lands turns it off.

useInboxPage();

const frame = () => box().closest<HTMLElement>('[data-zen-frame]');
const lit = () => frame()?.hasAttribute('data-highlight-reply') === true;

const toggle = () => {
  prefix();
  press({ key: 'h', code: 'KeyH' });
};

describe('highlight reply', () => {
  it('turns the answer box’s border yellow, and back', async () => {
    await mounted(`/inbox/${A}`);
    expect(lit()).toBe(false);
    expect(frame()?.className).not.toContain('border-yellow');
    toggle();
    await waitFor(() => expect(lit()).toBe(true));
    expect(frame()?.className).toContain('border-yellow');
    // The border is the switch's only sign: there is no button to click.
    expect(
      screen.queryByRole('button', { name: /Highlight reply/i }),
    ).toBeNull();
    toggle();
    await waitFor(() => expect(lit()).toBe(false));
  });

  it('sends the answer with highlightReply, then turns itself off', async () => {
    await mounted(`/inbox/${A}`);
    type('Port 5432');
    toggle();
    await waitFor(() => expect(lit()).toBe(true));
    press({ key: 'Enter', code: 'Enter', ctrlKey: true }, box());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]).toEqual({
      path: `/api/inbox/${A}/questions/1/answer`,
      body: { response: 'Port 5432', seenRevision: 1, highlightReply: true },
    });
    await waitFor(() => expect(lit()).toBe(false));
  });

  it('leaves the flag off a plain answer', async () => {
    await mounted(`/inbox/${A}`);
    type('Yes');
    press({ key: 'Enter', code: 'Enter', ctrlKey: true }, box());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]?.body).not.toHaveProperty('highlightReply');
  });

  it('carries it on a question asked of the agent', async () => {
    await mounted(`/inbox/${A}`);
    press({ key: 'a', code: 'KeyA', ctrlKey: true });
    await screen.findByText(/In orchard/);
    type('Can you check the cache?');
    toggle();
    await waitFor(() => expect(lit()).toBe(true));
    press({ key: 'Enter', code: 'Enter', metaKey: true }, box());
    await waitFor(() => expect(serve.posts).toHaveLength(1));
    expect(serve.posts[0]).toEqual({
      path: `/api/inbox/${A}/questions`,
      body: { text: 'Can you check the cache?', highlightReply: true },
    });
  });
});
