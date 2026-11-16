import { loadXdgConfigHome, macrosPath } from '@operator-inbox/core';
import {
  MacrosUnreadable,
  type OperatorInboxApi,
} from '@operator-inbox/core/api';
import { Effect, FileSystem } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

// `GET /api/macros`: the macros file's text, read fresh on every request, so an
// edit takes effect on the page's next refresh with no restart of serve. No
// file is an answer (`text: null`, no macros), not a failure; a file that is
// there and cannot be read is one. The page decodes the text itself.
export const readMacrosFile = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const p = macrosPath(
    yield* loadXdgConfigHome.pipe(
      Effect.mapError(
        (e) => new MacrosUnreadable({ message: `${e.message}.` }),
      ),
    ),
  );
  const unreadable = (cause: unknown) =>
    Effect.logError(`macros: could not read ${p}`, cause).pipe(
      Effect.andThen(
        Effect.fail(
          new MacrosUnreadable({
            message: `Could not read ${p}; the server's log has the detail.`,
          }),
        ),
      ),
    );
  const exists = yield* fs.exists(p).pipe(Effect.catch(unreadable));
  if (!exists) return { path: p, text: null };
  const text = yield* fs.readFileString(p).pipe(Effect.catch(unreadable));
  return { path: p, text };
});

export const makeMacrosApiLive = (api: typeof OperatorInboxApi) =>
  HttpApiBuilder.group(api, 'macros', (handlers) =>
    handlers.handle('read', () => readMacrosFile()),
  );
