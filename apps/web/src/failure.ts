import {
  AnswerRefused,
  ArchiveRefused,
  AskRefused,
  HighlightRefused,
  type InboxId,
  InboxNotFound,
  InboxUnavailable,
  inboxClashSentence,
  MuteRefused,
  PinRefused,
  PriorityRefused,
  RenameRefused,
} from '@operator-inbox/core/api';
import { Cause, Data, Predicate, Schema } from 'effect';
import { HttpClientError } from 'effect/http';

// A failed fetch, as the page shows it: the error's tag and its message. The
// server's own errors (`InboxUnavailable`, `InboxNotFound`) carry a sentence
// meant for this; a transport or decode failure (`HttpClientError`,
// `SchemaError`) carries its own. A defect or an interruption still says
// something rather than nothing.
//
// `kind` says what the page can tell the reader to do about it:
// - 'connection': the request never got a reply (an `HttpClientError` whose
//   reason is a request-side one: `TransportError`, `EncodeError`,
//   `InvalidUrlError`, or a read the page gave up on, `ReadTimedOut`). The
//   browser cannot tell a refused connection from one dropped after the
//   request went out, so a write that fails so reads "Not sent".
// - 'gateway': a proxy in front of serve answered for it with a 502 or a 504
//   (the Vite dev server's proxy does, with an empty body), or a 520 to 524
//   (a CDN's proxy gives those for an origin it could not reach or that timed
//   out). Serve's own answer did not come through, but the request did reach
//   the proxy, and may have reached serve, so a write answered so is
//   unconfirmed, never not done. A read asks whether serve is running, as for
//   'connection'.
// - 'mismatch': something answered, and the answer is not one this page
//   knows: a reply that did not decode (`SchemaError`, or an `HttpClientError`
//   whose reason is `StatusCodeError` when the status was a declared error
//   one, or `DecodeError` or `EmptyBodyError` on a 2xx), or a 404 for the
//   route.
//   The usual cause is a page left open while serve moved to a newer build
//   (no version rides on the wire), so the message
//   says the page is likely the older and asks for a reload. The page cannot
//   be sure — serve hands out the newest built page on every load, so a
//   rebuild without a restart leaves the page newer — so it names the restart
//   too. The decoder's own message runs to thousands of characters with the
//   cause at the end, so the page leads with a short sentence and keeps the
//   full text as `detail`. A write answered so may still have been made, so
//   the page never says it was not (`refusalText`).
// - 'undeclared': something answered with a status the contract does not
//   declare (a 401, a 408, a 429, a 415) and a body the page cannot read.
//   Serve or something in front of it answered, so the request went out, and
//   a write answered so is unconfirmed, never "Not sent". The decoder's own
//   message is kept as `detail`.
// - 'server': a 500 or a 503 whose body is not JSON (an HTML error page, from
//   serve or a proxy in front of it). Serve's own errors are
//   JSON, so this is a failure, not a reply from a newer serve, and it never
//   reads as the mismatch notice. The request went out, so a write answered
//   so is unconfirmed, never "Not sent". The decoder's message is `detail`.
// - 'other': anything else, including the server's own typed errors.
//
// `machine` is the label of the Inbox machine a refusal came from, when
// Local's serve forwarded the call to one (the error's `machine`);
// `clashedOn` names each machine that claims an Inbox refused as a clash
// (`InboxUnavailable`'s `clashedOn`).
export interface FailureText {
  readonly tag: string;
  readonly message: string;
  readonly kind:
    | 'connection'
    | 'gateway'
    | 'mismatch'
    | 'undeclared'
    | 'server'
    | 'other';
  readonly detail?: string;
  readonly machine?: string;
  readonly clashedOn?: ReadonlyArray<string>;
  // A write serve forwarded that may have reached the machine all the same
  // (`InboxUnavailable`'s `mayHaveLanded`).
  readonly mayHaveLanded?: true;
}

const labelOf = (x: unknown): string | undefined =>
  Predicate.hasProperty(x, 'label') && typeof x.label === 'string'
    ? x.label
    : undefined;

// The machine fields of a server error, as labels, when it carries them,
// and whether a forwarded write may have landed.
const machinesOf = (
  e: unknown,
): Pick<FailureText, 'machine' | 'clashedOn' | 'mayHaveLanded'> => {
  const machine = Predicate.hasProperty(e, 'machine')
    ? labelOf(e.machine)
    : undefined;
  const clashedOn =
    Predicate.hasProperty(e, 'clashedOn') && Array.isArray(e.clashedOn)
      ? e.clashedOn.flatMap((m: unknown) => labelOf(m) ?? [])
      : undefined;
  const mayHaveLanded =
    Predicate.hasProperty(e, 'mayHaveLanded') && e.mayHaveLanded === true;
  return {
    ...(machine === undefined ? {} : { machine }),
    ...(clashedOn === undefined ? {} : { clashedOn }),
    ...(mayHaveLanded ? { mayHaveLanded } : {}),
  };
};

// A read the page gave up waiting for (the board's bound,
// `BOARD_READ_BOUND`): no reply came, so it is the 'connection' kind, and the
// page asks whether serve is running.
export class ReadTimedOut extends Data.TaggedError('ReadTimedOut')<{
  readonly message: string;
}> {}

export const MISMATCH_MESSAGE =
  'The reply did not match what this page expects: this page is likely older than operator-inbox serve. Reload the page. If that does not clear it, restart operator-inbox serve.';

// A 500 or a 503 whose body is a page rather than JSON:
// serve, or a proxy in front of it, failed, and said so in a form no serve
// gives its page, so it is not a sign the page is older.
export const serverErrorMessage = (status: number): string =>
  `operator-inbox serve, or a proxy in front of it, answered HTTP ${status}, a server error`;

// Whether a reply's content type says JSON. A reply with none (serve's own
// empty 500 for a defect) is not called a page, so it stays a mismatch.
const isJson = (contentType: string | undefined): boolean =>
  contentType === undefined || /\bjson\b/i.test(contentType);

// What an `HttpClientError` says the page can do, from its reason. A
// request-side reason (`TransportError`, `EncodeError`, `InvalidUrlError`)
// means the request never got a reply. A response-side reason carries the
// reply, whose status decides the rest.
const httpKindOf = (
  e: HttpClientError.HttpClientError,
): FailureText['kind'] => {
  const reason = e.reason;
  switch (reason._tag) {
    case 'TransportError':
    case 'EncodeError':
    case 'InvalidUrlError':
      return 'connection';
    case 'StatusCodeError':
    case 'DecodeError':
    case 'EmptyBodyError': {
      const status = reason.response.status;
      if (status === 502 || status === 504 || (status >= 520 && status <= 524))
        return 'gateway';
      if (status === 404) return 'mismatch';
      if (
        (status === 500 || status === 503) &&
        !isJson(reason.response.headers['content-type'])
      )
        return 'server';
      // A 2xx serve answered whose body did not decode: the call succeeded,
      // so a write it answers was likely made, and the page must not say it
      // was not. It is a reply this page cannot read.
      if (status >= 200 && status < 300) return 'mismatch';
      // The typed client makes a `StatusCodeError` in one place only: a status
      // the contract declares for an error (400, 409, 500, 503) whose body did
      // not decode. The client fails with it and a `SchemaError` together, but
      // `AtomHttpApi` keeps only the first failure, so the `SchemaError` never
      // reaches the page and the reason is all there is to go on.
      // Any other status the contract does not declare: an answer, but not
      // one serve's contract gives.
      return reason._tag === 'StatusCodeError' ? 'mismatch' : 'undeclared';
    }
  }
};

// The HTTP status an `HttpClientError` was answered with, when it was.
const statusOf = (e: unknown): number | undefined =>
  HttpClientError.isHttpClientError(e) && 'response' in e.reason
    ? e.reason.response.status
    : undefined;

const kindOf = (tag: string, e: unknown): FailureText['kind'] => {
  if (HttpClientError.isHttpClientError(e)) return httpKindOf(e);
  if (e instanceof ReadTimedOut) return 'connection';
  if (tag === 'SchemaError') return 'mismatch';
  return 'other';
};

export const failureText = (cause: Cause.Cause<unknown>): FailureText => {
  const e = Cause.squash(cause);
  const tag =
    Predicate.hasProperty(e, '_tag') && typeof e._tag === 'string'
      ? e._tag
      : e instanceof Error
        ? e.name
        : 'Error';
  const raw =
    Predicate.hasProperty(e, 'message') && typeof e.message === 'string'
      ? e.message
      : String(e);
  const message = raw === '' ? Cause.pretty(cause) : raw;
  const kind = kindOf(tag, e);
  switch (kind) {
    case 'mismatch':
      return { tag, message: MISMATCH_MESSAGE, kind, detail: message };
    case 'server':
      return {
        tag,
        message: serverErrorMessage(statusOf(e) ?? 500),
        kind,
        detail: message,
      };
    case 'undeclared':
      return {
        tag,
        message: `operator-inbox serve, or a proxy in front of it, answered HTTP ${statusOf(e) ?? '?'}, which this page does not expect`,
        kind,
        detail: message,
      };
    default:
      return { tag, message, kind, ...machinesOf(e) };
  }
};

// The errors serve declares on every write besides the endpoint's own
// refusal (`InboxApiGroup`): each carries a sentence meant for the page
// (`inbox-api.ts`), so each reads as one, on every write alike.
// The tags come from the error classes themselves.
const SharedRefusals = Schema.Union([InboxNotFound, InboxUnavailable]).pipe(
  Schema.toTaggedUnion('_tag'),
);
const SENTENCE_TAGS: ReadonlySet<string> = new Set(
  SharedRefusals.discriminants,
);

// Each write's own refusal, so `refusedTag` names one of them, never a
// misspelt tag that would read through the foreign-tag arm.
const WriteRefusals = Schema.Union([
  AnswerRefused,
  AskRefused,
  HighlightRefused,
  PinRefused,
  ArchiveRefused,
  MuteRefused,
  PriorityRefused,
  RenameRefused,
]).pipe(Schema.toTaggedUnion('_tag'));
export type WriteRefusedTag = (typeof WriteRefusals.Type)['_tag'];

// A request that got no reply (the 'connection' kind), on a write: said as a
// sentence with the one thing to check, never the
// client's "Transport error (POST …)".
export const NO_REPLY_SENTENCE =
  'operator-inbox serve did not reply. Is operator-inbox serve running?';

// A refusal, as a card or the header says it: what was not done, on which
// machine when Local's serve forwarded the call to one, and why. A
// refusal whose Inbox two machines claim names each of them. `refusedTag` is the endpoint's own refusal; it and serve's
// other declared errors carry a sentence, so they read as one. Anything else
// (a request that got no reply, a defect) says its tag.
export const refusalText = (
  notDone: string,
  failure: FailureText,
  inboxId: InboxId,
  refusedTag: WriteRefusedTag,
): string => {
  const claimants = failure.clashedOn ?? [];
  if (claimants.length > 0)
    return `${notDone}: ${inboxClashSentence(
      inboxId,
      claimants.map((label) => ({ label })),
    )}.`;
  // A reply the page cannot read says nothing of whether the write was made
  // so it is never said not to be done: the sentence asks for a reload.
  if (failure.kind === 'mismatch') return `Unconfirmed: ${failure.message}`;
  // A proxy answered for serve: the write may have gone through it.
  if (failure.kind === 'gateway') return `Unconfirmed: ${GATEWAY_SENTENCE}`;
  // Something answered with a status the contract does not declare, or with
  // a server error page: the request went out, so the write may have been
  // made.
  if (failure.kind === 'undeclared' || failure.kind === 'server')
    return `Unconfirmed: ${failure.message}, so the change may have been made. The next read shows whether it was.`;
  if (failure.kind === 'connection') return `${notDone}: ${NO_REPLY_SENTENCE}`;
  const on = failure.machine === undefined ? '' : ` on ${failure.machine}`;
  // A write that may have reached the machine is never said not to be done:
  // serve's sentence says to reload to check.
  if (failure.mayHaveLanded === true)
    return `Unconfirmed${on}: ${failure.message}.`;
  return failure.tag === refusedTag || SENTENCE_TAGS.has(failure.tag)
    ? `${notDone}${on}: ${failure.message}.`
    : `${notDone}${on} — ${failure.tag}: ${failure.message}`;
};

// A write a proxy answered for (the 'gateway' kind). The page reads the
// board again on its own every few seconds, so it says that, rather than
// asking for a reload, which would drop what only this page holds.
export const GATEWAY_SENTENCE =
  'a proxy in front of operator-inbox serve answered for it, so the change may have been made. The next read shows whether it was.';

// Whether a write's failure leaves its outcome unknown: serve said the
// forwarded write may have landed, a proxy answered for serve, something
// answered with a status the contract does not declare, or with a server
// error page.
export const isUnconfirmed = (failure: FailureText): boolean =>
  failure.mayHaveLanded === true ||
  failure.kind === 'gateway' ||
  failure.kind === 'undeclared' ||
  failure.kind === 'server';

// A forwarded write that may have reached its machine, said short, for a
// place with little room (a pin's outcome under its sidebar row):
// what was unconfirmed, and where, without serve's full sentence.
export const unconfirmedShort = (what: string, failure: FailureText): string =>
  `${what} unconfirmed: it may have ${
    failure.machine === undefined ? 'been made' : `reached ${failure.machine}`
  }.`;

// What the page says when the board itself cannot be read. An unavailable
// store gets the one thing the operator can do about it, and the server's own
// line. A read the page gave up on is said as a sentence, never its tag, as a
// write that got no reply is.
export const fetchSentence = (failure: FailureText): string => {
  switch (failure.tag) {
    case 'InboxUnavailable':
      return `The inbox store is unavailable. Run operator-inbox install to check it. (The server said: ${failure.message})`;
    case 'ReadTimedOut':
      return `Could not load the inboxes: ${failure.message} Is operator-inbox serve running?`;
    default:
      return `Could not load the inboxes — ${failure.tag}: ${failure.message}${
        failure.kind === 'connection' || failure.kind === 'gateway'
          ? ' Is operator-inbox serve running?'
          : ''
      }`;
  }
};
