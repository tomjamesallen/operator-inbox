import { Effect, Schema, SchemaIssue } from 'effect';
import { HttpApi, HttpApiMiddleware } from 'effect/http-api';
import { formatSchemaIssues } from '../schema-issues';
import { InboxApiGroup } from './inbox-api';
import { InboxConfigApiGroup } from './inbox-config-api';
import { KeybindingsApiGroup } from './keybindings-api';
import { MacrosApiGroup } from './macros-api';
import { ReadoutApiGroup } from './readout-api';

// The local app's HTTP contract: the `HttpApi` that `operator-inbox serve`
// implements and the web client derives its Atoms from (`AtomHttpApi`).
// BROWSER-SAFE: nothing here, nor anything it imports, may pull a node-only
// module, since the web bundle imports it.
//
// One file per group holds its errors and its group class. The handlers and
// the live layer need the filesystem, which must never reach the browser
// bundle, so they live in apps/cli beside the `serve` command; this file holds
// the half both sides import.

// The port `operator-inbox serve` binds by default (`serve-port.ts`).
export { SERVE_DEFAULT_PORT } from './serve-port';

// Errors that cross the wire are schema errors, each earning its slot because
// the client renders it: an error must be visible, never swallowed.
//
// Each is `Schema.Error` with its `_tag` declared LAST, not
// `Schema.TaggedError`: Effect 4's `TaggedError` puts `_tag` first, and the
// body encodes in field order, while the wire carries
// `{"message":…,"_tag":…}` (pinned by
// packages/core/test/golden/v3/http-error-bodies.json).
// `Schema.TaggedError` is exactly `Schema.Error` over a struct holding
// `_tag: Schema.tag(…)`, so nothing else differs.

// A request that does not match the contract (a bad path parameter, or a JSON
// payload of the wrong shape) answers 400 with a JSON body naming what was
// wrong. A payload sent with no content-type, or as text/plain or
// form-urlencoded, never reaches this: Effect 4 answers it with a plain-text
// 415 that the contract does not declare. Left alone, Effect 4 answers a
// decode failure with an EMPTY 400 and declares nothing, unless a
// schema-error middleware turns its `HttpApiSchemaError` into a declared
// error. This middleware is that declaration, so the contract lists the 400
// on every endpoint (pinned by packages/core/test/golden/v3/http-status.json)
// and the body carries the issues a client needs to say what was wrong.
export class HttpApiDecodeError extends Schema.Error<HttpApiDecodeError>(
  'HttpApiDecodeError',
)(
  {
    issues: Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.PropertyKey),
        message: Schema.String,
      }),
    ),
    message: Schema.String,
    _tag: Schema.tag('HttpApiDecodeError'),
  },
  { httpApiStatus: 400 },
) {}

export class RequestDecodeErrors extends HttpApiMiddleware.Service<RequestDecodeErrors>()(
  'operator-inbox/RequestDecodeErrors',
  { error: HttpApiDecodeError },
) {}

// A request body that is not JSON at all. It answers an EMPTY 400, not the
// JSON one: there are no field issues to name. Effect 4.0.5 reports it as a
// `Payload` error whose issue is a bare
// top-level `InvalidValue` carrying the message "Expected a valid JSON body"
// (`HttpApiBuilder.ts`, `decodePayload`, the `JSON.parse` catch). A payload that
// parses but does not match its schema never yields that issue: a field issue
// sits under a key, and a whole-value check is wrapped in a `Filter`.
const isMalformedJsonBody = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === 'InvalidValue' &&
  issue.annotations?.message === 'Expected a valid JSON body';

// The server provides this layer. Only a REQUEST that fails to decode against
// its schema becomes the JSON 400. A malformed JSON body stays Effect 4's empty
// 400; a response that fails to encode stays Effect 4's empty 500, since it
// is the server's defect, not the client's mistake.
export const RequestDecodeErrorsLive =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestDecodeErrors, (error) =>
    error.kind === 'Body' ||
    error.kind === 'ResponseHeaders' ||
    (error.kind === 'Payload' && isMalformedJsonBody(error.cause.issue))
      ? Effect.fail(error)
      : Effect.fail(
          new HttpApiDecodeError({
            // The app's per-issue wording (`is missing`, `Expected X`),
            // from the one formatter core prints schema issues with.
            issues: formatSchemaIssues(error.cause.issue),
            message: SchemaIssue.makeFormatterDefault()(error.cause.issue),
          }),
        ),
  );

// Every route sits under /api, so the Vite dev proxy and the static shell
// never collide with it.
export class OperatorInboxApi extends HttpApi.make('operator-inbox')
  .add(InboxApiGroup)
  .add(InboxConfigApiGroup)
  .add(KeybindingsApiGroup)
  .add(MacrosApiGroup)
  .add(ReadoutApiGroup)
  .middleware(RequestDecodeErrors)
  .prefix('/api') {}
