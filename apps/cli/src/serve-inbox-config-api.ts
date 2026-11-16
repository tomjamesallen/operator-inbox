import { loadConfig, loadMetadataRules } from '@operator-inbox/core';
import {
  InboxConfigUnreadable,
  type OperatorInboxApi,
} from '@operator-inbox/core/api';
import { Effect, Result } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

// `GET /api/inbox-config`: the Inbox settings the page needs, read fresh on
// every request so an edit shows on the page's next load with no restart of
// serve: the metadata rules from `metadata.json`, as the file holds them, or
// the default when there is no file, and config.json's `chaseAfterMinutes`,
// `diagramSize`, `priorityPull` and `wideBlocks`.
// A metadata.json that is there and cannot be read, or whose rules are not
// usable, is a failure carrying the sentence the CLI prints for it. A
// config.json that does not load costs only the chase, diagram, priority and
// wide-block settings, so the page keeps their defaults: serve's start-up line already
// names that file's problem.
export const readInboxConfig = Effect.fnUntraced(function* () {
  const loaded = yield* loadMetadataRules().pipe(
    Effect.catch((e) =>
      Effect.fail(
        new InboxConfigUnreadable({
          message:
            e.message !== ''
              ? e.message
              : 'metadata.json could not be read; the server’s log has the detail.',
        }),
      ),
    ),
  );
  if (Result.isFailure(loaded.rules))
    return yield* new InboxConfigUnreadable({ message: loaded.rules.failure });
  const { chaseAfterMinutes, diagramSize, priorityPull, wideBlocks } =
    yield* loadConfig().pipe(
      Effect.map(({ config }) => config),
      Effect.orElseSucceed(() => ({
        chaseAfterMinutes: undefined,
        diagramSize: undefined,
        priorityPull: undefined,
        wideBlocks: undefined,
      })),
    );
  return {
    metadata: loaded.rules.success,
    ...(chaseAfterMinutes === undefined ? {} : { chaseAfterMinutes }),
    ...(diagramSize === undefined ? {} : { diagramSize }),
    ...(priorityPull === undefined ? {} : { priorityPull }),
    ...(wideBlocks === undefined ? {} : { wideBlocks }),
  };
});

export const makeInboxConfigApiLive = (api: typeof OperatorInboxApi) =>
  HttpApiBuilder.group(api, 'inboxConfig', (handlers) =>
    handlers.handle('read', () => readInboxConfig()),
  );
