# Golden encodings for `@operator-inbox/core`

Each file here is the exact bytes the core writes for the fixed, literal input beside it in `test/encoded-forms-v3.test.ts`. That test encodes the inputs and compares byte for byte and, where a form is read back, decodes the file and compares the value, so a change to an on-disk or on-the-wire form fails a test even when the type-check is clean.

**A golden edited to make a build pass is a defect, not a fix.** If the build writes different bytes, the build is what changed. Either fix the build, or make the change on purpose, as a deliberate change to an on-disk or on-the-wire form.

What is here:

- `inbox-events.jsonl`: every `InboxEvent` variant as the inbox log stores it, one encoded event per line.
- `inbox-code-events.jsonl`: `InboxCodeAssigned`, which came after `inbox-events.jsonl` was pinned and so has its own file.
- `inbox-code-change-events.jsonl`: `InboxCodeChanged`, and an `InboxCodeAssigned` in the current three-letter form, which came after `inbox-code-events.jsonl` was pinned and so have their own file.
- `inbox-highlight-reply-events.jsonl`: `highlightReply` on a `QuestionAnswered`, an operator's `QuestionAsked` and a `QuestionMoved`'s question, which came after the event goldens above were pinned and so have their own file.
- `inbox-drawing-events.jsonl`: `drawings` on a `QuestionAsked`, a `QuestionEdited` and a `QuestionAnswered`, and a `QuestionMoved`'s question carrying its drawings and the ones sent with its answer, which came after the event goldens above were pinned and so have their own file.
- `inbox-drawing-ref-events.jsonl`: `drawingRefs` on a `QuestionAsked`, a `QuestionEdited` (only the drawing it set) and a `QuestionAnswered`, each a scene's hash and size (the scene is a row of the blob table, never on the event), and a `QuestionMoved`'s question carrying a drawing logged as text beside one logged as a blob (`drawingRefs`, `sentDrawingRefs`), which came after `inbox-drawing-events.jsonl` was pinned and so have their own file. `inbox-drawing-events.jsonl` still reads as it did.
- `inbox-attachment-events.jsonl`: `attachments` on a `QuestionAnswered` that is files alone, on an operator's `QuestionAsked` and on a `QuestionMoved`'s question, each a file's path on disk, name, media type and size (the file is on disk, never on an event), which came after the event goldens above were pinned and so have their own file.
- `inbox-agent-attachment-events.jsonl`: the agent's own files, as `attachments` on its `QuestionAsked` and on a `QuestionEdited` (the whole new set), and as `askedAttachments` on a `QuestionMoved`'s question, which came after `inbox-attachment-events.jsonl` was pinned and so have their own file.
- `inbox-html-events.jsonl`: `htmls` on a `QuestionAsked` and a `QuestionEdited`, and a `QuestionMoved`'s question carrying its HTML blocks, each a document's hash and size (the document is a row of the blob table, never on an event), which came after the event goldens above were pinned and so have their own file.
- `inbox-macro-events.jsonl`: `macros` on a `QuestionAnswered`, on a deferral with no note, and on a `QuestionMoved`'s question, which came after the event goldens above were pinned and so have their own file.
- `inbox-group-archive-events.jsonl`: `GroupArchived` and `GroupUnarchived`, which came after the event goldens above were pinned and so have their own file.
- `inbox-priority-events.jsonl`: `InboxPriorityMarked` and `InboxPriorityCleared`, as a mark, its replacement (the holder's clearing first) and a clearing, which came after the event goldens above were pinned and so have their own file.
- `dto-inbox-board.json`, `dto-inbox-index.json`: the inbox API's two read DTOs.
- `dto-inbox-board-coded.json`: the board read with an Inbox's `code` on its row and its view, pinned apart for the same reason.
- `dto-inbox-board-archived-groups.json`: the board read with a view's `archivedGroups`, pinned apart for the same reason.
- `dto-inbox-board-priority.json`: the board read with an Inbox's `priority` on its row, pinned apart for the same reason.
- `dto-payload-*.json`: the inbox API's write payloads (answer, pin, archive, a group's archive, rename, priority), the answer and ask payloads with `highlightReply`, the answer payload with `drawings`, and the answer payload with `macros` and no text.
- `http-error-bodies.json`: the body of every error the inbox API sends. The messages of `InboxConfigUnreadable`, `KeybindingsUnreadable` and `MacrosUnreadable` name the app's own config paths.
- `http-status.json`: the status of every error the inbox API sends, and every endpoint's method, path, successes and errors.

biome must never format this directory (the root `biome.json` excludes `**/test/golden`): a formatted golden is no longer the bytes the core writes.
