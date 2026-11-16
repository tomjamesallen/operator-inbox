import { Data, Effect, Result, Schema } from 'effect';
import {
  commentProblem,
  commentsInBodyOrder,
  MAX_COMMENTS_PER_ANSWER,
  type QuestionComment,
  QuestionComments,
} from './comments';
import { checkDrawings } from './drawing';
import { checkHtmlBlocks, HtmlBlocks } from './html-block';
import { lettersOfNamedCode, questionRef } from './inbox-code';
import {
  emptyMetadata,
  GROUP_KEY,
  Metadata,
  type MetadataValue,
  metadataPatch,
} from './inbox-metadata';
import { type MacroInvoked, MacrosInvoked } from './macros';
import { InboxCode, InboxId, SessionId } from './schema/identifiers';

// The Inbox: a session's shared question queue with the operator, held as an
// event log on this machine. This module is the pure half — the events, the
// fold that derives every question's state, and the decisions. Ids and the
// clock come in from the CLI edge; the
// store, its tags and its append condition live in apps/cli's `inbox-store.ts`.
//
// BROWSER-SAFE: the local app's contract (`api/inbox-api.ts`) imports
// `QuestionNumber` from here, so this module may import only `effect` and
// core's own pure schema modules.

// A question's number within its Inbox: 1, 2, 3… so the operator and the agent
// can say "#3" to each other. Never reused, even after the question is
// processed.
export const QuestionNumber = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('QuestionNumber'),
);
export type QuestionNumber = typeof QuestionNumber.Type;

// How many times a question's text has been set: 1 when asked, one more per
// edit. The page sends back the revision it showed, so an answer to text the
// agent has since changed is refused rather than recorded against new words.
export const QuestionRevision = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('QuestionRevision'),
);
export type QuestionRevision = typeof QuestionRevision.Type;

// --- metadata -------------------------------------------------------------------

// Set when the Inbox is opened or the Question asked, and changed later by its
// own event, which carries the top-level keys it sets and the keys it removes,
// so the fold replays every change and the history stays in the log. The shape
// and the rules are in `inbox-metadata.ts`.
export { emptyMetadata, Metadata };

/** A dictionary with `set` merged in and `unset` taken out. */
export const applyMetadata = (
  current: Metadata,
  set: Metadata,
  unset: ReadonlyArray<string>,
): Metadata => {
  const next: Record<string, MetadataValue> = { ...current, ...set };
  for (const key of unset) delete next[key];
  return next;
};

// --- drawings -------------------------------------------------------------------

// A Question's drawings, by id: each an Excalidraw scene as JSON text, which a
// body line `<Excalidraw id="…"/>` shows (`drawing.ts` holds the forms, the
// checks and the limits). Text, not a decoded value: a scene has nulls and
// arrays of arrays, and nothing here looks inside it.
export const Drawings = Schema.Record(Schema.String, Schema.String);
export type Drawings = typeof Drawings.Type;

// A drawing as the fold holds it: its scene, and the revision of the Question
// that last set or changed it. The page keeps an edit with the revision it
// was made against, so it can tell the operator the agent has since changed
// that drawing, and only that one.
export const QuestionDrawing = Schema.Struct({
  scene: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type QuestionDrawing = typeof QuestionDrawing.Type;

// --- events ---------------------------------------------------------------------

export const InboxOpened = Schema.TaggedStruct('InboxOpened', {
  inboxId: InboxId,
  label: Schema.String,
  sessionId: Schema.optionalKey(SessionId),
  cwd: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Metadata),
});
export type InboxOpened = typeof InboxOpened.Type;

export const InboxAdopted = Schema.TaggedStruct('InboxAdopted', {
  inboxId: InboxId,
  sessionId: SessionId,
});
export type InboxAdopted = typeof InboxAdopted.Type;

// `operatorQuestion` marks a question the operator put to the agent, from the
// app: the same event as an agent's question, with a flag on it. It goes
// straight to the agent's column:
// `body` is the operator's whole question, which the fold holds as what the
// agent acts on (`response`), with no context of its own, and `title` is its
// first line (`operatorQuestionTitle`).
// `highlightReply`, on an operator's question only, asks the agent to
// highlight the Question it asks in reply (see `QuestionAnswered`).
export const QuestionAsked = Schema.TaggedStruct('QuestionAsked', {
  inboxId: InboxId,
  number: QuestionNumber,
  title: Schema.String,
  body: Schema.String,
  metadata: Schema.optionalKey(Metadata),
  operatorQuestion: Schema.optionalKey(Schema.Literal(true)),
  highlightReply: Schema.optionalKey(Schema.Literal(true)),
  // The drawings the body shows. An optional key, so every Question asked
  // before drawings existed reads as it did.
  drawings: Schema.optionalKey(Drawings),
  // The HTML blocks the body shows, by id: each its document's hash and
  // size, never the document, which is a row of the store's blob table
  // (`html-block.ts`). Optional for the same reason.
  htmls: Schema.optionalKey(HtmlBlocks),
});
export type QuestionAsked = typeof QuestionAsked.Type;

// `deferred` marks an answer that hands the decision to the agent ("you
// decide"): the agent makes the call itself.
// `response` is then the operator's optional note with it, '' when they gave
// none. An optional key, so every answer logged before it reads as it did.
// `highlightReply` asks the agent to highlight the Question it asks in reply,
// so the operator finds it among the rest. Optional for the same reason.
// `drawings` holds only the drawings the operator changed, each the whole
// edited scene; a drawing left alone is not sent. Optional for the same
// reason.
// `macros` holds the macros the operator invoked, in the order they stacked
// them, each with its instruction copied in (`macros.ts`). With macros,
// `response` may be ''. Optional for the same reason.
// `comments` holds the operator's comments on the Question's text, in the
// order their spans sit in the body (`comments.ts`). With comments,
// `response` may be ''. Optional for the same reason.
export const QuestionAnswered = Schema.TaggedStruct('QuestionAnswered', {
  inboxId: InboxId,
  number: QuestionNumber,
  response: Schema.String,
  deferred: Schema.optionalKey(Schema.Literal(true)),
  highlightReply: Schema.optionalKey(Schema.Literal(true)),
  drawings: Schema.optionalKey(Drawings),
  macros: Schema.optionalKey(MacrosInvoked),
  comments: Schema.optionalKey(QuestionComments),
});
export type QuestionAnswered = typeof QuestionAnswered.Type;

export const AnswerProcessed = Schema.TaggedStruct('AnswerProcessed', {
  inboxId: InboxId,
  number: QuestionNumber,
});
export type AnswerProcessed = typeof AnswerProcessed.Type;

// The agent rewrote a question the operator has not answered yet. It carries
// the whole new title and body, not a patch, so the fold needs no merge.
// `drawings`, when set, is the whole new set of drawings in the same way; left
// out, the drawings stay as they were, as every edit logged before drawings
// existed did. `htmls`, when set, is the whole new set of HTML blocks in the
// same way; left out, they stay as they were.
export const QuestionEdited = Schema.TaggedStruct('QuestionEdited', {
  inboxId: InboxId,
  number: QuestionNumber,
  title: Schema.String,
  body: Schema.String,
  drawings: Schema.optionalKey(Drawings),
  htmls: Schema.optionalKey(HtmlBlocks),
});
export type QuestionEdited = typeof QuestionEdited.Type;

// The agent took back a question the operator has not answered yet: it is
// moot or wrong. Withdrawing is processing it with a reason, since an agent
// must never remove a question from the operator's inbox without marking it
// processed, so it moves to Processed
// with that reason; its number is still never reused. `decideWithdraw` refuses
// an empty reason. Events written before the reason existed decode with "", so
// an old log still folds.
export const QuestionWithdrawn = Schema.TaggedStruct('QuestionWithdrawn', {
  inboxId: InboxId,
  number: QuestionNumber,
  reason: Schema.String.pipe(
    Schema.withDecodingDefaultType(Effect.succeed('')),
  ),
});
export type QuestionWithdrawn = typeof QuestionWithdrawn.Type;

// The Inbox's readable name changed. An Inbox carries a name a person can
// read, so the label set at open is no longer final: the latest
// `InboxRenamed` wins.
//
// `previousLabel` is the name it gave up. Names are unique, and the store tags a rename with BOTH names' label tags, so a
// read of one name sees every event that took it or released it. A rename
// logged before names were unique has no `previousLabel`; the full index
// still folds it (see `nameHolder`).
export const InboxRenamed = Schema.TaggedStruct('InboxRenamed', {
  inboxId: InboxId,
  label: Schema.String,
  previousLabel: Schema.optionalKey(Schema.String),
});
export type InboxRenamed = typeof InboxRenamed.Type;

// The Inbox was given its code (`inbox-code.ts`): `xyz`, which with a
// Question's number is that Question's code, `xyz#12`. Assigned once, in the
// same append as `InboxOpened` for a new Inbox, and by serve at start-up for
// one opened before codes. The first one folded is the Inbox's code: a rename
// never changes it, and only `InboxCodeChanged` moves it. The store tags it
// with the code, so a read of a code's tag finds the Inbox holding it and an
// assignment conditioned on that tag cannot hand one code to two Inboxes.
// One logged before codes lost their name part holds the older form,
// `ab-xyz`.
export const InboxCodeAssigned = Schema.TaggedStruct('InboxCodeAssigned', {
  inboxId: InboxId,
  code: InboxCode,
});
export type InboxCodeAssigned = typeof InboxCodeAssigned.Type;

// The Inbox's code moved from `from` to `code`. Written by serve at start-up
// for an Inbox whose code is in the older named form (`ab-xyz`): it keeps its
// three letters (`xyz`), or, when another Inbox already holds them, takes the
// first free code derived from its id. The store tags it with both codes, so
// a read of either tag sees the move: `from` is free again, `code` is held,
// and the older code still finds its Inbox for a transcript that quotes it.
// Folded only when `from` is the Inbox's code then.
export const InboxCodeChanged = Schema.TaggedStruct('InboxCodeChanged', {
  inboxId: InboxId,
  from: InboxCode,
  code: InboxCode,
});
export type InboxCodeChanged = typeof InboxCodeChanged.Type;

// The agent put an Inbox away: its questions leave the All view, and the
// Inbox moves into the sidebar's collapsed Archived section. Nothing is lost: an archived Inbox keeps its
// questions, its answers and its name, and is still answered, processed,
// edited and withdrawn in. The operator archives too, in the app; and asking
// a NEW question into an archived Inbox brings it back first, so the question
// is never hidden.
export const InboxArchived = Schema.TaggedStruct('InboxArchived', {
  inboxId: InboxId,
});
export type InboxArchived = typeof InboxArchived.Type;

// The agent brought an archived Inbox back.
export const InboxUnarchived = Schema.TaggedStruct('InboxUnarchived', {
  inboxId: InboxId,
});
export type InboxUnarchived = typeof InboxUnarchived.Type;

// The agent changed an Inbox's metadata: `set` merged in, `unset` removed.
// Allowed in an archived Inbox too: it describes the Inbox, it asks nothing.
export const InboxMetadataChanged = Schema.TaggedStruct(
  'InboxMetadataChanged',
  {
    inboxId: InboxId,
    set: Metadata,
    unset: Schema.Array(Schema.String),
  },
);
export type InboxMetadataChanged = typeof InboxMetadataChanged.Type;

// The agent changed a Question's metadata, in any state: it describes the
// Question, so it is not refused once answered or processed, and it does not
// change the revision an answer is checked against.
export const QuestionMetadataChanged = Schema.TaggedStruct(
  'QuestionMetadataChanged',
  {
    inboxId: InboxId,
    number: QuestionNumber,
    set: Metadata,
    unset: Schema.Array(Schema.String),
  },
);
export type QuestionMetadataChanged = typeof QuestionMetadataChanged.Type;

// The agent highlighted a Question waiting for the operator: it rises to the
// top of "Your inbox", newest highlight first. The purpose: the operator can
// ask an agent in chat to show the questions relating to something, and it
// highlights them. `note` is the agent's
// short reason, shown on the highlight. A new highlight leaves the others
// alone; highlighting one again moves it back to the top.
export const QuestionHighlighted = Schema.TaggedStruct('QuestionHighlighted', {
  inboxId: InboxId,
  number: QuestionNumber,
  note: Schema.optionalKey(Schema.String),
});
export type QuestionHighlighted = typeof QuestionHighlighted.Type;

// Who took a highlight away: "user or agent can dismiss the highlight".
export const HighlightDismissedBy = Schema.Literals(['agent', 'operator']);
export type HighlightDismissedBy = typeof HighlightDismissedBy.Type;

// A highlight was taken away. Answering does not take it away: the operator
// or the agent removes it, and only this event does.
export const QuestionHighlightDismissed = Schema.TaggedStruct(
  'QuestionHighlightDismissed',
  {
    inboxId: InboxId,
    number: QuestionNumber,
    by: HighlightDismissedBy,
  },
);
export type QuestionHighlightDismissed = typeof QuestionHighlightDismissed.Type;

// A question's place in the whole log and when it got there, as an event can
// carry it: the shape of `EventStamp` below.
const CarriedStamp = Schema.Struct({
  seq: Schema.Int,
  at: Schema.optionalKey(Schema.String),
});

// Everything the fold knows about a question, as a move carries it, so the
// Inbox it moves to folds it whole: its text, revision, metadata, answer,
// state, highlight and the stamps of when it was asked, answered and
// processed. Nothing about the question is lost by moving it.
export const MovedQuestion = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  revision: QuestionRevision,
  metadata: Metadata,
  state: Schema.Literals(['awaiting-operator', 'awaiting-agent', 'processed']),
  response: Schema.optionalKey(Schema.String),
  withdrawn: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  highlight: Schema.optionalKey(
    Schema.Struct({
      note: Schema.optionalKey(Schema.String),
      stamp: Schema.optionalKey(CarriedStamp),
    }),
  ),
  askedStamp: Schema.optionalKey(CarriedStamp),
  answeredStamp: Schema.optionalKey(CarriedStamp),
  processedStamp: Schema.optionalKey(CarriedStamp),
  operatorQuestion: Schema.optionalKey(Schema.Literal(true)),
  deferred: Schema.optionalKey(Schema.Literal(true)),
  highlightReply: Schema.optionalKey(Schema.Literal(true)),
  drawings: Schema.optionalKey(Schema.Record(Schema.String, QuestionDrawing)),
  sentDrawings: Schema.optionalKey(Drawings),
  macros: Schema.optionalKey(MacrosInvoked),
  comments: Schema.optionalKey(QuestionComments),
  htmls: Schema.optionalKey(HtmlBlocks),
});
export type MovedQuestion = typeof MovedQuestion.Type;

// The agent moved a question from one Inbox (`inboxId`, `number`) to another
// (`toInboxId`, where it is `toNumber`, one past the highest there). One event
// in both Inboxes' logs, tagged with both: the Inbox it left keeps the number
// as moved, so it is never reused and an answer to it says where it went; the
// Inbox it joined folds `question` whole. A move in place of a copy is what
// keeps a migration between Inboxes lossless.
export const QuestionMoved = Schema.TaggedStruct('QuestionMoved', {
  inboxId: InboxId,
  number: QuestionNumber,
  toInboxId: InboxId,
  toNumber: QuestionNumber,
  question: MovedQuestion,
});
export type QuestionMoved = typeof QuestionMoved.Type;

// The operator pinned or unpinned an Inbox, or one of its groups, in the
// app's sidebar. A pinned Inbox sits above
// the unpinned ones in the sidebar; a pinned group sits above its Inbox's
// other groups. `group` is a value of the Questions' `group` metadata key.
export const InboxPinned = Schema.TaggedStruct('InboxPinned', {
  inboxId: InboxId,
});
export type InboxPinned = typeof InboxPinned.Type;

export const InboxUnpinned = Schema.TaggedStruct('InboxUnpinned', {
  inboxId: InboxId,
});
export type InboxUnpinned = typeof InboxUnpinned.Type;

export const GroupPinned = Schema.TaggedStruct('GroupPinned', {
  inboxId: InboxId,
  group: Schema.String,
});
export type GroupPinned = typeof GroupPinned.Type;

export const GroupUnpinned = Schema.TaggedStruct('GroupUnpinned', {
  inboxId: InboxId,
  group: Schema.String,
});
export type GroupUnpinned = typeof GroupUnpinned.Type;

// The operator or the agent archived one of an Inbox's groups, or brought it
// back. An archived group leaves the sidebar's group list for its Inbox's
// collapsed "Archived groups", and its questions leave the All view and the
// Inbox's own view, as an archived Inbox's leave All; picked on its own, it
// still shows them. Kept on the Inbox, as a pin is: the Questions' `group`
// metadata is never touched, so the tag stays. A new question asked into an
// archived group brings it back first (`askEvents`).
export const GroupArchived = Schema.TaggedStruct('GroupArchived', {
  inboxId: InboxId,
  group: Schema.String,
});
export type GroupArchived = typeof GroupArchived.Type;

export const GroupUnarchived = Schema.TaggedStruct('GroupUnarchived', {
  inboxId: InboxId,
  group: Schema.String,
});
export type GroupUnarchived = typeof GroupUnarchived.Type;

// The operator muted or unmuted an Inbox in the app's sidebar. A muted Inbox
// stays in the sidebar, greyed, with its count; its groups fold away and its
// questions leave the All view. Picked on its own, it shows them all.
export const InboxMuted = Schema.TaggedStruct('InboxMuted', {
  inboxId: InboxId,
});
export type InboxMuted = typeof InboxMuted.Type;

export const InboxUnmuted = Schema.TaggedStruct('InboxUnmuted', {
  inboxId: InboxId,
});
export type InboxUnmuted = typeof InboxUnmuted.Type;

// The operator marked an Inbox as the priority Inbox, or cleared that mark, in
// the app's sidebar. One Inbox at most in a log is the priority Inbox: a mark
// on another Inbox is appended together with the clearing of the one that
// held it, in one append conditioned on the log's priority tag, so the log
// never holds two (`decidePriority`; the tag is apps/cli's `inbox-store.ts`).
// The page pulls the operator back to it after each answer elsewhere. While
// it is archived or muted the mark stays, and it does not pull.
export const InboxPriorityMarked = Schema.TaggedStruct('InboxPriorityMarked', {
  inboxId: InboxId,
});
export type InboxPriorityMarked = typeof InboxPriorityMarked.Type;

export const InboxPriorityCleared = Schema.TaggedStruct(
  'InboxPriorityCleared',
  { inboxId: InboxId },
);
export type InboxPriorityCleared = typeof InboxPriorityCleared.Type;

// Inbox mode: while it is on for a
// session, hooks route every question for the operator to that session's
// Inbox. Both events carry the session as well as the Inbox, because the mode
// belongs to the session (`inbox-mode.ts` folds it from the session's tag),
// and the Inbox's own fold ignores them. `reason` says what turned it off:
// the agent's `operator-inbox mode off`, or the operator typing an off phrase.
export const InboxModeOn = Schema.TaggedStruct('InboxModeOn', {
  inboxId: InboxId,
  sessionId: SessionId,
});
export type InboxModeOn = typeof InboxModeOn.Type;

export const InboxModeOffReason = Schema.Literals(['command', 'phrase']);
export type InboxModeOffReason = typeof InboxModeOffReason.Type;

export const InboxModeOff = Schema.TaggedStruct('InboxModeOff', {
  inboxId: InboxId,
  sessionId: SessionId,
  reason: InboxModeOffReason,
});
export type InboxModeOff = typeof InboxModeOff.Type;

export const InboxEvent = Schema.Union([
  InboxOpened,
  InboxAdopted,
  InboxRenamed,
  InboxCodeAssigned,
  InboxCodeChanged,
  InboxArchived,
  InboxUnarchived,
  QuestionAsked,
  QuestionAnswered,
  AnswerProcessed,
  QuestionEdited,
  QuestionWithdrawn,
  InboxMetadataChanged,
  QuestionMetadataChanged,
  QuestionHighlighted,
  QuestionHighlightDismissed,
  QuestionMoved,
  InboxPinned,
  InboxUnpinned,
  GroupPinned,
  GroupUnpinned,
  GroupArchived,
  GroupUnarchived,
  InboxMuted,
  InboxUnmuted,
  InboxPriorityMarked,
  InboxPriorityCleared,
  InboxModeOn,
  InboxModeOff,
]);
export type InboxEvent = typeof InboxEvent.Type;
export type InboxEventTag = InboxEvent['_tag'];

// --- the fold -------------------------------------------------------------------

// Derived, never stored. There is no "processing" state: the agent thinks,
// then marks the question processed. A question is
// processed either because its answer was dealt with (`inbox done`) or because
// the agent withdrew it, with a reason, before it was answered.
export type QuestionState =
  | 'awaiting-operator'
  | 'awaiting-agent'
  | 'processed'
  // Moved to another Inbox (`movedTo`): in no column here, its number kept.
  | 'moved';

/**
 * Where an event sits in the whole log (`seq`, higher is later; the store's
 * position is global, so it orders events across Inboxes too) and when it was
 * written (`at`, ISO, for display only). The edge hands these in; the fold
 * only carries them, so it stays pure and needs no clock.
 */
export interface EventStamp {
  readonly seq: number;
  readonly at?: string;
}

export interface InboxQuestion {
  readonly number: QuestionNumber;
  readonly title: string;
  readonly body: string;
  readonly revision: QuestionRevision;
  readonly metadata: Metadata;
  readonly response?: string;
  readonly state: QuestionState;
  // True when the agent withdrew it rather than processing an answer; it is
  // then `processed`, and `reason` holds the agent's reason.
  readonly withdrawn: boolean;
  readonly reason?: string;
  // Its place in the order questions were processed: 1 for the first one
  // processed or withdrawn in this Inbox, and so on. Set once it is
  // `processed`. Counted from the events, so the fold needs no clock.
  readonly processedOrder?: number;
  // When it was asked, answered and processed, when the events were folded
  // with stamps (`inboxStateStamped`).
  readonly askedStamp?: EventStamp;
  readonly answeredStamp?: EventStamp;
  readonly processedStamp?: EventStamp;
  // Set while the Question is highlighted: the agent's note, if it gave one,
  // and the stamp of the highlight, so the newest highlight sorts first.
  readonly highlight?: QuestionHighlight;
  // Set when the operator put it to the agent (`QuestionAsked`'s
  // `operatorQuestion`): `response` is their question, and `body` is empty.
  readonly operatorQuestion?: true;
  // Set when the operator's answer deferred to the agent
  // (`QuestionAnswered`'s `deferred`): `response` is their note, if any.
  readonly deferred?: true;
  // Set when the operator asked for the agent's reply to be highlighted
  // (`highlightReply` on their answer or their question).
  readonly highlightReply?: true;
  // The agent's drawings, by id, each with the revision that last set it.
  readonly drawings?: Readonly<Record<string, QuestionDrawing>>;
  // The drawings the operator changed and sent with their answer, by id.
  readonly sentDrawings?: Drawings;
  // The agent's HTML blocks, by id: each its document's hash and size. The
  // operator's answer never changes one.
  readonly htmls?: HtmlBlocks;
  // The macros the operator invoked with their answer, in order.
  readonly macros?: MacrosInvoked;
  // The operator's comments on its text, sent with their answer, in body order.
  readonly comments?: QuestionComments;
  // Where it went, once `moved`.
  readonly movedTo?: {
    readonly inboxId: InboxId;
    readonly number: QuestionNumber;
  };
}

export interface QuestionHighlight {
  readonly note?: string;
  readonly stamp?: EventStamp;
}

export interface InboxState {
  // False until an `InboxOpened` is folded: an id nobody opened is not an Inbox.
  readonly opened: boolean;
  // The Inbox's own id, from its `InboxOpened`, so the fold can tell a move
  // into this Inbox from a move out of it.
  readonly inboxId?: InboxId;
  readonly label: string;
  // Its code, from its first `InboxCodeAssigned` and any `InboxCodeChanged`
  // after it; absent until it has one.
  readonly code?: InboxCode;
  readonly metadata: Metadata;
  // True after `InboxArchived`, false again after `InboxUnarchived`.
  readonly archived: boolean;
  // True after `InboxPinned`, false again after `InboxUnpinned`.
  readonly pinned: boolean;
  // The pinned groups, in the order they were pinned.
  readonly pinnedGroups: ReadonlyArray<string>;
  // The archived groups, in the order they were archived.
  readonly archivedGroups: ReadonlyArray<string>;
  // True after `InboxMuted`, false again after `InboxUnmuted`.
  readonly muted: boolean;
  // True after `InboxPriorityMarked`, false again after `InboxPriorityCleared`.
  readonly priority: boolean;
  readonly questions: ReadonlyArray<InboxQuestion>;
  // How many questions have been processed or withdrawn so far.
  readonly processedCount: number;
}

export const emptyInboxState: InboxState = {
  opened: false,
  label: '',
  metadata: emptyMetadata,
  archived: false,
  pinned: false,
  pinnedGroups: [],
  archivedGroups: [],
  muted: false,
  priority: false,
  questions: [],
  processedCount: 0,
};

// A Question's drawings once `next` is its whole set at `revision`: a drawing
// whose scene is unchanged keeps the revision it had, a new or changed one
// takes `revision`, and one left out of `next` is gone.
const drawingsAt = (
  current: Readonly<Record<string, QuestionDrawing>> | undefined,
  next: Drawings,
  revision: QuestionRevision,
): Readonly<Record<string, QuestionDrawing>> =>
  Object.fromEntries(
    Object.entries(next).map(([id, scene]) => {
      const was = current?.[id];
      return [
        id,
        was !== undefined && was.scene === scene ? was : { scene, revision },
      ];
    }),
  );

// A Question with `next` as its whole set of HTML blocks: none, when empty.
const htmlsSet = (q: InboxQuestion, next: HtmlBlocks): InboxQuestion => {
  const { htmls: _, ...rest } = q;
  return Object.keys(next).length === 0 ? rest : { ...rest, htmls: next };
};

const withQuestion = (
  state: InboxState,
  number: QuestionNumber,
  update: (q: InboxQuestion) => InboxQuestion,
): InboxState => ({
  ...state,
  questions: state.questions.map((q) => (q.number === number ? update(q) : q)),
});

export const evolveInbox = (
  state: InboxState,
  event: InboxEvent,
  stamp?: EventStamp,
): InboxState => {
  switch (event._tag) {
    case 'InboxOpened':
      return {
        ...state,
        opened: true,
        inboxId: event.inboxId,
        label: event.label,
        metadata: event.metadata ?? emptyMetadata,
      };
    case 'InboxAdopted':
      return state;
    case 'InboxRenamed':
      return { ...state, label: event.label };
    case 'InboxCodeAssigned':
      return state.code === undefined ? { ...state, code: event.code } : state;
    case 'InboxCodeChanged':
      return state.code === event.from ? { ...state, code: event.code } : state;
    case 'InboxArchived':
      return { ...state, archived: true };
    case 'InboxUnarchived':
      return { ...state, archived: false };
    case 'QuestionAsked':
      if (event.operatorQuestion === true)
        return {
          ...state,
          questions: [
            ...state.questions,
            {
              number: event.number,
              title: event.title,
              body: '',
              revision: QuestionRevision.make(1),
              metadata: event.metadata ?? emptyMetadata,
              response: event.body,
              state: 'awaiting-agent',
              withdrawn: false,
              operatorQuestion: true,
              ...(event.highlightReply === undefined
                ? {}
                : { highlightReply: event.highlightReply }),
              ...(stamp === undefined
                ? {}
                : { askedStamp: stamp, answeredStamp: stamp }),
            },
          ],
        };
      return {
        ...state,
        questions: [
          ...state.questions,
          {
            number: event.number,
            title: event.title,
            body: event.body,
            revision: QuestionRevision.make(1),
            metadata: event.metadata ?? emptyMetadata,
            state: 'awaiting-operator',
            withdrawn: false,
            ...(event.drawings === undefined
              ? {}
              : {
                  drawings: drawingsAt(
                    undefined,
                    event.drawings,
                    QuestionRevision.make(1),
                  ),
                }),
            ...(event.htmls === undefined ? {} : { htmls: event.htmls }),
            ...(stamp === undefined ? {} : { askedStamp: stamp }),
          },
        ],
      };
    case 'QuestionAnswered':
      return withQuestion(state, event.number, (q) => ({
        ...q,
        response: event.response,
        state: 'awaiting-agent',
        ...(event.deferred === undefined ? {} : { deferred: event.deferred }),
        ...(event.highlightReply === undefined
          ? {}
          : { highlightReply: event.highlightReply }),
        ...(event.drawings === undefined
          ? {}
          : { sentDrawings: event.drawings }),
        ...(event.macros === undefined ? {} : { macros: event.macros }),
        ...(event.comments === undefined ? {} : { comments: event.comments }),
        ...(stamp === undefined ? {} : { answeredStamp: stamp }),
      }));
    case 'AnswerProcessed':
      return withQuestion(
        { ...state, processedCount: state.processedCount + 1 },
        event.number,
        (q) => ({
          ...q,
          state: 'processed',
          processedOrder: state.processedCount + 1,
          ...(stamp === undefined ? {} : { processedStamp: stamp }),
        }),
      );
    case 'QuestionEdited':
      return withQuestion(state, event.number, (q) => {
        const revision = QuestionRevision.make(q.revision + 1);
        const htmled = event.htmls === undefined ? q : htmlsSet(q, event.htmls);
        if (event.drawings === undefined)
          return { ...htmled, title: event.title, body: event.body, revision };
        const { drawings: _, ...rest } = htmled;
        const drawings = drawingsAt(q.drawings, event.drawings, revision);
        return {
          ...rest,
          title: event.title,
          body: event.body,
          revision,
          ...(Object.keys(drawings).length === 0 ? {} : { drawings }),
        };
      });
    case 'QuestionWithdrawn':
      return withQuestion(
        { ...state, processedCount: state.processedCount + 1 },
        event.number,
        (q) => ({
          ...q,
          state: 'processed',
          withdrawn: true,
          reason: event.reason,
          processedOrder: state.processedCount + 1,
          ...(stamp === undefined ? {} : { processedStamp: stamp }),
        }),
      );
    case 'InboxMetadataChanged':
      return {
        ...state,
        metadata: applyMetadata(state.metadata, event.set, event.unset),
      };
    case 'QuestionMetadataChanged':
      return withQuestion(state, event.number, (q) => ({
        ...q,
        metadata: applyMetadata(q.metadata, event.set, event.unset),
      }));
    case 'QuestionHighlighted':
      return withQuestion(state, event.number, (q) => ({
        ...q,
        highlight: {
          ...(event.note === undefined ? {} : { note: event.note }),
          ...(stamp === undefined ? {} : { stamp }),
        },
      }));
    case 'QuestionMoved': {
      if (event.toInboxId === state.inboxId) {
        const q = event.question;
        const processed = q.state === 'processed';
        return {
          ...state,
          processedCount: state.processedCount + (processed ? 1 : 0),
          questions: [
            ...state.questions,
            {
              number: event.toNumber,
              title: q.title,
              body: q.body,
              revision: q.revision,
              metadata: q.metadata,
              state: q.state,
              withdrawn: q.withdrawn,
              ...(q.response === undefined ? {} : { response: q.response }),
              ...(q.reason === undefined ? {} : { reason: q.reason }),
              ...(processed
                ? { processedOrder: state.processedCount + 1 }
                : {}),
              ...(q.highlight === undefined ? {} : { highlight: q.highlight }),
              ...(q.askedStamp === undefined
                ? {}
                : { askedStamp: q.askedStamp }),
              ...(q.answeredStamp === undefined
                ? {}
                : { answeredStamp: q.answeredStamp }),
              ...(q.processedStamp === undefined
                ? {}
                : { processedStamp: q.processedStamp }),
              ...(q.operatorQuestion === undefined
                ? {}
                : { operatorQuestion: q.operatorQuestion }),
              ...(q.deferred === undefined ? {} : { deferred: q.deferred }),
              ...(q.highlightReply === undefined
                ? {}
                : { highlightReply: q.highlightReply }),
              ...(q.drawings === undefined ? {} : { drawings: q.drawings }),
              ...(q.sentDrawings === undefined
                ? {}
                : { sentDrawings: q.sentDrawings }),
              ...(q.macros === undefined ? {} : { macros: q.macros }),
              ...(q.comments === undefined ? {} : { comments: q.comments }),
              ...(q.htmls === undefined ? {} : { htmls: q.htmls }),
            },
          ],
        };
      }
      return withQuestion(state, event.number, (q) => {
        const { highlight: _, ...rest } = q;
        return {
          ...rest,
          state: 'moved',
          movedTo: { inboxId: event.toInboxId, number: event.toNumber },
        };
      });
    }
    case 'InboxPinned':
      return { ...state, pinned: true };
    case 'InboxUnpinned':
      return { ...state, pinned: false };
    case 'GroupPinned':
      return state.pinnedGroups.includes(event.group)
        ? state
        : { ...state, pinnedGroups: [...state.pinnedGroups, event.group] };
    case 'InboxMuted':
      return { ...state, muted: true };
    case 'InboxUnmuted':
      return { ...state, muted: false };
    case 'InboxPriorityMarked':
      return { ...state, priority: true };
    case 'InboxPriorityCleared':
      return { ...state, priority: false };
    case 'GroupUnpinned':
      return {
        ...state,
        pinnedGroups: state.pinnedGroups.filter((g) => g !== event.group),
      };
    case 'GroupArchived':
      return state.archivedGroups.includes(event.group)
        ? state
        : { ...state, archivedGroups: [...state.archivedGroups, event.group] };
    case 'GroupUnarchived':
      return {
        ...state,
        archivedGroups: state.archivedGroups.filter((g) => g !== event.group),
      };
    case 'QuestionHighlightDismissed':
      return withQuestion(state, event.number, (q) => {
        const { highlight: _, ...rest } = q;
        return rest;
      });
    // The mode is the session's, folded by `inbox-mode.ts`; the Inbox's
    // questions, name and flags do not change.
    case 'InboxModeOn':
    case 'InboxModeOff':
      return state;
  }
};

/** Fold one Inbox's events, oldest first, into its state. */
export const inboxState = (events: ReadonlyArray<InboxEvent>): InboxState =>
  events.reduce((state, event) => evolveInbox(state, event), emptyInboxState);

/** Fold one Inbox's events with their stamps, oldest first. */
export const inboxStateStamped = (
  events: ReadonlyArray<{
    readonly event: InboxEvent;
    readonly stamp: EventStamp;
  }>,
): InboxState =>
  events.reduce(
    (state, { event, stamp }) => evolveInbox(state, event, stamp),
    emptyInboxState,
  );

/** The operator's column: asked, not yet answered. Oldest first. */
export const awaitingOperator = (
  state: InboxState,
): ReadonlyArray<InboxQuestion> =>
  state.questions.filter((q) => q.state === 'awaiting-operator');

/** The agent's column: answered, not yet processed. Oldest first. */
export const awaitingAgent = (
  state: InboxState,
): ReadonlyArray<InboxQuestion> =>
  state.questions.filter((q) => q.state === 'awaiting-agent');

// How many processed questions the Processed column shows: the 30 most
// recent. The fold keeps every one; the cap only bounds the view.
export const PROCESSED_VIEW_CAP = 30;

/**
 * The Processed column: answered-and-processed and withdrawn questions alike,
 * newest processed first, at most `PROCESSED_VIEW_CAP` of them.
 */
export const recentlyProcessed = (
  state: InboxState,
): ReadonlyArray<InboxQuestion> =>
  state.questions
    .filter((q) => q.state === 'processed')
    .sort((a, b) => (b.processedOrder ?? 0) - (a.processedOrder ?? 0))
    .slice(0, PROCESSED_VIEW_CAP);

// --- the index of every Inbox ----------------------------------------------------

/**
 * One Inbox as the all-inboxes page lists it. `lastActivity` is the place of
 * the Inbox's newest event in the whole log (higher is more recent), handed in
 * by the edge, so ordering needs no clock.
 */
export interface InboxSummary {
  readonly inboxId: InboxId;
  readonly label: string;
  readonly code?: InboxCode;
  readonly archived: boolean;
  readonly muted: boolean;
  readonly awaitingOperator: number;
  readonly awaitingAgent: number;
  readonly processed: number;
  readonly lastActivity: number;
}

/**
 * A question's group: its `group` metadata, trimmed; '' (the default group)
 * when it has none.
 */
export const questionGroup = (metadata: Metadata): string => {
  const group = metadata[GROUP_KEY];
  return typeof group === 'string' ? group.trim() : '';
};

/**
 * The questions waiting for the operator outside the Inbox's archived groups:
 * the ones its sidebar row counts, as an archived Inbox's leave All's count.
 */
export const awaitingOperatorShown = (
  state: InboxState,
): ReadonlyArray<InboxQuestion> =>
  awaitingOperator(state).filter(
    (q) => !state.archivedGroups.includes(questionGroup(q.metadata)),
  );

// `awaitingOperator` leaves out the questions in an archived group, which the
// sidebar folds away; the other two counts are the columns' whole.
export const summariseInbox = (
  inboxId: InboxId,
  state: InboxState,
  lastActivity: number,
): InboxSummary => ({
  inboxId,
  label: state.label,
  ...(state.code === undefined ? {} : { code: state.code }),
  archived: state.archived,
  muted: state.muted,
  awaitingOperator: awaitingOperatorShown(state).length,
  awaitingAgent: awaitingAgent(state).length,
  processed: state.processedCount,
  lastActivity,
});

/**
 * The all-inboxes order: the active Inboxes before the archived ones; within
 * each, every Inbox with a question waiting for the operator first, then the
 * rest, each group most recent activity first.
 */
export const orderInboxes = <S extends InboxSummary>(
  summaries: ReadonlyArray<S>,
): ReadonlyArray<S> =>
  [...summaries].sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      Number(b.awaitingOperator > 0) - Number(a.awaitingOperator > 0) ||
      b.lastActivity - a.lastActivity,
  );

/**
 * How many questions wait for the operator across the ACTIVE Inboxes: the
 * sidebar's All count. An archived or muted Inbox's questions are out of the
 * All view, so they are out of its count.
 */
export const totalAwaitingOperator = (
  summaries: ReadonlyArray<InboxSummary>,
): number =>
  summaries.reduce(
    (n, s) => (s.archived || s.muted ? n : n + s.awaitingOperator),
    0,
  );

// --- unique names --------------------------------------------------------------------

// No two Inboxes share a name: a second Inbox with a taken name is refused,
// and the refusal gives the agent the id of the Inbox holding it, so that it
// can check for a duplicate before deciding whether to pick up the other
// Inbox or to create a new one. A rename frees the previous name for reuse.
// An archived Inbox keeps
// its name, so an agent finds it and can adopt it.

/**
 * The form two names are compared in: trimmed, inner whitespace collapsed to
 * one space, compatibility-normalised and case-folded. "Markdown  check " and
 * "markdown check" are the same name.
 */
export const normaliseInboxLabel = (label: string): string =>
  label.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Who holds `label`, folded from the events that took or released it (the
 * store's label tag hands back exactly those): each Inbox's latest name among
 * them, and the Inboxes whose latest name is `label`. Oldest holder first.
 * An `InboxRenamed` moves its Inbox to the new name, which releases the old.
 */
export const labelHolders = (
  label: string,
  events: ReadonlyArray<InboxEvent>,
): ReadonlyArray<InboxId> => {
  const target = normaliseInboxLabel(label);
  const current = new Map<InboxId, string>();
  for (const event of events) {
    if (event._tag === 'InboxOpened' || event._tag === 'InboxRenamed')
      current.set(event.inboxId, normaliseInboxLabel(event.label));
  }
  return [...current].filter(([, name]) => name === target).map(([id]) => id);
};

/**
 * The Inbox that already holds `label`, other than `self`, if any.
 *
 * Two sources, because the log is older than unique names. `labelEvents` is
 * what a read of the name's label tag returned, so it is the consistency
 * boundary: the append that takes the name is conditioned on it. `index` is
 * every Inbox's CURRENT name from the full log, and it catches the Inboxes
 * opened or renamed before the label tags existed, whose events no label read
 * can see (a check, not a backfill). A label-tag holder
 * the index has since seen renamed away does not hold the name; one the index
 * has not seen yet (it was read first) still does.
 */
export const nameHolder = (input: {
  readonly label: string;
  readonly self?: InboxId;
  readonly labelEvents: ReadonlyArray<InboxEvent>;
  readonly index: ReadonlyArray<{
    readonly inboxId: InboxId;
    readonly label: string;
  }>;
}): InboxId | undefined => {
  const target = normaliseInboxLabel(input.label);
  const current = new Map(
    input.index.map((i) => [i.inboxId, normaliseInboxLabel(i.label)]),
  );
  const tagged = labelHolders(input.label, input.labelEvents).filter((id) => {
    const now = current.get(id);
    return now === undefined || now === target;
  });
  const legacy = input.index
    .filter((i) => normaliseInboxLabel(i.label) === target)
    .map((i) => i.inboxId);
  return [...tagged, ...legacy].find((id) => id !== input.self);
};

/** The sentence a taken name is refused with; it names the holder's id. */
export const nameTakenSentence = (label: string, holder: InboxId): string =>
  `an inbox named "${label}" already exists: ${holder} — adopt it with \`operator-inbox open --inbox ${holder}\`, or choose another name`;

// --- decisions --------------------------------------------------------------------

// Why a decision refused. `not-found` is its own reason because the HTTP edge
// answers it 404 rather than 409; every refusal carries a sentence a person
// can read without the code.
export type InboxRefusalReason =
  | 'not-found'
  | 'empty'
  | 'unknown-question'
  | 'already-answered'
  | 'not-answered'
  | 'already-processed'
  | 'withdrawn'
  | 'unchanged'
  | 'changed'
  | 'name-taken'
  | 'archived'
  | 'not-archived'
  | 'bad-metadata'
  | 'not-waiting'
  | 'not-highlighted'
  | 'moved'
  | 'same-inbox'
  | 'code-taken'
  | 'bad-drawing'
  | 'bad-html'
  | 'bad-macro'
  | 'bad-comment'
  | 'unknown-group';

// `conflictingInboxId` is set on `name-taken` only: the Inbox that holds the
// name, so the agent can look at it and adopt it.
export class InboxRefusal extends Data.TaggedError('InboxRefusal')<{
  readonly reason: InboxRefusalReason;
  readonly message: string;
  readonly conflictingInboxId?: InboxId;
}> {}

const refuse = (reason: InboxRefusalReason, message: string) =>
  Result.fail(new InboxRefusal({ reason, message }));

const nameTaken = (label: string, holder: InboxId) =>
  Result.fail(
    new InboxRefusal({
      reason: 'name-taken',
      message: nameTakenSentence(label, holder),
      conflictingInboxId: holder,
    }),
  );

const checkedDrawings = (
  drawings: Drawings | undefined,
): Result.Result<Drawings | undefined, InboxRefusal> =>
  drawings === undefined
    ? Result.succeed(undefined)
    : Result.mapError(
        checkDrawings(drawings),
        (message) => new InboxRefusal({ reason: 'bad-drawing', message }),
      );

const checkedHtmls = (
  htmls: HtmlBlocks | undefined,
): Result.Result<HtmlBlocks | undefined, InboxRefusal> =>
  htmls === undefined
    ? Result.succeed(undefined)
    : Result.mapError(
        checkHtmlBlocks(htmls),
        (message) => new InboxRefusal({ reason: 'bad-html', message }),
      );

const notFound = (inboxId: InboxId) =>
  refuse('not-found', `inbox ${inboxId} does not exist`);

// A question still in this Inbox. A moved one is not: `missing` says where
// it went.
const find = (state: InboxState, number: QuestionNumber) =>
  state.questions.find((q) => q.number === number && q.state !== 'moved');

const missing = (state: InboxState, number: QuestionNumber) => {
  const moved = state.questions.find((q) => q.number === number)?.movedTo;
  return moved === undefined
    ? refuse(
        'unknown-question',
        `there is no question ${questionRef(state.code, number)}`,
      )
    : refuse(
        'moved',
        `${questionRef(state.code, number)} was moved to inbox ${moved.inboxId}, where it is #${moved.number}`,
      );
};

const withdrawnSentence = (ref: string) =>
  `${ref} was withdrawn; it no longer needs an answer`;

/**
 * The question the agent may still change: asked, not yet answered. Shared by
 * edit and withdraw, which refuse the same things in the same words.
 */
const changeable = (
  state: InboxState,
  inboxId: InboxId,
  number: QuestionNumber,
): Result.Result<InboxQuestion, InboxRefusal> => {
  if (!state.opened) return notFound(inboxId);
  const q = find(state, number);
  if (q === undefined) return missing(state, number);
  switch (q.state) {
    case 'awaiting-agent':
      return refuse(
        'already-answered',
        `${questionRef(state.code, number)} is already answered; use \`inbox done\``,
      );
    case 'processed':
      return q.withdrawn
        ? refuse(
            'withdrawn',
            `${questionRef(state.code, number)} was already withdrawn`,
          )
        : refuse(
            'already-processed',
            `${questionRef(state.code, number)} was already answered and processed`,
          );
    case 'awaiting-operator':
      return Result.succeed(q);
    case 'moved':
      return missing(state, number);
  }
};

/**
 * A metadata dictionary as given: every key trimmed and not empty. Absent or
 * empty, there is nothing to record.
 */
const checkedMetadata = (
  given: Metadata | undefined,
): Result.Result<Metadata | undefined, InboxRefusal> => {
  if (given === undefined) return Result.succeed(undefined);
  const out: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(given)) {
    const k = key.trim();
    if (k.length === 0)
      return refuse('bad-metadata', 'a metadata key cannot be empty');
    if (k === GROUP_KEY && typeof value !== 'string')
      return refuse('bad-metadata', `metadata key "${GROUP_KEY}" is a string`);
    out[k] = value;
  }
  return Result.succeed(Object.keys(out).length === 0 ? undefined : out);
};

/**
 * A metadata change against what is there now: the top-level keys it sets to
 * a new value and the keys it removes that are present. A dotted key reaches
 * into an object (`metadataPatch`). A key both set and removed is refused, and
 * so is a change that changes nothing, so the log never carries one.
 */
const metadataChange = (
  current: Metadata,
  input: { readonly set: Metadata; readonly unset: ReadonlyArray<string> },
  what: string,
): Result.Result<
  { readonly set: Metadata; readonly unset: ReadonlyArray<string> },
  InboxRefusal
> =>
  Result.flatMap(checkedMetadata(input.set), (checked) => {
    const unsetKeys = [...new Set(input.unset.map((k) => k.trim()))];
    if (unsetKeys.some((k) => k.length === 0))
      return refuse('bad-metadata', 'a metadata key cannot be empty');
    const patch = metadataPatch(current, checked ?? emptyMetadata, unsetKeys);
    if (Result.isFailure(patch)) return refuse('bad-metadata', patch.failure);
    const { set, unset } = patch.success;
    if (Object.keys(set).length === 0 && unset.length === 0)
      return refuse('unchanged', `${what} metadata already says that`);
    return Result.succeed({ set, unset });
  });

/** Adopting an Inbox needs one that exists. */
export const decideAdopt = (
  state: InboxState,
  input: { readonly inboxId: InboxId; readonly sessionId: SessionId },
): Result.Result<InboxAdopted, InboxRefusal> =>
  state.opened
    ? Result.succeed({
        _tag: 'InboxAdopted',
        inboxId: input.inboxId,
        sessionId: input.sessionId,
      })
    : notFound(input.inboxId);

/**
 * Open a new Inbox under a readable name. The name is trimmed; an empty one is
 * refused, and so is a name another Inbox holds (`holder`, from `nameHolder`),
 * with that Inbox's id.
 */
export const decideOpen = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly label: string;
    readonly holder: InboxId | undefined;
    readonly sessionId?: SessionId;
    readonly cwd?: string;
    readonly metadata?: Metadata;
  },
): Result.Result<InboxOpened, InboxRefusal> => {
  if (state.opened)
    return refuse('unchanged', `inbox ${input.inboxId} is already open`);
  const label = input.label.trim();
  if (label.length === 0) return refuse('empty', 'an inbox needs a name');
  if (input.holder !== undefined) return nameTaken(label, input.holder);
  return Result.map(
    checkedMetadata(input.metadata),
    (metadata): InboxOpened => ({
      _tag: 'InboxOpened',
      inboxId: input.inboxId,
      label,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(metadata === undefined ? {} : { metadata }),
    }),
  );
};

// --- codes ---------------------------------------------------------------------------

// Each Inbox's code as the events of one or more code tags show it, oldest
// first: its first assignment, then each change. A change whose start the
// read does not hold (an Inbox moved onto the code read for) still moves it.
// Every assignment and change carries the tags of the codes it touches, so a
// read of a code's tag is the whole answer for that code, with no older log
// to consult as names have.
const codesShown = (events: ReadonlyArray<InboxEvent>) => {
  const current = new Map<InboxId, InboxCode>();
  const held = new Map<InboxId, Set<InboxCode>>();
  const hold = (inboxId: InboxId, code: InboxCode) => {
    current.set(inboxId, code);
    const all = held.get(inboxId) ?? new Set<InboxCode>();
    all.add(code);
    held.set(inboxId, all);
  };
  for (const event of events) {
    if (event._tag === 'InboxCodeAssigned' && !current.has(event.inboxId))
      hold(event.inboxId, event.code);
    if (event._tag === 'InboxCodeChanged') {
      const now = current.get(event.inboxId);
      if (now === undefined || now === event.from) {
        if (now === undefined) hold(event.inboxId, event.from);
        hold(event.inboxId, event.code);
      }
    }
  }
  return { current, held };
};

/**
 * The Inboxes holding `code` now, from the events its code tag holds (the
 * store hands back exactly those, oldest first).
 */
export const codeHolders = (
  code: InboxCode,
  events: ReadonlyArray<InboxEvent>,
): ReadonlyArray<InboxId> =>
  [...codesShown(events).current]
    .filter(([, c]) => c === code)
    .map(([id]) => id);

/**
 * The Inboxes that held `code` once and have moved off it since
 * (`InboxCodeChanged`), from the events its code tag holds: how an older
 * code a transcript quotes still finds its Inbox.
 */
export const formerCodeHolders = (
  code: InboxCode,
  events: ReadonlyArray<InboxEvent>,
): ReadonlyArray<InboxId> => {
  const { current, held } = codesShown(events);
  return [...held]
    .filter(([id, codes]) => codes.has(code) && current.get(id) !== code)
    .map(([id]) => id);
};

/**
 * The first of `candidates` no Inbox other than `self` holds, given the
 * events of every candidate's code tag; none when all are taken.
 */
export const firstFreeCode = (input: {
  readonly candidates: ReadonlyArray<InboxCode>;
  readonly self: InboxId;
  readonly codeEvents: ReadonlyArray<InboxEvent>;
}): InboxCode | undefined =>
  input.candidates.find((code) =>
    codeHolders(code, input.codeEvents).every((id) => id === input.self),
  );

/**
 * Give an Inbox its code: `code` is the first free one the edge's candidates
 * gave (`firstFreeCode`), undefined when every one is taken. An Inbox that
 * has a code keeps it (`unchanged`), so the assignment is safe to repeat.
 */
export const decideAssignCode = (
  state: InboxState,
  input: { readonly inboxId: InboxId; readonly code: InboxCode | undefined },
): Result.Result<InboxCodeAssigned, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  if (state.code !== undefined)
    return refuse(
      'unchanged',
      `inbox ${input.inboxId} already has its code, ${state.code}`,
    );
  if (input.code === undefined)
    return refuse(
      'code-taken',
      `every code drawn for inbox ${input.inboxId} is taken; run it again to draw more`,
    );
  return Result.succeed({
    _tag: 'InboxCodeAssigned',
    inboxId: input.inboxId,
    code: input.code,
  });
};

/**
 * Move an Inbox's code in the older named form (`ab-xyz`) to the current
 * form: `code` is the first free one of the edge's candidates (its own three
 * letters first), undefined when every one is taken. An Inbox with no code,
 * or with one in the current form, is left alone (`unchanged`), so the move
 * is safe to repeat.
 */
export const decideShortenCode = (
  state: InboxState,
  input: { readonly inboxId: InboxId; readonly code: InboxCode | undefined },
): Result.Result<InboxCodeChanged, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  if (state.code === undefined || lettersOfNamedCode(state.code) === undefined)
    return refuse(
      'unchanged',
      `inbox ${input.inboxId} has no code in the older named form to move`,
    );
  if (input.code === undefined)
    return refuse(
      'code-taken',
      `every code tried for inbox ${input.inboxId} is taken; run it again to try more`,
    );
  return Result.succeed({
    _tag: 'InboxCodeChanged',
    inboxId: input.inboxId,
    from: state.code,
    code: input.code,
  });
};

/**
 * Give the Inbox a new readable name. The name is trimmed; an empty one is
 * refused, and so is the name it already has, so the log never carries a
 * rename that changed nothing, and so is a name another Inbox holds
 * (`holder`, from `nameHolder`), with that Inbox's id. The event carries the
 * name given up, which the store tags too, so the old name is free again.
 */
export const decideRename = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly label: string;
    readonly holder?: InboxId | undefined;
  },
): Result.Result<InboxRenamed, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const label = input.label.trim();
  if (label.length === 0) return refuse('empty', 'an inbox needs a name');
  if (label === state.label)
    return refuse('unchanged', `the inbox is already called "${label}"`);
  if (input.holder !== undefined && input.holder !== input.inboxId)
    return nameTaken(label, input.holder);
  return Result.succeed({
    _tag: 'InboxRenamed',
    inboxId: input.inboxId,
    label,
    previousLabel: state.label,
  });
};

/**
 * The events an ask appends: the question, and before it an `InboxUnarchived`
 * when the Inbox is archived and a `GroupUnarchived` when the question's group
 * is, so a new question brings its Inbox and its group back.
 */
export const askEvents = (
  state: InboxState,
  asked: QuestionAsked,
): ReadonlyArray<InboxUnarchived | GroupUnarchived | QuestionAsked> => {
  const group = questionGroup(asked.metadata ?? emptyMetadata);
  return [
    ...(state.archived
      ? [{ _tag: 'InboxUnarchived', inboxId: asked.inboxId } as const]
      : []),
    ...(group !== '' && state.archivedGroups.includes(group)
      ? [{ _tag: 'GroupUnarchived', inboxId: asked.inboxId, group } as const]
      : []),
    asked,
  ];
};

/** Archive an Inbox that is active. */
export const decideArchive = (
  state: InboxState,
  input: { readonly inboxId: InboxId },
): Result.Result<InboxArchived, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  if (state.archived)
    return refuse('archived', `inbox ${input.inboxId} is already archived`);
  return Result.succeed({ _tag: 'InboxArchived', inboxId: input.inboxId });
};

/** Bring back an Inbox that is archived. */
export const decideUnarchive = (
  state: InboxState,
  input: { readonly inboxId: InboxId },
): Result.Result<InboxUnarchived, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  if (!state.archived)
    return refuse('not-archived', `inbox ${input.inboxId} is not archived`);
  return Result.succeed({ _tag: 'InboxUnarchived', inboxId: input.inboxId });
};

/**
 * Ask the next question: numbered one past the highest ever asked. Into an
 * archived Inbox it is allowed: `askEvents` brings the Inbox back with it.
 */
export const decideAsk = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly title: string;
    readonly body: string;
    readonly metadata?: Metadata;
    // Scenes by id, for the body's `<Excalidraw id="…"/>` lines.
    readonly drawings?: Drawings;
    // Documents' hashes and sizes by id, for the body's `<Html id="…"/>`
    // lines; each document already in the blob table.
    readonly htmls?: HtmlBlocks;
  },
): Result.Result<QuestionAsked, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  if (input.title.trim().length === 0)
    return refuse('empty', 'a question needs a title');
  const highest = state.questions.reduce((n, q) => Math.max(n, q.number), 0);
  return Result.flatMap(checkedDrawings(input.drawings), (drawings) =>
    Result.flatMap(checkedHtmls(input.htmls), (htmls) =>
      Result.map(
        checkedMetadata(input.metadata),
        (metadata): QuestionAsked => ({
          _tag: 'QuestionAsked',
          inboxId: input.inboxId,
          number: QuestionNumber.make(highest + 1),
          title: input.title,
          body: input.body,
          ...(metadata === undefined ? {} : { metadata }),
          ...(drawings === undefined || Object.keys(drawings).length === 0
            ? {}
            : { drawings }),
          ...(htmls === undefined || Object.keys(htmls).length === 0
            ? {}
            : { htmls }),
        }),
      ),
    ),
  );
};

// The most characters an operator question's title keeps of its first line.
export const OPERATOR_QUESTION_TITLE_LIMIT = 80;

/**
 * An operator question's title: its first line with text, trimmed, cut to
 * `OPERATOR_QUESTION_TITLE_LIMIT` characters with an ellipsis when longer.
 */
export const operatorQuestionTitle = (text: string): string => {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.length <= OPERATOR_QUESTION_TITLE_LIMIT
    ? line
    : `${line.slice(0, OPERATOR_QUESTION_TITLE_LIMIT - 1).trimEnd()}…`;
};

/**
 * The operator asks the agent a question, from the app: the next number, as
 * the agent's are, waiting on the agent at once. Into an archived Inbox it is
 * allowed: `askEvents` brings the Inbox back with it.
 */
export const decideOperatorAsk = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly text: string;
    // The operator asks the agent to highlight the Question it asks in reply.
    readonly highlightReply?: true;
  },
): Result.Result<QuestionAsked, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const text = input.text.trim();
  if (text.length === 0) return refuse('empty', 'a question cannot be empty');
  const highest = state.questions.reduce((n, q) => Math.max(n, q.number), 0);
  return Result.succeed({
    _tag: 'QuestionAsked',
    inboxId: input.inboxId,
    number: QuestionNumber.make(highest + 1),
    title: operatorQuestionTitle(text),
    body: text,
    operatorQuestion: true,
    ...(input.highlightReply === undefined
      ? {}
      : { highlightReply: input.highlightReply }),
  });
};

/**
 * Change an Inbox's metadata: set some keys, remove others. Allowed whether
 * or not the Inbox is archived.
 */
export const decideInboxMetadata = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly set: Metadata;
    readonly unset: ReadonlyArray<string>;
  },
): Result.Result<InboxMetadataChanged, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  return Result.map(
    metadataChange(state.metadata, input, 'the inbox'),
    ({ set, unset }): InboxMetadataChanged => ({
      _tag: 'InboxMetadataChanged',
      inboxId: input.inboxId,
      set,
      unset,
    }),
  );
};

/**
 * Change a Question's metadata, in any state: set some keys, remove others.
 */
export const decideQuestionMetadata = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly number: QuestionNumber;
    readonly set: Metadata;
    readonly unset: ReadonlyArray<string>;
  },
): Result.Result<QuestionMetadataChanged, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const q = find(state, input.number);
  if (q === undefined) return missing(state, input.number);
  return Result.map(
    metadataChange(
      q.metadata,
      input,
      `${questionRef(state.code, input.number)}'s`,
    ),
    ({ set, unset }): QuestionMetadataChanged => ({
      _tag: 'QuestionMetadataChanged',
      inboxId: input.inboxId,
      number: input.number,
      set,
      unset,
    }),
  );
};

/** The operator answers a question that is still waiting for them. */
export const decideAnswer = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly number: QuestionNumber;
    readonly response: string;
    // The revision the operator read. Absent, the answer is not checked
    // against later edits.
    readonly seenRevision?: number;
    // The operator hands the decision to the agent; `response` may then be
    // empty, as a note with the deferral is optional.
    readonly deferred?: true;
    // The operator asks the agent to highlight the Question it asks in reply.
    readonly highlightReply?: true;
    // The drawings the operator changed, by id: each the whole edited scene.
    readonly drawings?: Drawings;
    // The macros the operator invoked, in order. With one, the response may
    // be empty: a macro is a complete answer on its own.
    readonly macros?: ReadonlyArray<MacroInvoked>;
    // The operator's comments on the Question's text. With one, the response
    // may be empty too: a comment says something on its own. Sent in body
    // order, whatever order they come in.
    readonly comments?: ReadonlyArray<QuestionComment>;
  },
): Result.Result<QuestionAnswered, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const q = find(state, input.number);
  if (q === undefined) return missing(state, input.number);
  if (q.state === 'awaiting-agent')
    return refuse(
      'already-answered',
      `${questionRef(state.code, input.number)} was already answered; the agent has it`,
    );
  if (q.withdrawn)
    return refuse(
      'withdrawn',
      withdrawnSentence(questionRef(state.code, input.number)),
    );
  if (q.state === 'processed')
    return refuse(
      'already-processed',
      `${questionRef(state.code, input.number)} was already answered and the agent has dealt with it`,
    );
  if (input.seenRevision !== undefined && q.revision > input.seenRevision)
    return refuse(
      'changed',
      `${questionRef(state.code, input.number)} changed after you opened it; read it again before answering`,
    );
  const macros = input.macros ?? [];
  const comments = commentsInBodyOrder(input.comments ?? []);
  if (
    input.deferred !== true &&
    macros.length === 0 &&
    comments.length === 0 &&
    input.response.trim().length === 0
  )
    return refuse('empty', 'an answer cannot be empty');
  if (comments.length > MAX_COMMENTS_PER_ANSWER)
    return refuse(
      'bad-comment',
      `an answer carries at most ${MAX_COMMENTS_PER_ANSWER} comments, not ${comments.length}`,
    );
  const badComment = comments.map(commentProblem).find((p) => p !== undefined);
  if (badComment !== undefined) return refuse('bad-comment', badComment);
  if (macros.length > MAX_MACROS_PER_ANSWER)
    return refuse(
      'bad-macro',
      `an answer carries at most ${MAX_MACROS_PER_ANSWER} macros, not ${macros.length}`,
    );
  const blank = macros.find((m) => m.instruction.trim().length === 0);
  if (blank !== undefined)
    return refuse('bad-macro', `/${blank.macro} has no instruction`);
  const unknown = Object.keys(input.drawings ?? {}).find(
    (id) => q.drawings?.[id] === undefined,
  );
  if (unknown !== undefined)
    return refuse(
      'bad-drawing',
      `${questionRef(state.code, input.number)} has no drawing named "${unknown}"`,
    );
  return Result.map(checkedDrawings(input.drawings), (drawings) => ({
    _tag: 'QuestionAnswered' as const,
    inboxId: input.inboxId,
    number: input.number,
    response: input.response,
    ...(input.deferred === undefined ? {} : { deferred: input.deferred }),
    ...(input.highlightReply === undefined
      ? {}
      : { highlightReply: input.highlightReply }),
    ...(drawings === undefined || Object.keys(drawings).length === 0
      ? {}
      : { drawings }),
    ...(isNonEmptyMacros(macros) ? { macros } : {}),
    ...(isNonEmptyComments(comments) ? { comments } : {}),
  }));
};

/** The most macros one answer may carry. */
export const MAX_MACROS_PER_ANSWER = 20;

const isNonEmptyComments = (
  comments: ReadonlyArray<QuestionComment>,
): comments is QuestionComments => comments.length > 0;

const isNonEmptyMacros = (
  macros: ReadonlyArray<MacroInvoked>,
): macros is MacrosInvoked => macros.length > 0;

/**
 * The agent marks an answer processed. It cannot close a question the operator
 * never answered.
 */
export const decideProcess = (
  state: InboxState,
  input: { readonly inboxId: InboxId; readonly number: QuestionNumber },
): Result.Result<AnswerProcessed, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const q = find(state, input.number);
  if (q === undefined) return missing(state, input.number);
  if (q.state === 'awaiting-operator')
    return refuse(
      'not-answered',
      `${questionRef(state.code, input.number)} has not been answered yet, so it cannot be processed`,
    );
  if (q.withdrawn)
    return refuse(
      'withdrawn',
      `${questionRef(state.code, input.number)} was withdrawn`,
    );
  if (q.state === 'processed')
    return refuse(
      'already-processed',
      `${questionRef(state.code, input.number)} was already processed`,
    );
  return Result.succeed({
    _tag: 'AnswerProcessed',
    inboxId: input.inboxId,
    number: input.number,
  });
};

/**
 * The agent rewrites a question the operator has not answered. A field left
 * out keeps its value; at least one must be given, and the result must differ
 * from what the question already says, or the edit would only bump the
 * revision and refuse an answer to unchanged words.
 */
export const decideEdit = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly number: QuestionNumber;
    readonly title?: string;
    readonly body?: string;
    // Drawings to set, by id: each replaces the drawing of that id or adds
    // one; the Question's other drawings stay.
    readonly drawings?: Drawings;
    // HTML blocks to set, by id, in the same way; the others stay.
    readonly htmls?: HtmlBlocks;
  },
): Result.Result<QuestionEdited, InboxRefusal> =>
  Result.flatMap(changeable(state, input.inboxId, input.number), (q) => {
    if (
      input.title === undefined &&
      input.body === undefined &&
      input.drawings === undefined &&
      input.htmls === undefined
    )
      return refuse(
        'empty',
        'an edit needs a new title, a new body, a drawing or an HTML block',
      );
    const title = input.title ?? q.title;
    const body = input.body ?? q.body;
    if (title.trim().length === 0)
      return refuse('empty', 'a question needs a title');
    const current: Record<string, string> = Object.fromEntries(
      Object.entries(q.drawings ?? {}).map(([id, d]) => [id, d.scene]),
    );
    return Result.flatMap(
      input.drawings === undefined
        ? Result.succeed(undefined)
        : checkedDrawings({ ...current, ...input.drawings }),
      (drawings) => {
        const sameDrawings =
          drawings === undefined ||
          (Object.keys(drawings).length === Object.keys(current).length &&
            Object.entries(drawings).every(([id, s]) => current[id] === s));
        const currentHtmls = q.htmls ?? {};
        return Result.flatMap(
          input.htmls === undefined
            ? Result.succeed(undefined)
            : checkedHtmls({ ...currentHtmls, ...input.htmls }),
          (htmls) => {
            const sameHtmls =
              htmls === undefined ||
              (Object.keys(htmls).length === Object.keys(currentHtmls).length &&
                Object.entries(htmls).every(
                  ([id, r]) => currentHtmls[id]?.sha === r.sha,
                ));
            if (
              title === q.title &&
              body === q.body &&
              sameDrawings &&
              sameHtmls
            )
              return refuse(
                'unchanged',
                `${questionRef(state.code, input.number)} already says that; nothing changed`,
              );
            return Result.succeed({
              _tag: 'QuestionEdited' as const,
              inboxId: input.inboxId,
              number: input.number,
              title,
              body,
              ...(drawings === undefined || sameDrawings ? {} : { drawings }),
              ...(htmls === undefined || sameHtmls ? {} : { htmls }),
            });
          },
        );
      },
    );
  });

/**
 * The agent takes back a question the operator has not answered. It needs a
 * reason: a withdrawal marks the question processed, and the operator sees the
 * reason in the Processed column, so nothing leaves the inbox unexplained.
 */
export const decideWithdraw = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly number: QuestionNumber;
    readonly reason: string;
  },
): Result.Result<QuestionWithdrawn, InboxRefusal> =>
  Result.flatMap(changeable(state, input.inboxId, input.number), () =>
    input.reason.trim().length === 0
      ? refuse('empty', 'a withdrawal needs a reason')
      : Result.succeed<QuestionWithdrawn>({
          _tag: 'QuestionWithdrawn',
          inboxId: input.inboxId,
          number: input.number,
          reason: input.reason,
        }),
  );

// --- highlights -------------------------------------------------------------------

/**
 * The agent highlights Questions waiting for the operator, each with the same
 * optional note. Only a waiting Question can be highlighted, because only
 * "Your inbox" shows highlights. Highlighting one already highlighted with the
 * same note highlights it again, so it moves back to the top. Allowed in an
 * archived Inbox, which is still answered in.
 */
export const decideHighlight = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly numbers: ReadonlyArray<QuestionNumber>;
    readonly note?: string;
  },
): Result.Result<ReadonlyArray<QuestionHighlighted>, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const numbers = [...new Set(input.numbers)];
  if (numbers.length === 0)
    return refuse('empty', 'name at least one question to highlight');
  const note = input.note?.trim();
  const events: Array<QuestionHighlighted> = [];
  for (const number of numbers) {
    const q = find(state, number);
    if (q === undefined) return missing(state, number);
    if (q.state !== 'awaiting-operator')
      return refuse(
        'not-waiting',
        `${questionRef(state.code, number)} is not waiting for the operator; only a question in their inbox can be highlighted`,
      );
    events.push({
      _tag: 'QuestionHighlighted',
      inboxId: input.inboxId,
      number,
      ...(note === undefined || note.length === 0 ? {} : { note }),
    });
  }
  return Result.succeed(events);
};

/**
 * Take highlights away: the named Questions, or with none named, every
 * highlighted Question in the Inbox. A named Question that is not highlighted
 * is refused; with none named and nothing highlighted, `unchanged`.
 */
export const decideDismissHighlight = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly numbers: ReadonlyArray<QuestionNumber>;
    readonly by: HighlightDismissedBy;
  },
): Result.Result<ReadonlyArray<QuestionHighlightDismissed>, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const dismiss = (number: QuestionNumber): QuestionHighlightDismissed => ({
    _tag: 'QuestionHighlightDismissed',
    inboxId: input.inboxId,
    number,
    by: input.by,
  });
  if (input.numbers.length === 0) {
    const highlighted = state.questions.filter(
      (q) => q.highlight !== undefined,
    );
    if (highlighted.length === 0)
      return refuse('unchanged', 'no question in this inbox is highlighted');
    return Result.succeed(highlighted.map((q) => dismiss(q.number)));
  }
  const events: Array<QuestionHighlightDismissed> = [];
  for (const number of new Set(input.numbers)) {
    const q = find(state, number);
    if (q === undefined) return missing(state, number);
    if (q.highlight === undefined)
      return refuse(
        'not-highlighted',
        `${questionRef(state.code, number)} is not highlighted`,
      );
    events.push(dismiss(number));
  }
  return Result.succeed(events);
};

// --- moving ------------------------------------------------------------------------

/**
 * Move questions from one Inbox to another, in any state, each whole. They
 * take the next numbers in the Inbox they join, in the order given. The Inbox
 * they leave may be archived; the one they join may not, as asking into it
 * may not. An Inbox cannot move a question to itself.
 */
export const decideMove = (
  from: InboxState,
  to: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly numbers: ReadonlyArray<QuestionNumber>;
    readonly toInboxId: InboxId;
  },
): Result.Result<ReadonlyArray<QuestionMoved>, InboxRefusal> => {
  if (!from.opened) return notFound(input.inboxId);
  if (!to.opened) return notFound(input.toInboxId);
  if (input.toInboxId === input.inboxId)
    return refuse('same-inbox', 'a question cannot move to its own inbox');
  if (to.archived)
    return refuse(
      'archived',
      `inbox ${input.toInboxId} is archived; run \`operator-inbox unarchive --inbox ${input.toInboxId}\` first`,
    );
  const numbers = [...new Set(input.numbers)];
  if (numbers.length === 0)
    return refuse('empty', 'name at least one question to move');
  let next = to.questions.reduce((n, q) => Math.max(n, q.number), 0);
  const events: Array<QuestionMoved> = [];
  for (const number of numbers) {
    const q = find(from, number);
    if (q === undefined || q.state === 'moved') return missing(from, number);
    next += 1;
    events.push({
      _tag: 'QuestionMoved',
      inboxId: input.inboxId,
      number,
      toInboxId: input.toInboxId,
      toNumber: QuestionNumber.make(next),
      question: movedQuestionOf(q, q.state),
    });
  }
  return Result.succeed(events);
};

const movedQuestionOf = (
  q: InboxQuestion,
  state: MovedQuestion['state'],
): MovedQuestion => {
  return {
    title: q.title,
    body: q.body,
    revision: q.revision,
    metadata: q.metadata,
    state,
    withdrawn: q.withdrawn,
    ...(q.response === undefined ? {} : { response: q.response }),
    ...(q.reason === undefined ? {} : { reason: q.reason }),
    ...(q.highlight === undefined ? {} : { highlight: q.highlight }),
    ...(q.askedStamp === undefined ? {} : { askedStamp: q.askedStamp }),
    ...(q.answeredStamp === undefined
      ? {}
      : { answeredStamp: q.answeredStamp }),
    ...(q.processedStamp === undefined
      ? {}
      : { processedStamp: q.processedStamp }),
    ...(q.operatorQuestion === undefined
      ? {}
      : { operatorQuestion: q.operatorQuestion }),
    ...(q.deferred === undefined ? {} : { deferred: q.deferred }),
    ...(q.highlightReply === undefined
      ? {}
      : { highlightReply: q.highlightReply }),
    ...(q.drawings === undefined ? {} : { drawings: q.drawings }),
    ...(q.sentDrawings === undefined ? {} : { sentDrawings: q.sentDrawings }),
    ...(q.macros === undefined ? {} : { macros: q.macros }),
    ...(q.comments === undefined ? {} : { comments: q.comments }),
    ...(q.htmls === undefined ? {} : { htmls: q.htmls }),
  };
};

// --- pins --------------------------------------------------------------------------

/**
 * Pin or unpin an Inbox, or with `group`, one of its groups. A group is
 * trimmed and may not be empty: the default group has no name to pin. A pin
 * that changes nothing is refused (`unchanged`), so the log never carries
 * one. Allowed in an archived Inbox.
 */
export const decidePin = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly pinned: boolean;
    readonly group?: string;
  },
): Result.Result<
  InboxPinned | InboxUnpinned | GroupPinned | GroupUnpinned,
  InboxRefusal
> => {
  if (!state.opened) return notFound(input.inboxId);
  const { inboxId, pinned } = input;
  if (input.group === undefined) {
    if (state.pinned === pinned)
      return refuse(
        'unchanged',
        `the inbox is already ${pinned ? 'pinned' : 'unpinned'}`,
      );
    return Result.succeed(
      pinned
        ? { _tag: 'InboxPinned', inboxId }
        : { _tag: 'InboxUnpinned', inboxId },
    );
  }
  const group = input.group.trim();
  if (group.length === 0) return refuse('empty', 'a group to pin needs a name');
  if (state.pinnedGroups.includes(group) === pinned)
    return refuse(
      'unchanged',
      `group "${group}" is already ${pinned ? 'pinned' : 'unpinned'}`,
    );
  return Result.succeed(
    pinned
      ? { _tag: 'GroupPinned', inboxId, group }
      : { _tag: 'GroupUnpinned', inboxId, group },
  );
};

// --- group archives ----------------------------------------------------------------

/**
 * Archive one of an Inbox's groups, or bring it back. A group is trimmed and
 * may not be empty: the default group has no name to archive. Archiving needs
 * a group some question in the Inbox is in, so a mistyped name is refused
 * rather than recorded (`unknown-group`); bringing one back needs only that it
 * is archived. One that changes nothing is refused (`archived`,
 * `not-archived`), so the log never carries one. Allowed in an archived Inbox.
 */
export const decideGroupArchive = (
  state: InboxState,
  input: {
    readonly inboxId: InboxId;
    readonly group: string;
    readonly archived: boolean;
  },
): Result.Result<GroupArchived | GroupUnarchived, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const { inboxId, archived } = input;
  const group = input.group.trim();
  if (group.length === 0)
    return refuse('empty', 'a group to archive needs a name');
  const is = state.archivedGroups.includes(group);
  if (!archived)
    return is
      ? Result.succeed({ _tag: 'GroupUnarchived', inboxId, group })
      : refuse('not-archived', `group "${group}" is not archived`);
  if (is) return refuse('archived', `group "${group}" is already archived`);
  const held = state.questions.some(
    (q) => q.state !== 'moved' && questionGroup(q.metadata) === group,
  );
  if (!held)
    return refuse(
      'unknown-group',
      `no question in this inbox is in group "${group}"`,
    );
  return Result.succeed({ _tag: 'GroupArchived', inboxId, group });
};

// --- mutes -------------------------------------------------------------------------

/**
 * Mute or unmute an Inbox. A mute that changes nothing is refused
 * (`unchanged`), so the log never carries one. Allowed in an archived Inbox.
 */
export const decideMute = (
  state: InboxState,
  input: { readonly inboxId: InboxId; readonly muted: boolean },
): Result.Result<InboxMuted | InboxUnmuted, InboxRefusal> => {
  if (!state.opened) return notFound(input.inboxId);
  const { inboxId, muted } = input;
  if (state.muted === muted)
    return refuse(
      'unchanged',
      `the inbox is already ${muted ? 'muted' : 'unmuted'}`,
    );
  return Result.succeed(
    muted ? { _tag: 'InboxMuted', inboxId } : { _tag: 'InboxUnmuted', inboxId },
  );
};

// --- the priority Inbox ------------------------------------------------------------

/**
 * The Inbox holding the priority mark, folded from the events of the log's
 * priority tag (every `InboxPriorityMarked` and `InboxPriorityCleared`),
 * oldest first; undefined when none does.
 */
export const priorityHolderOf = (
  events: ReadonlyArray<InboxEvent>,
): InboxId | undefined =>
  events.reduce<InboxId | undefined>((holder, event) => {
    if (event._tag === 'InboxPriorityMarked') return event.inboxId;
    if (event._tag === 'InboxPriorityCleared' && event.inboxId === holder)
      return undefined;
    return holder;
  }, undefined);

/**
 * Mark an Inbox as the priority Inbox (`priority: true`), or clear its mark.
 * `holder` is the Inbox holding the mark now (`priorityHolderOf`). A mark on
 * an Inbox while another holds it clears that one first, in the same events,
 * so one append replaces the mark and the log never holds two. One that
 * changes nothing is refused (`unchanged`), so the log never carries one.
 * Allowed in an archived or a muted Inbox: the mark stays and waits there,
 * as a pin does.
 */
export const decidePriority = (
  state: InboxState,
  holder: InboxId | undefined,
  input: { readonly inboxId: InboxId; readonly priority: boolean },
): Result.Result<
  ReadonlyArray<InboxPriorityMarked | InboxPriorityCleared>,
  InboxRefusal
> => {
  if (!state.opened) return notFound(input.inboxId);
  const { inboxId, priority } = input;
  if ((holder === inboxId) === priority)
    return refuse(
      'unchanged',
      priority
        ? 'the inbox is already the priority inbox'
        : 'the inbox is not the priority inbox',
    );
  if (!priority)
    return Result.succeed([{ _tag: 'InboxPriorityCleared', inboxId }]);
  return Result.succeed([
    ...(holder === undefined
      ? []
      : [{ _tag: 'InboxPriorityCleared' as const, inboxId: holder }]),
    { _tag: 'InboxPriorityMarked', inboxId },
  ]);
};
