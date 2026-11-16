import {
  type AppendConditionFailed,
  DcbEventStore,
  DcbEventStoreInMemory,
  EventType,
  type Position,
  query,
  retryOnConflict,
  Tag,
} from '@kairos-es/core';
import {
  codeHolders,
  describeInboxDatabase,
  type EventStamp,
  firstFreeCode,
  formerCodeHolders,
  type InboxCode,
  InboxEvent,
  type InboxId,
  type InboxRefusal,
  type InboxState,
  inboxState,
  nameHolder,
  normaliseInboxLabel,
  priorityHolderOf,
  type ResolvedInboxDatabase,
  type SessionId,
  type SessionInboxMode,
  sessionInboxMode,
} from '@operator-inbox/core';
import {
  type Array as Arr,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  type FileSystem,
  Layer,
  Option,
  Random,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { SqlClient, type SqlError } from 'effect/sql';
import { InputError } from './errors';
import {
  ensureBlobTable,
  InboxBlobs,
  InboxBlobsInMemory,
  makeInboxBlobsSql,
  type StoredBlob,
} from './inbox-blobs';
import {
  ensureInboxFolder,
  resolveInboxDatabaseEdge,
  STORE_CONFIG,
} from './inbox-database';
import {
  catchUpReadModel,
  ensureReadModelTables,
  InboxReadModel,
  InboxReadModelInMemory,
  inboxesOf,
  type ListedInbox,
  listReadModel,
  makeInboxReadModelSql,
  type QuestionCounts,
} from './inbox-read-model';

export type { ListedInbox } from './inbox-read-model';

// The inbox event log: one machine-local, append-only
// kairos-es store behind the `InboxLog` service. Which questions await whom is
// never stored — `@operator-inbox/core`'s `inboxState` folds it from what this hands
// back.
//
// The store is a local SQLite file. kairos-es's SQLite engine keeps every
// acknowledged append when several processes write one file, which the inbox
// needs, because `serve` and every session's CLI write the same log. Only `connectInboxLog` knows the
// backend; everything else asks for `InboxLog`.
//
// Tags — the DCB consistency boundary is ONE inbox, and, for taking a name,
// that name across every inbox:
// - every event carries `inbox:<id>`;
// - `InboxOpened` and `InboxAdopted` also carry `session:<id>` when there is
//   one, which is how a session finds its inbox again after a compaction;
// - `InboxModeOn` and `InboxModeOff` carry `session:<id>` too: inbox mode is
//   the session's, so its hooks fold it from one read of that tag
//   (`readSession`). `findBySession` takes the inbox from the same fold
//   (`sessionInboxMode`);
// - `InboxOpened` carries `inbox-label:<name>`, and `InboxRenamed` carries it
//   for BOTH the name it takes and the name it gives up, with the name in
//   core's normalised form. A read of one name's tag therefore sees every
//   event that took or released that name, and an append conditioned on it
//   means two sessions racing for one name cannot both win;
// - `QuestionMoved` also carries `inbox:<toInboxId>`: it belongs to both
//   Inboxes, so a read of either sees it, and its append is conditioned on
//   both;
// - `InboxCodeAssigned` carries `inbox-code:<code>`, so a read of a code's
//   tag finds who holds it (`findByCode`), and an assignment conditioned on
//   it means two Inboxes racing for one code cannot both win;
// - `InboxCodeChanged` carries the tags of both codes it touches, so a read of
//   either sees the move, and the older code still finds its Inbox;
// - `InboxPriorityMarked` and `InboxPriorityCleared` carry `inbox-priority:mark`,
//   one tag for the whole log, so a read of it folds which Inbox holds the
//   mark (core's `priorityHolderOf`), and a mark conditioned on it means two
//   marks racing cannot both win: the log never holds two priority Inboxes.

const inboxTag = (inboxId: InboxId) => Tag.make(`inbox:${inboxId}`);
const sessionTag = (sessionId: SessionId) => Tag.make(`session:${sessionId}`);
const labelTag = (label: string) =>
  Tag.make(`inbox-label:${normaliseInboxLabel(label)}`);
const codeTag = (code: InboxCode) => Tag.make(`inbox-code:${code}`);
const priorityTag = Tag.make('inbox-priority:mark');

const EventJson = Schema.fromJsonString(InboxEvent);
const encodeEvent = Schema.encodeSync(EventJson);
const decodeEvent = Schema.decodeUnknownSync(EventJson);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface InboxRead {
  readonly events: ReadonlyArray<InboxEvent>;
  // The same events with their place in the whole log and their write time,
  // for core's `inboxStateStamped`.
  readonly stamped: ReadonlyArray<{
    readonly event: InboxEvent;
    readonly stamp: EventStamp;
  }>;
  readonly head: Position;
}

/**
 * One inbox's events and the events that took or released one name, read
 * together so one head conditions the append on both (`readNamed`), with
 * the events of any codes it may take.
 */
export interface NamedRead {
  // The inbox's own events, oldest first.
  readonly inbox: ReadonlyArray<InboxEvent>;
  // Every event the name's label tag holds, oldest first; none with no name.
  readonly label: ReadonlyArray<InboxEvent>;
  // Every event the codes' tags hold, oldest first; none with no codes.
  readonly codes: ReadonlyArray<InboxEvent>;
  readonly head: Position;
}

/**
 * One inbox's events and every event of the log's priority tag, read together
 * so one head conditions the append on both (`readPriority`).
 */
export interface PriorityRead {
  // The inbox's own events, oldest first.
  readonly inbox: ReadonlyArray<InboxEvent>;
  // Every mark and clearing of the priority, oldest first.
  readonly priority: ReadonlyArray<InboxEvent>;
  readonly head: Position;
}

/** Two inboxes, read together with one head, for a move between them. */
export interface PairRead {
  readonly first: ReadonlyArray<InboxEvent>;
  readonly second: ReadonlyArray<InboxEvent>;
  readonly head: Position;
}

/** An event's stamp: its global position as a number, its time as ISO. */
const stampOf = (position: Position, occurredAt: DateTime.Utc): EventStamp => ({
  seq: Number(position),
  at: DateTime.formatIso(occurredAt),
});

/**
 * Append only if no event tagged with the inboxes the events touch landed
 * after `after` — nor, when `label` is given, any event tagged with that
 * name, nor, when `codes` are, any tagged with one of them. With `session`, the condition is that session's tag alone, the query
 * `readSession` reads: a decision taken from the session's events is
 * conditioned on what it read, and nothing else (`decideSessionAndAppend`).
 * With `priority`, likewise, it is that inbox and the priority tag, the query
 * `readPriority` reads (`decidePriorityAndAppend`): the clearing of the Inbox
 * that held the mark is conditioned on the mark, not on that Inbox's
 * questions.
 */
export type InboxGuard =
  | {
      readonly after: Position;
      readonly label?: string;
      readonly codes?: ReadonlyArray<InboxCode>;
    }
  | { readonly after: Position; readonly session: SessionId }
  | { readonly after: Position; readonly priority: InboxId };

export class InboxLog extends Context.Service<
  InboxLog,
  {
    readonly read: (inboxId: InboxId) => Effect.Effect<InboxRead, InputError>;
    /**
     * One inbox, one name's label tag (none when `label` is undefined) and
     * the tags of `codes`, in one read with one head.
     */
    readonly readNamed: (
      inboxId: InboxId,
      label: string | undefined,
      codes?: ReadonlyArray<InboxCode>,
    ) => Effect.Effect<NamedRead, InputError>;
    /**
     * The inbox holding `code`, if any; else the inbox that held it before
     * its code moved (an older `ab-xyz` a transcript quotes).
     */
    readonly findByCode: (
      code: InboxCode,
    ) => Effect.Effect<Option.Option<InboxId>, InputError>;
    /** One inbox and the log's priority tag, in one read with one head. */
    readonly readPriority: (
      inboxId: InboxId,
    ) => Effect.Effect<PriorityRead, InputError>;
    /** Two inboxes in one read with one head, for a move between them. */
    readonly readPair: (
      a: InboxId,
      b: InboxId,
    ) => Effect.Effect<PairRead, InputError>;
    /** The inbox this session opened or adopted most recently. */
    readonly findBySession: (
      sessionId: SessionId,
    ) => Effect.Effect<Option.Option<InboxId>, InputError>;
    /**
     * Every event the session's tag holds (its opens, adoptions and inbox
     * mode), stamped, with the log's head, for core's `sessionInboxMode`.
     */
    readonly readSession: (
      sessionId: SessionId,
    ) => Effect.Effect<InboxRead, InputError>;
    /**
     * Every inbox on the machine, in the order they were opened, served from
     * the list's read model (`inbox-read-model.ts`) once it is caught up.
     */
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<ListedInbox>,
      InputError
    >;
    /** Counts over every Question, from the same read model. */
    readonly countQuestions: (
      since: string,
    ) => Effect.Effect<QuestionCounts, InputError>;
    readonly append: (
      events: Arr.NonEmptyReadonlyArray<InboxEvent>,
      guard: InboxGuard,
    ) => Effect.Effect<void, AppendConditionFailed | InputError>;
    /**
     * Keep a document in the blob table (`inbox-blobs.ts`), before the event
     * that names it is appended. A blob already kept is left as it is.
     */
    readonly putBlob: (blob: StoredBlob) => Effect.Effect<void, InputError>;
    /** The blobs kept under these keys; a key with none is left out. */
    readonly readBlobs: (
      shas: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, StoredBlob>, InputError>;
  }
>()('operator-inbox/InboxLog') {}

/**
 * A v4 UUID from Effect's injected `Random`, so a test can seed it. `DcbEvent`
 * requires the UUID shape; the version and variant bits are set by hand.
 */
const randomUuid = Effect.gen(function* () {
  const bytes: Array<number> = [];
  for (let i = 0; i < 16; i++)
    bytes.push(yield* Random.nextIntBetween(0, 256, { halfOpen: true }));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const tagsFor = (event: InboxEvent) => {
  const tags = [inboxTag(event.inboxId)];
  if (
    event._tag === 'InboxAdopted' ||
    event._tag === 'InboxModeOn' ||
    event._tag === 'InboxModeOff'
  )
    tags.push(sessionTag(event.sessionId));
  if (event._tag === 'InboxOpened') {
    if (event.sessionId !== undefined) tags.push(sessionTag(event.sessionId));
    tags.push(labelTag(event.label));
  }
  if (event._tag === 'QuestionMoved') tags.push(inboxTag(event.toInboxId));
  if (event._tag === 'InboxCodeAssigned') tags.push(codeTag(event.code));
  if (event._tag === 'InboxCodeChanged')
    tags.push(codeTag(event.from), codeTag(event.code));
  if (
    event._tag === 'InboxPriorityMarked' ||
    event._tag === 'InboxPriorityCleared'
  )
    tags.push(priorityTag);
  if (event._tag === 'InboxRenamed') {
    tags.push(labelTag(event.label));
    if (event.previousLabel !== undefined) {
      const released = labelTag(event.previousLabel);
      if (!tags.includes(released)) tags.push(released);
    }
  }
  return tags;
};

/**
 * The boundary an append is conditioned on: every inbox it touches, a name
 * if given, and any codes. Each `query.item` matches one tag, so the items
 * together match an event carrying any of them.
 */
const boundary = (
  inboxIds: ReadonlyArray<InboxId>,
  label: string | undefined,
  codes: ReadonlyArray<InboxCode> = [],
) => {
  const [only, ...more] = inboxIds;
  if (
    only !== undefined &&
    more.length === 0 &&
    label === undefined &&
    codes.length === 0
  )
    return query.tags([inboxTag(only)]);
  const [head, ...tail] = [
    ...inboxIds.map((id) => query.item({ tags: [inboxTag(id)] })),
    ...(label === undefined ? [] : [query.item({ tags: [labelTag(label)] })]),
    ...codes.map((code) => query.item({ tags: [codeTag(code)] })),
  ];
  // Every caller names at least one inbox.
  return head === undefined ? query.all() : query.or([head, ...tail]);
};

/** What a priority decision reads and is conditioned on: one inbox and the mark. */
const priorityBoundary = (inboxId: InboxId) =>
  query.or([
    query.item({ tags: [inboxTag(inboxId)] }),
    query.item({ tags: [priorityTag] }),
  ]);

/**
 * `InboxLog` over whatever `DcbEventStore`, `InboxBlobs` and `InboxReadModel`
 * are provided.
 */
export const makeInboxLog = Effect.gen(function* () {
  const store = yield* DcbEventStore;
  const blobs = yield* InboxBlobs;
  const readModel = yield* InboxReadModel;
  const collectSequenced = (
    q: ReturnType<typeof query.all>,
    after?: Position,
  ) =>
    Effect.gen(function* () {
      const response = yield* store.read(
        q,
        after === undefined ? undefined : { after },
      );
      const sequenced = yield* Stream.runCollect(response.events);
      return { sequenced, head: response.head };
    });
  const collect = (q: ReturnType<typeof query.all>, after?: Position) =>
    Effect.map(collectSequenced(q, after), ({ sequenced, head }): InboxRead => {
      const stamped = sequenced.map((s) => ({
        event: decodeEvent(textDecoder.decode(s.event.data)),
        stamp: stampOf(s.position, s.event.occurredAt),
      }));
      return { events: stamped.map((e) => e.event), stamped, head };
    });
  // The list's read model catches up from the log after its checkpoint.
  const readAfter = (after: Position) => collect(query.all(), after);
  return InboxLog.of({
    putBlob: blobs.put,
    readBlobs: blobs.get,
    read: (inboxId) => collect(query.tags([inboxTag(inboxId)])),
    readNamed: (inboxId, label, codes = []) =>
      Effect.map(
        collectSequenced(boundary([inboxId], label, codes)),
        ({ sequenced, head }): NamedRead => {
          const own = inboxTag(inboxId);
          const name = label === undefined ? undefined : labelTag(label);
          const coded = new Set(codes.map(codeTag));
          const inbox: Array<InboxEvent> = [];
          const named: Array<InboxEvent> = [];
          const codeEvents: Array<InboxEvent> = [];
          for (const s of sequenced) {
            const event = decodeEvent(textDecoder.decode(s.event.data));
            if (s.event.tags.includes(own)) inbox.push(event);
            if (name !== undefined && s.event.tags.includes(name))
              named.push(event);
            if (s.event.tags.some((t) => coded.has(t))) codeEvents.push(event);
          }
          return { inbox, label: named, codes: codeEvents, head };
        },
      ),
    findByCode: (code) =>
      Effect.map(collect(query.tags([codeTag(code)])), ({ events }) =>
        Option.fromNullishOr(
          codeHolders(code, events)[0] ?? formerCodeHolders(code, events)[0],
        ),
      ),
    readPriority: (inboxId) =>
      Effect.map(
        collectSequenced(priorityBoundary(inboxId)),
        ({ sequenced, head }): PriorityRead => {
          const own = inboxTag(inboxId);
          const inbox: Array<InboxEvent> = [];
          const priority: Array<InboxEvent> = [];
          for (const s of sequenced) {
            const event = decodeEvent(textDecoder.decode(s.event.data));
            if (s.event.tags.includes(own)) inbox.push(event);
            if (s.event.tags.includes(priorityTag)) priority.push(event);
          }
          return { inbox, priority, head };
        },
      ),
    readPair: (a, b) =>
      Effect.map(
        collectSequenced(boundary([a, b], undefined)),
        ({ sequenced, head }): PairRead => {
          const tagA = inboxTag(a);
          const tagB = inboxTag(b);
          const first: Array<InboxEvent> = [];
          const second: Array<InboxEvent> = [];
          for (const s of sequenced) {
            const event = decodeEvent(textDecoder.decode(s.event.data));
            if (s.event.tags.includes(tagA)) first.push(event);
            if (s.event.tags.includes(tagB)) second.push(event);
          }
          return { first, second, head };
        },
      ),
    findBySession: (sessionId) =>
      Effect.map(collect(query.tags([sessionTag(sessionId)])), ({ stamped }) =>
        Option.fromNullishOr(sessionInboxMode(sessionId, stamped).inboxId),
      ),
    readSession: (sessionId) => collect(query.tags([sessionTag(sessionId)])),
    listAll: () => listReadModel(readModel, readAfter),
    countQuestions: (since) =>
      Effect.andThen(
        catchUpReadModel(readModel, readAfter),
        readModel.counts(since),
      ),
    append: (events, guard) =>
      Effect.gen(function* () {
        const occurredAt = yield* DateTime.now;
        const encoded = yield* Effect.forEach(events, (event) =>
          Effect.map(randomUuid, (uuid) => ({
            type: EventType.make(event._tag),
            data: textEncoder.encode(encodeEvent(event)),
            tags: tagsFor(event),
            uuid,
            occurredAt,
            // The inbox records nothing in kairos-es's metadata bag; the
            // event's own payload carries everything it needs.
            metadata: {},
          })),
        );
        const [first, ...rest] = encoded;
        if (first === undefined) return;
        // The condition is the session's tag for a session decision;
        // otherwise the boundary of every inbox the events touch (one,
        // except for a move), and the name's when one is taken.
        const failIfEventsMatch =
          'session' in guard
            ? query.tags([sessionTag(guard.session)])
            : 'priority' in guard
              ? priorityBoundary(guard.priority)
              : boundary(
                  [...new Set(events.flatMap(inboxesOf))],
                  guard.label,
                  guard.codes,
                );
        yield* store.append([first, ...rest], {
          failIfEventsMatch,
          after: guard.after,
        });
      }),
  });
});

// --- deciding against the log ------------------------------------------------------

/**
 * Read one inbox, decide, and append under the condition that nothing landed
 * in that inbox since the read. On a conflict the WHOLE cycle runs once more
 * from a fresh read (kairos-es's `retryOnConflict`), so a double Send records
 * one answer and refuses the second, and two asks never share a number.
 *
 * `decide` returns the events to append (empty: nothing to do) or a refusal.
 */
export type InboxDecision<A> = (
  state: InboxState,
) => Result.Result<
  { readonly events: ReadonlyArray<InboxEvent>; readonly result: A },
  InboxRefusal
>;

export const decideAndAppend = <A>(
  inboxId: InboxId,
  decide: InboxDecision<A>,
) =>
  Effect.flatMap(InboxLog, (log) =>
    retryOnConflict(
      Effect.gen(function* () {
        const { events, head } = yield* log.read(inboxId);
        const decided = decide(inboxState(events));
        if (Result.isFailure(decided)) return Result.fail(decided.failure);
        const [first, ...rest] = decided.success.events;
        if (first !== undefined)
          yield* log.append([first, ...rest], { after: head });
        return Result.succeed(decided.success.result);
      }),
      Schedule.recurs(1),
    ),
  );

/**
 * The same cycle for a decision that takes a name — opening an inbox, or
 * renaming one. One read covers the inbox and the name's label tag, and the
 * full index is read too, from the list's read model, for inboxes named
 * before the label tags existed (core's `nameHolder`). The index only finds
 * the name's likely holder: the append is conditioned on the inbox AND the name,
 * so of two sessions racing for one name, the second's append fails, and its
 * re-read finds the first holding it and refuses with that inbox's id.
 *
 * With `codes` (an open, which assigns the new inbox its code), the same read
 * covers those codes' tags too, the decision is handed the first one no other
 * inbox holds (`free`, core's `firstFreeCode`), and the append is conditioned
 * on them as well, so a code taken meanwhile sends the cycle round again.
 */
export type NamedDecision<A> = (
  state: InboxState,
  holder: InboxId | undefined,
  free: InboxCode | undefined,
) => Result.Result<
  { readonly events: ReadonlyArray<InboxEvent>; readonly result: A },
  InboxRefusal
>;

export const decideNamedAndAppend = <A>(
  inboxId: InboxId,
  label: string,
  decide: NamedDecision<A>,
  codes: ReadonlyArray<InboxCode> = [],
) =>
  // An empty name has no label tag to read; the decision refuses it on the
  // inbox's own read.
  normaliseInboxLabel(label) === ''
    ? decideAndAppend(inboxId, (state) => decide(state, undefined, undefined))
    : decideNamedCycle(inboxId, label, decide, codes);

const decideNamedCycle = <A>(
  inboxId: InboxId,
  label: string,
  decide: NamedDecision<A>,
  codes: ReadonlyArray<InboxCode>,
) =>
  Effect.flatMap(InboxLog, (log) =>
    retryOnConflict(
      Effect.gen(function* () {
        const index = (yield* log.listAll())
          .filter((i) => i.state.opened)
          .map((i) => ({ inboxId: i.inboxId, label: i.state.label }));
        const read = yield* log.readNamed(inboxId, label, codes);
        const holder = nameHolder({
          label,
          self: inboxId,
          labelEvents: read.label,
          index,
        });
        const free = firstFreeCode({
          candidates: codes,
          self: inboxId,
          codeEvents: read.codes,
        });
        const decided = decide(inboxState(read.inbox), holder, free);
        if (Result.isFailure(decided)) return Result.fail(decided.failure);
        const [first, ...rest] = decided.success.events;
        if (first !== undefined)
          yield* log.append([first, ...rest], {
            after: read.head,
            label,
            ...(codes.length === 0 ? {} : { codes }),
          });
        return Result.succeed(decided.success.result);
      }),
      Schedule.recurs(1),
    ),
  );

/**
 * The cycle for giving an inbox a code: one read of the inbox and of the
 * candidate codes' tags, a decision handed the first code no other inbox
 * holds (`free`), and an append conditioned on the inbox and every
 * candidate, retried once on a conflict.
 */
export type CodeDecision<A> = (
  state: InboxState,
  free: InboxCode | undefined,
) => Result.Result<
  { readonly events: ReadonlyArray<InboxEvent>; readonly result: A },
  InboxRefusal
>;

export const decideCodedAndAppend = <A>(
  inboxId: InboxId,
  codes: ReadonlyArray<InboxCode>,
  decide: CodeDecision<A>,
) =>
  Effect.flatMap(InboxLog, (log) =>
    retryOnConflict(
      Effect.gen(function* () {
        const read = yield* log.readNamed(inboxId, undefined, codes);
        const free = firstFreeCode({
          candidates: codes,
          self: inboxId,
          codeEvents: read.codes,
        });
        const decided = decide(inboxState(read.inbox), free);
        if (Result.isFailure(decided)) return Result.fail(decided.failure);
        const [first, ...rest] = decided.success.events;
        if (first !== undefined)
          yield* log.append([first, ...rest], { after: read.head, codes });
        return Result.succeed(decided.success.result);
      }),
      Schedule.recurs(1),
    ),
  );

/**
 * The cycle for a move: one read of both inboxes, one decision over both
 * states, and an append conditioned on both, retried once on a conflict.
 */
export type MoveDecision<A> = (
  from: InboxState,
  to: InboxState,
) => Result.Result<
  { readonly events: ReadonlyArray<InboxEvent>; readonly result: A },
  InboxRefusal
>;

export const decideMoveAndAppend = <A>(
  from: InboxId,
  to: InboxId,
  decide: MoveDecision<A>,
) =>
  Effect.flatMap(InboxLog, (log) =>
    retryOnConflict(
      Effect.gen(function* () {
        const read = yield* log.readPair(from, to);
        const decided = decide(inboxState(read.first), inboxState(read.second));
        if (Result.isFailure(decided)) return Result.fail(decided.failure);
        const [first, ...rest] = decided.success.events;
        if (first !== undefined)
          yield* log.append([first, ...rest], { after: read.head });
        return Result.succeed(decided.success.result);
      }),
      Schedule.recurs(1),
    ),
  );

/**
 * The cycle for the priority mark: one read of the inbox and of the log's
 * priority tag, a decision handed the Inbox that holds the mark now (core's
 * `priorityHolderOf`), and an append conditioned on that read alone, retried
 * once on a conflict. So a mark replaces the one before it in one append, and
 * of two marks racing, the second's re-read finds the first and replaces it.
 */
export type PriorityDecision<A> = (
  state: InboxState,
  holder: InboxId | undefined,
) => Result.Result<
  { readonly events: ReadonlyArray<InboxEvent>; readonly result: A },
  InboxRefusal
>;

export const decidePriorityAndAppend = <A>(
  inboxId: InboxId,
  decide: PriorityDecision<A>,
) =>
  Effect.flatMap(InboxLog, (log) =>
    retryOnConflict(
      Effect.gen(function* () {
        const read = yield* log.readPriority(inboxId);
        const decided = decide(
          inboxState(read.inbox),
          priorityHolderOf(read.priority),
        );
        if (Result.isFailure(decided)) return Result.fail(decided.failure);
        const [first, ...rest] = decided.success.events;
        if (first !== undefined)
          yield* log.append([first, ...rest], {
            after: read.head,
            priority: inboxId,
          });
        return Result.succeed(decided.success.result);
      }),
      Schedule.recurs(1),
    ),
  );

export type SessionDecision<A> = (mode: SessionInboxMode) => {
  readonly events: ReadonlyArray<InboxEvent>;
  readonly result: A;
};

/**
 * The cycle for inbox mode: read the session's tag, fold the session's mode
 * from it, decide the events (none: nothing to do) and a result, and append
 * under the condition that nothing landed in that tag since the read, retried
 * once on a conflict. The condition is the query the decision read, so a
 * question or an answer landing in the session's Inbox meanwhile does not
 * conflict, and the session opening or adopting another Inbox, or switching
 * the mode from another process, does.
 */
export const decideSessionAndAppend = <A>(
  sessionId: SessionId,
  decide: SessionDecision<A>,
) =>
  Effect.flatMap(InboxLog, (log) =>
    retryOnConflict(
      Effect.gen(function* () {
        const read = yield* log.readSession(sessionId);
        const decided = decide(sessionInboxMode(sessionId, read.stamped));
        const [first, ...rest] = decided.events;
        if (first !== undefined)
          yield* log.append([first, ...rest], {
            after: read.head,
            session: sessionId,
          });
        return decided;
      }),
      Schedule.recurs(1),
    ),
  );

// --- the live store -------------------------------------------------------------------

/** A defect's reason, as one line, for a message that must stay one line. */
const defectReason = (defect: unknown): string =>
  defect instanceof Error
    ? firstLine(defect)
    : (String(defect).split('\n')[0] ?? 'unknown');

/**
 * The driver's reason, as one line. An `SqlError` carries it at the bottom of
 * its cause chain (`SqlError` → its structured reason → the driver's own
 * error), and only there: the reason's own message is the operation that
 * failed ("Failed to open database"), and kairos-es's open failure repeats the
 * file's path, which the caller's line already names. So the innermost
 * non-empty message wins.
 */
const firstLine = (e: {
  readonly message: string;
  readonly cause?: unknown;
}) => {
  const innermost = (cause: unknown, depth: number): string | undefined => {
    if (!(cause instanceof Error) || depth > 8) return undefined;
    const deeper = innermost(cause.cause, depth + 1);
    if (deeper !== undefined) return deeper;
    return cause.message.length > 0 ? cause.message : undefined;
  };
  const reason = innermost(e.cause, 0) ?? e.message;
  return reason.split('\n')[0] ?? reason;
};

/**
 * The contention retry for the two statements below: SQLite answers a busy
 * lock at once (kairos-es's `clientLayer` sets no busy wait), and the driver
 * classifies it as a `LockTimeoutError`. Short, jittered, bounded; nothing but
 * a busy lock is retried.
 */
const RETRY_BUSY = Schedule.max([
  Schedule.jittered(
    Schedule.min([
      Schedule.exponential('1 millis', 2),
      Schedule.spaced('100 millis'),
    ]),
  ),
  Schedule.recurs(10),
]).pipe(
  Schedule.while(
    ({ input }: { readonly input: SqlError.SqlError }) =>
      input.reason._tag === 'LockTimeoutError',
  ),
);

/** `PRAGMA table_info`'s rows, of which only the column name is read. */
const TableColumn = Schema.Struct({ name: Schema.String });
const decodeColumns = Schema.decodeUnknownSync(Schema.Array(TableColumn));

/** An identifier quoted for SQL text, any embedded `"` doubled. */
const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Bring an inbox file written before kairos-es 1.0.0-alpha.4 up to its
 * events table's current shape. That release added a `metadata` column, and
 * `ensureSchema` never alters an existing table, so on an older file the store
 * would die at its first statement (store-sqlite's README, "Upgrading from
 * 1.0.0-alpha.3"). This adds the column with the README's own statement, and
 * ONLY when the table exists and lacks it: a fresh file (no table yet, which
 * `ensureSchema` then creates with the column) and an already-migrated one are
 * both a read and nothing else. Two processes racing on one old file may both
 * see the column missing; the loser's `ALTER` fails, and a second read finding
 * the column there is success.
 * Exported for its tests only, which run it over a recording client.
 */
export const addMetadataColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table = quoteIdentifier(STORE_CONFIG.tablePrefix);
  const columns = sql.unsafe(`PRAGMA table_info(${table})`).pipe(
    Effect.retry(RETRY_BUSY),
    Effect.map((rows) => decodeColumns(rows).map((c) => c.name)),
  );
  const before = yield* columns;
  if (before.length === 0 || before.includes('metadata')) return;
  yield* sql
    .unsafe(
      `ALTER TABLE ${table} ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`,
    )
    .pipe(
      Effect.retry(RETRY_BUSY),
      Effect.catch((e) =>
        Effect.flatMap(columns, (after) =>
          after.includes('metadata') ? Effect.void : Effect.fail(e),
        ),
      ),
    );
});

/**
 * The live log against one file: `@kairos-es/store-sqlite` over its own
 * `clientLayer`, which opens the file and puts it in WAL with the engine's
 * contention retry — the multi-process guarantee depends on that, so this is
 * the one place the client is built (`install` builds this layer too).
 * The folder is made first; then, once per acquisition, an older file gains
 * the `metadata` column (`addMetadataColumn`) and `ensureSchema` runs (both
 * idempotent). A file that cannot be opened fails with one line naming it and
 * the driver's own reason.
 */
export const connectInboxLog = (
  resolved: ResolvedInboxDatabase,
): Layer.Layer<InboxLog, InputError, FileSystem.FileSystem> => {
  // The store is imported HERE, when a log is first opened, not at module
  // load: its driver is `node:sqlite`, which prints an ExperimentalWarning on
  // stderr when it loads, and every other command must start without it.
  const opened = Layer.unwrap(
    Effect.map(
      Effect.promise(() => import('@kairos-es/store-sqlite')),
      ({ clientLayer, ensureSchema, SqliteClient, layer: storeLayer }) => {
        const migrated = Layer.effectDiscard(
          Effect.andThen(addMetadataColumn, ensureSchema(STORE_CONFIG)).pipe(
            Effect.andThen(ensureBlobTable),
            Effect.andThen(ensureReadModelTables),
            Effect.provideServiceEffect(SqlClient.SqlClient, SqliteClient),
          ),
        );
        // The blob table on the store's own client, so a blob and the event
        // that names it are written through one connection to one file.
        const blobs = Layer.effect(
          InboxBlobs,
          makeInboxBlobsSql.pipe(
            Effect.provideServiceEffect(SqlClient.SqlClient, SqliteClient),
          ),
        );
        // The list's read model on the same client, so its rows sit in the
        // same file as the events they are folded from.
        const readModel = Layer.effect(
          InboxReadModel,
          makeInboxReadModelSql.pipe(
            Effect.provideServiceEffect(SqlClient.SqlClient, SqliteClient),
          ),
        );
        return Layer.effect(InboxLog, makeInboxLog).pipe(
          Layer.provide(storeLayer(STORE_CONFIG)),
          Layer.provide(blobs),
          Layer.provide(readModel),
          Layer.provide(migrated),
          Layer.provide(clientLayer({ filename: resolved.path })),
        );
      },
    ),
  );
  const store = Layer.catch(opened, (e) =>
    Layer.effect(
      InboxLog,
      Effect.fail(
        new InputError({
          message: `inbox could not open its event log at ${describeInboxDatabase(resolved)}: ${firstLine(e)}`,
        }),
      ),
    ),
  );
  return Layer.unwrap(Effect.as(ensureInboxFolder(resolved), store));
};

/** The live log: the path resolved (env → config.json → default), then opened. */
export const inboxLogLive: Layer.Layer<
  InboxLog,
  InputError,
  FileSystem.FileSystem
> = Layer.unwrap(Effect.map(resolveInboxDatabaseEdge, connectInboxLog));

/**
 * The in-memory log, for tests: kairos-es's own in-memory store, and blobs
 * and the list's read model in memory.
 */
export const InboxLogInMemory: Layer.Layer<InboxLog> = Layer.effect(
  InboxLog,
  makeInboxLog,
).pipe(
  Layer.provide(DcbEventStoreInMemory),
  Layer.provide(InboxBlobsInMemory),
  Layer.provide(InboxReadModelInMemory),
);

// --- lazy acquisition --------------------------------------------------------------

/**
 * `InboxLog` built on first use from `live`, so neither the CLI's other
 * commands nor `operator-inbox serve` need the store to start. A SUCCESSFUL
 * acquisition is kept until a call on it fails (below); a FAILED one is not, so the
 * next call tries again — `serve` keeps answering `InboxUnavailable` while
 * the file cannot be opened and recovers once it can, with no restart.
 *
 * Every call is bounded — between statements: `node:sqlite` runs a statement
 * synchronously, so a timeout fires only once a slow one returns. A defect
 * from the store (a statement the driver could not run on a store that had
 * opened) becomes a one-line `InputError` carrying its reason, and THAT store
 * is closed and dropped, so the next call opens the file afresh — resolving
 * the path again. A caller sees "unavailable", never a stack. This layer does
 * not know the file; its own lines point at `operator-inbox install`, which
 * prints it.
 */
export const makeInboxLogLazy = <R>(
  live: Layer.Layer<InboxLog, InputError, R>,
) =>
  Layer.effect(
    InboxLog,
    Effect.gen(function* () {
      const parent = yield* Effect.scope;
      // What `live` needs (config.json, the disk) is captured once, here, so a
      // call through the service has no requirements of its own.
      const env = yield* Effect.context<R>();
      // The acquired log and the scope it was built in, so a store that fails
      // after it opened can be closed and dropped (see `forget` below).
      type Acquired = {
        readonly log: InboxLog['Service'];
        readonly scope: Scope.Closeable;
      };
      const cached = yield* Ref.make(Option.none<Acquired>());
      const lock = yield* Semaphore.make(1);
      const acquire = lock.withPermits(1)(
        Effect.gen(function* () {
          const have = yield* Ref.get(cached);
          if (Option.isSome(have)) return have.value;
          // Each attempt builds into its own child scope, closed on failure,
          // so a client left open by a failed attempt is closed.
          const child = yield* Scope.fork(parent, 'sequential');
          const built = yield* Layer.buildWithScope(live, child).pipe(
            Effect.map((ctx) => Context.get(ctx, InboxLog)),
            Effect.provide(env),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void,
            ),
          );
          const acquired: Acquired = { log: built, scope: child };
          yield* Ref.set(cached, Option.some(acquired));
          return acquired;
        }),
      );
      // A store that fails AFTER it opened (a defect from the driver, such as
      // a write to a file deleted or replaced under it, or a full or read-only
      // disk) is closed and dropped, so the next call opens the file afresh.
      // Only the store THAT call used: a call still running on an old store
      // that fails late must not close the new one another call has opened.
      const forget = (failed: Acquired) =>
        lock.withPermits(1)(
          Effect.flatMap(Ref.get(cached), (have) =>
            Option.isSome(have) && have.value === failed
              ? Effect.andThen(
                  Ref.set(cached, Option.none()),
                  Scope.close(failed.scope, Exit.void),
                )
              : Effect.void,
          ),
        );
      // Two bounds: acquisition (resolve, make the folder, open the file,
      // ensure the schema) and each call against an acquired store.
      const bounded = <A, E>(
        use: (log: InboxLog['Service']) => Effect.Effect<A, E | InputError>,
      ) =>
        Effect.flatMap(
          acquire.pipe(
            Effect.timeoutOrElse({
              duration: Duration.seconds(30),
              orElse: () =>
                Effect.fail(
                  new InputError({
                    message:
                      'inbox: the store did not open within 30 seconds — `operator-inbox install` names the file and opens it',
                  }),
                ),
            }),
          ),
          (acquired) =>
            use(acquired.log).pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(20),
                orElse: () =>
                  Effect.fail(
                    new InputError({
                      message:
                        'inbox: the store did not answer within 20 seconds — `operator-inbox install` names the file and opens it',
                    }),
                  ),
              }),
              Effect.catchDefect((defect) =>
                Effect.andThen(
                  forget(acquired),
                  Effect.fail(
                    new InputError({
                      message: `inbox: the store failed (${defectReason(defect)}) — it is reopened on the next call; \`operator-inbox install\` names the file`,
                    }),
                  ),
                ),
              ),
            ),
        ).pipe(
          // A defect while opening is not a store to drop: the attempt's own
          // scope is already closed.
          Effect.catchDefect((defect) =>
            Effect.fail(
              new InputError({
                message: `inbox: the store failed to open (${defectReason(defect)}) — \`operator-inbox install\` names the file and opens it`,
              }),
            ),
          ),
        );
      return InboxLog.of({
        read: (inboxId) => bounded((log) => log.read(inboxId)),
        readNamed: (inboxId, label, codes) =>
          bounded((log) => log.readNamed(inboxId, label, codes)),
        findByCode: (code) => bounded((log) => log.findByCode(code)),
        readPriority: (inboxId) => bounded((log) => log.readPriority(inboxId)),
        readPair: (a, b) => bounded((log) => log.readPair(a, b)),
        findBySession: (sessionId) =>
          bounded((log) => log.findBySession(sessionId)),
        readSession: (sessionId) =>
          bounded((log) => log.readSession(sessionId)),
        listAll: () => bounded((log) => log.listAll()),
        countQuestions: (since) => bounded((log) => log.countQuestions(since)),
        append: (events, guard) => bounded((log) => log.append(events, guard)),
        putBlob: (blob) => bounded((log) => log.putBlob(blob)),
        readBlobs: (shas) => bounded((log) => log.readBlobs(shas)),
      });
    }),
  );

export const InboxLogLazy = makeInboxLogLazy(inboxLogLive);
