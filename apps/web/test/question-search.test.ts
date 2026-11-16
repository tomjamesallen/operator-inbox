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
    readonly code?: string;
    readonly operator?: ReadonlyArray<ReturnType<typeof q>>;
    readonly agent?: ReadonlyArray<ReturnType<typeof q>>;
    readonly processed?: ReadonlyArray<ReturnType<typeof q>>;
  },
) => ({
  inboxId: InboxId.make(id),
  label: id,
  ...(columns.code === undefined ? {} : { code: columns.code }),
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
      code: 'orc',
      operator: [q(7, 'Prune the pear trees')],
      processed: [q(3, 'Order more ladders')],
    }),
    view('quarry', false, {
      code: 'oqx',
      operator: [q(3, 'Blast schedule')],
      agent: [q(4, 'Ladder safety check', 'Is the long ladder sound?')],
    }),
    view('kiln', true, {
      code: 'kil',
      operator: [q(3, 'Glaze ladder racks')],
    }),
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

describe('the question search by code', () => {
  const codes = (query: string) =>
    searchQuestions(INDEX, query, undefined).flatMap((s) =>
      s.items.map((e) =>
        e.kind === 'inbox' ? `@${e.code}` : (e.code ?? `#${e.number}`),
      ),
    );

  it('gives every question its full code', () => {
    expect(codes('#3')).toEqual(['oqx#3', 'kil#3', 'orc#3']);
  });

  it('lists the inboxes a partial code matches, archived last, and no questions', () => {
    // In the order of their codes.
    expect(keys('@o')).toEqual([
      ['inboxes', ['inbox:quarry', 'inbox:orchard']],
    ]);
    expect(keys('@')).toEqual([
      ['inboxes', ['inbox:quarry', 'inbox:orchard', 'inbox:kiln']],
    ]);
    expect(keys('@x')).toEqual([]);
  });

  it('filters to the inbox a whole code names, in any case', () => {
    expect(keys('@ORC')).toEqual([
      ['inboxes', ['inbox:orchard']],
      ['operator', ['orchard#7']],
      ['processed', ['orchard#3']],
    ]);
  });

  it('filters to exactly one question on @code#n', () => {
    expect(keys('@oqx#4')).toEqual([['agent', ['quarry#4']]]);
    expect(keys('@oqx#9')).toEqual([]);
    // A partial code names no question.
    expect(keys('@oq#4')).toEqual([]);
  });

  it('searches the words after a whole code in that inbox only', () => {
    expect(keys('@oqx ladder')).toEqual([['agent', ['quarry#4']]]);
    expect(keys('@orc ladder')).toEqual([['processed', ['orchard#3']]]);
  });

  it('matches nothing for what is not a code', () => {
    expect(keys('@orch')).toEqual([]);
    expect(keys('@o-rc')).toEqual([]);
  });
});
