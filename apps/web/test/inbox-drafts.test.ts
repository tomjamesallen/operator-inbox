import { InboxBoardDto } from '@operator-inbox/core/api';
import { waitFor } from '@testing-library/react';
import { Schema } from 'effect';
import { AsyncResult, AtomRegistry } from 'effect/reactivity';
import { describe, expect, it } from 'vitest';
import {
  draftsStillWaiting,
  inboxBoardAtom,
  ResponseDraft,
  responseDraftAtom,
  responseDraftsAtom,
} from '../src/inbox';
import { A, BOARD, serve, useInboxPage } from './inbox-page-harness';

// The response drafts, on their Atoms alone.

useInboxPage();

describe('a response box’s draft', () => {
  const draft = (inboxId: string, number: number, text: string) =>
    Schema.decodeUnknownSync(ResponseDraft)({ inboxId, number, text });

  // A draft whose question no longer waits on the operator is
  // dropped once a board says so; one whose Inbox the board does not hold
  // (its machine not read) is kept.
  it('is dropped once a board shows its question no longer waiting, and kept while its Inbox is off the board', async () => {
    serve.board = BOARD;
    const registry = AtomRegistry.make();
    // Keyed as `answerKey` keys a card: `<inboxId>/<number>`.
    const drafts = {
      waiting: `${A}/1`,
      answered: `${A}/2`,
      withdrawn: `${A}/5`,
      offBoard: 'inbox-on-laptop/1',
    };
    const parts = {
      waiting: [A, 1],
      answered: [A, 2],
      withdrawn: [A, 5],
      offBoard: ['inbox-on-laptop', 1],
    } as const;
    for (const [name, key] of Object.entries(drafts)) {
      const [inboxId, number] = parts[name as keyof typeof parts];
      registry.set(
        responseDraftAtom(key),
        draft(inboxId, number, `draft for ${key}`),
      );
    }
    const unmount = registry.mount(inboxBoardAtom);
    await waitFor(() =>
      expect(AsyncResult.isSuccess(registry.get(inboxBoardAtom))).toBe(true),
    );
    expect([...registry.get(responseDraftsAtom).keys()]).toEqual([
      drafts.waiting,
      drafts.offBoard,
    ]);
    expect(registry.get(responseDraftAtom(drafts.waiting))).toBe(
      `draft for ${drafts.waiting}`,
    );
    unmount();
    registry.dispose();
  });

  // "Reload to check" throws nothing
  // typed away: the drafts are kept in the tab's storage, so a new page (a
  // new registry) has them before any board has loaded.
  it('survives a reload of the page, in the tab’s storage', () => {
    const first = AtomRegistry.make();
    first.set(responseDraftAtom(`${A}/1`), draft(A, 1, 'Half a thought'));
    first.dispose();
    const reloaded = AtomRegistry.make();
    expect(reloaded.get(responseDraftAtom(`${A}/1`))).toBe('Half a thought');
    expect(localStorage.length).toBe(0);
    reloaded.dispose();
  });

  it('keeps the same drafts when a board drops none', () => {
    const drafts = new Map([[`${A}/1`, draft(A, 1, 'Go')]]);
    const decoded = Schema.decodeUnknownSync(InboxBoardDto)(BOARD);
    expect(draftsStillWaiting(drafts, decoded)).toBe(drafts);
  });

  it('is held only while it has text, so the drafts kept are those not yet sent', () => {
    const registry = AtomRegistry.make();
    registry.set(responseDraftAtom('a/1'), draft('a', 1, 'one'));
    registry.set(responseDraftAtom('a/2'), draft('a', 2, 'two'));
    registry.set(responseDraftAtom('a/2'), draft('a', 2, ''));
    expect([...registry.get(responseDraftsAtom).keys()]).toEqual(['a/1']);
    expect(registry.get(responseDraftAtom('a/2'))).toBe('');
    registry.dispose();
  });
});
