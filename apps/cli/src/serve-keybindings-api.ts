import { keybindingsPath, loadXdgConfigHome } from '@operator-inbox/core';
import {
  KeybindingsUnreadable,
  type OperatorInboxApi,
} from '@operator-inbox/core/api';
import { Effect, FileSystem } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';

// `GET /api/keybindings`: the keybindings file's text, read fresh on every
// request, so an edit takes effect on the page's next load with no restart of
// serve. No file is an answer (`text: null`, the defaults), not a
// failure; a file that is there and cannot be read is one.
export const readKeybindingsFile = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const p = keybindingsPath(
    yield* loadXdgConfigHome.pipe(
      Effect.mapError(
        (e) => new KeybindingsUnreadable({ message: `${e.message}.` }),
      ),
    ),
  );
  const unreadable = (cause: unknown) =>
    Effect.logError(`keybindings: could not read ${p}`, cause).pipe(
      Effect.andThen(
        Effect.fail(
          new KeybindingsUnreadable({
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

export const makeKeybindingsApiLive = (api: typeof OperatorInboxApi) =>
  HttpApiBuilder.group(api, 'keybindings', (handlers) =>
    handlers.handle('read', () => readKeybindingsFile()),
  );
