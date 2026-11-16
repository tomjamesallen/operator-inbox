import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import {
  INBOX_MACHINE_HOST,
  type InboxMachineName,
  type InboxMachinePort,
  type MachineCallRead,
  machineRef,
  machineText,
  machineView,
} from '@operator-inbox/core';
import {
  AnswerRefused,
  ArchiveRefused,
  AskRefused,
  HighlightRefused,
  type HttpApiDecodeError,
  type InboxBoardDto,
  type InboxIndexDto,
  type InboxMachineRef,
  InboxNotFound,
  InboxUnavailable,
  type InboxViewDto,
  MACHINE_CALL_TIMEOUT,
  MACHINE_WRITE_TIMEOUT,
  MuteRefused,
  OperatorInboxApi,
  PinRefused,
  PriorityRefused,
  RenameRefused,
} from '@operator-inbox/core/api';
import {
  type Cause,
  Data,
  Duration,
  Effect,
  Fiber,
  Option,
  Predicate,
  Schema,
  Stream,
} from 'effect';
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/http';
import { HttpApiClient } from 'effect/http-api';

// Local's serve calling one Inbox machine's serve through its SSH tunnel,
// with the client derived from the same `OperatorInboxApi` the web
// client uses. Every call:
//
// - goes over `node:http` (`layerNodeHttp`), never the global `fetch`: fetch
//   drops a `Host` set on the request and sends the tunnel's own authority,
//   which the machine's Host guard answers with 421. `node:http` sends the
//   `Host` set here;
// - names `Host: 127.0.0.1:7184`, the port the machine's serve bound, whatever
//   local port the tunnel listens on;
// - carries `local=true`, so the machine answers from its own log only: it
//   never fans out to its own Inbox machines, nor routes an Inbox id on to
//   one. Local merges one level, two machines that list each other never call
//   each other back, and an Inbox two machines away is never reached. It is
//   set on the request here, below every call, so no call can leave it out;
// - gives up after MACHINE_CALL_TIMEOUT for a read, so a machine that hangs
//   slows the board by that much and no more, and after the longer
//   MACHINE_WRITE_TIMEOUT for a forwarded write, which may still land;
// - reads at most MACHINE_RESPONSE_LIMIT bytes of the answer, so a machine
//   cannot fill Local's memory, nor make a string too long to decode.
//
// The layer is provided per call, so no caller can put the calls on fetch.

// MACHINE_CALL_TIMEOUT and MACHINE_WRITE_TIMEOUT live in core's contract
// (`serve-timeouts.ts`), so the page derives its own bound from them.
export { MACHINE_CALL_TIMEOUT, MACHINE_WRITE_TIMEOUT };

// The most Local reads of one machine's answer: a board of a few hundred
// Inboxes is well under a megabyte.
export const MACHINE_RESPONSE_LIMIT = 16 * 1024 * 1024;

export interface MachineCallOptions {
  // Overrides MACHINE_CALL_TIMEOUT for a read; tests shorten it.
  readonly timeout?: Duration.Input;
  // Overrides MACHINE_WRITE_TIMEOUT for a forwarded write; tests shorten it.
  readonly writeTimeout?: Duration.Input;
  // Overrides MACHINE_RESPONSE_LIMIT; tests lower it.
  readonly maxBytes?: number;
}

// A forwarded call reads or writes: only a write's timeout leaves its
// outcome unknown.
export type MachineCallKind = 'read' | 'write';

// An answer longer than Local will read, carried as the `cause` of the
// HttpClientError the derived client fails with.
class MachineResponseTooLarge extends Data.TaggedError(
  'MachineResponseTooLarge',
)<{ readonly maxBytes: number }> {}

const MIB = 1024 * 1024;
const sizeOf = (bytes: number): string =>
  bytes >= MIB && bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;

// Every refusal an inbox endpoint declares (`InboxApiGroup`), as one tagged
// union: the type, and the tags `isTransportFailure` and `refusalOn` test,
// both come from it, so a refusal is added in one place.
const InboxRefusals = Schema.Union([
  InboxNotFound,
  AnswerRefused,
  AskRefused,
  RenameRefused,
  HighlightRefused,
  PinRefused,
  ArchiveRefused,
  MuteRefused,
  PriorityRefused,
  InboxUnavailable,
]).pipe(Schema.toTaggedUnion('_tag'));
export type InboxRefusal = typeof InboxRefusals.Type;

const REFUSAL_TAGS: ReadonlySet<string> = new Set(InboxRefusals.discriminants);

// The part of a refusal's body Local passes on: the machine's tag, its
// sentence, and a rename's `conflictingInboxId` as sent (the client's decode
// judges it). Every other key the machine sent is dropped by the decode.
const RefusalBody = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literals(InboxRefusals.discriminants),
    message: Schema.String,
    conflictingInboxId: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeRefusalBody = Schema.decodeUnknownOption(RefusalBody);

// A forwarded call's refusal body as Local passes it on: the machine's tag and sentence, the sentence through `machineText` as
// every machine's words are, a rename's `conflictingInboxId` as sent, and
// `machine` set to the machine Local sent the call to. Nothing else the
// machine sent is kept (`RefusalBody`), so a machine cannot put a field only
// Local sets (`machine`, `clashedOn`, `mayHaveLanded`) on its own refusal.
// Rewritten before the client decodes it, so the refusal comes back as the
// client's own member of the endpoint's errors. Any other body (one that is
// not JSON, not a refusal, or whose sentence is not a string) is left as it
// came, for the decode to judge.
const refusalOn = (
  body: Uint8Array,
  machine: InboxMachineRef,
): Uint8Array<ArrayBuffer> | undefined =>
  Option.getOrUndefined(
    Option.map(
      decodeRefusalBody(new TextDecoder().decode(body)),
      ({ _tag, message, ...rest }) =>
        new TextEncoder().encode(
          JSON.stringify({
            message: machineText(message),
            ...rest,
            machine,
            _tag,
          }),
        ),
    ),
  );

// The answer read whole, but never past `maxBytes`: refused on its declared
// length before any of it is read, or as soon as the bytes read pass the
// limit. What is read comes back as a response the client decodes as usual,
// with a refusal's body passed on as `refusalOn` says when `machine` is
// given.
const cappedResponse =
  (maxBytes: number, machine: InboxMachineRef | undefined) =>
  (
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  > =>
    Effect.gen(function* () {
      const tooLarge = new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          request: response.request,
          response,
          cause: new MachineResponseTooLarge({ maxBytes }),
          description: `the body is over ${sizeOf(maxBytes)}`,
        }),
      });
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes)
        return yield* Effect.fail(tooLarge);
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      yield* Stream.runForEach(response.stream, (chunk) => {
        total += chunk.length;
        if (total > maxBytes) return Effect.fail(tooLarge);
        chunks.push(chunk);
        return Effect.void;
      });
      const read = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        read.set(chunk, at);
        at += chunk.length;
      }
      const refusal =
        machine === undefined ||
        (response.status >= 200 && response.status < 300)
          ? undefined
          : refusalOn(read, machine);
      const { 'content-length': _, ...headers } = response.headers;
      const body = refusal ?? read;
      return HttpClientResponse.fromWeb(
        response.request,
        new Response(body.length === 0 ? null : body, {
          status: response.status,
          headers,
        }),
      );
    });

// The derived client, aimed at one tunnel port, with the machine's `Host`
// and `local=true` on every request, every answer capped at `maxBytes`, and
// every refusal passed on with `machine` set when it is given.
const machineApi = (
  port: InboxMachinePort,
  maxBytes: number,
  machine: InboxMachineRef | undefined,
) =>
  HttpApiClient.make(OperatorInboxApi, {
    baseUrl: `http://127.0.0.1:${port}`,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.setHeader('host', INBOX_MACHINE_HOST),
            HttpClientRequest.setUrlParam('local', 'true'),
          ),
        ),
        HttpClient.transformResponse(
          Effect.flatMap(cappedResponse(maxBytes, machine)),
        ),
      ),
  });

export type MachineApi = Effect.Success<ReturnType<typeof machineApi>>;

// A defect inside one call to a machine (the client throwing on an answer
// it cannot handle), as a failure of that call, so it is classified with the
// rest and never escapes as a defect of Local's.
class MachineAnswerDefect extends Data.TaggedError('MachineAnswerDefect')<{
  readonly defect: unknown;
}> {}

// What the derived client fails with besides an endpoint's own refusals: the
// transport's failure, a body that does not decode, or the machine refusing
// the request Local sent as one it cannot decode (`HttpApiDecodeError`: the
// page's request decoded on Local, so the two serves' contracts differ).
type ClientFailure =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | HttpApiDecodeError;

// Every way a call to a machine fails that is not one of the inbox's
// refusals: the client's, a timeout, or a defect inside the call.
type TransportFailure =
  | ClientFailure
  | Cause.TimeoutError
  | MachineAnswerDefect;

// A failure is the transport's when it is none of the inbox's refusals.
const isTransportFailure = (
  error: InboxRefusal | TransportFailure,
): error is TransportFailure => !REFUSAL_TAGS.has(error._tag);

// What a read of a machine (its board or its index) fails with: the
// transport, or its store refusing (`InboxUnavailable`, the only refusal
// those endpoints declare).
export type MachineReadFailure = InboxUnavailable | TransportFailure;

// One call to the machine on `port`, timed out and on `node:http`; a defect
// inside it is that call's failure (`MachineAnswerDefect`). Given `machine`,
// a refusal comes back with it set (`refusalOn`).
const callMachine = <A, E>(
  port: InboxMachinePort,
  call: (api: MachineApi) => Effect.Effect<A, E>,
  timeout: Duration.Input,
  options: MachineCallOptions | undefined,
  machine?: InboxMachineRef,
): Effect.Effect<A, E | Cause.TimeoutError | MachineAnswerDefect> =>
  Effect.flatMap(
    machineApi(port, options?.maxBytes ?? MACHINE_RESPONSE_LIMIT, machine),
    call,
  ).pipe(
    Effect.timeout(timeout),
    Effect.provide(NodeHttpClient.layerNodeHttp),
    Effect.catchDefect((defect) =>
      Effect.fail(new MachineAnswerDefect({ defect })),
    ),
  );

const readTimeout = (options: MachineCallOptions | undefined) =>
  options?.timeout ?? MACHINE_CALL_TIMEOUT;
const writeTimeout = (options: MachineCallOptions | undefined) =>
  options?.writeTimeout ?? MACHINE_WRITE_TIMEOUT;

// Why a call reached no usable answer, in a short sentence, and which of the
// two failures it was. Nothing answering (a refused connection: the tunnel is
// down; a connection reset, closed or failing otherwise before any answer; a
// timeout) is
// `unreachable`. Something answering with what the contract cannot read is
// `incompatible`: an undeclared status, a body that is not the contract's, or
// 421 — the machine's guard refusing the `Host`, which means the tunnel leads
// somewhere that is not that machine's serve on 127.0.0.1:7184. A 421 is a
// wrong destination, not a machine that is down, so it is not reported as
// `unreachable`, whose hint is to open the tunnel. An answer over the byte
// limit is `incompatible` too. Every sentence passes through core's
// `machineText`, since a machine's words may carry escapes.
type Failure = Exclude<
  MachineCallRead<never>,
  { readonly status: 'reachable' }
>;

export const classifyMachineFailure = (
  port: InboxMachinePort,
  error: MachineReadFailure,
  timeout: Duration.Input = MACHINE_CALL_TIMEOUT,
): Failure => {
  const failure = classifyUnsafe(port, error, timeout);
  return { ...failure, detail: machineText(failure.detail) };
};

// One arm per failure the channel can carry: there is no other.
const classifyUnsafe = (
  port: InboxMachinePort,
  error: MachineReadFailure,
  timeout: Duration.Input,
): Failure => {
  switch (error._tag) {
    case 'MachineAnswerDefect':
      return {
        status: 'incompatible',
        reason: 'undecodable',
        detail: defectDetail(port, error.defect),
      };
    case 'TimeoutError':
      return {
        status: 'unreachable',
        reason: 'timed-out',
        detail: `no answer on port ${port} within ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
      };
    case 'InboxUnavailable':
      return {
        status: 'unreachable',
        reason: 'store-unavailable',
        detail: `its inbox store is unavailable: ${error.message}`,
      };
    case 'HttpClientError':
      return httpFailure(port, error);
    case 'HttpApiDecodeError':
      return {
        status: 'incompatible',
        reason: 'undecodable',
        detail: `port ${port} could not decode the request Local sent: ${firstLine(error.message)}`,
      };
    case 'SchemaError':
      return {
        status: 'incompatible',
        reason: 'undecodable',
        detail: `port ${port} answered with a body that is not the inbox contract's: ${firstLine(error.message)}`,
      };
  }
};

const httpFailure = (
  port: InboxMachinePort,
  error: HttpClientError.HttpClientError,
): Failure => {
  const { reason } = error;
  if (reason._tag === 'TransportError')
    return transportFailure(port, reason.cause, reason.description);
  if (
    reason._tag === 'DecodeError' &&
    reason.cause instanceof MachineResponseTooLarge
  )
    return {
      status: 'incompatible',
      reason: 'undecodable',
      detail: `port ${port} answered with more than ${sizeOf(reason.cause.maxBytes)}, more than Local reads from a machine`,
    };
  if ('response' in reason) {
    const { status } = reason.response;
    if (status === 421)
      return {
        status: 'incompatible',
        reason: 'misdirected',
        detail: `port ${port} answered 421: the serve there refused the Host ${INBOX_MACHINE_HOST}, so the tunnel does not lead to the machine's serve on that port`,
      };
    if (status < 200 || status >= 300)
      return {
        status: 'incompatible',
        reason: 'undecodable',
        detail: `port ${port} answered HTTP ${status}, which the inbox contract does not declare`,
      };
    return {
      status: 'incompatible',
      reason: 'undecodable',
      detail: `port ${port} answered with a body that is not the inbox contract's`,
    };
  }
  return {
    status: 'incompatible',
    reason: 'undecodable',
    detail: error.message,
  };
};

// A connection something on the port accepted and then ended before any
// answer, told apart by how it ended (as Node reports each):
// - reset (`read ECONNRESET`, `write EPIPE`: an error the OS reported, so it
//   names its `syscall`): the far end closed with the request unread. That is
//   what ssh does with a `-L` connection whose forward the machine's sshd
//   refuses, or whose far end (the machine's serve on 7184) is not listening:
//   it holds the request until the machine answers the channel's open, and
//   closes it unread when the open fails. `ExitOnForwardFailure` covers only
//   the local bind, so ssh stays up, holding the port. `forward-refused`.
// - closed (Node's "socket hang up": ECONNRESET with no `syscall`): the far
//   end closed cleanly, having taken the request, and sent no answer: what
//   is behind the tunnel dropped the request. `hung-up`.
// A refused connection (ECONNREFUSED) is nothing listening: the tunnel is
// down, the one failure whose advice is to open it. Any other transport
// error says neither, so it is `connection-failed`, with the error's own
// words. A forwarded write that ends any way but refused may still have
// landed (`provesUnsent`).
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);
const codeOf = (cause: unknown): string | undefined =>
  Predicate.hasProperty(cause, 'code') && typeof cause.code === 'string'
    ? cause.code
    : undefined;

const transportFailure = (
  port: InboxMachinePort,
  cause: unknown,
  description: string | undefined,
): Failure => {
  const code = codeOf(cause);
  if (
    code !== undefined &&
    RESET_CODES.has(code) &&
    Predicate.hasProperty(cause, 'syscall')
  )
    return {
      status: 'unreachable',
      reason: 'forward-refused',
      detail: `port ${port} reset the connection before any answer${causeText(cause)}`,
    };
  if (code === 'ECONNRESET')
    return {
      status: 'unreachable',
      reason: 'hung-up',
      detail: `port ${port} closed the connection without answering${causeText(cause)}`,
    };
  const said = description === undefined ? '' : ` (${description})`;
  return code === 'ECONNREFUSED'
    ? {
        status: 'unreachable',
        reason: 'tunnel-down',
        detail: `nothing answered on port ${port}${said}`,
      }
    : {
        status: 'unreachable',
        reason: 'connection-failed',
        detail: `the connection to port ${port} failed before any answer${said}${causeText(cause)}`,
      };
};

const firstLine = (s: string): string => s.split('\n')[0] ?? s;

const causeText = (cause: unknown): string =>
  cause instanceof Error && cause.message !== '' ? ` (${cause.message})` : '';

// A defect inside the call (the client throwing on an answer it cannot
// handle) is the machine's answer failing too, never the board's.
const defectDetail = (port: InboxMachinePort, defect: unknown): string =>
  `port ${port} answered with something Local could not read: ${
    defect instanceof Error ? defect.message : String(defect)
  }`;

// A read, never failing: one machine failing never fails the board, nor the
// index, whatever it sent.
const classified = <A>(
  port: InboxMachinePort,
  call: (api: MachineApi) => Effect.Effect<A, InboxUnavailable | ClientFailure>,
  options: MachineCallOptions | undefined,
): Effect.Effect<MachineCallRead<A>> =>
  callMachine(port, call, readTimeout(options), options).pipe(
    Effect.map((value): MachineCallRead<A> => ({ status: 'reachable', value })),
    Effect.catch((error) =>
      Effect.succeed<MachineCallRead<A>>(
        classifyMachineFailure(port, error, readTimeout(options)),
      ),
    ),
  );

// The machine's whole inbox board, for Local's merged board.
export const fetchMachineBoard = (
  port: InboxMachinePort,
  options?: MachineCallOptions,
): Effect.Effect<MachineCallRead<InboxBoardDto>> =>
  classified(port, (api) => api.inbox.board({ query: {} }), options);

// The machine's index, for Local's merged index.
export const fetchMachineIndex = (
  port: InboxMachinePort,
  options?: MachineCallOptions,
): Effect.Effect<MachineCallRead<InboxIndexDto>> =>
  classified(port, (api) => api.inbox.index({ query: {} }), options);

// A write that failed this way was never acted on: the connection was
// refused, so nothing was sent (the tunnel is down), or the far end refused
// the request before any handler ran (a 421 from the machine's Host guard,
// or the machine saying it could not decode the request). Any other failure
// came after the request may have been sent: a connection taken
// and reset or closed, an answer that does not decode, is over the byte
// limit or has a status the contract does not declare, a defect, a timeout.
const provesUnsent = (error: TransportFailure, failure: Failure): boolean =>
  failure.reason === 'misdirected' ||
  error._tag === 'HttpApiDecodeError' ||
  (error._tag === 'HttpClientError' &&
    error.reason._tag === 'TransportError' &&
    codeOf(error.reason.cause) === 'ECONNREFUSED');

// What a forwarded call that reached no answer comes to: InboxUnavailable,
// naming the machine. A write that may have landed (`provesUnsent`) says the
// outcome is not known, and sets `mayHaveLanded`, rather than that nothing
// was reached or that the machine's answer was of no use.
const unavailableOn = (
  machine: Pick<InboxMachineName, 'key' | 'label'>,
  kind: MachineCallKind,
  error: TransportFailure,
  failure: Failure,
  timeout: Duration.Input,
): InboxUnavailable => {
  const mayHaveLanded = kind === 'write' && !provesUnsent(error, failure);
  const sentence = mayHaveLanded
    ? `${
        failure.reason === 'timed-out'
          ? `the Inbox machine ${machine.label} did not answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}`
          : `no answer Local can use came from the Inbox machine ${machine.label}: ${failure.detail}`
      }; the change may have reached it — reload to check`
    : failure.status === 'unreachable'
      ? `the Inbox machine ${machine.label} could not be reached: ${failure.detail}`
      : `the Inbox machine ${machine.label} answered with something Local cannot use: ${failure.detail}`;
  return new InboxUnavailable({
    message: sentence,
    machine: machineRef(machine),
    ...(mayHaveLanded ? { mayHaveLanded } : {}),
  });
};

// How a forwarded write is run: on a fiber of its own, which the caller
// joins, so that once sent it is not cut off when the call waiting on it is
// interrupted (the server interrupts a request's handler when its client
// disconnects, and again when its shutdown grace runs out). Serve's keeps
// each such fiber in a set its scope awaits before it closes
// (`servedInboxMachinesLayer`), so stopping serve finishes a write in flight
// rather than cutting it; each still ends within its own write timeout.
export type KeepWrite = <A, E>(
  write: Effect.Effect<A, E>,
) => Effect.Effect<A, E>;

// A write on a fiber no scope owns: it outlives the call waiting on it, but
// not the process. Only for callers with no serve scope to hold it (tests,
// and a ServedInboxMachines built without its layer).
export const detachedWrite: KeepWrite = (write) =>
  Effect.flatMap(Effect.forkDetach(write), Fiber.join);

// One call of the derived client keyed by an Inbox id, refused with `E` or
// failing in the client's own way.
export type ForwardedCall<E extends InboxRefusal> = (
  api: MachineApi,
) => Effect.Effect<InboxViewDto, E | ClientFailure>;

// One endpoint keyed by an Inbox id (`view`, `answer`, `dismissHighlight`,
// `pin`, `archive`, `mute`, `rename`), sent to the machine that owns the
// Inbox. Its view comes back through core's `machineView`: `machine` set to the
// machine's ref, and every question's body rendered again by Local, never
// the machine's HTML. Its refusals (InboxNotFound, AnswerRefused, …) come
// back with the owning machine's own sentence, and `machine` set too
// (`refusalOn`). A transport failure, or a defect inside the call, becomes
// InboxUnavailable, naming the machine; a defect in Local's own rendering of
// the view stays a defect, Local's, never blamed on the machine. A `read`
// waits MACHINE_CALL_TIMEOUT, a `write` the longer MACHINE_WRITE_TIMEOUT. The
// call carries `local=true` (see `machineApi`), so the machine answers it
// from its own log and never sends it on to another machine. A write runs
// on a fiber of its own (`keep`, serve's `keepWrite`), joined here: once
// sent, it is not cut off when the page that asked goes away, nor when serve
// stops, and ends within its timeout all the same, so the machine's outcome
// is never interrupted half-way.
//
//   forwardInboxCall(machine, 'write', (api) =>
//     api.inbox.answer({ ...request, query: {} }),
//   )
export const forwardInboxCall = <E extends InboxRefusal>(
  machine: Pick<InboxMachineName, 'key' | 'label' | 'port'>,
  kind: MachineCallKind,
  call: ForwardedCall<E>,
  options?: MachineCallOptions,
  keep: KeepWrite = detachedWrite,
): Effect.Effect<InboxViewDto, E | InboxUnavailable> => {
  const timeout =
    kind === 'write' ? writeTimeout(options) : readTimeout(options);
  const ref = machineRef(machine);
  const unreached = (error: TransportFailure) =>
    Effect.fail(
      unavailableOn(
        machine,
        kind,
        error,
        classifyMachineFailure(machine.port, error, timeout),
        timeout,
      ),
    );
  const forwarded = callMachine(machine.port, call, timeout, options, ref).pipe(
    Effect.catchIf(isTransportFailure, unreached),
    Effect.map((view) => machineView(view, ref)),
  );
  return kind === 'write' ? keep(forwarded) : forwarded;
};
