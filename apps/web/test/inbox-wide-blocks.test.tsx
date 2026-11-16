import { cleanup, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mounted, serve, useInboxPage } from './inbox-page-harness';

// How a table or a picture wider than the text column widens: config.json's
// `wideBlocks`, which the reader carries as `data-wide-blocks` for the
// stylesheet and the figures' variants to read (`styles.test.ts` holds what
// each value draws).

useInboxPage();

const wideBlocks = () =>
  document.querySelector<HTMLElement>('[data-inbox-reader]')?.dataset
    .wideBlocks;

describe('wideBlocks', () => {
  it('grows both ways when config.json does not set it', async () => {
    await mounted();
    expect(wideBlocks()).toBe('both');
  });

  it('grows both ways when config.json says "both"', async () => {
    serve.config = { ...(serve.config as object), wideBlocks: 'both' };
    await mounted();
    expect(wideBlocks()).toBe('both');
  });

  it('keeps to the text’s left edge when config.json says "right"', async () => {
    serve.config = { ...(serve.config as object), wideBlocks: 'right' };
    await mounted();
    await waitFor(() => expect(wideBlocks()).toBe('right'));
  });

  // So a reload does not draw the pictures one way and move them sideways
  // when config.json is read again: until it is read, or when it cannot be,
  // the setting last read stands.
  it('keeps the setting last read while config.json cannot be read', async () => {
    serve.config = { ...(serve.config as object), wideBlocks: 'right' };
    await mounted();
    await waitFor(() => expect(wideBlocks()).toBe('right'));
    cleanup();
    serve.config = { metadata: 'not rules' };
    await mounted();
    expect(wideBlocks()).toBe('right');
  });
});
