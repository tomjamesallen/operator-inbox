import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

// The inbox screen's keybindings file (`keybindings`), as serve read it: where it
// is looked for, and its text, `null` when there is no file. Serve does the IO
// and nothing else; the browser parses it with `@operator-inbox/core/keymap`, so a
// line that does not parse is the help's to report, never a failed request.
export const KeybindingsFileDto = Schema.Struct({
  path: Schema.String,
  text: Schema.NullOr(Schema.String),
});
export type KeybindingsFileDto = typeof KeybindingsFileDto.Type;

// The file is there and could not be read (a directory, no permission).
export class KeybindingsUnreadable extends Schema.Error<KeybindingsUnreadable>(
  'KeybindingsUnreadable',
)(
  { message: Schema.String, _tag: Schema.tag('KeybindingsUnreadable') },
  { httpApiStatus: 500 },
) {}

export class KeybindingsApiGroup extends HttpApiGroup.make('keybindings').add(
  HttpApiEndpoint.get('read', '/keybindings', {
    success: KeybindingsFileDto,
    error: [KeybindingsUnreadable],
  }),
) {}
