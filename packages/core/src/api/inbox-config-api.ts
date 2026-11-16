import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { InboxMetadataRules } from '../inbox-metadata';

// How long a question may sit with the agent before the page says it
// probably needs chasing, in minutes: config.json's `chaseAfterMinutes`.
export const ChaseAfterMinutes = Schema.Number.check(Schema.isGreaterThan(0));
export const DEFAULT_CHASE_AFTER_MINUTES = 10;

// How a picture in a question's body (a drawing, a Mermaid diagram) is sized:
// config.json's `diagramSize`. `box` fills the box it may take, as wide as
// the room to the right edge and as tall as the height cap allow. `area`
// does the same and also holds its area to a budget, so a picture of any
// shape takes about as much of the page. Never larger than its own size,
// either way. The rule itself is `pictureFrameStyle` in the web app.
export const DiagramSize = Schema.Literals(['box', 'area']);
export type DiagramSize = typeof DiagramSize.Type;
export const DEFAULT_DIAGRAM_SIZE: DiagramSize = 'box';

// What serve reads from Local's config for the Inbox page: the metadata rules
// from metadata.json as the file holds them, or the default when there is no
// file, and config.json's `chaseAfterMinutes` and `diagramSize` when they
// are set. Its own
// endpoint, apart from the board, so the board's shape does not move.
// BROWSER-SAFE: the web app imports it, so it uses nothing Node-only.
export const InboxConfigDto = Schema.Struct({
  metadata: InboxMetadataRules,
  // Absent: unset, or from a serve that predates it. The page then uses
  // `DEFAULT_CHASE_AFTER_MINUTES`.
  chaseAfterMinutes: Schema.optionalKey(ChaseAfterMinutes),
  // Absent: unset, or from a serve that predates it. The page then uses
  // `DEFAULT_DIAGRAM_SIZE`.
  diagramSize: Schema.optionalKey(DiagramSize),
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
