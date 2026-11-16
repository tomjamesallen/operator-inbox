# Golden encodings for `@operator-inbox/web`

Each file here is the exact bytes the web app persists for a fixed value, so a build can prove it writes and reads the same bytes as the browsers that already store them. `test/encoded-forms-v3.test.ts` asserts against them.

A golden edited to make a build pass is a defect, not a fix. If the build writes different bytes, that is a change to what an existing browser has stored, and it is a decision to raise, not a file to regenerate.

| File | What it is |
| :-- | :-- |
| `inbox-rail-width.txt` | the `localStorage` value under `operator-inbox:inbox-rail-width` after the inbox sidebar is set to 176px (`inboxRailWidthAtom`, `Atom.kvs` over `Schema.NullOr(Schema.Number)`) |
| `inbox-rail-width-null.txt` | the same key's value for `null`, the design's own width; also what is written when the key is absent on first read |

The files carry no trailing newline: `Atom.kvs` writes none.
