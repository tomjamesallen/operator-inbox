import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

// The operator's macros file (`macros.json`), as serve read it: where it is
// looked for, and its text, `null` when there is no file. Serve does the IO and
// nothing else; the page decodes it with core's `decodeMacrosFile`, so a file
// that does not parse is the page's to report, as a bad keybindings file is,
// never a failed request.
export const MacrosFileDto = Schema.Struct({
  path: Schema.String,
  text: Schema.NullOr(Schema.String),
});
export type MacrosFileDto = typeof MacrosFileDto.Type;

// The file is there and could not be read (a directory, no permission).
export class MacrosUnreadable extends Schema.Error<MacrosUnreadable>(
  'MacrosUnreadable',
)(
  { message: Schema.String, _tag: Schema.tag('MacrosUnreadable') },
  { httpApiStatus: 500 },
) {}

export class MacrosApiGroup extends HttpApiGroup.make('macros').add(
  HttpApiEndpoint.get('read', '/macros', {
    success: MacrosFileDto,
    error: [MacrosUnreadable],
  }),
) {}
