import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { QuestionComments } from '../comments';
import { HTML_BLOCK_WIDTHS, HtmlBlocks } from '../html-block';
import {
  Drawings,
  Metadata,
  QuestionDrawing,
  QuestionNumber,
  QuestionRevision,
} from '../inbox';
import { SessionLink } from '../inbox-metadata';
import { MacrosInvoked } from '../macros';
import {
  InboxCode,
  InboxId,
  InboxMachineKey,
  type InboxMachinePort,
} from '../schema/identifiers';
import { SERVE_DEFAULT_PORT } from './serve-port';

// The page reads an inbox id from its own URL, and brands it with this; it
// keys its machine sections by an `InboxMachineKey`.
export { InboxId, InboxMachineKey };

// The inbox group of the local app's contract: two reads,
// the index of every Inbox and the operator's view of one, and the server's
// writes: answering a question, dismissing a highlight, pinning, archiving,
// muting, marking as the priority Inbox and renaming an Inbox, and opening a
// session link on this machine. BROWSER-SAFE, like the rest of this subpath (see `api.ts`): it
// imports only `effect` (its `effect/http-api` modules among them) and core's
// pure modules.

// A question waiting for the operator. `bodyHtml` is the agent's markdown body
// rendered on the server by core's small renderer, which escapes everything
// first, so the browser carries no markdown library. `body` is the same
// markdown raw, for the card's copy button. `revision` is sent back with an
// answer, so one typed against text the agent has since edited is refused.
//
// Every question carries the stamp of the move that put it in its column:
// `askedSeq`, `answeredSeq` or `processedSeq` is the event's place in the
// whole log (higher is later, across every Inbox, so it orders the All view
// too); the matching `…At` is when it was written (ISO), for display.
const at = Schema.optionalKey(Schema.String);
//
// Every question, and every Inbox's view, carries its metadata dictionary
// (string keys to string values, set by the agent); `{}` when it has none.

// A highlighted question carries `highlight`: the agent's note, if any, and
// `seq`, the highlight's place in the log, so the newest highlight sorts
// first. Only a question waiting for the operator carries it: "Your inbox"
// is the only column that shows highlights.
export const InboxHighlightDto = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  seq: Schema.Int,
});
export type InboxHighlightDto = typeof InboxHighlightDto.Type;

// The body as parts (core's `renderQuestionParts`): rendered HTML, and each
// ```mermaid fence as its source, which the page draws with Mermaid. The
// server always sends it; it is optional so a payload without it still
// decodes, and the page then shows `bodyHtml`.
export const QuestionBodyPartDto = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('html'), html: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('mermaid'), source: Schema.String }),
  // An `<Excalidraw id="…"/>` line: the Question's drawing of that id.
  Schema.Struct({ kind: Schema.Literal('excalidraw'), id: Schema.String }),
  // An `<Html id="…"/>` line: the Question's HTML block of that id, and how
  // wide it runs (left out: `constrain`).
  Schema.Struct({
    kind: Schema.Literal('html-block'),
    id: Schema.String,
    width: Schema.optionalKey(Schema.Literals(HTML_BLOCK_WIDTHS)),
  }),
]);
export type QuestionBodyPartDto = typeof QuestionBodyPartDto.Type;
const bodyParts = Schema.optionalKey(Schema.Array(QuestionBodyPartDto));

// The Question's drawings, by id (core's `InboxQuestion.drawings`): each scene
// as JSON text and the revision that last set it. Optional keys, so a machine
// on an older build, which never sends them, still decodes.
const drawings = Schema.optionalKey(
  Schema.Record(Schema.String, QuestionDrawing),
);
// The drawings the operator changed and sent with their answer, by id.
const sentDrawings = Schema.optionalKey(Drawings);
// The Question's HTML blocks, by id (core's `InboxQuestion.htmls`): each its
// document's hash and size only. The documents come from their own endpoint
// (`htmlBlocks`), fetched for the Question the page shows, so the board never
// carries them. An optional key, so a machine on an older build still decodes.
const htmls = Schema.optionalKey(HtmlBlocks);
// The macros the operator invoked with their answer, in order (core's
// `macros.ts`). An optional key, so a machine on an older build still decodes.
const macros = Schema.optionalKey(MacrosInvoked);
// The operator's comments on the Question's text, in body order (core's
// `comments.ts`). An optional key, for the same older machines.
const comments = Schema.optionalKey(QuestionComments);

export const InboxOperatorQuestionDto = Schema.Struct({
  number: QuestionNumber,
  revision: QuestionRevision,
  metadata: Metadata,
  title: Schema.String,
  body: Schema.String,
  bodyHtml: Schema.String,
  bodyParts,
  askedSeq: Schema.Int,
  askedAt: at,
  highlight: Schema.optionalKey(InboxHighlightDto),
  drawings,
  htmls,
});
export type InboxOperatorQuestionDto = typeof InboxOperatorQuestionDto.Type;

// Set on a question the operator put to the agent, absent on the agent's own.
// An optional key, so a machine on an older build, which never sends it,
// still decodes.
const operatorQuestion = Schema.optionalKey(Schema.Literal(true));

// Set on an answer that deferred the decision to the agent (core's
// `deferred`): `response` is the operator's note with it, '' for none. An
// optional key, for the same older machines.
const deferred = Schema.optionalKey(Schema.Literal(true));

// Set on an answer or an operator's question that asks the agent to highlight
// the Question it asks in reply (core's `highlightReply`). An optional key, so
// a machine on an older build, which never sends it, still decodes.
const highlightReply = Schema.optionalKey(Schema.Literal(true));

// A question with the operator's answer that the agent has not yet processed.
// `body` is the raw markdown, for the copy button; `bodyHtml` is rendered as
// for a waiting question, for the card's details dialog, which also shows
// when it was asked.
export const InboxAgentQuestionDto = Schema.Struct({
  number: QuestionNumber,
  revision: QuestionRevision,
  metadata: Metadata,
  title: Schema.String,
  body: Schema.String,
  bodyHtml: Schema.String,
  bodyParts,
  response: Schema.String,
  answeredSeq: Schema.Int,
  answeredAt: at,
  askedAt: at,
  // The operator put it to the agent (core's `operatorQuestion`):
  // `response` is their question, and there is no body.
  operatorQuestion,
  deferred,
  drawings,
  sentDrawings,
  macros,
  comments,
  htmls,
});
export type InboxAgentQuestionDto = typeof InboxAgentQuestionDto.Type;

// A processed question: either the agent dealt with the operator's answer
// (`response` is set, `withdrawn` false), or it withdrew the question before
// it was answered (`withdrawn` true, `reason` set; "" for a withdrawal logged
// before reasons were required). `bodyHtml` is shown in the card's details
// dialog, with when it was asked and answered; `body` is for the copy button.
export const InboxProcessedQuestionDto = Schema.Struct({
  number: QuestionNumber,
  revision: QuestionRevision,
  metadata: Metadata,
  title: Schema.String,
  body: Schema.String,
  bodyHtml: Schema.String,
  bodyParts,
  response: Schema.optionalKey(Schema.String),
  withdrawn: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  processedSeq: Schema.Int,
  processedAt: at,
  askedAt: at,
  answeredAt: at,
  operatorQuestion,
  deferred,
  drawings,
  sentDrawings,
  macros,
  comments,
  htmls,
});
export type InboxProcessedQuestionDto = typeof InboxProcessedQuestionDto.Type;

// --- Inbox machines: who a machine is ---------------------------------------------

// The name the app gives the machine the operator sits at, as GLOSSARY.md
// does: the first sidebar section's. No Inbox machine may take it, in any
// case, so no two sections read alike.
export const LOCAL_MACHINE = 'Local';

// Local's key, and an Inbox machine's: its tunnel port (`InboxMachineKey`).
// A section, its fold state and an owner record are keyed by these, never by
// the label, which is for display only.
export const LOCAL_MACHINE_KEY = InboxMachineKey.make('local');
export const inboxMachineKey = (port: InboxMachinePort): InboxMachineKey =>
  InboxMachineKey.make(String(port));

// The Inbox machine an Inbox, a view or a refusal comes from: its key, and
// its label for display (the Herdr machine's). Only Local's serve sets it,
// on what it merged or forwarded from a machine, for its own page; Local's
// own Inboxes and refusals leave it unset. A machine is always asked for its
// own Inboxes only (`local=true`, `InboxReadQuery`), so what a machine sends
// back never carries it, from this build or an older one: its shape is
// Local's and its page's alone. An optional key all the same, so a machine's
// answer that leaves it out decodes.
export const InboxMachineRef = Schema.Struct({
  key: InboxMachineKey,
  label: Schema.String,
});
export type InboxMachineRef = typeof InboxMachineRef.Type;
const machine = Schema.optionalKey(InboxMachineRef);

// The section a row, a view or a refusal belongs to: its machine's key, or
// Local's when it carries none.
export const machineKeyOf = (x: {
  readonly machine?: InboxMachineRef;
}): InboxMachineKey => x.machine?.key ?? LOCAL_MACHINE_KEY;

// The Inbox's code (core's `InboxCodeAssigned`), `xyz`: with a question's
// number it is that question's code, `xyz#12`, which the page shows on the
// card and the agent's CLI takes. Absent for an Inbox not yet given one, and
// from a machine whose serve predates codes.
const code = Schema.optionalKey(InboxCode);

// The three columns. `awaitingOperator` is oldest asked first (the page sorts
// it either way); `awaitingAgent` is oldest answered first, the order the
// agent will probably process them in; `processed` is
// newest processed first, and holds only the most recent (core's
// `PROCESSED_VIEW_CAP`, 30). `archived` is true for an Inbox the agent has
// archived: the page leaves its cards out of the All view.
// `pinnedGroups` is the groups the operator pinned, in the order pinned.
// `archivedGroups` is the groups archived, in the order archived: the page
// folds them away under the Inbox and leaves their cards out of All and of
// the Inbox's own view. Optional, so a machine's serve that predates group
// archives still decodes; absent reads as none, and serve leaves it out when
// there are none.
export const InboxViewDto = Schema.Struct({
  inboxId: InboxId,
  label: Schema.String,
  code,
  metadata: Metadata,
  archived: Schema.Boolean,
  // The operator muted it: greyed in the sidebar, its groups folded away and
  // its cards out of the All view. Optional, so a machine's serve that
  // predates mutes still decodes; absent reads as not muted.
  muted: Schema.optionalKey(Schema.Boolean),
  pinnedGroups: Schema.Array(Schema.String),
  archivedGroups: Schema.optionalKey(Schema.Array(Schema.String)),
  awaitingOperator: Schema.Array(InboxOperatorQuestionDto),
  awaitingAgent: Schema.Array(InboxAgentQuestionDto),
  processed: Schema.Array(InboxProcessedQuestionDto),
  machine,
});
export type InboxViewDto = typeof InboxViewDto.Type;

// One row of the all-inboxes page. The counts are the three columns'.
// `lastActivityAt` is when the Inbox's newest event was written (ISO, UTC),
// for display only: the order is the server's. `archived` puts the row in
// the sidebar's collapsed Archived section.
export const InboxSummaryDto = Schema.Struct({
  inboxId: InboxId,
  label: Schema.String,
  code,
  archived: Schema.Boolean,
  // The operator pinned it: the sidebar puts it above the unpinned ones.
  pinned: Schema.Boolean,
  // The operator muted it (see `InboxViewDto`). Absent reads as not muted.
  muted: Schema.optionalKey(Schema.Boolean),
  // The operator marked it as the priority Inbox (core's
  // `InboxPriorityMarked`): one at most in its machine's log. Absent reads as
  // not, and serve leaves it out unless it is, so a machine's serve that
  // predates the mark still decodes.
  priority: Schema.optionalKey(Schema.Literal(true)),
  awaitingOperator: Schema.Int,
  awaitingAgent: Schema.Int,
  processed: Schema.Int,
  lastActivityAt: Schema.optionalKey(Schema.String),
  machine,
});
export type InboxSummaryDto = typeof InboxSummaryDto.Type;

// Why a machine that is not `reachable` could not be read, for advice that
// fits it (`inboxMachineAdvice`). `unreachable`'s: `tunnel-down` (nothing
// answered on its port: open the tunnel), `forward-refused` (something
// listening on the port reset the connection before any answer, as ssh does
// with a forward it could not open: the tunnel is open, but the machine
// refused the forward or its serve is not running on SERVE_DEFAULT_PORT),
// `hung-up` (something listening on the port took the request and closed the
// connection without answering: the tunnel is open, and what is behind it
// dropped the request), `connection-failed` (the connection to its port
// failed some other way, which says neither that nothing listens there nor
// what does), `timed-out` (the tunnel is open
// but no answer came in time), `store-unavailable` (its serve answered, but
// its own inbox store is down), `unresolved` (it was never called: its
// `inboxMachines` entry names no usable Herdr machine, its Herdr label is
// another machine's or Local's, or its tunnel port is serve's own; a config
// error, so fix config.json, or Herdr's labels), `herdr-unread` (it was never
// called because Herdr itself failed or did not answer in time, which is no
// fault of its entry: fix Herdr). `incompatible`'s: `misdirected`
// (421: the port leads to a serve that is not that machine's on
// SERVE_DEFAULT_PORT) and `undecodable` (an answer the contract cannot read).
export const InboxUnreachableReason = Schema.Literals([
  'tunnel-down',
  'forward-refused',
  'hung-up',
  'connection-failed',
  'timed-out',
  'store-unavailable',
  'unresolved',
  'herdr-unread',
]);
export type InboxUnreachableReason = typeof InboxUnreachableReason.Type;
export const InboxIncompatibleReason = Schema.Literals([
  'misdirected',
  'undecodable',
]);
export type InboxIncompatibleReason = typeof InboxIncompatibleReason.Type;
export const InboxMachineReason = Schema.Union([
  InboxUnreachableReason,
  InboxIncompatibleReason,
]);
export type InboxMachineReason = typeof InboxMachineReason.Type;

// One sidebar section's machine, as Local's serve read it for its own page
//, in order: Local first, then each Inbox machine in the
// configured order. A tagged union on `status`, so each state carries
// exactly what it has:
// - `local`: Local itself, with the waiting count of its own active Inboxes;
//   it has no tunnel port, and it is always there.
// - `reachable`: an Inbox machine whose Inboxes are merged, with the waiting
//   count of its own active Inboxes (a refused clash left out).
// - `unreachable`: nothing answered (the connection was refused, dropped
//   before any answer, or timed out), its inbox store was down, or it was
//   never called (`unresolved`, `herdr-unread`).
// - `incompatible`: something answered with a response that did not decode.
// The last two carry `reason`, which of them it was, and `detail`, the
// reason in a sentence. `port` is the local port the machine's tunnel
// listens on, and `key` its `InboxMachineKey`.
const keyed = { key: InboxMachineKey, label: Schema.String };
export const LocalMachineStatusDto = Schema.Struct({
  status: Schema.Literal('local'),
  ...keyed,
  awaitingOperator: Schema.Int,
});
export const ReachableMachineStatusDto = Schema.Struct({
  status: Schema.Literal('reachable'),
  ...keyed,
  port: Schema.Int,
  awaitingOperator: Schema.Int,
});
export const UnreachableMachineStatusDto = Schema.Struct({
  status: Schema.Literal('unreachable'),
  ...keyed,
  port: Schema.Int,
  reason: InboxUnreachableReason,
  detail: Schema.String,
});
export const IncompatibleMachineStatusDto = Schema.Struct({
  status: Schema.Literal('incompatible'),
  ...keyed,
  port: Schema.Int,
  reason: InboxIncompatibleReason,
  detail: Schema.String,
});
export const InboxMachineStatusDto = Schema.Union([
  LocalMachineStatusDto,
  ReachableMachineStatusDto,
  UnreachableMachineStatusDto,
  IncompatibleMachineStatusDto,
]);
export type InboxMachineStatusDto = typeof InboxMachineStatusDto.Type;
// A machine that could not be read: what advice is given for.
export type UnreadMachineStatusDto = Extract<
  InboxMachineStatusDto,
  { readonly status: 'unreachable' | 'incompatible' }
>;

// An Inbox id two machines claim. An
// Inbox id is a ULID, so it belongs to one machine; two claiming it means
// one of them is not what its tunnel port says it is, or holds a copy of
// another's log. `claims` is each machine claiming it, in section order,
// with the name it gives the Inbox. `refused`: two Inbox machines claim it,
// so neither's copy is merged, and no write is sent to either
// (`InboxUnavailable` with `clashedOn`).
// `kept-on-local`: Local's own log has it, so Local's is the Inbox (Local's
// log answers first), and every machine's claim is left
// out.
export const InboxClashDto = Schema.Struct({
  inboxId: InboxId,
  outcome: Schema.Literals(['refused', 'kept-on-local']),
  claims: Schema.Array(
    Schema.Struct({ machine: InboxMachineRef, label: Schema.String }),
  ),
});
export type InboxClashDto = typeof InboxClashDto.Type;

// The command that opens one machine's tunnel, for advice beside a machine
// that cannot be reached, ready to paste into a shell: a label with anything
// a shell would read apart (a space, a quote) is single-quoted. Here, in the
// browser-safe contract, so the page and the CLI give the same command.
const SHELL_SAFE = /^[A-Za-z0-9._:@%+=,/-]+$/;
export const shellWord = (word: string): string =>
  SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
export const tunnelCommand = (label: string): string =>
  `operator-inbox tunnel ${shellWord(label)}`;

// Where a machine's serve logs, for advice that sends the operator to it.
const MACHINE_SERVE_LOG = '~/.local/state/operator-inbox/serve.log';

// What to do about a machine whose forward was refused: its tunnel is open
// (running the tunnel command again would find the port held), so the fix is
// on the machine.
export const forwardRefusedHint = (label: string): string => {
  const far = `127.0.0.1:${SERVE_DEFAULT_PORT}`;
  return `The tunnel to ${label} is open, but it reset the connection: on ${label}, check that sshd lets the tunnel forward to ${far} (AllowTcpForwarding, PermitOpen) and that \`operator-inbox serve\` runs there on port ${SERVE_DEFAULT_PORT}`;
};

// What to do about a machine that could not be read, by why (`reason`): the
// one place the advice is written, so the CLI and the page's section say the
// same. `advice` is a sentence without its full stop; `command` is set
// only when running a command is the fix, a tunnel that is down, for the
// page's copy button (the advice names it too). Only `tunnel-down` offers the
// tunnel command: every other reason is a tunnel
// already open, a machine never called, or a port something else holds, and
// for each the tunnel command would refuse a port already held or not help.
// `configPath` names the config.json for `unresolved`; the page does not
// know it, so it reads "config.json on this machine".
export interface InboxMachineAdvice {
  readonly advice: string;
  readonly command?: string;
}

export const inboxMachineAdvice = (
  machine: Pick<UnreadMachineStatusDto, 'label' | 'port' | 'reason'>,
  configPath?: string,
): InboxMachineAdvice => {
  const { label, port } = machine;
  const serveThere = `look at \`operator-inbox serve\` on ${label} (its log is ${MACHINE_SERVE_LOG})`;
  switch (machine.reason) {
    case 'tunnel-down': {
      const command = tunnelCommand(label);
      return { advice: `Open its tunnel with \`${command}\``, command };
    }
    case 'forward-refused':
      return { advice: forwardRefusedHint(label) };
    case 'hung-up':
      return {
        advice: `Its tunnel took the request and closed it without an answer, so ${serveThere}`,
      };
    case 'connection-failed':
      return {
        advice: `The connection to port ${port} failed: check what listens on port ${port} (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\`) and that it is ${label}'s tunnel`,
      };
    case 'timed-out':
      return { advice: `Its tunnel is open, so ${serveThere}` };
    case 'store-unavailable':
      return {
        advice: `Its serve answered, but its inbox store is down: ${serveThere}`,
      };
    case 'unresolved':
      return {
        advice: `Correct or remove its entry in inboxMachines in ${configPath ?? 'config.json on this machine'}`,
      };
    case 'herdr-unread':
      return {
        advice:
          'Herdr could not be read on this machine, which is no fault of any inboxMachines entry: check that Herdr is installed and that `herdr machine list --json` answers here',
      };
    case 'misdirected':
      return {
        advice: `Port ${port} leads to a serve that is not ${label}'s on its port ${SERVE_DEFAULT_PORT}: check what listens on port ${port} (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\`) and that it is ${label}'s tunnel`,
      };
    case 'undecodable':
      return {
        advice: `${label} runs an operator-inbox whose inbox contract this one cannot read: pull and \`pnpm build\` there, then restart its serve`,
      };
  }
};

// The sentence for an Inbox id two machines claim, naming each, for the
// refusal (`InboxUnavailable`'s `clashedOn`) and the page's notice alike.
export const inboxClashSentence = (
  inboxId: InboxId,
  machines: ReadonlyArray<Pick<InboxMachineRef, 'label'>>,
): string =>
  `the Inbox ${inboxId} is claimed by ${machines.map((m) => m.label).join(' and ')}: an Inbox lives on one machine, so it is refused on every one of them until one no longer has it`;

// The board's and the index's machine fields, which only Local's serve fills,
// for its own page; a serve asked with `local=true` (an Inbox machine, asked
// by Local) leaves all three out. Each is an optional key, so a machine's
// answer decodes whatever build it runs: a serve from before Inbox machines
// sends none of them.
// - `machines`: every section's machine, Local first (`InboxMachineStatusDto`).
// - `clashes`: each Inbox id two machines claim (`InboxClashDto`).
// - `machinesOff`: set when `config.json`'s `inboxMachines` (or config.json
//   itself) could not be read: the sentence saying why, for the page's
//   banner. At start-up no Inbox machine is read, and `machines` holds Local
//   alone; on a later re-read serve keeps the machines it read before, still
//   listed in `machines`, and the sentence says so.
const machines = Schema.optionalKey(Schema.Array(InboxMachineStatusDto));
const clashes = Schema.optionalKey(Schema.Array(InboxClashDto));
const machinesOff = Schema.optionalKey(Schema.String);

// Every Inbox on the machine: the active ones first, then the archived; within
// each, those with a question waiting for the operator first, then the rest,
// each most recent activity first. `totalAwaitingOperator` is the sum over the
// ACTIVE Inboxes, for the sidebar's All count. On Local's serve, the Inbox machines' Inboxes follow Local's, and the
// total adds every reachable machine's own.
export const InboxIndexDto = Schema.Struct({
  inboxes: Schema.Array(InboxSummaryDto),
  totalAwaitingOperator: Schema.Int,
  machines,
  clashes,
  machinesOff,
});
export type InboxIndexDto = typeof InboxIndexDto.Type;

// The whole inbox screen in one read, so it polls once: the sidebar's rows
// (as `/inboxes` orders them) and every Inbox's view, in the same order. The
// page shows one view, or merges them all for the All view.
export const InboxBoardDto = Schema.Struct({
  inboxes: Schema.Array(InboxSummaryDto),
  totalAwaitingOperator: Schema.Int,
  views: Schema.Array(InboxViewDto),
  machines,
  clashes,
  machinesOff,
});
export type InboxBoardDto = typeof InboxBoardDto.Type;

// One Question's HTML blocks' documents, by id: each its hash, which is the
// key of its blob, and the document's text. Read for the Question the page
// shows, never with the board. A block whose document the store does not
// hold (a log copied without its blobs) is left out, and the page shows it
// as missing.
export const QuestionHtmlBlocksDto = Schema.Struct({
  blocks: Schema.Record(
    Schema.String,
    Schema.Struct({ sha: Schema.String, doc: Schema.String }),
  ),
});
export type QuestionHtmlBlocksDto = typeof QuestionHtmlBlocksDto.Type;

export const RenamePayload = Schema.Struct({ label: Schema.String });
export type RenamePayload = typeof RenamePayload.Type;

// `seenRevision` is the revision the card showed when the operator typed.
export const AnswerPayload = Schema.Struct({
  response: Schema.String,
  seenRevision: QuestionRevision,
  // "Defer to agent": the agent decides, and `response` is an optional note.
  deferred,
  // "Highlight reply": the agent highlights the Question it asks in reply.
  highlightReply,
  // The drawings the operator changed, by id: each the whole edited scene.
  drawings: Schema.optionalKey(Drawings),
  // The macros the operator invoked, in order, each with its instruction.
  macros,
  // The operator's comments on spans of the Question's text.
  comments,
});
export type AnswerPayload = typeof AnswerPayload.Type;

// The operator's question to the agent, as they typed it.
export const AskPayload = Schema.Struct({
  text: Schema.String,
  highlightReply,
});
export type AskPayload = typeof AskPayload.Type;

// Pin or unpin the Inbox (no `group`), or one of its groups.
export const PinPayload = Schema.Struct({
  pinned: Schema.Boolean,
  group: Schema.optionalKey(Schema.String),
});
export type PinPayload = typeof PinPayload.Type;

// Archive the Inbox (`archived: true`) or bring it back (`false`).
export const ArchivePayload = Schema.Struct({ archived: Schema.Boolean });
export type ArchivePayload = typeof ArchivePayload.Type;

// Archive one of the Inbox's groups (`archived: true`) or bring it back
// (`false`). An endpoint of its own rather than a `group` on `ArchivePayload`:
// a serve that predates group archives would ignore the key and archive the
// whole Inbox, where an unknown path is refused.
export const GroupArchivePayload = Schema.Struct({
  group: Schema.String,
  archived: Schema.Boolean,
});
export type GroupArchivePayload = typeof GroupArchivePayload.Type;

// Mute the Inbox (`muted: true`) or unmute it (`false`).
export const MutePayload = Schema.Struct({ muted: Schema.Boolean });
export type MutePayload = typeof MutePayload.Type;

// Mark the Inbox as the priority Inbox (`priority: true`), clearing the mark
// on whichever Inbox of its log held it, or clear its own mark (`false`).
export const PriorityPayload = Schema.Struct({ priority: Schema.Boolean });
export type PriorityPayload = typeof PriorityPayload.Type;

// The errors are `Schema.Error` with `_tag` declared last, so the body keeps
// its wire order, `message` first: see the note on wire errors in `api.ts`.

// Every error may carry `machine`: the Inbox machine whose serve refused
// (the owning machine's answers and refusals come back with `machine` set), as `InboxMachineRef`. Local's own refusals leave it
// unset, and so does every machine's serve asked with `local=true`.
const refusedOn = Schema.optionalKey(InboxMachineRef);

// No Inbox has this id.
export class InboxNotFound extends Schema.Error<InboxNotFound>('InboxNotFound')(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('InboxNotFound'),
  },
  { httpApiStatus: 404 },
) {}

// The answer was refused: already answered (the double Send), processed,
// withdrawn, changed since the card was rendered, an unknown number, or empty. `message` is the refusal's own sentence, which the
// page shows as it is.
export class AnswerRefused extends Schema.Error<AnswerRefused>('AnswerRefused')(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('AnswerRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The operator's question was refused: it is empty. `message` is the
// refusal's own sentence, which the page shows as it is.
export class AskRefused extends Schema.Error<AskRefused>('AskRefused')(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('AskRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The rename was refused: the name is empty, it is the name the Inbox already
// has, or another Inbox holds it — then `conflictingInboxId` is that Inbox.
// `message` is the refusal's own sentence.
export class RenameRefused extends Schema.Error<RenameRefused>('RenameRefused')(
  {
    message: Schema.String,
    conflictingInboxId: Schema.optionalKey(InboxId),
    machine: refusedOn,
    _tag: Schema.tag('RenameRefused'),
  },
  { httpApiStatus: 409 },
) {}

// Dismissing a highlight was refused: the question is unknown or not
// highlighted. `message` is the refusal's own sentence.
export class HighlightRefused extends Schema.Error<HighlightRefused>(
  'HighlightRefused',
)(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('HighlightRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The pin was refused: it changes nothing, or the group has no name.
export class PinRefused extends Schema.Error<PinRefused>('PinRefused')(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('PinRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The archive was refused: the Inbox is already archived, or already not; or,
// for a group, it is already archived or already not, it has no name, or no
// question is in it.
export class ArchiveRefused extends Schema.Error<ArchiveRefused>(
  'ArchiveRefused',
)(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('ArchiveRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The mute was refused: the Inbox is already muted, or already not.
export class MuteRefused extends Schema.Error<MuteRefused>('MuteRefused')(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('MuteRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The priority mark was refused: the Inbox is already the priority Inbox, or
// already not.
export class PriorityRefused extends Schema.Error<PriorityRefused>(
  'PriorityRefused',
)(
  {
    message: Schema.String,
    machine: refusedOn,
    _tag: Schema.tag('PriorityRefused'),
  },
  { httpApiStatus: 409 },
) {}

// What the page asks serve to open: only ever a whole session link, so this
// endpoint cannot be made to open anything else.
export const OpenSessionPayload = Schema.Struct({ link: SessionLink });
export type OpenSessionPayload = typeof OpenSessionPayload.Type;

// `open` could not hand the link to the Claude app.
export class OpenSessionRefused extends Schema.Error<OpenSessionRefused>(
  'OpenSessionRefused',
)(
  {
    message: Schema.String,
    _tag: Schema.tag('OpenSessionRefused'),
  },
  { httpApiStatus: 409 },
) {}

// The inbox's store is unavailable — it could not be resolved, opened or
// asked; the message says which, as far as the server knows. The rest of the
// app still serves.
//
// `clashedOn` is set when the Inbox could not be resolved to one machine
// because two Inbox machines claim its id (`InboxClashDto`): Local's serve refuses it rather than choose, sends nothing to
// either, and names each claimant here, in section order; `message` is
// `inboxClashSentence`'s. Only Local's serve sets it, for its own page. It
// rides on this error, an optional key, rather than on an error of its own,
// so the endpoints' declared errors and statuses stay as the golden
// `packages/core/test/golden/v3/http-status.json` pins them.
//
// `mayHaveLanded` is set when a write Local's serve forwarded failed after it
// may have been sent, so the change may have reached the machine, or when a
// serve's own write appended and only reading the view back failed: the page says the change is unconfirmed, never that it was not
// made. A serve sets it for its own page, and only `true`; Local never passes
// on a machine's (`refusalOn`).
export class InboxUnavailable extends Schema.Error<InboxUnavailable>(
  'InboxUnavailable',
)(
  {
    message: Schema.String,
    machine: refusedOn,
    clashedOn: Schema.optionalKey(Schema.Array(InboxMachineRef)),
    mayHaveLanded: Schema.optionalKey(Schema.Literal(true)),
    _tag: Schema.tag('InboxUnavailable'),
  },
  { httpApiStatus: 503 },
) {}

// Every inbox endpoint's query. `local=true` asks a serve to answer from its
// own log only: the index and the board without its Inbox machines' Inboxes,
// and an endpoint keyed by an Inbox id without looking for the Inbox on
// another machine. Local's serve sends it on every call to an Inbox machine,
// so Local merges one level (a machine's own Inboxes, never what that machine
// merged), and a call that reaches a machine goes no further: two machines
// that list each other never call each other back, and an Inbox two machines
// away is never reached. Additive: a serve on an older build declares no
// query on these endpoints, and Effect's HttpApi server decodes a query only
// for an endpoint that declares one, so it ignores the parameter and answers
// as before.
export const InboxReadQuery = Schema.Struct({
  local: Schema.optionalKey(Schema.Literal('true')),
});
export type InboxReadQuery = typeof InboxReadQuery.Type;

const InboxPath = Schema.Struct({ inboxId: InboxId });
const QuestionPath = Schema.Struct({
  inboxId: InboxId,
  // Path segments arrive as strings.
  number: Schema.NumberFromString.pipe(Schema.decodeTo(QuestionNumber)),
});

export class InboxApiGroup extends HttpApiGroup.make('inbox').add(
  HttpApiEndpoint.get('index', '/inboxes', {
    query: InboxReadQuery,
    success: InboxIndexDto,
    error: [InboxUnavailable],
  }),
  HttpApiEndpoint.get('board', '/inbox-board', {
    query: InboxReadQuery,
    success: InboxBoardDto,
    error: [InboxUnavailable],
  }),
  HttpApiEndpoint.get('view', '/inbox/:inboxId', {
    params: InboxPath,
    query: InboxReadQuery,
    success: InboxViewDto,
    error: [InboxNotFound, InboxUnavailable],
  }),
  // A Question's HTML blocks' documents. A Question the Inbox has no such
  // number for, or one with no blocks, has none.
  HttpApiEndpoint.get(
    'htmlBlocks',
    '/inbox/:inboxId/questions/:number/html-blocks',
    {
      params: QuestionPath,
      query: InboxReadQuery,
      success: QuestionHtmlBlocksDto,
      error: [InboxNotFound, InboxUnavailable],
    },
  ),
  HttpApiEndpoint.post('answer', '/inbox/:inboxId/questions/:number/answer', {
    params: QuestionPath,
    query: InboxReadQuery,
    payload: AnswerPayload,
    success: InboxViewDto,
    error: [InboxNotFound, AnswerRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post('ask', '/inbox/:inboxId/questions', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: AskPayload,
    success: InboxViewDto,
    error: [InboxNotFound, AskRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post(
    'dismissHighlight',
    '/inbox/:inboxId/questions/:number/dismiss-highlight',
    {
      params: QuestionPath,
      query: InboxReadQuery,
      success: InboxViewDto,
      error: [InboxNotFound, HighlightRefused, InboxUnavailable],
    },
  ),
  HttpApiEndpoint.post('pin', '/inbox/:inboxId/pin', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: PinPayload,
    success: InboxViewDto,
    error: [InboxNotFound, PinRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post('archive', '/inbox/:inboxId/archive', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: ArchivePayload,
    success: InboxViewDto,
    error: [InboxNotFound, ArchiveRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post('archiveGroup', '/inbox/:inboxId/archive-group', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: GroupArchivePayload,
    success: InboxViewDto,
    error: [InboxNotFound, ArchiveRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post('mute', '/inbox/:inboxId/mute', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: MutePayload,
    success: InboxViewDto,
    error: [InboxNotFound, MuteRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post('priority', '/inbox/:inboxId/priority', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: PriorityPayload,
    success: InboxViewDto,
    error: [InboxNotFound, PriorityRefused, InboxUnavailable],
  }),
  HttpApiEndpoint.post('rename', '/inbox/:inboxId/rename', {
    params: InboxPath,
    query: InboxReadQuery,
    payload: RenamePayload,
    success: InboxViewDto,
    error: [InboxNotFound, RenameRefused, InboxUnavailable],
  }),
  // For the desktop app's window, which cannot open a `claude://` link itself
  // Not keyed by an Inbox: the page offers the link only on the
  // machine that ran the session, which is the one this serve runs on.
  HttpApiEndpoint.post('openSession', '/open-session', {
    payload: OpenSessionPayload,
    error: [OpenSessionRefused],
  }),
) {}
