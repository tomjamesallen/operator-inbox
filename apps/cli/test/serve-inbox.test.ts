import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import {
  InboxId,
  QuestionNumber,
  QuestionRevision,
  SessionId,
} from '@operator-inbox/core';
import { InboxUnavailable, OperatorInboxApi } from '@operator-inbox/core/api';
import { Effect, Layer, Option } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServer,
} from 'effect/http';
import { HttpApiClient } from 'effect/http-api';
import {
  dispatchAnswers,
  dispatchArchive,
  dispatchAsk,
  dispatchDone,
  dispatchEdit,
  dispatchHighlight,
  dispatchMeta,
  dispatchOpen,
  dispatchRename,
  dispatchWithdraw,
} from '../src/commands/inbox';
import { InputError } from '../src/errors';
import {
  InboxLog,
  InboxLogInMemory,
  makeInboxLogLazy,
} from '../src/inbox-store';
import { makeServeLayer } from '../src/serve-server';

// The inbox group of `operator-inbox serve`, in process on a real listener on port
// 0, called through `HttpApiClient` derived from the same `OperatorInboxApi` the web
// client uses. The log is kairos-es's in-memory store, seeded through the CLI's
// own dispatchers; the store-down case uses the lazy log over a layer that
// always fails, which is what `serve` runs with the store unavailable.

const ID = InboxId.make('01INBOXSERVE00000000000000');

const serving = (log: Layer.Layer<InboxLog>) =>
  Layer.mergeAll(makeServeLayer(0, undefined), FetchHttpClient.layer).pipe(
    Layer.provideMerge(log),
    Layer.provideMerge(NodeServices.layer),
  );

const client = Effect.gen(function* () {
  const url = yield* HttpServer.addressFormattedWith((u) => Effect.succeed(u));
  return {
    url,
    api: yield* HttpApiClient.make(OperatorInboxApi, { baseUrl: url }),
  };
});

const seed = Effect.gen(function* () {
  yield* dispatchOpen({
    session: Option.some({ sessionId: SessionId.make('s'), cwd: '/w/demo' }),
    inbox: Option.none(),
    label: Option.some('demo'),
    freshId: ID,
    cwd: '/w',
  });
  yield* dispatchAsk({
    inboxId: ID,
    title: 'Pick a store',
    body: '## Context\n\nUse **Postgres**? Not ~~SQLite~~.\n\n- [x] measured',
  });
  yield* dispatchAsk({ inboxId: ID, title: 'Second', body: '' });
});

const ID2 = InboxId.make('01INBOXSERVE00000000000002');
const ID3 = InboxId.make('01INBOXSERVE00000000000003');

// Two more inboxes after `seed`: ID2 quiet, then ID3 with a question.
const seedMore = Effect.gen(function* () {
  for (const [inboxId, cwd] of [
    [ID2, '/w/quiet'],
    [ID3, '/w/busy'],
  ] as const)
    yield* dispatchOpen({
      session: Option.none(),
      inbox: Option.none(),
      label: Option.some(cwd.slice(cwd.lastIndexOf('/') + 1)),
      freshId: inboxId,
      cwd,
    });
  yield* dispatchAsk({ inboxId: ID3, title: 'Busy one', body: '' });
});

const n = QuestionNumber.make;
const r = QuestionRevision.make;

describe('operator-inbox serve — the inbox group', () => {
  it.effect('serves an inbox’s columns, the body rendered', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      const view = yield* api.inbox.view({
        query: {},
        params: { inboxId: ID },
      });
      expect(view.label).toBe('demo');
      expect(view.awaitingOperator.map((q) => q.number)).toEqual([1, 2]);
      expect(view.awaitingOperator[0]?.bodyHtml).toContain(
        '<strong>Postgres</strong>',
      );
      // Full GFM, through the question renderer.
      expect(view.awaitingOperator[0]?.bodyHtml).toContain('<del>SQLite</del>');
      expect(view.awaitingOperator[0]?.bodyHtml).toContain(
        '<input type="checkbox" disabled checked>',
      );
      expect(view.awaitingAgent).toEqual([]);
      expect(view.processed).toEqual([]);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'a processed answer stays in the view, newest processed first',
    () =>
      Effect.gen(function* () {
        yield* seed;
        const { api } = yield* client;
        yield* api.inbox.answer({
          query: {},
          params: { inboxId: ID, number: n(2) },
          payload: { response: 'second answer', seenRevision: r(1) },
        });
        yield* dispatchDone({ inboxId: ID, numbers: [2] });
        yield* dispatchWithdraw({ inboxId: ID, numbers: [1], reason: 'moot' });
        const view = yield* api.inbox.view({
          query: {},
          params: { inboxId: ID },
        });
        expect(view.awaitingOperator).toEqual([]);
        expect(view.awaitingAgent).toEqual([]);
        expect(
          view.processed.map((q) => [
            q.number,
            q.withdrawn,
            q.response,
            q.reason,
          ]),
        ).toEqual([
          [1, true, undefined, 'moot'],
          [2, false, 'second answer', undefined],
        ]);
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('carries the inbox’s and each question’s metadata', () =>
    Effect.gen(function* () {
      yield* seed;
      yield* dispatchMeta({
        inboxId: ID,
        set: { repo: 'orchard' },
        unset: [],
        json: false,
      });
      yield* dispatchMeta({
        inboxId: ID,
        number: 2,
        set: { topic: 'store' },
        unset: [],
        json: false,
      });
      const { api } = yield* client;
      const view = yield* api.inbox.view({
        query: {},
        params: { inboxId: ID },
      });
      expect(view.metadata).toEqual({ repo: 'orchard' });
      expect(view.awaitingOperator.map((q) => [q.number, q.metadata])).toEqual([
        [1, {}],
        [2, { topic: 'store' }],
      ]);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('carries a highlight, and the operator dismisses it', () =>
    Effect.gen(function* () {
      yield* seed;
      yield* dispatchHighlight({
        inboxId: ID,
        numbers: [2],
        note: 'about the store',
      });
      const { api } = yield* client;
      const view = yield* api.inbox.view({
        query: {},
        params: { inboxId: ID },
      });
      const [one, two] = view.awaitingOperator;
      expect(one?.highlight).toBeUndefined();
      expect(two?.highlight?.note).toBe('about the store');
      expect(two?.highlight?.seq).toBeGreaterThan(two?.askedSeq ?? 0);
      const after = yield* api.inbox.dismissHighlight({
        query: {},
        params: { inboxId: ID, number: n(2) },
      });
      expect(after.awaitingOperator[1]?.highlight).toBeUndefined();
      const again = yield* Effect.flip(
        api.inbox.dismissHighlight({
          query: {},
          params: { inboxId: ID, number: n(2) },
        }),
      );
      expect(again._tag).toBe('HighlightRefused');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('pins and unpins an inbox and a group', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      yield* api.inbox.pin({
        query: {},
        params: { inboxId: ID },
        payload: { pinned: true },
      });
      const view = yield* api.inbox.pin({
        query: {},
        params: { inboxId: ID },
        payload: { pinned: true, group: 'store' },
      });
      expect(view.pinnedGroups).toEqual(['store']);
      const index = yield* api.inbox.index({ query: {} });
      expect(index.inboxes.find((i) => i.inboxId === ID)?.pinned).toBe(true);
      const again = yield* Effect.flip(
        api.inbox.pin({
          query: {},
          params: { inboxId: ID },
          payload: { pinned: true },
        }),
      );
      expect(again._tag).toBe('PinRefused');
      const off = yield* api.inbox.pin({
        query: {},
        params: { inboxId: ID },
        payload: { pinned: false, group: 'store' },
      });
      expect(off.pinnedGroups).toEqual([]);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('archives and unarchives an inbox from the app', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      const view = yield* api.inbox.archive({
        query: {},
        params: { inboxId: ID },
        payload: { archived: true },
      });
      expect(view.archived).toBe(true);
      const again = yield* Effect.flip(
        api.inbox.archive({
          query: {},
          params: { inboxId: ID },
          payload: { archived: true },
        }),
      );
      expect(again._tag).toBe('ArchiveRefused');
      const back = yield* api.inbox.archive({
        query: {},
        params: { inboxId: ID },
        payload: { archived: false },
      });
      expect(back.archived).toBe(false);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('sends a mermaid fence as its own part', () =>
    Effect.gen(function* () {
      yield* seed;
      yield* dispatchAsk({
        inboxId: ID,
        title: 'Flow',
        body: 'Before.\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter.',
      });
      const { api } = yield* client;
      const view = yield* api.inbox.view({
        query: {},
        params: { inboxId: ID },
      });
      const flow = view.awaitingOperator.find((q) => q.title === 'Flow');
      expect(flow?.bodyParts).toEqual([
        { kind: 'html', html: '<p>Before.</p>\n' },
        { kind: 'mermaid', source: 'graph TD; A-->B' },
        { kind: 'html', html: '<p>After.</p>\n' },
      ]);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('an answer moves the card to the agent’s column', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      const view = yield* api.inbox.answer({
        query: {},
        params: { inboxId: ID, number: n(1) },
        payload: { response: 'Postgres, for now', seenRevision: r(1) },
      });
      expect(view.awaitingOperator.map((q) => q.number)).toEqual([2]);
      expect(view.awaitingAgent).toEqual([
        {
          number: 1,
          revision: 1,
          metadata: {},
          title: 'Pick a store',
          body: '## Context\n\nUse **Postgres**? Not ~~SQLite~~.\n\n- [x] measured',
          bodyHtml: expect.stringContaining('<strong>Postgres</strong>'),
          bodyParts: [
            {
              kind: 'html',
              html: expect.stringContaining('<strong>Postgres</strong>'),
            },
          ],
          response: 'Postgres, for now',
          // The answer is the fourth event in the log (open, two asks).
          answeredSeq: expect.any(Number),
          answeredAt: expect.any(String),
          askedAt: expect.any(String),
        },
      ]);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('the operator asks the agent, and the agent reads it', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      const view = yield* api.inbox.ask({
        query: {},
        params: { inboxId: ID },
        payload: { text: 'Check the slow tests\nThe store ones' },
      });
      expect(
        view.awaitingAgent.map((q) => [
          q.number,
          q.title,
          q.body,
          q.response,
          q.operatorQuestion,
        ]),
      ).toEqual([
        [
          3,
          'Check the slow tests',
          '',
          'Check the slow tests\nThe store ones',
          true,
        ],
      ]);
      expect(yield* dispatchAnswers({ inboxId: ID, json: false })).toBe(
        '#3 (the operator asks) Check the slow tests\n  Check the slow tests\n  The store ones',
      );
      yield* dispatchDone({ inboxId: ID, numbers: [3] });
      const after = yield* api.inbox.view({
        query: {},
        params: { inboxId: ID },
      });
      expect(
        after.processed.map((q) => [q.number, q.operatorQuestion]),
      ).toEqual([[3, true]]);
      const empty = yield* Effect.flip(
        api.inbox.ask({
          query: {},
          params: { inboxId: ID },
          payload: { text: '  ' },
        }),
      );
      expect(empty._tag).toBe('AskRefused');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('opens nothing but a whole session link', () =>
    Effect.gen(function* () {
      const { url } = yield* client;
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post(`${url}/api/open-session`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ link: 'https://example.com' }),
        ),
      );
      expect(response.status).toBe(400);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('a second Send is refused 409 with the refusal sentence', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      const answer = api.inbox.answer({
        query: {},
        params: { inboxId: ID, number: n(1) },
        payload: { response: 'yes', seenRevision: r(1) },
      });
      yield* answer;
      const failure = yield* Effect.flip(answer);
      expect(failure._tag).toBe('AnswerRefused');
      if (failure._tag === 'AnswerRefused')
        expect(failure.message).toContain('already answered');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'an edit shows in the view, and a withdrawn question moves to processed',
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* dispatchEdit({
          inboxId: ID,
          number: 2,
          title: 'Second, sharper',
        });
        yield* dispatchWithdraw({
          inboxId: ID,
          numbers: [1],
          reason: 'settled in the session',
        });
        const { api } = yield* client;
        const view = yield* api.inbox.view({
          query: {},
          params: { inboxId: ID },
        });
        expect(
          view.awaitingOperator.map((q) => [
            q.number,
            q.revision,
            q.title,
            q.body,
          ]),
        ).toEqual([[2, 2, 'Second, sharper', '']]);
        expect(
          view.processed.map((q) => [
            q.number,
            q.title,
            q.withdrawn,
            q.reason,
            q.response,
          ]),
        ).toEqual([
          [1, 'Pick a store', true, 'settled in the session', undefined],
        ]);
        expect(view.processed[0]?.bodyHtml).toContain('<strong>Postgres');
        // When it was asked rides along for the details dialog; a withdrawn
        // question was never answered, so it has no answered time.
        expect(view.processed[0]?.askedAt).toEqual(expect.any(String));
        expect(view.processed[0]?.answeredAt).toBeUndefined();
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('an answer to a revision since edited is refused 409', () =>
    Effect.gen(function* () {
      yield* seed;
      yield* dispatchEdit({ inboxId: ID, number: 1, body: 'MySQL instead?' });
      const { api } = yield* client;
      const failure = yield* Effect.flip(
        api.inbox.answer({
          query: {},
          params: { inboxId: ID, number: n(1) },
          payload: { response: 'Postgres', seenRevision: r(1) },
        }),
      );
      expect(failure._tag).toBe('AnswerRefused');
      if (failure._tag === 'AnswerRefused')
        expect(failure.message).toBe(
          '#1 changed after you opened it; read it again before answering',
        );
      // Nothing was recorded: the question still waits on the operator.
      const view = yield* api.inbox.view({
        query: {},
        params: { inboxId: ID },
      });
      expect(view.awaitingOperator.map((q) => q.number)).toEqual([1, 2]);
      expect(view.awaitingAgent).toEqual([]);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'lists every inbox, waiting-for-you first, then most recent, with the total',
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* seedMore;
        const { api } = yield* client;
        // ID2 is touched last, but has nothing waiting for the operator.
        yield* dispatchRename({ inboxId: ID2, label: 'Quiet one' });
        const index = yield* api.inbox.index({ query: {} });
        expect(
          index.inboxes.map((i) => [i.inboxId, i.label, i.awaitingOperator]),
        ).toEqual([
          [ID3, 'busy', 1],
          [ID, 'demo', 2],
          [ID2, 'Quiet one', 0],
        ]);
        expect(index.totalAwaitingOperator).toBe(3);
        expect(index.inboxes[0]?.lastActivityAt).toEqual(expect.any(String));
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'the board carries every inbox’s view, in the index’s order, with global seqs',
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* seedMore;
        const { api } = yield* client;
        yield* api.inbox.answer({
          query: {},
          params: { inboxId: ID, number: n(2) },
          payload: { response: 'first', seenRevision: r(1) },
        });
        yield* api.inbox.answer({
          query: {},
          params: { inboxId: ID, number: n(1) },
          payload: { response: 'second', seenRevision: r(1) },
        });
        const board = yield* api.inbox.board({ query: {} });
        expect(board.views.map((v) => v.inboxId)).toEqual(
          board.inboxes.map((i) => i.inboxId),
        );
        const demo = board.views.find((v) => v.inboxId === ID);
        // With the agent: oldest answered first (#2 was answered before #1),
        // the order the agent will probably work in.
        expect(demo?.awaitingAgent.map((q) => q.number)).toEqual([2, 1]);
        // The seq is global: ID3's question was asked before either answer
        // in ID landed.
        const busy = board.views.find((v) => v.inboxId === ID3);
        const asked = busy?.awaitingOperator[0]?.askedSeq ?? 0;
        expect(asked).toBeGreaterThan(0);
        expect(demo?.awaitingAgent.at(-1)?.answeredSeq ?? 0).toBeGreaterThan(
          asked,
        );
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('renames an inbox, and refuses the name it already has', () =>
    Effect.gen(function* () {
      yield* seed;
      const { api } = yield* client;
      const view = yield* api.inbox.rename({
        query: {},
        params: { inboxId: ID },
        payload: { label: ' Markdown check ' },
      });
      expect(view.label).toBe('Markdown check');
      const failure = yield* Effect.flip(
        api.inbox.rename({
          query: {},
          params: { inboxId: ID },
          payload: { label: 'Markdown check' },
        }),
      );
      expect(failure._tag).toBe('RenameRefused');
      const missing = yield* Effect.flip(
        api.inbox.rename({
          query: {},
          params: { inboxId: InboxId.make('nope') },
          payload: { label: 'x' },
        }),
      );
      expect(missing._tag).toBe('InboxNotFound');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'a muted inbox is reported muted in the index and the board, and its waiting questions are out of the total',
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* seedMore;
        const { api } = yield* client;
        // ID has two questions waiting and ID3 one; muting ID3 drops its one.
        yield* api.inbox.mute({
          query: {},
          params: { inboxId: ID3 },
          payload: { muted: true },
        });
        const index = yield* api.inbox.index({ query: {} });
        const mutedOf = (inboxId: InboxId) =>
          index.inboxes.find((i) => i.inboxId === inboxId)?.muted;
        expect(mutedOf(ID3)).toBe(true);
        expect(mutedOf(ID)).toBe(false);
        expect(
          index.inboxes.find((i) => i.inboxId === ID3)?.awaitingOperator,
        ).toBe(1);
        expect(index.totalAwaitingOperator).toBe(2);
        const board = yield* api.inbox.board({ query: {} });
        expect(board.inboxes.find((i) => i.inboxId === ID3)?.muted).toBe(true);
        expect(board.inboxes.find((i) => i.inboxId === ID)?.muted).toBe(false);
        expect(board.views.find((v) => v.inboxId === ID3)?.muted).toBe(true);
        expect(board.views.find((v) => v.inboxId === ID)?.muted).toBe(false);
        expect(board.totalAwaitingOperator).toBe(2);
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'an archived inbox is marked, ordered last, and out of the total',
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* seedMore;
        // ID3 has the one question waiting outside ID; archived, it drops out.
        yield* dispatchArchive({ inboxId: ID3 });
        const { api } = yield* client;
        const index = yield* api.inbox.index({ query: {} });
        expect(
          index.inboxes.map((i) => [i.inboxId, i.archived, i.awaitingOperator]),
        ).toEqual([
          [ID, false, 2],
          [ID2, false, 0],
          [ID3, true, 1],
        ]);
        expect(index.totalAwaitingOperator).toBe(2);
        const board = yield* api.inbox.board({ query: {} });
        expect(board.totalAwaitingOperator).toBe(2);
        expect(board.views.map((v) => [v.inboxId, v.archived])).toEqual([
          [ID, false],
          [ID2, false],
          [ID3, true],
        ]);
        // Its own view still serves, and still takes an answer.
        const answered = yield* api.inbox.answer({
          query: {},
          params: { inboxId: ID3, number: n(1) },
          payload: { response: 'yes', seenRevision: r(1) },
        });
        expect(answered.archived).toBe(true);
        expect(answered.awaitingAgent.map((q) => q.number)).toEqual([1]);
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect(
    'a rename to a taken name is refused 409 with the holder’s id',
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* seedMore;
        const { api } = yield* client;
        const failure = yield* Effect.flip(
          api.inbox.rename({
            query: {},
            params: { inboxId: ID2 },
            payload: { label: ' DEMO ' },
          }),
        );
        expect(failure._tag).toBe('RenameRefused');
        if (failure._tag === 'RenameRefused') {
          expect(failure.conflictingInboxId).toBe(ID);
          expect(failure.message).toBe(
            `an inbox named "DEMO" already exists: ${ID} — adopt it with \`operator-inbox open --inbox ${ID}\`, or choose another name`,
          );
        }
      }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('the rename POST is refused 403 from a foreign Origin', () =>
    Effect.gen(function* () {
      yield* seed;
      const { url } = yield* client;
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post(`${url}/api/inbox/${ID}/rename`).pipe(
          HttpClientRequest.setHeader('origin', 'http://evil.example'),
          HttpClientRequest.bodyJsonUnsafe({ label: 'pwned' }),
        ),
      );
      expect(response.status).toBe(403);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  // Effect 4 alone answers a request decode failure with an EMPTY 400; core's
  // RequestDecodeErrors middleware gives a payload that parses but does not
  // match its schema a JSON body naming what was wrong. The message wording is not
  // pinned here, only its presence and the body's shape.
  it.effect('a payload that does not decode is a 400 naming the field', () =>
    Effect.gen(function* () {
      yield* seed;
      const { url } = yield* client;
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post(`${url}/api/inbox/${ID}/rename`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ label: 5 }),
        ),
      );
      expect(response.status).toBe(400);
      const text = yield* response.text;
      const body = JSON.parse(text) as {
        issues: ReadonlyArray<{
          path: ReadonlyArray<unknown>;
          message: string;
        }>;
        message: unknown;
        _tag: unknown;
      };
      expect(Object.keys(body)).toEqual(['issues', 'message', '_tag']);
      expect(body._tag).toBe('HttpApiDecodeError');
      expect(typeof body.message).toBe('string');
      expect(body.issues.length).toBeGreaterThan(0);
      expect(body.issues[0]?.path).toContain('label');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  // A body that is not JSON at all has no field to name, so the middleware
  // leaves Effect 4's empty 400 in place for it rather than the JSON
  // decode-error body.
  it.effect('a body that is not JSON is an empty 400', () =>
    Effect.gen(function* () {
      yield* seed;
      const { url } = yield* client;
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post(`${url}/api/inbox/${ID}/rename`).pipe(
          HttpClientRequest.bodyText('{"label":', 'application/json'),
        ),
      );
      expect(response.status).toBe(400);
      expect(yield* response.text).toBe('');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('an unknown inbox is 404', () =>
    Effect.gen(function* () {
      const { api } = yield* client;
      const failure = yield* Effect.flip(
        api.inbox.view({
          query: {},
          params: { inboxId: InboxId.make('nope') },
        }),
      );
      expect(failure._tag).toBe('InboxNotFound');
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  it.effect('the answer POST is refused 403 from a foreign Origin', () =>
    Effect.gen(function* () {
      yield* seed;
      const { url } = yield* client;
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.post(
          `${url}/api/inbox/${ID}/questions/1/answer`,
        ).pipe(
          HttpClientRequest.setHeader('origin', 'http://127.0.0.1:5173'),
          HttpClientRequest.bodyJsonUnsafe({
            response: 'yes',
            seenRevision: 1,
          }),
        ),
      );
      expect(response.status).toBe(403);
    }).pipe(Effect.provide(serving(InboxLogInMemory))),
  );

  // A write appends, then reads its view back.
  // When only the read-back fails, the change is in the log, so serve never
  // lets the page say it was not made: the refusal carries `mayHaveLanded`,
  // which the page words as unconfirmed, as it does a forwarded write.
  describe('a Local write whose read-back fails after it landed', () => {
    const reads = { broken: false };
    // The in-memory log, whose reads fail once a write has landed while
    // `reads.broken` is set (so the seed's own appends do not count).
    const readBackFails = Layer.effect(
      InboxLog,
      Effect.gen(function* () {
        const inner = yield* InboxLog;
        let landed = false;
        return InboxLog.of({
          ...inner,
          append: (events, guard) =>
            inner.append(events, guard).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  landed = reads.broken;
                }),
              ),
            ),
          read: (inboxId) =>
            reads.broken && landed
              ? Effect.fail(
                  new InputError({
                    message: 'inbox read timed out after 20 seconds',
                  }),
                )
              : inner.read(inboxId),
        });
      }),
    ).pipe(Layer.provide(InboxLogInMemory));

    // The write's failure, once it is made with reads broken after it lands.
    const failureOf = <E>(
      write: (
        api: Effect.Success<typeof client>['api'],
      ) => Effect.Effect<unknown, E>,
    ) =>
      Effect.gen(function* () {
        reads.broken = false;
        yield* seed;
        const { api } = yield* client;
        reads.broken = true;
        const failure = yield* Effect.flip(write(api));
        reads.broken = false;
        return failure;
      });

    const isUnconfirmed = (failure: { readonly _tag: string }) => {
      expect(failure._tag).toBe('InboxUnavailable');
      if (!(failure instanceof InboxUnavailable)) return;
      expect(failure.mayHaveLanded).toBe(true);
      expect(failure.message).toContain('reload to check');
      expect(failure.message).toContain('inbox read timed out');
    };

    it.effect('an answer is unconfirmed, never not done', () =>
      Effect.gen(function* () {
        isUnconfirmed(
          yield* failureOf((api) =>
            api.inbox.answer({
              query: {},
              params: { inboxId: ID, number: n(1) },
              payload: { response: 'yes', seenRevision: r(1) },
            }),
          ),
        );
      }).pipe(Effect.provide(serving(readBackFails))),
    );

    it.effect('a pin is unconfirmed, never not done', () =>
      Effect.gen(function* () {
        isUnconfirmed(
          yield* failureOf((api) =>
            api.inbox.pin({
              query: {},
              params: { inboxId: ID },
              payload: { pinned: true },
            }),
          ),
        );
      }).pipe(Effect.provide(serving(readBackFails))),
    );

    it.effect('a write refused before anything landed keeps its refusal', () =>
      Effect.gen(function* () {
        reads.broken = true;
        const failure = yield* Effect.flip(
          (yield* client).api.inbox.pin({
            query: {},
            params: { inboxId: ID },
            payload: { pinned: true },
          }),
        );
        reads.broken = false;
        // Nothing landed, so the read before the append still works and the
        // Inbox is not there.
        expect(failure._tag).toBe('InboxNotFound');
      }).pipe(Effect.provide(serving(readBackFails))),
    );
  });

  // The store is unavailable. The server started (this test reached it), and
  // the inbox answers 503.
  it.effect('with the store unavailable, serve still starts and answers', () =>
    Effect.gen(function* () {
      const { api } = yield* client;
      const failure = yield* Effect.flip(
        api.inbox.view({ query: {}, params: { inboxId: ID } }),
      );
      expect(failure._tag).toBe('InboxUnavailable');
      if (failure._tag === 'InboxUnavailable')
        expect(failure.message).toContain('could not open its event log');
    }).pipe(
      Effect.provide(
        serving(
          makeInboxLogLazy(
            Layer.unwrap(
              Effect.fail(
                new InputError({
                  message:
                    'inbox could not open its event log at /nowhere/inbox.sqlite: unable to open database file',
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
