# Glossary

The words this codebase uses for its domain. Use them as defined here, in code, docs and the UI.

**Operator**: the person the agent sessions work for, who answers their Questions in the app.

**Inbox**: a session's shared queue of **Questions** for the operator, held in a machine-local event log on one SQLite file (by default `~/.local/state/operator-inbox/inbox.sqlite`). A session opens one with `operator-inbox open`, or adopts one another session handed over; the operator answers it in the app at `/inbox/<id>`. It has a readable name, unique across its machine's Inboxes, which the agent or the operator can change. Either can archive an Inbox when its work is finished: it moves to a collapsed Archived section and keeps its name and Questions, and a new Question asked into it brings it back. An Inbox and each of its Questions carry a metadata dictionary the agent sets and the operator sees. An Inbox carries a conversation, not knowledge. _Avoid_: thread, channel.

**Question**: one item in an **Inbox**: asked by the agent with enough context to answer cold, answered by the operator, then processed by the agent. Numbered `#1`, `#2`… per Inbox, never reused. There is no "processing" state: the agent acts on the answer, then marks the Question done. The agent may instead withdraw a Question the operator has not answered yet, with a reason. The agent can **highlight** a Question waiting for the operator, with a short note, and can **move** a Question to another Inbox, where it takes the next number. The operator can ask the agent a Question from the app, and can **defer** a Question to the agent instead of answering it. A follow-up is a new Question.

**Question code**: a Question's handle across every Inbox, such as `toe#12`: its Inbox's **Inbox code**, `#`, and its number. The app shows it on each card, where clicking it copies the Question, and the CLI prints it and takes it wherever it takes a question number. _Avoid_: question id.

**Inbox code**: the `toe` part: three random lower-case letters, unique across the machine's Inboxes and checked when it is assigned. Assigned once, by `InboxCodeAssigned`; a rename never changes it. An Inbox opened before codes gets one when `serve` starts. Codes once carried two letters of the Inbox's name in front (`op-toe`): `serve` moves such an Inbox to its three letters by `InboxCodeChanged` when it starts (a fresh three when an older Inbox already holds them), and the older form is still taken wherever a code is, so an older transcript still finds its Question.

**Queue**: one of the three lists the inbox page shows as tabs: **Your inbox** (waiting on the operator, oldest first), **With the agent** and **Processed** (both most recent first). An Inbox holds Questions in all three, so "inbox" never names a queue. _Avoid_: column, Waiting.

**With the agent**: the queue of Questions the operator has answered, deferred or asked, which the agent has not yet marked done.

**Chase**: nudging the session that holds a Question which has sat in **With the agent** too long, chiefly one that is stuck or has dropped its Inbox. Past `config.json`'s `chaseAfterMinutes` (ten by default) the page marks the Question's time with a **Chase** link to the session, and raises a toast per Inbox that stays until the operator dismisses it. An Inbox with no **session link** gets the mark and the toast, without the link.

**Processed**: the queue of Questions the agent has marked done or withdrawn, each shown with its answer or the agent's reason. The operator can still read them there.

**Inbox mode**: a per-session switch on a session's **Inbox**. While it is on, the app's Claude Code hooks route every question for the operator to the Inbox: a question asked in chat, in the next-step box or with AskUserQuestion is refused. When the operator types in the session, inline questions are allowed for that one reply (a *pause*). Recorded as `InboxModeOn` and `InboxModeOff` on the log. _Avoid_: inbox lock.

**Watcher**: the long-lived process `operator-inbox watch` starts for a session. It waits on the inbox log and prints one signal line when an answer arrives, which the session's harness turns into a wake-up; everything else goes to stderr. It stops when its owning session's process goes away, or at its deadline. Its record lives under `inbox-watchers/`.

**Metadata rules**: the list of metadata keys an Inbox and its Questions carry, read from `metadata.json`: each key's type, description and presence (`required`, `expected` or `optional`), and whether keys the list does not name are allowed. `session` and `sessionLink` are built in. The rules bind what the CLI writes, never what the log already holds.

**Session link**: the `sessionLink` key on an Inbox: a `claude://` link that opens the Claude desktop session working it. `operator-inbox open` fills it, with `sessionTitle`, from the desktop app's session files.

**Keymap**: the inbox page's key bindings: every action it can bind, each bound to one or more triggers (`ctrl+b`, or a sequence after the prefix, `ctrl+space>n`). It is the defaults with `keybindings` applied in order.

**Inbox machine**: a Herdr machine whose Inboxes this machine's app shows beside its own, listed in `config.json`'s `inboxMachines` with the local port its SSH tunnel listens on. Its Inboxes stay in its own log; this machine's server reads and writes them through the tunnel (`operator-inbox tunnel <machine>`). An Inbox id two machines both list is a **clash**, and is refused on both. _Avoid_: remote inbox.
