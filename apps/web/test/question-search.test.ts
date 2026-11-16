import type { InboxBoardDto } from '@operator-inbox/core/api';
import { InboxId } from '@operator-inbox/core/api';
import { describe, expect, it } from 'vitest';
import { searchIndexOf, searchQuestions } from '../src/question-search';

// The search over a small board, as pure functions. All names are invented.

const q = (number: number, title: string, body = `About ${title}`) => ({
  number,
  revision: 1,
  metadata: {} as Record<string, string>,
  title,
  body,
  bodyHtml: '',
  askedSeq: number,
  askedAt: '2026-10-09T10:00:00.000Z',
});

const view = (
  id: string,
  archived: boolean,
  columns: {
    readonly operator?: ReadonlyArray<ReturnType<typeof q>>;
    readonly agent?: ReadonlyArray<ReturnType<typeof q>>;
    readonly processed?: ReadonlyArray<ReturnType<typeof q>>;
  },
) => ({
  inboxId: InboxId.make(id),
  label: id,
  metadata: {},
  archived,
  pinnedGroups: [],
  awaitingOperator: columns.operator ?? [],
  awaitingAgent: (columns.agent ?? []).map((x) => ({
    ...x,
    response: 'ok',
    answeredSeq: 1,
    answeredAt: x.askedAt,
  })),
  processed: (columns.processed ?? []).map((x) => ({
    ...x,
    withdrawn: false,
    response: 'ok',
    processedSeq: 1,
    processedAt: x.askedAt,
    answeredAt: x.askedAt,
  })),
});

const BOARD = {
  inboxes: [],
  totalAwaitingOperator: 0,
  views: [
    view('orchard', false, {
      operator: [q(7, 'Prune the pear trees')],
      processed: [q(3, 'Order more ladders')],
    }),
    view('quarry', false, {
      operator: [q(3, 'Blast schedule')],
      agent: [q(4, 'Ladder safety check', 'Is the long ladder sound?')],
    }),
    view('kiln', true, { operator: [q(3, 'Glaze ladder racks')] }),
  ],
} as unknown as InboxBoardDto;

const INDEX = searchIndexOf(BOARD);
const keys = (query: string, current?: string) =>
  searchQuestions(
    INDEX,
    query,
    current === undefined ? undefined : InboxId.make(current),
  ).map((s) => [s.column, s.items.map((e) => e.key)]);

describe('the question search', () => {
  it('finds nothing for an empty query, or a # with no number', () => {
    expect(keys('')).toEqual([]);
    expect(keys('  ')).toEqual([]);
    expect(keys('#')).toEqual([]);
    expect(keys('#x3')).toEqual([]);
  });

  it('matches #n exactly in every inbox, the one on screen first, archived last', () => {
    expect(keys('#3', 'quarry')).toEqual([
      ['operator', ['quarry#3', 'kiln#3']],
      ['processed', ['orchard#3']],
    ]);
    expect(keys('# 3', 'orchard')).toEqual([
      ['operator', ['quarry#3', 'kiln#3']],
      ['processed', ['orchard#3']],
    ]);
    // Exact: #30 is not #3.
    expect(keys('#30')).toEqual([]);
  });

  it('searches titles and bodies otherwise, under Your inbox, With the agent, then Processed', () => {
    expect(keys('ladder')).toEqual([
      ['operator', ['kiln#3']],
      ['agent', ['quarry#4']],
      ['processed', ['orchard#3']],
    ]);
    // A word only the body holds still matches.
    expect(keys('sound')).toEqual([['agent', ['quarry#4']]]);
    expect(keys('zebra')).toEqual([]);
  });
});
