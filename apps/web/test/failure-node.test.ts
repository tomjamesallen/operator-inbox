// @vitest-environment node
// This file runs under node, not happy-dom: under happy-dom a failed declared
// status makes Effect 4 hash happy-dom's own `Response` while it dedupes the
// cause, which dies with a TypeError a browser's native `Response` does not
// give, so the test would pin that TypeError instead of the page's real path.

import { InboxId } from '@operator-inbox/core/api';
import { Effect, Exit } from 'effect';
import { type AsyncResult, type Atom, AtomRegistry } from 'effect/reactivity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxClient } from '../src/api';
import {
  type FailureText,
  failureText,
  GATEWAY_SENTENCE,
  isUnconfirmed,
  MISMATCH_MESSAGE,
  NO_REPLY_SENTENCE,
  refusalText,
  serverErrorMessage,
  type WriteRefusedTag,
} from '../src/failure';
import { pinAtom } from '../src/inbox';

// The typed client resolves its relative `/api/…` against `location`, which
// node does not have.
vi.stubGlobal('location', new URL('http://127.0.0.1:5173/'));

// Effect 4's `FetchHttpClient` keeps the first `globalThis.fetch` it reads, so
// this is ONE stub for the file, and each test swaps the reply it gives.
let reply: () => Response = () => new Response(null, { status: 599 });
vi.stubGlobal('fetch', async () => reply());

let registry: AtomRegistry.AtomRegistry | undefined;

afterEach(() => {
  registry?.dispose();
  registry = undefined;
});

// Read through the page's own client, answered with `response`, and classify
// the failure as the page does. The board declares 400 and 503; the inbox
// config read declares 500, so a case about a declared 500 reads that.
const boardAtom = InboxClient.query('inbox', 'board', { query: {} });
const configAtom = InboxClient.query('inboxConfig', 'read', {});
type ReadAtom = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

const classify = async (
  response: () => Response,
  atom: ReadAtom = boardAtom,
): Promise<FailureText> => {
  reply = response;
  registry = AtomRegistry.make();
  const exit = await Effect.runPromiseExit(
    AtomRegistry.getResult(registry, atom, {
      suspendOnWaiting: true,
    }),
  );
  if (Exit.isSuccess(exit)) throw new Error('the request did not fail');
  return failureText(exit.cause);
};

const empty = (status: number) => () => new Response(null, { status });

// A declared error status (400, 409, 500, 503) whose body does not decode: a
// server defect's empty 500, a newer serve's error `_tag`, a proxy's HTML
// page. Effect 4's client gives an `HttpClientError` whose reason is
// `StatusCodeError`: the page and serve disagree, so the banner says to reload
// or restart.
describe('a declared error status whose body does not decode', () => {
  const cases: ReadonlyArray<readonly [string, () => Response, ReadAtom]> = [
    ['503, empty', empty(503), boardAtom],
    ['500, empty', empty(500), configAtom],
    ['400, empty', empty(400), boardAtom],
    [
      '500, an error _tag this page does not know',
      () =>
        new Response(
          JSON.stringify({
            _tag: 'SomethingNewer',
            message: 'From the future.',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      configAtom,
    ],
  ];

  it.each(cases)('%s is a mismatch', async (_, response, atom) => {
    const failure = await classify(response, atom);
    expect(failure.kind).toBe('mismatch');
    expect(failure.message).toBe(MISMATCH_MESSAGE);
  });
});

// A 500 or a 503 whose body is a page, not JSON, is a server error from serve or a proxy in front of it, not a reply
// from a newer serve, so it never reads as the mismatch notice.
const html = (status: number) => () =>
  new Response('<html><body>Service Unavailable</body></html>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

describe('a 500 or 503 whose body is not JSON', () => {
  it.each([500, 503])('an HTML %i is a server error', async (status) => {
    const failure = await classify(html(status));
    expect(failure.kind).toBe('server');
    expect(failure.message).not.toBe(MISMATCH_MESSAGE);
    expect(failure.message).toBe(serverErrorMessage(status));
    expect(failure.message).toBe(
      `operator-inbox serve, or a proxy in front of it, answered HTTP ${status}, a server error`,
    );
  });

  it.each([
    500, 503,
  ])('a write answered with an HTML %i is unconfirmed', async (status) => {
    const failure = await pinFailure(html(status));
    expect(pinRefusal(failure)).toBe(
      `Unconfirmed: operator-inbox serve, or a proxy in front of it, answered HTTP ${status}, a server error, so the change may have been made. The next read shows whether it was.`,
    );
    expect(isUnconfirmed(failure)).toBe(true);
  });
});

describe('the statuses whose kind did not move', () => {
  // A proxy's 502 or 504 is an answer, not a
  // request that got none, so it is a kind of its own.
  it.each([
    502, 504,
  ])('a %i from a proxy is a gateway answer', async (status) => {
    expect((await classify(empty(status))).kind).toBe('gateway');
  });

  it('a request that got no reply is a connection failure', async () => {
    expect(
      (
        await classify(() => {
          throw new TypeError('Failed to fetch');
        })
      ).kind,
    ).toBe('connection');
  });

  it('a 404 is a mismatch', async () => {
    expect((await classify(empty(404))).kind).toBe('mismatch');
  });
});

// A CDN's 520 to 524 are `gateway`, and any other status the contract does
// not declare is `undeclared`.
describe('the statuses a proxy or the contract decides', () => {
  // A CDN's proxy answers 520 to 524 for an origin it could
  // not reach or that timed out, as a 502 or a 504 does.
  it.each([
    520, 521, 522, 523, 524,
  ])('a %i from a proxy is a gateway answer', async (status) => {
    expect((await classify(empty(status))).kind).toBe('gateway');
  });

  // A status the contract does not declare is still an answer. 519 and 525
  // sit either side of the CDN's range, so a range widened by one either way
  // is caught here.
  it.each([
    401, 408, 415, 429, 519, 525,
  ])('a %i is an undeclared answer, said with its status', async (status) => {
    const failure = await classify(empty(status));
    expect(failure.kind).toBe('undeclared');
    expect(failure.message).toBe(
      `operator-inbox serve, or a proxy in front of it, answered HTTP ${status}, which this page does not expect`,
    );
  });
});

// A pin through the page's own client, answered with `response`, and its
// failure as the page classifies it.
const pinFailure = async (response: () => Response): Promise<FailureText> => {
  reply = response;
  registry = AtomRegistry.make();
  const pin = pinAtom('inbox-a');
  const unmount = registry.mount(pin);
  registry.set(pin, { inboxId: InboxId.make('inbox-a'), pinned: true });
  const exit = await Effect.runPromiseExit(
    AtomRegistry.getResult(registry, pin, { suspendOnWaiting: true }),
  );
  unmount();
  if (Exit.isSuccess(exit)) throw new Error('the pin did not fail');
  return failureText(exit.cause);
};

const pinRefusal = (failure: FailureText): string =>
  refusalText('Not pinned', failure, InboxId.make('inbox-a'), 'PinRefused');

// A write answered by another proxy's 520 to 524, or with a
// status the contract does not declare, went out, so it is unconfirmed,
// never "Not sent".
describe('a write answered with a status serve does not declare', () => {
  it.each([520, 524])('a %i is unconfirmed', async (status) => {
    const failure = await pinFailure(empty(status));
    expect(pinRefusal(failure)).toBe(`Unconfirmed: ${GATEWAY_SENTENCE}`);
    expect(isUnconfirmed(failure)).toBe(true);
  });

  it.each([408, 429])('a %i is unconfirmed', async (status) => {
    const failure = await pinFailure(empty(status));
    expect(pinRefusal(failure)).toBe(
      `Unconfirmed: operator-inbox serve, or a proxy in front of it, answered HTTP ${status}, which this page does not expect, so the change may have been made. The next read shows whether it was.`,
    );
    expect(isUnconfirmed(failure)).toBe(true);
  });
});

// A write that got no reply is said as a sentence with
// advice, never the client's raw "HttpClientError: Transport error (POST …)".
describe('a write that got no reply', () => {
  it('says it was not sent, and asks whether serve is running', async () => {
    const failure = await pinFailure(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(pinRefusal(failure)).toBe(`Not pinned: ${NO_REPLY_SENTENCE}`);
    expect(NO_REPLY_SENTENCE).toBe(
      'operator-inbox serve did not reply. Is operator-inbox serve running?',
    );
    expect(isUnconfirmed(failure)).toBe(false);
  });
});

// Serve's declared errors besides a write's own refusal each carry a
// sentence, so each reads as one on every write.
describe('serve’s shared refusals, on every write', () => {
  const writes: ReadonlyArray<readonly [string, WriteRefusedTag]> = [
    ['Not sent', 'AnswerRefused'],
    ['Not dismissed', 'HighlightRefused'],
    ['Not pinned', 'PinRefused'],
    ['Not archived', 'ArchiveRefused'],
    ['Not renamed', 'RenameRefused'],
  ];
  const cases = ['InboxNotFound', 'InboxUnavailable'].flatMap((tag) =>
    writes.map(([notDone, refused]) => [tag, notDone, refused] as const),
  );
  it.each(
    cases,
  )('%s reads as a sentence after “%s”', (tag, notDone, refused) => {
    const failure: FailureText = {
      tag,
      message: 'the sentence serve wrote',
      kind: 'other',
    };
    expect(
      refusalText(notDone, failure, InboxId.make('inbox-a'), refused),
    ).toBe(`${notDone}: the sentence serve wrote.`);
  });

  it('a tag serve does not declare says its tag', () => {
    const failure: FailureText = {
      tag: 'SomethingElse',
      message: 'what it said',
      kind: 'other',
    };
    expect(pinRefusal(failure)).toBe(
      'Not pinned — SomethingElse: what it said',
    );
  });
});

// A write answered with a declared error status whose body
// this page cannot decode (a newer serve's refusal) may have been made, so
// the page says it is unconfirmed and asks for a reload, never that it was
// not made.
describe('a write whose declared error reply does not decode', () => {
  it('is unconfirmed, never not done', async () => {
    reply = () =>
      new Response(
        JSON.stringify({ _tag: 'PinMovedElsewhere', note: 'From the future.' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    registry = AtomRegistry.make();
    const pin = pinAtom('inbox-a');
    const unmount = registry.mount(pin);
    registry.set(pin, { inboxId: InboxId.make('inbox-a'), pinned: true });
    const exit = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, pin, { suspendOnWaiting: true }),
    );
    unmount();
    if (Exit.isSuccess(exit)) throw new Error('the pin did not fail');
    expect(
      refusalText(
        'Not pinned',
        failureText(exit.cause),
        InboxId.make('inbox-a'),
        'PinRefused',
      ),
    ).toBe(`Unconfirmed: ${MISMATCH_MESSAGE}`);
  });
});

// A write a proxy answered for with a 502 or a 504 went out, and may have
// reached serve, so it is unconfirmed, never not done. Only a request that got
// no reply at all reads "Not sent".
describe('a write a proxy answered for', () => {
  it.each([502, 504])('a %i is unconfirmed', async (status) => {
    reply = empty(status);
    registry = AtomRegistry.make();
    const pin = pinAtom('inbox-a');
    const unmount = registry.mount(pin);
    registry.set(pin, { inboxId: InboxId.make('inbox-a'), pinned: true });
    const exit = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, pin, { suspendOnWaiting: true }),
    );
    unmount();
    if (Exit.isSuccess(exit)) throw new Error('the pin did not fail');
    const failure = failureText(exit.cause);
    expect(
      refusalText('Not pinned', failure, InboxId.make('inbox-a'), 'PinRefused'),
    ).toBe(`Unconfirmed: ${GATEWAY_SENTENCE}`);
    expect(isUnconfirmed(failure)).toBe(true);
  });
});

// A 2xx reply whose body cannot be read (`DecodeError`: the
// connection broke while the body came) answers a write that succeeded, so
// it may well have been made: unconfirmed, never not done. (A 2xx body that
// arrives but does not match is a `SchemaError`, a mismatch already.)
describe('a write whose 2xx reply does not decode', () => {
  const cases: ReadonlyArray<readonly [string, () => Response]> = [
    [
      'a body cut off while it is read',
      () =>
        new Response(
          new ReadableStream({
            start: (c) => c.error(new Error('connection reset')),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ],
  ];

  it.each(cases)('%s is unconfirmed', async (_, response) => {
    reply = response;
    registry = AtomRegistry.make();
    const pin = pinAtom('inbox-a');
    const unmount = registry.mount(pin);
    registry.set(pin, { inboxId: InboxId.make('inbox-a'), pinned: true });
    const exit = await Effect.runPromiseExit(
      AtomRegistry.getResult(registry, pin, { suspendOnWaiting: true }),
    );
    unmount();
    if (Exit.isSuccess(exit)) throw new Error('the pin did not fail');
    expect(
      refusalText(
        'Not pinned',
        failureText(exit.cause),
        InboxId.make('inbox-a'),
        'PinRefused',
      ),
    ).toBe(`Unconfirmed: ${MISMATCH_MESSAGE}`);
  });
});
