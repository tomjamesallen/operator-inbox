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

// How the page pulls the operator back to the priority Inbox once they answer
// a Question in another Inbox while it has Questions waiting: config.json's
// `priorityPull`. `interjection`: the next thing in the reader is a card
// saying how many wait there, to go there or carry on, shown again after
// every answer while anything waits. `boomerang`: the reader goes straight
// there, and back to where the operator was once nothing waits there.
export const PriorityPull = Schema.Literals(['interjection', 'boomerang']);
export type PriorityPull = typeof PriorityPull.Type;
export const DEFAULT_PRIORITY_PULL: PriorityPull = 'interjection';

// How a table or a picture wider than the text column widens in the reading
// column: config.json's `wideBlocks`. `both`: it is centred on the column,
// growing both ways while there is room either side, then grows right only
// from the left limit, so it uses the room. `right`: it keeps the text's left
// edge and grows right only, so everything in a Question starts where its
// text does. A code block grows right only either way: its lines are read,
// and a line is easier to find from where the text starts.
export const WideBlocks = Schema.Literals(['both', 'right']);
export type WideBlocks = typeof WideBlocks.Type;
export const DEFAULT_WIDE_BLOCKS: WideBlocks = 'both';

// What serve reads from Local's config for the Inbox page: the metadata rules
// from metadata.json as the file holds them, or the default when there is no
// file, and config.json's `chaseAfterMinutes`, `diagramSize`,
// `priorityPull` and `wideBlocks` when they are set. Its own
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
  // Absent: unset, or from a serve that predates it. The page then uses
  // `DEFAULT_PRIORITY_PULL`.
  priorityPull: Schema.optionalKey(PriorityPull),
  // Absent: unset, or from a serve that predates it. The page then uses
  // `DEFAULT_WIDE_BLOCKS`.
  wideBlocks: Schema.optionalKey(WideBlocks),
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
