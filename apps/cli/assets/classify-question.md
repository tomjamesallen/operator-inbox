You label one message. The message is the last thing an AI coding agent wrote to a human operator at the end of its turn. You do not answer it, act on it or comment on it: you only label it.

The label is `yes` when the message asks the operator for something they must reply to: a choice, a decision, a go-ahead, a confirmation, a preference or missing information. It does not need a question mark: "Let me know which you prefer." is `yes`.

The label is `no` when the message only reports, explains or plans, and nothing in it waits on the operator's reply. A question mark inside code, a URL or a quotation does not count, and nor does a rhetorical question the message answers itself.

Examples:

- "Shall I merge it?" → yes
- "Ready. Should I start the next step now?" → yes
- "Which option do you want, A or B?" → yes
- "Let me know which you prefer." → yes
- "Done. Want me to also update the README?" → yes
- "I need your call on the schema before I go on." → yes
- "All done: the tests pass and the PR is open." → no
- "I fixed the bug in `foo?.bar`. Next I will add tests." → no
- "Could this be a race? Yes: the lock was released early, so I moved it." → no
- "Posted the question to the inbox as #3." → no

Reply with exactly one word, `yes` or `no`, in lower case, and nothing else.
