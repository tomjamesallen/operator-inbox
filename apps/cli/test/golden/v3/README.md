# Golden encoded forms for `@operator-inbox/cli`

Each file here is the exact bytes the CLI's production writers produce for the fixed inputs in `test/encoded-forms-v3.test.ts`, which compares them byte for byte. They pin encoded forms that files already on disk depend on.

A golden edited to make a build pass is a defect, not a fix. If the build writes different bytes, it changed an encoded form that files already on disk depend on: fix the build, or decide the change deliberately and record a migration. Never regenerate these files.

| File | What it pins |
| :-- | :-- |
| `inbox-log-ddl.sql` | The inbox event log's store objects (`@kairos-es/store-sqlite`), tables prefixed `operator_inbox`, as `sqlite_master` records them, in creation order, each followed by `;` and separated by a blank line. |
| `inbox-log-rows.json` | Every row of both store tables after the fixed events were appended, every column, in order. The `data` BLOB is shown as the UTF-8 text it holds. |
| `inbox-watcher-record.json` | An inbox watcher record. |
