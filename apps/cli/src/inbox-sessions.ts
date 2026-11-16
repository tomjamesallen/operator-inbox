import path from 'node:path';
import {
  emptyScratch,
  InboxSessionScratch,
  type SessionId,
  scratchFileName,
} from '@operator-inbox/core';
import { Effect, FileSystem, Option, Schema } from 'effect';
import { InputError } from './errors';
import { resolveInboxDatabaseEdge } from './inbox-database';

// Inbox mode's sidecar: one small file per session,
// `inbox-sessions/<sessionId>.json { pausedPromptId?, lastSeenSeq? }`, beside
// the event log and its `inbox-watchers/` folder. It is current-state, on
// purpose: turn-scratch, rewritten on nearly every prompt, the same kind
// as the watcher records, and an append per prompt in every session is what
// keeping it in the log would cost.
//
// It never says whether the mode is on: that is the events', read from the
// log on every hook (`inbox-mode-hooks.ts`). `operator-inbox mode on` writes
// it fresh and turning the mode off removes it, but a sidecar that is there
// with the mode off, or missing with it on, means nothing more than an empty
// one.
//
// A missing or unreadable file reads as empty. A write or a removal that fails
// fails with one line naming the file: the hooks ignore it, since a hook must
// never trap a session, and `operator-inbox mode on|off` reports it.

const ScratchJson = Schema.fromJsonString(InboxSessionScratch);

/** A failed write or removal, as one line naming the file. */
const failed =
  (file: string) =>
  (e: { readonly message: string }): InputError =>
    new InputError({
      message: `inbox mode: could not update the session's sidecar ${file}: ${e.message}`,
    });

/** The folder the sidecars live in, beside the event log. */
const sessionsFolder = Effect.map(resolveInboxDatabaseEdge, (resolved) =>
  path.join(path.dirname(resolved.path), 'inbox-sessions'),
);

/** The sidecar's path, or none for an id that cannot be a file name. */
const scratchPath = (sessionId: SessionId) =>
  Effect.map(sessionsFolder, (folder) =>
    Option.map(Option.fromNullishOr(scratchFileName(sessionId)), (name) =>
      path.join(folder, name),
    ),
  );

/** The session's sidecar: empty when it is missing or does not decode. */
export const readScratch = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* scratchPath(sessionId);
    if (Option.isNone(file)) return emptyScratch;
    return yield* fs
      .readFileString(file.value)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ScratchJson)));
  }).pipe(Effect.orElseSucceed(() => emptyScratch));

/**
 * Write the session's sidecar whole. Written beside itself and renamed into
 * place, so a hook reading it at the same moment sees the old file or the
 * new one, never half of one.
 */
export const writeScratch = (
  sessionId: SessionId,
  scratch: InboxSessionScratch,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* scratchPath(sessionId);
    if (Option.isNone(file)) return;
    const pid = yield* Effect.sync(() => process.pid);
    const temporary = `${file.value}.${pid}.tmp`;
    yield* fs
      .makeDirectory(path.dirname(file.value), { recursive: true })
      .pipe(Effect.mapError(failed(file.value)));
    yield* fs
      .writeFileString(temporary, Schema.encodeSync(ScratchJson)(scratch))
      .pipe(Effect.mapError(failed(file.value)));
    yield* fs
      .rename(temporary, file.value)
      .pipe(Effect.mapError(failed(file.value)));
  });

/** Read, change and write the sidecar. */
export const updateScratch = (
  sessionId: SessionId,
  change: (scratch: InboxSessionScratch) => InboxSessionScratch,
) =>
  Effect.flatMap(readScratch(sessionId), (scratch) =>
    writeScratch(sessionId, change(scratch)),
  );

/** Remove the sidecar, when the mode is turned off. */
export const removeScratch = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* scratchPath(sessionId);
    if (Option.isNone(file)) return;
    yield* fs
      .remove(file.value, { force: true })
      .pipe(Effect.mapError(failed(file.value)));
  });
