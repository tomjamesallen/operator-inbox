import { OperatorInboxApi } from '@operator-inbox/core/api';
import { FetchHttpClient } from 'effect/http';
import { AtomHttpApi } from 'effect/reactivity';

// The typed client, derived from the SAME `HttpApi` `operator-inbox serve`
// implements: no hand-written fetch layer, no second copy of the types.
// Same-origin: serve hosts the shell itself, and the Vite dev server proxies
// /api to it.
export class InboxClient extends AtomHttpApi.Service<InboxClient>()(
  'InboxClient',
  { api: OperatorInboxApi, httpClient: FetchHttpClient.layer },
) {}
