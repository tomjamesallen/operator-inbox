import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { InboxMetadataRules } from '../inbox-metadata';

// What serve reads from Local's metadata.json for the Inbox page: the
// metadata rules as the file holds them, or the default when there is no
// file. Its own endpoint, apart from the board, so the board's shape does not
// move. BROWSER-SAFE: the web app imports it, so it uses nothing Node-only.
export const InboxConfigDto = Schema.Struct({
  metadata: InboxMetadataRules,
});
export type InboxConfigDto = typeof InboxConfigDto.Type;

// metadata.json is there and did not load, or does not hold usable rules.
// Its message is the sentence the CLI
// prints for the same file (key, what was expected, what was there): this is
// the operator's own machine, and the sentence is what they need to fix it.
export class InboxConfigUnreadable extends Schema.Error<InboxConfigUnreadable>(
  'InboxConfigUnreadable',
)(
  { message: Schema.String, _tag: Schema.tag('InboxConfigUnreadable') },
  { httpApiStatus: 500 },
) {}

export class InboxConfigApiGroup extends HttpApiGroup.make('inboxConfig').add(
  HttpApiEndpoint.get('read', '/inbox-config', {
    success: InboxConfigDto,
    error: [InboxConfigUnreadable],
  }),
) {}
