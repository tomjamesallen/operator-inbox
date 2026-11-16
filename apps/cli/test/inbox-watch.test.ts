import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { InboxId, SessionId } from '@operator-inbox/core';
import { ConfigProvider, Effect, Option } from 'effect';
import { dispatchAsk, dispatchOpen } from '../src/commands/inbox';
import { envProvider } from '../src/env-config';
import { dispatchStopGuard } from '../src/inbox-mode-hooks';
import { type InboxLog, InboxLogInMemory } from '../src/inbox-store';
import { watcherAlive } from '../src/inbox-watch';
import { readOwnerFingerprint } from '../src/process-edge';
import {
  makeTestQuestionClassifier,
  type QuestionClassifier,
} from '../src/question-classifier';

// The guard and the watcher record against the in-memory log and a temporary
// folder for the records. The records are real files,
// and the liveness check runs the real `ps`, so a record of THIS test process
// is a live watcher and a record with a wrong fingerprint is a stale one. The
// guard is the Stop hook with inbox mode off, whose session comes from the
// process walk when stdin has none; the inbox's file is there (empty, the log
// is in memory), since the hook reads nothing on a machine without one.

const ID = InboxId.make('01INBOXGUARD00000000000000');

const SESSION = SessionId.make('s');

const run = <A, E>(
  effect: Effect.Effect<A, E, never>,
  folder: string,
): Effect.Effect<A, E, never> =>
  Effect.andThen(
    Effect.sync(() => writeFileSync(join(folder, 'inbox.sqlite'), '')),
    effect,
  ).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      envProvider({
        OPERATOR_INBOX_DATABASE_PATH: join(folder, 'inbox.sqlite'),
        XDG_CONFIG_HOME: folder,
      }),
    ),
  );

const scenario = <A, E>(
  folder: string,
  body: Effect.Effect<
    A,
    E,
    InboxLog | QuestionClassifier | NodeServices.NodeServices
  >,
) =>
  run(
    Effect.gen(function* () {
      yield* dispatchOpen({
        session: Option.some({ sessionId: SESSION, cwd: '/w' }),
        inbox: Option.none(),
        label: Option.some('demo'),
        freshId: ID,
        cwd: '/w',
      });
      yield* dispatchAsk({ inboxId: ID, title: 'Q?', body: '' });
      return yield* body;
    }).pipe(
      Effect.provide(InboxLogInMemory),
      // With the mode off the classifier is never asked.
      Effect.provide(
        makeTestQuestionClassifier(() => Effect.die(new Error('asked'))),
      ),
      Effect.provide(NodeServices.layer),
    ),
    folder,
  );

const guard = (stdin = '{}', session = SESSION) =>
  dispatchStopGuard({
    stdin,
    fallbackSession: Effect.succeed(Option.some(session)),
  });

const recordSelf = (folder: string, fingerprint?: string) =>
  Effect.gen(function* () {
    const reading = yield* readOwnerFingerprint(process.pid);
    if (reading.kind !== 'alive') throw new Error('cannot read own process');
    const dir = join(folder, 'inbox-watchers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${ID}.${process.pid}.json`),
      JSON.stringify({
        inboxId: ID,
        pid: process.pid,
        fingerprint: fingerprint ?? reading.fingerprint,
      }),
    );
    return dir;
  });

describe('inbox guard', () => {
  it.effect('blocks while a question waits and no watcher runs', () => {
    const folder = mkdtempSync(join(tmpdir(), 'inbox-guard-'));
    return scenario(
      folder,
      Effect.gen(function* () {
        const out = JSON.parse(yield* guard());
        expect(out.decision).toBe('block');
        expect(out.reason).toContain('operator-inbox watch --owner-pid');
        // Already continuing because of a stop hook: never twice in a row.
        expect(yield* guard('{"stop_hook_active":true}')).toBe('');
      }),
    );
  });

  it.effect('lets the turn end while a live watcher is recorded', () => {
    const folder = mkdtempSync(join(tmpdir(), 'inbox-guard-'));
    return scenario(
      folder,
      Effect.gen(function* () {
        yield* recordSelf(folder);
        expect(yield* watcherAlive(ID)).toBe(true);
        expect(yield* guard()).toBe('');
      }),
    );
  });

  it.effect(
    'removes a stale record, whose fingerprint no longer matches',
    () => {
      const folder = mkdtempSync(join(tmpdir(), 'inbox-guard-'));
      return scenario(
        folder,
        Effect.gen(function* () {
          const dir = yield* recordSelf(
            folder,
            'node Mon Jan  1 00:00:00 2001',
          );
          expect(yield* watcherAlive(ID)).toBe(false);
          expect(readdirSync(dir)).toEqual([]);
          expect(JSON.parse(yield* guard()).decision).toBe('block');
        }),
      );
    },
  );

  it.effect('says nothing without an inbox', () => {
    const folder = mkdtempSync(join(tmpdir(), 'inbox-guard-'));
    return scenario(
      folder,
      Effect.map(guard('{}', SessionId.make('no-inbox')), (out) =>
        expect(out).toBe(''),
      ),
    );
  });
});
