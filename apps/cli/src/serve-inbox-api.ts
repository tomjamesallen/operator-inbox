import {
  type Attachment,
  askEvents,
  awaitingAgent,
  awaitingOperator,
  type DrawingRefs,
  type Drawings,
  decideAnswer,
  decideArchive,
  decideDismissHighlight,
  decideGroupArchive,
  decideInboxOwner,
  decideMute,
  decideOperatorAsk,
  decidePin,
  decidePriority,
  decideRename,
  decideUnarchive,
  HTML_BLOCK_BLOB_KIND,
  heldClaims,
  type InboxEvent,
  type InboxId,
  type InboxMachineEntry,
  type InboxMachineKey,
  type InboxMachinePort,
  type InboxQuestion,
  type InboxRefusal,
  type InboxState,
  inboxState,
  inboxStateStamped,
  type LocalInboxBoard,
  type LocalInboxIndex,
  type MachineRead,
  type MachineResult,
  type MacrosInvoked,
  type MergedInboxBoard,
  type MergedInboxIndex,
  machineRef,
  mergeInboxBoard,
  mergeInboxIndex,
  type OwnerAnswer,
  orderInboxes,
  ownerLookupMachines,
  ownersOfClaims,
  planInboxOwnerLookup,
  type QuestionComments,
  type QuestionDrawingRef,
  type QuestionNumber,
  type QuestionRevision,
  recentlyProcessed,
  recordMachineClaims,
  renderedQuestionBody,
  summariseInbox,
  totalAwaitingOperator,
  unresolvedRead,
} from '@operator-inbox/core';
import {
  AnswerRefused,
  ArchiveRefused,
  AskRefused,
  type AttachmentUpload,
  HighlightRefused,
  type InboxBoardDto,
  type InboxIndexDto,
  InboxNotFound,
  type InboxReadQuery,
  InboxUnavailable,
  type InboxViewDto,
  inboxClashSentence,
  MuteRefused,
  OpenSessionRefused,
  type OperatorInboxApi,
  PinRefused,
  PriorityRefused,
  type QuestionDrawingsDto,
  type QuestionHtmlBlocksDto,
  RenameRefused,
} from '@operator-inbox/core/api';
import { Effect, Predicate, Result, SubscriptionRef } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import type { InputError } from './errors';
import { keepAttachments, plannedUploads } from './inbox-attachments';
import {
  checkedScenes,
  drawingRefOf,
  keepScenes,
  questionScenes,
} from './inbox-drawings';
import {
  type ForwardedCall,
  type InboxRefusal as ForwardedRefusal,
  fetchMachineBoard,
  fetchMachineIndex,
  forwardInboxCall,
  forwardInboxRead,
  type MachineApi,
  type MachineCallKind,
} from './inbox-machine-client';
import {
  decideAndAppend,
  decideNamedAndAppend,
  decidePriorityAndAppend,
  InboxLog,
  type ListedInbox,
} from './inbox-store';
import {
  ServedInboxMachines,
  type ServedInboxMachinesShape,
} from './serve-inbox-machines';
import { openSessionLink } from './session-edge';

// The `inbox` group's handlers and live layer. The group
// class, its errors and the DTO live in `@operator-inbox/core/api`, because
// the browser imports them; this half reads the inbox log, so it stays here.
//
// The handlers ask for `InboxLog` and nothing else. `serve` provides the LAZY
// log (`InboxLogLazy`), so the store is acquired on the first inbox request,
// never at start-up: with the store unavailable the server still starts and
// serves the page, and these handlers answer
// `InboxUnavailable` until the store can be opened.
//
// The server's writes (answering a question, dismissing a highlight,
// pinning, archiving, muting, marking the priority Inbox, and renaming an
// Inbox) go to
// the inbox log: Local's own, or the Inbox machine's that owns the Inbox,
// through `routeByOwner` below.

// The store is unavailable: log the detail here, send a sentence.
const unavailable = <A, R>(self: Effect.Effect<A, InputError, R>) =>
  self.pipe(
    Effect.catchTag('InputError', (e) =>
      // Every store line already says "inbox".
      Effect.logWarning(e.message).pipe(
        Effect.andThen(
          Effect.fail(new InboxUnavailable({ message: e.message })),
        ),
      ),
    ),
  );

const notFound = (inboxId: InboxId) =>
  new InboxNotFound({ message: `inbox ${inboxId} does not exist` });

// A question's stamp, as the DTO's `<move>Seq` and `<move>At`, is written out
// per column below. A state folded without stamps (only a test does that)
// reads as seq 0.
/** The operator's view of one inbox, as the wire carries it. */
export const toInboxView = (
  inboxId: InboxId,
  state: InboxState,
): InboxViewDto => ({
  inboxId,
  label: state.label,
  ...(state.code === undefined ? {} : { code: state.code }),
  metadata: state.metadata,
  archived: state.archived,
  muted: state.muted,
  pinnedGroups: state.pinnedGroups,
  ...(state.archivedGroups.length === 0
    ? {}
    : { archivedGroups: state.archivedGroups }),
  awaitingOperator: awaitingOperator(state).map((q) => ({
    number: q.number,
    revision: q.revision,
    metadata: q.metadata,
    title: q.title,
    ...renderedQuestionBody(q.body),
    askedSeq: q.askedStamp?.seq ?? 0,
    ...(q.askedStamp?.at === undefined ? {} : { askedAt: q.askedStamp.at }),
    ...(q.highlight === undefined
      ? {}
      : {
          highlight: {
            ...(q.highlight.note === undefined
              ? {}
              : { note: q.highlight.note }),
            seq: q.highlight.stamp?.seq ?? 0,
          },
        }),
    ...drawingRefsDto(q),
    ...(q.htmls === undefined ? {} : { htmls: q.htmls }),
  })),
  // Oldest answered first: the order the agent will probably process them in.
  awaitingAgent: [...awaitingAgent(state)]
    .sort(
      (a, b) =>
        (a.answeredStamp?.seq ?? a.number) - (b.answeredStamp?.seq ?? b.number),
    )
    .map((q) => ({
      number: q.number,
      revision: q.revision,
      metadata: q.metadata,
      title: q.title,
      ...renderedQuestionBody(q.body),
      response: q.response ?? '',
      answeredSeq: q.answeredStamp?.seq ?? 0,
      ...(q.answeredStamp?.at === undefined
        ? {}
        : { answeredAt: q.answeredStamp.at }),
      ...(q.askedStamp?.at === undefined ? {} : { askedAt: q.askedStamp.at }),
      ...(q.operatorQuestion === undefined
        ? {}
        : { operatorQuestion: q.operatorQuestion }),
      ...(q.deferred === undefined ? {} : { deferred: q.deferred }),
      ...drawingRefsDto(q),
      ...sentDrawingRefsDto(q),
      ...(q.macros === undefined ? {} : { macros: q.macros }),
      ...(q.comments === undefined ? {} : { comments: q.comments }),
      ...(q.htmls === undefined ? {} : { htmls: q.htmls }),
      ...(q.attachments === undefined ? {} : { attachments: q.attachments }),
    })),
  processed: recentlyProcessed(state).map((q) => ({
    number: q.number,
    revision: q.revision,
    metadata: q.metadata,
    title: q.title,
    ...renderedQuestionBody(q.body),
    withdrawn: q.withdrawn,
    ...(q.response === undefined ? {} : { response: q.response }),
    ...(q.withdrawn ? { reason: q.reason ?? '' } : {}),
    processedSeq: q.processedStamp?.seq ?? 0,
    ...(q.processedStamp?.at === undefined
      ? {}
      : { processedAt: q.processedStamp.at }),
    ...(q.askedStamp?.at === undefined ? {} : { askedAt: q.askedStamp.at }),
    ...(q.answeredStamp?.at === undefined
      ? {}
      : { answeredAt: q.answeredStamp.at }),
    ...(q.operatorQuestion === undefined
      ? {}
      : { operatorQuestion: q.operatorQuestion }),
    ...(q.deferred === undefined ? {} : { deferred: q.deferred }),
    ...drawingRefsDto(q),
    ...sentDrawingRefsDto(q),
    ...(q.macros === undefined ? {} : { macros: q.macros }),
    ...(q.comments === undefined ? {} : { comments: q.comments }),
    ...(q.htmls === undefined ? {} : { htmls: q.htmls }),
    ...(q.attachments === undefined ? {} : { attachments: q.attachments }),
  })),
});

// A Question's drawings as the board carries them: each its scene's hash and
// size, and its revision; never the scene, whichever shape it was logged in
// (`drawingRefOf`). The page reads the scenes of the Question it shows
// (`questionDrawings`).
const drawingRefsDto = (
  q: InboxQuestion,
): { readonly drawingRefs?: Record<string, QuestionDrawingRef> } =>
  q.drawings === undefined
    ? {}
    : {
        drawingRefs: Object.fromEntries(
          Object.entries(q.drawings).map(([id, d]) => [
            id,
            { ...drawingRefOf(d.stored), revision: d.revision },
          ]),
        ),
      };

const sentDrawingRefsDto = (
  q: InboxQuestion,
): { readonly sentDrawingRefs?: DrawingRefs } =>
  q.sentDrawings === undefined
    ? {}
    : {
        sentDrawingRefs: Object.fromEntries(
          Object.entries(q.sentDrawings).map(([id, d]) => [
            id,
            drawingRefOf(d),
          ]),
        ),
      };

const readView = Effect.fnUntraced(function* (inboxId: InboxId) {
  const log = yield* InboxLog;
  const { stamped } = yield* unavailable(log.read(inboxId));
  const state = inboxStateStamped(stamped);
  if (!state.opened) return yield* notFound(inboxId);
  return toInboxView(inboxId, state);
});

// GET /api/inbox/:inboxId
export const inboxView = (inboxId: InboxId) => readView(inboxId);

const utf8 = new TextDecoder();

// GET /api/inbox/:inboxId/questions/:number/html-blocks: the documents of
// one Question's HTML blocks, read from the blob table by the hashes its
// events carry. Only this reads blobs: the board and every list carry the
// hashes alone. A Question with no such number, or no blocks, has none; a
// hash the table does not hold (a log copied without its blobs) is left out,
// and the page shows that block as missing.
export const questionHtmlBlocks = Effect.fnUntraced(function* (
  inboxId: InboxId,
  number: QuestionNumber,
) {
  const log = yield* InboxLog;
  const { events } = yield* unavailable(log.read(inboxId));
  const state = inboxState(events);
  if (!state.opened) return yield* notFound(inboxId);
  const refs = state.questions.find((q) => q.number === number)?.htmls ?? {};
  const shas = Object.values(refs).map((r) => r.sha);
  const kept =
    shas.length === 0
      ? new Map<string, never>()
      : yield* unavailable(log.readBlobs(shas));
  const blocks: Record<string, { sha: string; doc: string }> = {};
  for (const [id, ref] of Object.entries(refs)) {
    const blob = kept.get(ref.sha);
    if (blob !== undefined && blob.kind === HTML_BLOCK_BLOB_KIND)
      blocks[id] = { sha: ref.sha, doc: utf8.decode(blob.doc) };
  }
  const dto: QuestionHtmlBlocksDto = { blocks };
  return dto;
});

// GET /api/inbox/:inboxId/questions/:number/drawings: the scenes of one
// Question's drawings, the agent's and those the operator sent with their
// answer, read from the blob table by the hashes its events carry, or from
// the events themselves for drawings logged before scenes moved to the blob
// table. Only this reads them: the board and every list carry the hashes
// alone. A Question with no such number, or no drawings, has none; a scene
// the table does not hold is left out, and the page shows that drawing as
// missing.
export const questionDrawings = Effect.fnUntraced(function* (
  inboxId: InboxId,
  number: QuestionNumber,
) {
  const log = yield* InboxLog;
  const { events } = yield* unavailable(log.read(inboxId));
  const state = inboxState(events);
  if (!state.opened) return yield* notFound(inboxId);
  const q = state.questions.find((x) => x.number === number);
  const scenes =
    q === undefined
      ? { drawings: {}, sent: {} }
      : yield* unavailable(questionScenes(q));
  const dto: QuestionDrawingsDto = scenes;
  return dto;
});

// The same reads for the page, which go to the machine that owns the Inbox
// when Local's log does not have it. The owner is the machine the latest
// board or index read recorded as claiming the Inbox (`ownersOfClaims`):
// the page reads the board before it shows a Question, so its owner is
// known by then. With no machine, two, or one that cannot be called, the
// Inbox is not found, or the clash or the unreachable machine is said.
const routedHtmlBlocks = (
  inboxId: InboxId,
  number: QuestionNumber,
  query: InboxReadQuery,
) =>
  routedQuestionRead(
    inboxId,
    query,
    questionHtmlBlocks(inboxId, number),
    (api) => api.inbox.htmlBlocks({ params: { inboxId, number }, query: {} }),
  );

const routedDrawings = (
  inboxId: InboxId,
  number: QuestionNumber,
  query: InboxReadQuery,
) =>
  routedQuestionRead(inboxId, query, questionDrawings(inboxId, number), (api) =>
    api.inbox.drawings({ params: { inboxId, number }, query: {} }),
  );

const routedQuestionRead = <A, R>(
  inboxId: InboxId,
  query: InboxReadQuery,
  local: Effect.Effect<A, InboxNotFound | InboxUnavailable, R>,
  forward: Parameters<
    typeof forwardInboxRead<A, InboxNotFound | InboxUnavailable>
  >[1],
) =>
  Effect.gen(function* () {
    if (query.local === 'true') return yield* local;
    const served = yield* ServedInboxMachines;
    const { entries } = yield* served.machines;
    if (entries.length === 0) return yield* local;
    return yield* local.pipe(
      Effect.catchIf(
        (e) => Predicate.isTagged(e, 'InboxNotFound'),
        (lacked) =>
          Effect.gen(function* () {
            const { claims } = yield* SubscriptionRef.get(served.lastOwners);
            const keys = ownersOfClaims(claims, entries).get(inboxId) ?? [];
            const machines = yield* machinesAmong(entries, keys);
            const [owner, second] = machines;
            if (second !== undefined)
              return yield* Effect.fail(
                new InboxUnavailable({
                  message: inboxClashSentence(inboxId, machines),
                  clashedOn: machines.map(machineRef),
                }),
              );
            if (owner === undefined) return yield* Effect.fail(lacked);
            if (Result.isFailure(owner.resolved))
              return yield* Effect.fail(neverCalled(inboxId, [owner]));
            return yield* forwardInboxRead(owner, forward, served.callOptions);
          }),
      ),
    );
  });

// A write's view, read back after its append. A read-back that fails says
// the change may have been made, never that it was not: `mayHaveLanded`, which the page words as unconfirmed, as
// it does a forwarded write. Retrying is safe: the decision refuses a repeat.
const readBack = (inboxId: InboxId) =>
  readView(inboxId).pipe(
    Effect.catchTag('InboxUnavailable', (e) =>
      Effect.fail(
        new InboxUnavailable({
          message: `the inbox could not be read back after the change: ${e.message}; the change may have been made — reload to check`,
          mayHaveLanded: true,
        }),
      ),
    ),
  );

// POST /api/inbox/:inboxId/questions/:number/answer. Read, decide, append
// under the inbox's condition, retried once on a conflict; a second Send of
// the same card is refused by the decision on the fresh read, and so is an
// answer typed against a revision the agent has since edited (409, with the
// decision's own sentence).
export const answerQuestion = Effect.fnUntraced(function* (
  inboxId: InboxId,
  number: QuestionNumber,
  response: string,
  seenRevision: QuestionRevision,
  deferred?: true,
  highlightReply?: true,
  drawings?: Drawings,
  macros?: MacrosInvoked,
  comments?: QuestionComments,
  uploads: ReadonlyArray<AttachmentUpload> = [],
) {
  const refused = (refusal: InboxRefusal) =>
    refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new AnswerRefused({ message: refusal.message }));
  const base = {
    inboxId,
    number,
    response,
    seenRevision,
    ...(deferred === undefined ? {} : { deferred }),
    ...(highlightReply === undefined ? {} : { highlightReply }),
    ...(macros === undefined ? {} : { macros }),
    ...(comments === undefined ? {} : { comments }),
  };
  // The files: where each goes is known from its bytes, so the answer is
  // decided on that plan first, and one refused, or for an Inbox another
  // machine holds, writes no file. Then each is written, BEFORE the answer
  // is decided again and appended.
  const attachments = yield* keptUploads(
    inboxId,
    uploads,
    (message) => new AnswerRefused({ message }),
    (state, planned) => decideAnswer(state, { ...base, attachments: planned }),
    refused,
  );
  // Each edited scene checked as the decision checks it, then kept in the
  // blob table BEFORE the answer is decided and appended, so the event names
  // only scenes the store holds; a refused scene is never written.
  const checked = drawings === undefined ? undefined : checkedScenes(drawings);
  if (checked !== undefined && Result.isFailure(checked))
    return yield* Effect.fail(
      new AnswerRefused({ message: checked.failure.message }),
    );
  const kept =
    checked === undefined
      ? undefined
      : yield* unavailable(keepScenes(checked.success));
  const decided = yield* decideAndAppend(inboxId, (state) =>
    Result.map(
      decideAnswer(state, {
        ...base,
        ...(kept === undefined ? {} : { drawings: kept }),
        attachments,
      }),
      (event) => ({
        events: [event],
        result: undefined,
      }),
    ),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new AnswerRefused({
          message: 'the inbox changed twice while answering; send again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) return yield* refused(decided.failure);
  return yield* readBack(inboxId);
});

// The files an answer or a question carries, kept on disk: none for none.
// The plan is decided on this machine's own read of the Inbox first
// (`decide`), so an Inbox this log lacks is InboxNotFound before a byte is
// written, and the write goes on to the machine that holds it, files and all.
const keptUploads = <E, R>(
  inboxId: InboxId,
  uploads: ReadonlyArray<AttachmentUpload>,
  bad: (message: string) => E,
  decide: (
    state: InboxState,
    planned: ReadonlyArray<Attachment>,
  ) => Result.Result<unknown, InboxRefusal>,
  refused: (
    refusal: InboxRefusal,
  ) => Effect.Effect<never, E | InboxNotFound, R>,
) =>
  Effect.gen(function* () {
    if (uploads.length === 0) return [];
    const log = yield* InboxLog;
    const { stamped } = yield* unavailable(log.read(inboxId));
    const state = inboxStateStamped(stamped);
    if (!state.opened) return yield* Effect.fail(notFound(inboxId));
    const planned = yield* unavailable(plannedUploads(inboxId, uploads));
    if (Result.isFailure(planned))
      return yield* Effect.fail(bad(planned.failure));
    const first = decide(
      state,
      planned.success.map((p) => p.attachment),
    );
    if (Result.isFailure(first)) return yield* refused(first.failure);
    return yield* unavailable(keepAttachments(planned.success));
  });

// POST /api/inbox/:inboxId/questions. The operator asks the agent a
// question, from the app; it waits on the agent at once. Read, decide,
// append, as for an answer.
export const askQuestion = Effect.fnUntraced(function* (
  inboxId: InboxId,
  text: string,
  highlightReply?: true,
  uploads: ReadonlyArray<AttachmentUpload> = [],
) {
  const refused = (refusal: InboxRefusal) =>
    refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new AskRefused({ message: refusal.message }));
  const base = {
    inboxId,
    text,
    ...(highlightReply === undefined ? {} : { highlightReply }),
  };
  const attachments = yield* keptUploads(
    inboxId,
    uploads,
    (message) => new AskRefused({ message }),
    (state, planned) =>
      decideOperatorAsk(state, { ...base, attachments: planned }),
    refused,
  );
  const decided = yield* decideAndAppend(inboxId, (state) =>
    Result.map(decideOperatorAsk(state, { ...base, attachments }), (event) => ({
      events: askEvents(state, event),
      result: undefined,
    })),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new AskRefused({
          message: 'the inbox changed twice while asking; send again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new AskRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// Every opened Inbox, summarised and ordered by core: those waiting on the
// operator first, then most recent activity.
const listInboxes = Effect.fnUntraced(function* () {
  const log = yield* InboxLog;
  const listed = (yield* unavailable(log.listAll())).filter(
    (i) => i.state.opened,
  );
  return orderInboxes(
    listed.map((i) => ({
      ...summariseInbox(i.inboxId, i.state, i.lastActivity.seq),
      listed: i,
    })),
  );
});

const toIndex = (
  ordered: ReadonlyArray<
    ReturnType<typeof summariseInbox> & { listed: ListedInbox }
  >,
): LocalInboxIndex => ({
  inboxes: ordered.map((s) => ({
    inboxId: s.inboxId,
    label: s.label,
    ...(s.code === undefined ? {} : { code: s.code }),
    archived: s.archived,
    pinned: s.listed.state.pinned,
    muted: s.listed.state.muted,
    ...(s.listed.state.priority ? { priority: true as const } : {}),
    awaitingOperator: s.awaitingOperator,
    awaitingAgent: s.awaitingAgent,
    processed: s.processed,
    ...(s.listed.lastActivity.at === undefined
      ? {}
      : { lastActivityAt: s.listed.lastActivity.at }),
  })),
  // The active inboxes only: an archived one is out of the All view.
  totalAwaitingOperator: totalAwaitingOperator(ordered),
});

// --- Inbox machines ---
// The reads fan out: Local's log as before, and every configured machine at
// the same time, each through its tunnel with its read timeout. What each
// machine came to (reachable, unreachable, incompatible) is merged by core,
// so one machine failing never fails the board. A machine that names no
// Herdr profile is never called: it reads as unreachable, with the sentence
// saying why. With no machines configured, nothing is called and `machines`
// holds Local alone. A read from Local's serve (`local=true`, this serve
// asked as an Inbox machine) skips the fan-out and answers from this log
// alone, with none of the machine fields: Local merges one level, and a call
// never travels on to a third machine.

type MachineFetch<A> = (
  port: InboxMachinePort,
  options: ServedInboxMachinesShape['callOptions'],
) => Effect.Effect<MachineRead<A>>;

// Every configured machine's read, in order, and the banner's sentence when
// the machines are off. The read takes a number as it starts,
// and each machine it reaches records what it claims as soon as its own read
// completes (core's `recordMachineClaims`), so a read the page gives up on
// still records every machine it reached; the merge is given the claims
// that still count against the machines read (`heldClaims`).
export const readMachines = <A extends Pick<InboxIndexDto, 'inboxes'>>(
  fetch: MachineFetch<A>,
) =>
  Effect.gen(function* () {
    const served = yield* ServedInboxMachines;
    const number = yield* SubscriptionRef.modify(served.lastOwners, (last) => [
      last.next,
      { ...last, next: last.next + 1 },
    ]);
    const { entries, machinesOff } = yield* served.machines;
    const record = (key: InboxMachineKey, read: MachineRead<A>) =>
      read.status === 'reachable'
        ? SubscriptionRef.update(served.lastOwners, (last) => ({
            ...last,
            claims: recordMachineClaims(last.claims, {
              number,
              entries,
              key,
              rows: read.value.inboxes,
            }),
          }))
        : Effect.void;
    const results = yield* Effect.forEach(
      entries,
      ({ resolved, ...name }) =>
        (Result.isSuccess(resolved)
          ? Effect.uninterruptibleMask((restore) =>
              restore(fetch(name.port, served.callOptions)).pipe(
                Effect.tap((read) => record(name.key, read)),
              ),
            )
          : Effect.succeed(unresolvedRead(resolved.failure))
        ).pipe(Effect.map((read): MachineResult<A> => ({ ...name, read }))),
      { concurrency: 'unbounded' },
    );
    const { claims } = yield* SubscriptionRef.get(served.lastOwners);
    return {
      results,
      options: {
        claims: heldClaims(claims, entries),
        ...(machinesOff === undefined ? {} : { machinesOff }),
      },
    };
  });

// GET /api/inboxes: the sidebar's rows and the header's count.
export const inboxIndex = Effect.fnUntraced(function* (
  query: InboxReadQuery = {},
) {
  if (query.local === 'true') {
    const own: InboxIndexDto = toIndex(yield* listInboxes());
    return own;
  }
  const [ordered, machines] = yield* Effect.all(
    [listInboxes(), readMachines(fetchMachineIndex)],
    { concurrency: 'unbounded' },
  );
  const index: InboxIndexDto & MergedInboxIndex = mergeInboxIndex(
    toIndex(ordered),
    machines.results,
    machines.options,
  );
  return index;
});

const localBoard = (
  ordered: Parameters<typeof toIndex>[0],
): LocalInboxBoard => ({
  ...toIndex(ordered),
  views: ordered.map((s) => toInboxView(s.inboxId, s.listed.state)),
});

// GET /api/inbox-board: the whole inbox screen in one read — the index, and
// every Inbox's view in the same order.
export const inboxBoard = Effect.fnUntraced(function* (
  query: InboxReadQuery = {},
) {
  if (query.local === 'true') {
    const own: InboxBoardDto = localBoard(yield* listInboxes());
    return own;
  }
  const [ordered, machines] = yield* Effect.all(
    [listInboxes(), readMachines(fetchMachineBoard)],
    { concurrency: 'unbounded' },
  );
  const board: InboxBoardDto & MergedInboxBoard = mergeInboxBoard(
    localBoard(ordered),
    machines.results,
    machines.options,
  );
  return board;
});

// What a machine that has the Inbox gave a round: the machine, so a write
// probed with `view` is sent on to it, and its answer, as an Effect to give
// back (its view, or a refusal only the owner can give).
interface Owned<E> {
  readonly machine: InboxMachineEntry;
  readonly answer: Effect.Effect<InboxViewDto, E>;
}

// How a machine answered a round's ask, for core's `decideInboxOwner`:
// `Has` when it has the Inbox (its view, or a refusal only the owner can
// give); `Lacks` on InboxNotFound; `Unreached` on InboxUnavailable, since it
// may yet be the owner.
const ownerAnswer = <E extends ForwardedRefusal>(
  machine: InboxMachineEntry,
  answer: Effect.Effect<InboxViewDto, E | InboxNotFound | InboxUnavailable>,
) => {
  const has = <EA>(
    owned: Effect.Effect<InboxViewDto, EA>,
  ): OwnerAnswer<Owned<EA>, InboxUnavailable> => ({
    _tag: 'Has',
    value: { machine, answer: owned },
  });
  return answer.pipe(
    Effect.map((view) => has(Effect.succeed(view))),
    Effect.catchTag('InboxUnavailable', (value) =>
      Effect.succeed<OwnerAnswer<never, InboxUnavailable>>({
        _tag: 'Unreached',
        value,
      }),
    ),
    Effect.catchTag(
      'InboxNotFound',
      () => Effect.succeed<OwnerAnswer<never, never>>({ _tag: 'Lacks' }),
      (refusal) => Effect.succeed(has(Effect.fail(refusal))),
    ),
  );
};

// Every endpoint keyed by an Inbox id goes to the machine that owns the
// Inbox. Local's log first: the endpoint is answered
// from it, and only its InboxNotFound, which Local's handlers give for an
// Inbox its log has never opened and for nothing else (core's `decide*`
// check that first), sends the request on to the machines. Then core plans
// the lookup (`planInboxOwnerLookup`) from what each configured machine
// claims (`ownersOfClaims`), whether or not it can be called now: an id two
// machines claim is refused at once; an id only a machine that cannot be
// called claims is that machine's, unreachable; otherwise the machine
// recorded as claiming it is asked, then every other machine that can be
// called, each round asked AT ONCE, so a machine that hangs costs one
// timeout, not one each. Core decides each round (`decideInboxOwner`): two
// that have it is a clash, refused; one is the owner; none, and one not
// reached, is that one's InboxUnavailable, never InboxNotFound, since it may
// own it. Every machine asked lacking it is InboxNotFound only when no
// configured machine was left uncalled; otherwise it is InboxUnavailable
// naming those, since one of them may hold it. A `read` round sends the call itself. A `write` is sent only to
// one machine: a round of one (the recorded owner, or the only machine) gets
// the write itself, and a round of several is probed with `view` (a read's
// timeout), the write then sent to the one owner the probe found. The
// request goes with its params and payload as they came, and `local=true`
// (see `forwardInboxCall`), so the owner answers from its own log; its
// refusal comes back as the owner said it, and its view with `machine` set
// and every body rendered again by Local (core's `machineView`). A `write`
// waits longer than a `read`, and one that times out says its outcome is not
// known. A call from Local's serve (`local=true`) is answered from this
// machine's log alone, the machines never read.
const routeByOwner = <EL, RL, ER extends ForwardedRefusal>(
  kind: MachineCallKind,
  inboxId: InboxId,
  query: InboxReadQuery,
  local: Effect.Effect<InboxViewDto, EL, RL>,
  remote: ForwardedCall<ER>,
) =>
  Effect.gen(function* () {
    if (query.local === 'true') return yield* local;
    const served = yield* ServedInboxMachines;
    const { entries } = yield* served.machines;
    if (entries.length === 0) return yield* local;
    return yield* local.pipe(
      Effect.catchIf(
        (e) => Predicate.isTagged(e, 'InboxNotFound'),
        () => askMachines(kind, inboxId, served, entries, remote),
      ),
    );
  });

// The lookup past Local's log (`routeByOwner`), over every configured
// machine, in the configured order.
const askMachines = <ER extends ForwardedRefusal>(
  kind: MachineCallKind,
  inboxId: InboxId,
  served: ServedInboxMachinesShape,
  entries: ReadonlyArray<InboxMachineEntry>,
  remote: ForwardedCall<ER>,
) =>
  Effect.gen(function* () {
    const among = (keys: ReadonlyArray<InboxMachineKey>) =>
      machinesAmong(entries, keys);
    const clashed = (keys: ReadonlyArray<InboxMachineKey>) =>
      Effect.flatMap(among(keys), (machines) =>
        Effect.fail(
          new InboxUnavailable({
            message: inboxClashSentence(inboxId, machines),
            clashedOn: machines.map(machineRef),
          }),
        ),
      );
    const { claims } = yield* SubscriptionRef.get(served.lastOwners);
    const plan = planInboxOwnerLookup({
      inboxId,
      lastOwners: ownersOfClaims(claims, entries),
      ...ownerLookupMachines(entries),
    });
    if (plan._tag === 'Clashed') return yield* clashed(plan.machines);
    if (plan._tag === 'Unreached')
      return yield* Effect.fail(neverCalled(inboxId, yield* among([plan.key])));
    // No machine asked has it: it does not exist, unless a machine that
    // cannot be called may hold it.
    const lacked = Effect.flatMap(among(plan.uncalled), (uncalled) =>
      Effect.fail(neverCalled(inboxId, uncalled)),
    );
    const send = (
      machine: InboxMachineEntry,
      callKind: MachineCallKind,
      call: ForwardedCall<ER | InboxNotFound | InboxUnavailable>,
    ) =>
      forwardInboxCall(
        machine,
        callKind,
        call,
        served.callOptions,
        served.keepWrite,
      );
    for (const [i, keys] of plan.rounds.entries()) {
      const probing = kind === 'write' && keys.length > 1;
      const answers = yield* Effect.forEach(
        yield* among(keys),
        (machine) =>
          ownerAnswer(
            machine,
            probing
              ? send(machine, 'read', (api) =>
                  api.inbox.view({ params: { inboxId }, query: {} }),
                )
              : send(machine, kind, remote),
          ).pipe(Effect.map((answer) => ({ key: machine.key, answer }))),
        { concurrency: 'unbounded' },
      );
      const decision = decideInboxOwner(answers, i < plan.rounds.length - 1);
      switch (decision._tag) {
        case 'AskNext':
          continue;
        case 'NotFound':
          return yield* lacked;
        case 'Unreached':
          return yield* decision.value;
        case 'Clash':
          return yield* clashed(decision.machines);
        case 'Owner':
          return yield* probing
            ? send(decision.value.machine, kind, remote)
            : decision.value.answer;
      }
    }
    return yield* lacked;
  });

// The machines whose keys are given, in section order. Core's plan and
// decision name only configured machines, so a key no entry has is Local's
// own bug: it dies naming the key, rather than the machine being left out
// of the round, the clash or the refusal without a word.
export const machinesAmong = (
  entries: ReadonlyArray<InboxMachineEntry>,
  keys: ReadonlyArray<InboxMachineKey>,
): Effect.Effect<ReadonlyArray<InboxMachineEntry>> => {
  const unknown = keys.filter((key) => !entries.some((e) => e.key === key));
  return unknown.length > 0
    ? Effect.die(
        new Error(
          `no configured Inbox machine has the key ${unknown.join(', ')}`,
        ),
      )
    : Effect.succeed(entries.filter((e) => keys.includes(e.key)));
};

// The refusal for an Inbox only machines that cannot be called may hold:
// the one recorded as claiming it, or, with no machine asked having it,
// every machine that could not be asked. Each one's entry names no usable
// Herdr machine now, or Herdr could not be read. Nothing was sent, so
// nothing may have landed. None, or one that can be called, is the Inbox
// not existing: the plan names only machines that cannot be called, so
// that arm is taken only when every machine asked lacked it and none was
// left uncalled.
const neverCalled = (
  inboxId: InboxId,
  machines: ReadonlyArray<InboxMachineEntry>,
): InboxUnavailable | InboxNotFound => {
  const uncalled = machines.flatMap((m) =>
    Result.isFailure(m.resolved)
      ? [{ machine: m, reason: m.resolved.failure.reason }]
      : [],
  );
  const [only, second] = uncalled;
  if (only === undefined) return notFound(inboxId);
  if (second === undefined)
    return new InboxUnavailable({
      message: `the Inbox machine ${only.machine.label} could not be reached: ${only.reason}`,
      machine: machineRef(only.machine),
    });
  return new InboxUnavailable({
    message: `no Inbox machine asked has inbox ${inboxId}, and the Inbox machines ${uncalled.map((u) => u.machine.label).join(', ')} could not be reached, so it may be on one of them: ${uncalled.map((u) => `${u.machine.label}: ${u.reason}`).join('; ')}`,
  });
};

// POST /api/inbox/:inboxId/rename. The read → decide → append cycle for a
// decision that takes a name, conditioned on the inbox and the name; an empty
// name, the name it already has, and a name another inbox holds are refused
// (409) — the last with that inbox's id.
export const renameInbox = Effect.fnUntraced(function* (
  inboxId: InboxId,
  label: string,
) {
  const decided = yield* decideNamedAndAppend(inboxId, label, (state, holder) =>
    Result.map(decideRename(state, { inboxId, label, holder }), (event) => ({
      events: [event],
      result: undefined,
    })),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new RenameRefused({
          message: 'the inbox changed twice while renaming; save again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(
          new RenameRefused({
            message: refusal.message,
            ...(refusal.conflictingInboxId === undefined
              ? {}
              : { conflictingInboxId: refusal.conflictingInboxId }),
          }),
        );
  }
  return yield* readBack(inboxId);
});

// POST /api/inbox/:inboxId/questions/:number/dismiss-highlight. The operator
// takes a highlight away (either side may dismiss one). Read, decide,
// append, as for an answer.
export const dismissHighlight = Effect.fnUntraced(function* (
  inboxId: InboxId,
  number: QuestionNumber,
) {
  const decided = yield* decideAndAppend(inboxId, (state) =>
    Result.map(
      decideDismissHighlight(state, {
        inboxId,
        numbers: [number],
        by: 'operator',
      }),
      (events) => ({ events, result: undefined }),
    ),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new HighlightRefused({
          message: 'the inbox changed twice while dismissing; try again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new HighlightRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// POST /api/inbox/:inboxId/pin. The operator pins or unpins the Inbox, or one
// of its groups, from the sidebar. Read, decide, append, as for an answer.
export const pinInbox = Effect.fnUntraced(function* (
  inboxId: InboxId,
  pinned: boolean,
  group: string | undefined,
) {
  const decided = yield* decideAndAppend(inboxId, (state) =>
    Result.map(
      decidePin(state, {
        inboxId,
        pinned,
        ...(group === undefined ? {} : { group }),
      }),
      (event) => ({ events: [event], result: undefined }),
    ),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new PinRefused({
          message: 'the inbox changed twice while pinning; try again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new PinRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// POST /api/inbox/:inboxId/archive. The operator archives an Inbox, or brings
// it back, from the app. Read, decide, append, as for an answer.
export const archiveInbox = Effect.fnUntraced(function* (
  inboxId: InboxId,
  archived: boolean,
) {
  const decided = yield* decideAndAppend(inboxId, (state) => {
    const event: Result.Result<InboxEvent, InboxRefusal> = archived
      ? decideArchive(state, { inboxId })
      : decideUnarchive(state, { inboxId });
    return Result.map(event, (e) => ({ events: [e], result: undefined }));
  }).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new ArchiveRefused({
          message: 'the inbox changed twice while archiving; try again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new ArchiveRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// POST /api/inbox/:inboxId/archive-group. The operator archives one of an
// Inbox's groups, or brings it back, from its sidebar row. Read, decide,
// append, as for an Inbox's archive.
export const archiveGroup = Effect.fnUntraced(function* (
  inboxId: InboxId,
  group: string,
  archived: boolean,
) {
  const decided = yield* decideAndAppend(inboxId, (state) =>
    Result.map(
      decideGroupArchive(state, { inboxId, group, archived }),
      (event) => ({ events: [event], result: undefined }),
    ),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new ArchiveRefused({
          message: 'the inbox changed twice while archiving; try again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new ArchiveRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// POST /api/inbox/:inboxId/mute. The operator mutes or unmutes an Inbox from
// the sidebar. Read, decide, append, as for a pin.
export const muteInbox = Effect.fnUntraced(function* (
  inboxId: InboxId,
  muted: boolean,
) {
  const decided = yield* decideAndAppend(inboxId, (state) =>
    Result.map(decideMute(state, { inboxId, muted }), (event) => ({
      events: [event],
      result: undefined,
    })),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new MuteRefused({
          message: 'the inbox changed twice while muting; try again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new MuteRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// POST /api/inbox/:inboxId/priority. The operator marks an Inbox as the
// priority Inbox, or clears its mark, from the sidebar. Read the Inbox and the
// log's priority tag, decide, append: a mark that replaces another clears that
// one in the same append (`decidePriorityAndAppend`).
export const priorityInbox = Effect.fnUntraced(function* (
  inboxId: InboxId,
  priority: boolean,
) {
  const decided = yield* decidePriorityAndAppend(inboxId, (state, holder) =>
    Result.map(
      decidePriority(state, holder, { inboxId, priority }),
      (events) => ({
        events,
        result: undefined,
      }),
    ),
  ).pipe(
    Effect.catchTag('AppendConditionFailed', () =>
      Effect.fail(
        new PriorityRefused({
          message:
            'the priority inbox changed twice while marking it; try again',
        }),
      ),
    ),
    Effect.catchTag('InputError', (e) => unavailable(Effect.fail(e))),
  );
  if (Result.isFailure(decided)) {
    const refusal = decided.failure;
    return yield* refusal.reason === 'not-found'
      ? Effect.fail(notFound(inboxId))
      : Effect.fail(new PriorityRefused({ message: refusal.message }));
  }
  return yield* readBack(inboxId);
});

// The endpoints keyed by an Inbox id, each a `read` or a `write`
// (`routeByOwner`).
type OwnedEndpoint = Exclude<
  keyof MachineApi['inbox'],
  'index' | 'board' | 'openSession' | 'htmlBlocks' | 'drawings'
>;
const OWNED_KIND: Record<OwnedEndpoint, MachineCallKind> = {
  view: 'read',
  answer: 'write',
  ask: 'write',
  dismissHighlight: 'write',
  pin: 'write',
  archive: 'write',
  archiveGroup: 'write',
  mute: 'write',
  priority: 'write',
  rename: 'write',
};

// The derived client's methods for them, each by name, so a method looked
// up by a name given as a type parameter keeps its own request and its own
// refusals (TypeScript's correlated mapped type). The request is the
// handler's too: the same Schema types, so it is forwarded as it came.
type OwnedRequests = {
  readonly [N in OwnedEndpoint]: Omit<
    Parameters<MachineApi['inbox'][N]>[0],
    'responseMode' | 'sseOptions'
  > &
    KeyedByInbox;
};
// What every one of them is asked with, written out so `owned` can read it
// whatever the endpoint.
interface KeyedByInbox {
  readonly params: { readonly inboxId: InboxId };
  readonly query: InboxReadQuery;
}
type OwnedRequest<N extends OwnedEndpoint> = OwnedRequests[N];
type OwnedRefusal<N extends OwnedEndpoint> = Extract<
  Effect.Error<ReturnType<MachineApi['inbox'][N]>>,
  ForwardedRefusal
>;
type OwnedClient = {
  readonly [N in OwnedEndpoint]: (
    request: OwnedRequest<N>,
  ) => ReturnType<ForwardedCall<OwnedRefusal<N>>>;
};
const ownedClient = (api: MachineApi): OwnedClient => api.inbox;

// One endpoint keyed by an Inbox id, answered from `local` when the Inbox is
// Local's, and otherwise sent on to its owner as the same endpoint of the
// derived client (`routeByOwner`), with the request's params and payload as
// they came. Its query is not passed on: the only one there is, `local`, is
// set on every call to a machine below it (`machineApi`, `local=true`), and
// a request that carried it never gets here (`routeByOwner` answers it from
// Local's log).
const owned =
  <N extends OwnedEndpoint, EL, RL>(
    name: N,
    local: (request: OwnedRequest<N>) => Effect.Effect<InboxViewDto, EL, RL>,
  ) =>
  (request: OwnedRequests[N]) =>
    routeByOwner(
      OWNED_KIND[name],
      request.params.inboxId,
      request.query,
      local(request),
      (api) => ownedClient(api)[name]({ ...request, query: {} }),
    );

export const makeInboxApiLive = (api: typeof OperatorInboxApi) =>
  HttpApiBuilder.group(api, 'inbox', (handlers) =>
    handlers
      .handle('index', ({ query }) => inboxIndex(query))
      .handle('board', ({ query }) => inboxBoard(query))
      .handle('htmlBlocks', ({ params, query }) =>
        routedHtmlBlocks(params.inboxId, params.number, query),
      )
      .handle('drawings', ({ params, query }) =>
        routedDrawings(params.inboxId, params.number, query),
      )
      .handle(
        'view',
        owned('view', ({ params }) => inboxView(params.inboxId)),
      )
      .handle(
        'answer',
        owned('answer', ({ params, payload }) =>
          answerQuestion(
            params.inboxId,
            params.number,
            payload.response,
            payload.seenRevision,
            payload.deferred,
            payload.highlightReply,
            payload.drawings,
            payload.macros,
            payload.comments,
            payload.attachments,
          ),
        ),
      )
      .handle(
        'ask',
        owned('ask', ({ params, payload }) =>
          askQuestion(
            params.inboxId,
            payload.text,
            payload.highlightReply,
            payload.attachments,
          ),
        ),
      )
      .handle(
        'dismissHighlight',
        owned('dismissHighlight', ({ params }) =>
          dismissHighlight(params.inboxId, params.number),
        ),
      )
      .handle(
        'pin',
        owned('pin', ({ params, payload }) =>
          pinInbox(params.inboxId, payload.pinned, payload.group),
        ),
      )
      .handle(
        'archive',
        owned('archive', ({ params, payload }) =>
          archiveInbox(params.inboxId, payload.archived),
        ),
      )
      .handle(
        'archiveGroup',
        owned('archiveGroup', ({ params, payload }) =>
          archiveGroup(params.inboxId, payload.group, payload.archived),
        ),
      )
      .handle(
        'mute',
        owned('mute', ({ params, payload }) =>
          muteInbox(params.inboxId, payload.muted),
        ),
      )
      .handle(
        'priority',
        owned('priority', ({ params, payload }) =>
          priorityInbox(params.inboxId, payload.priority),
        ),
      )
      .handle(
        'rename',
        owned('rename', ({ params, payload }) =>
          renameInbox(params.inboxId, payload.label),
        ),
      )
      .handle('openSession', ({ payload }) =>
        openSessionLink(payload.link).pipe(
          Effect.flatMap((opened) =>
            opened
              ? Effect.void
              : Effect.fail(
                  new OpenSessionRefused({
                    message: 'the Claude app did not take the link',
                  }),
                ),
          ),
        ),
      ),
  );
