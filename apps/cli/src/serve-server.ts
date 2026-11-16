import { createServer } from 'node:http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import type { ServeTailnet } from '@operator-inbox/core';
import {
  FORWARDED_WRITE_WORST,
  OperatorInboxApi,
  RequestDecodeErrorsLive,
} from '@operator-inbox/core/api';
import { Duration, Effect, Layer } from 'effect';
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { NetAddress } from 'effect/net';
import { ReadoutLive } from './readout';
import { attachmentRouteLive } from './serve-attachments';
import { makeInboxApiLive } from './serve-inbox-api';
import { makeInboxConfigApiLive } from './serve-inbox-config-api';
import { makeKeybindingsApiLive } from './serve-keybindings-api';
import { makeMacrosApiLive } from './serve-macros-api';
import { makeReadoutApiLive, readoutAudioRouteLive } from './serve-readout-api';
import { staticRoutesLive } from './serve-static';
import { vendorRoutesLive } from './serve-vendor';

// The HTTP server behind `operator-inbox serve`: the `OperatorInboxApi`
// contract, its groups' live layers, the web build's static routes, and a
// Node listener. Composition only; the handlers are in `serve-inbox-api.ts`,
// `serve-inbox-config-api.ts`, `serve-keybindings-api.ts`,
// `serve-readout-api.ts` and `serve-static.ts`.

// The ONLY interface the server binds: the inbox holds the operator's
// questions and answers, so it is never reachable from another machine
// directly. A constant, not a flag, so no invocation can widen it. The one
// way in from elsewhere is Tailscale's proxy, opted into in config.json and
// locked to named peers (the tailnet section below).
export const SERVE_HOST = '127.0.0.1';

// --- Local-only requests (DNS rebinding) ---
// Binding 127.0.0.1 keeps other MACHINES out, but not other web pages in this
// machine's browser. A hostile page can rebind its own hostname to 127.0.0.1
// and then read this server as if it were its own origin: same-origin to the
// browser, so no CORS check stands in the way. What gives it away is the
// `Host` header, which still names the hostile hostname. So a request is
// answered only when its `Host` names this server by loopback address or by
// `localhost`, on the port actually bound; anything else gets 421 and no
// data.
//
// An `Origin` header, when the browser sends one, must name one of the same
// two authorities over http, or the answer is 403. A same-origin GET carries
// no `Origin`, so the served app and the Vite dev proxy (which rewrites `Host`,
// `changeOrigin`) are unaffected; this refuses a cross-site page that reaches
// the right `Host` directly. That page could not read the answer anyway (no
// CORS headers are ever sent), so this is the belt to the `Host` braces, and
// it keeps any later endpoint that writes from being driven cross-site.
//
// ⚠ Writes, and the Vite dev server. A browser sends `Origin` on every POST,
// same-origin included, so the inbox's answer (the first endpoint that writes)
// arrives from the app under the dev server with `Origin:
// http://127.0.0.1:5173`, which is not an allowed authority here. The fix is
// at the proxy, NOT here: apps/web/vite.config.ts rewrites the forwarded
// `Origin` to this server's own authority, as `changeOrigin` does for `Host`.
// The allowed list stays exactly this server's two authorities.

// --- The tailnet ---
// When config.json sets `serve.tailnet`, `tailscale serve` proxies
// `https://<tailnet host>`, `http://<tailnet host>`, or the tailnet host on
// this listener's own port (`tailscale serve --http=7184`, for a machine whose
// 80 and 443 already proxy something else) to this listener, and such a
// request is answered
// too, but only from a peer in `allowFrom`. The listener still binds
// 127.0.0.1 only: the tailnet reaches it through Tailscale's proxy, never
// directly. The proxy names the peer in `X-Forwarded-For`, APPENDING to any
// value the client sent, so only the LAST entry is Tailscale's word; the
// earlier ones are whatever the client claimed.
//
// A request carrying `X-Forwarded-For` came through a proxy, and the only
// proxy allowed to send one is Tailscale's on the tailnet host. So a
// forwarded request is judged by the tailnet rule whatever its `Host` says:
// a proxy that rewrote `Host` to 127.0.0.1 cannot slip past the peer check
// by way of the loopback rule.

export type LocalOnlyVerdict =
  | 'allow'
  | 'misdirected'
  | 'cross-site'
  | 'peer-refused';

// The authorities (`host:port`) a request may name. Pure: the port is the one
// the listener actually bound, so port 0 resolves to the OS's choice. A
// listener with no TCP port (`undefined`) names none, so nothing is allowed.
export const allowedAuthorities = (
  port: number | undefined,
): readonly string[] =>
  port === undefined ? [] : [`${SERVE_HOST}:${port}`, `localhost:${port}`];

// The peer `tailscale serve` names: the last `X-Forwarded-For` entry.
const forwardedPeer = (forwardedFor: string): string | undefined =>
  forwardedFor.split(',').at(-1)?.trim().toLowerCase() || undefined;

const judgeTailnetRequest = (
  headers: {
    readonly host: string | undefined;
    readonly origin: string | undefined;
    readonly forwardedFor: string;
  },
  port: number | undefined,
  tailnet: ServeTailnet | undefined,
): LocalOnlyVerdict => {
  if (tailnet === undefined) return 'misdirected';
  const host = headers.host?.toLowerCase();
  // `tailscale serve` over https (443) or plain http (80), or on this
  // listener's own port: the traffic is WireGuard-encrypted on the tailnet
  // either way, and https only adds the certificate (and its name in the
  // public CT logs). The own port needs no config key: the port the tailnet
  // proxies to is the one this server listens on, so the two match. A
  // listener with no TCP port adds none.
  const authorities = [
    tailnet.host,
    ...(port === undefined ? [] : [`${tailnet.host}:${port}`]),
  ];
  const ownHosts = [
    ...authorities,
    `${tailnet.host}:443`,
    `${tailnet.host}:80`,
  ];
  if (host === undefined || !ownHosts.includes(host)) return 'misdirected';
  const peer = forwardedPeer(headers.forwardedFor);
  if (peer === undefined || !tailnet.allowFrom.includes(peer)) {
    return 'peer-refused';
  }
  const origin = headers.origin?.toLowerCase();
  if (
    origin !== undefined &&
    !authorities.some(
      (a) => origin === `https://${a}` || origin === `http://${a}`,
    )
  ) {
    return 'cross-site';
  }
  return 'allow';
};

export const judgeLocalRequest = (
  headers: {
    readonly host: string | undefined;
    readonly origin: string | undefined;
    readonly forwardedFor?: string | undefined;
  },
  port: number | undefined,
  tailnet?: ServeTailnet,
): LocalOnlyVerdict => {
  if (headers.forwardedFor !== undefined) {
    return judgeTailnetRequest(
      {
        host: headers.host,
        origin: headers.origin,
        forwardedFor: headers.forwardedFor,
      },
      port,
      tailnet,
    );
  }
  const allowed = allowedAuthorities(port);
  const host = headers.host?.toLowerCase();
  if (host === undefined || !allowed.includes(host)) return 'misdirected';
  const origin = headers.origin?.toLowerCase();
  if (origin !== undefined && !allowed.some((a) => origin === `http://${a}`)) {
    return 'cross-site';
  }
  return 'allow';
};

// --- Framing (clickjacking) ---
// The `Host` and `Origin` checks refuse a request a hostile page sends, but
// not one the app sends itself from inside a frame that hostile page drew: a
// tap on the inbox's own Answer, Archive or Open-session button is a
// same-origin request, so it passes both. So no page may frame this one.
// `frame-ancestors 'none'` is the current rule; `X-Frame-Options: DENY` is
// the older one, for any browser that ignores the first. Every answer
// carries both, refusals included, so nothing this server sends can be
// framed.
export const FRAMING_HEADERS = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
} as const;

// A refusal, framing headers and all. It needs them set here and not only by
// the pre-response handler below: a refusal stands in for the app, so the
// router's send path, where that handler runs, never sees it.
const refusal = (
  body: string,
  options: { readonly status: number },
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeaders(
    HttpServerResponse.text(body, options),
    FRAMING_HEADERS,
  );

// The middleware that applies the verdict ahead of every route, the static
// files' catch-all included. The bound
// port is read from the server on each request (a field read), so it is
// right for port 0 too. A refusal is a short plain-text sentence and never
// touches the handlers, so no inbox data can ride on it.
//
// The framing headers go on through a pre-response handler, registered
// before anything is judged, and NOT by mapping the response this returns:
// `HttpRouter.serve`'s middleware wraps the sending too, so a change to the
// response it hands back never reaches the client (that option's own doc
// says so). The handler runs on every response the router sends; a refusal
// is not one of those, so `refusal` sets them itself.
export const localOnlyWith =
  (tailnet: ServeTailnet | undefined) =>
  <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          HttpServerResponse.setHeaders(response, FRAMING_HEADERS),
        ),
      );
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { address } = yield* HttpServer.HttpServer;
      const port = NetAddress.isUnixPathAddress(address)
        ? undefined
        : address.port;
      const verdict = judgeLocalRequest(
        {
          host: request.headers.host,
          origin: request.headers.origin,
          forwardedFor: request.headers['x-forwarded-for'],
        },
        port,
        tailnet,
      );
      if (verdict === 'misdirected') {
        return refusal(
          'operator-inbox serve answers only requests addressed to 127.0.0.1, localhost or its configured tailnet name.\n',
          { status: 421 },
        );
      }
      if (verdict === 'peer-refused') {
        return refusal(
          'operator-inbox serve does not answer this tailnet device.\n',
          { status: 403 },
        );
      }
      if (verdict === 'cross-site') {
        return refusal(
          'operator-inbox serve does not answer cross-site requests.\n',
          { status: 403 },
        );
      }
      return yield* app;
    });

// The guard with no tailnet: loopback only.
export const localOnly = localOnlyWith(undefined);

// The API with every group's live layer under it. Adding a group is one more
// `Layer.provide` here. The inbox group needs `InboxLog`, which the caller
// provides LAZILY (`InboxLogLazy`), so the store never gates start-up. The
// readout group's `Readout` is lazy in the same way (`ReadoutLive`): nothing
// of listen mode is built, and no voice started, until a page asks. The
// API declares the `RequestDecodeErrors` middleware, which answers a request
// that does not decode with a 400 and a JSON body; its live layer is
// provided here, or the API does not build.
export const OperatorInboxApiLive = HttpApiBuilder.layer(OperatorInboxApi).pipe(
  Layer.provide(makeInboxApiLive(OperatorInboxApi)),
  Layer.provide(makeInboxConfigApiLive(OperatorInboxApi)),
  Layer.provide(makeKeybindingsApiLive(OperatorInboxApi)),
  Layer.provide(makeMacrosApiLive(OperatorInboxApi)),
  Layer.provide(
    makeReadoutApiLive(OperatorInboxApi).pipe(Layer.provide(ReadoutLive)),
  ),
  Layer.provide(RequestDecodeErrorsLive),
);

// How long serve's shutdown waits for the requests still running before it
// interrupts them (the Node server's own default is 20 s): the longest one
// forwarded write's request can take (`FORWARDED_WRITE_WORST`: the recorded
// owner's write, then a probe and the write to the owner it found), with 5 s
// to spare, so the page that sent it before serve was told to stop gets the
// machine's own answer. A write still running when the grace is up is not
// cut: its handler is, and the page gets the server's bare 503, but the write
// itself is finished before serve exits (`servedInboxMachinesLayer`).
export const SERVE_SHUTDOWN_GRACE = Duration.sum(
  FORWARDED_WRITE_WORST,
  Duration.seconds(5),
);

// Serve the API and the web build at `webDist` (`undefined`: none located) on
// `SERVE_HOST:port`, both behind `localOnly`; port 0 lets the OS choose. The
// `HttpServer` stays in the layer's services so the caller can read the bound address.
// The handlers still need `InboxLog`, which the caller
// provides. Effect 4's router logs every request and the listen address
// unless told not to. Both are off: start-up prints its own listening line
// (`announceStartup`), and serve's stderr is kept for what stops requests
// being answered as they should.
export const makeServeLayer = (
  port: number,
  webDist: string | undefined,
  tailnet?: ServeTailnet,
) =>
  HttpRouter.serve(
    Layer.mergeAll(
      OperatorInboxApiLive,
      readoutAudioRouteLive,
      attachmentRouteLive,
      vendorRoutesLive,
      staticRoutesLive(webDist),
    ),
    {
      middleware: localOnlyWith(tailnet),
      disableLogger: true,
      disableListenLog: true,
    },
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => createServer(), {
        host: SERVE_HOST,
        port,
        gracefulShutdownTimeout: SERVE_SHUTDOWN_GRACE,
      }),
    ),
  );
