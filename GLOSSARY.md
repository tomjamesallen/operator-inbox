# Glossary

The words this codebase uses for its domain. Use them as defined here, in code, docs and the UI.

**Operator**: the person the agent sessions work for, who answers their Questions in the app.

**Inbox**: a session's shared queue of **Questions** for the operator, held in a machine-local event log on one SQLite file (by default `~/.local/state/operator-inbox/inbox.sqlite`). A session opens one with `operator-inbox open`, or adopts one another session handed over; the operator answers it in the app at `/inbox/<id>`. It has a readable name, unique across its machine's Inboxes, which the agent or the operator can change. Either can archive an Inbox when its work is finished: it moves to a collapsed Archived section and keeps its name and Questions, and a new Question asked into it brings it back. An Inbox and each of its Questions carry a metadata dictionary the agent sets and the operator sees. An Inbox carries a conversation, not knowledge. _Avoid_: thread, channel.

**Group**: the `group` metadata key on a **Question**, which files it under that name in its **Inbox**; a Question with none is in "Default". The sidebar lists an Inbox's groups under it while it is the one selected, or a search reaches into them. Either the agent or the operator can **archive** a group when its thread of work is finished: recorded on the Inbox by `GroupArchived` (and `GroupUnarchived`), never by touching the Questions' `group` key, it moves to the Inbox's collapsed "Archived groups" fold, and its Questions leave the All view and the Inbox's own view; picking the group still shows them, and a new Question asked into it brings it back.

**Question**: one item in an **Inbox**: asked by the agent with enough context to answer cold, answered by the operator, then processed by the agent. Numbered `#1`, `#2`… per Inbox, never reused. There is no "processing" state: the agent acts on the answer, then marks the Question done. The agent may instead withdraw a Question the operator has not answered yet, with a reason. The agent can **highlight** a Question waiting for the operator, with a short note, and can **move** a Question to another Inbox, where it takes the next number. The operator can ask the agent a Question from the app, and can **defer** a Question to the agent instead of answering it. A follow-up is a new Question.

**Drawing**: an Excalidraw scene a **Question** carries beside its body, by id, which the body shows where a line reads `<Excalidraw id="…"/>`. The page draws it as a static picture, the column's width and no taller than the **picture height**, and the operator changes it only in a full-screen editor; a drawing they changed is sent whole with their answer or deferral, and only those. An agent writes one in the **compact form** and reads one back with `operator-inbox drawing <code> <id> --compact`. _Avoid_: sketch, diagram (a Mermaid fence).

**Compact form**: the drawing format agents write: one element per line (`rect`, `ellipse`, `diamond`, `text`, `arrow`, `line`), which the CLI converts to an Excalidraw scene. Its counterpart for reading is the **drawing summary**, one line per element, bound text folded into its shape and deleted elements dropped.

**Picture height**: the most a picture in a Question body is drawn inline, a **Drawing** and a Mermaid diagram alike (the `--max-height-picture` token, scaled with the page's type). A taller picture is scaled down to fit; its full-screen view shows it larger.

**Question code**: a Question's handle across every Inbox, such as `toe#12`: its Inbox's **Inbox code**, `#`, and its number. The app shows it on each card, where clicking it copies the Question, and the CLI prints it and takes it wherever it takes a question number. _Avoid_: question id.

**Inbox code**: the `toe` part: three random lower-case letters, unique across the machine's Inboxes and checked when it is assigned. Assigned once, by `InboxCodeAssigned`; a rename never changes it. An Inbox opened before codes gets one when `serve` starts. Codes once carried two letters of the Inbox's name in front (`op-toe`): `serve` moves such an Inbox to its three letters by `InboxCodeChanged` when it starts (a fresh three when an older Inbox already holds them), and the older form is still taken wherever a code is, so an older transcript still finds its Question.

**Queue**: one of the three lists the inbox page shows as tabs: **Your inbox** (waiting on the operator, oldest first), **With the agent** and **Processed** (both most recent first). An Inbox holds Questions in all three, so "inbox" never names a queue. _Avoid_: column, Waiting.

**With the agent**: the queue of Questions the operator has answered, deferred or asked, which the agent has not yet marked done.

**Chase**: nudging the session that holds a Question which has sat in **With the agent** too long, chiefly one that is stuck or has dropped its Inbox. Past `config.json`'s `chaseAfterMinutes` (ten by default) the page marks the Question's time with a **Chase** link to the session, and a round warning button in the bottom right counts the Inboxes holding such a Question. The button is there only while one does, and it never folds away; it opens the **Inbox picker**, which lists those Inboxes first. An Inbox with no **session link** gets the mark and is counted, without the link.

**Processed**: the queue of Questions the agent has marked done or withdrawn, each shown with its answer or the agent's reason. The operator can still read them there.

**Inbox mode**: a per-session switch on a session's **Inbox**. While it is on, the app's Claude Code hooks route every question for the operator to the Inbox: a question asked in chat, in the next-step box or with AskUserQuestion is refused. When the operator types in the session, inline questions are allowed for that one reply (a *pause*). Recorded as `InboxModeOn` and `InboxModeOff` on the log. _Avoid_: inbox lock.

**Watcher**: the long-lived process `operator-inbox watch` starts for a session. It waits on the inbox log and prints one signal line when an answer arrives, which the session's harness turns into a wake-up; everything else goes to stderr. It stops when its owning session's process goes away, or at its deadline. Its record lives under `inbox-watchers/`.

**Metadata rules**: the list of metadata keys an Inbox and its Questions carry, read from `metadata.json`: each key's type, description and presence (`required`, `expected` or `optional`), and whether keys the list does not name are allowed. `session`, `sessionLink` and `sessionTitle` are built in. The rules bind what the CLI writes, never what the log already holds.

**Session link**: the `sessionLink` key on an Inbox: a `claude://` link that opens the Claude desktop session working it. `operator-inbox open` fills it, with `sessionTitle`, from the desktop app's session files.

**Inbox picker**: the modal that finds an Inbox or its session (`Ctrl+Space i` or `Ctrl+Space s` by default, or the chase button): a search field over every Inbox, matching its name, its session's title or its **Inbox code**, in the order the empty state lists other Inboxes, then the rest. Enter selects the Inbox and puts the caret in its answer box; Ctrl+Enter, or the session icon on its row, opens its session and leaves the picker open. _Avoid_: session picker.

**Highlight reply**: the operator's request, set per send with `Ctrl+Space h`, that the agent highlight the Question it asks in reply. The box's border turns the highlight's yellow while it is on, and a send that lands turns it off. The answer or operator's question carries `highlightReply`; `answers` opens it with `HIGHLIGHT YOUR RESPONSE`, and the agent asks with `ask --highlight`.

**Macro**: a slash command the operator configures in `macros.json` (`/todo`, `/park`): a name, a description the operator reads, an instruction written for the agent, and its **Macro parameters**. Typing `/` at a word's start in the answer box opens the macros; each one picked is a card under the box, its "i" showing the instruction. The answer, or deferral, carries every macro invoked, in order, as `{ macro, instruction, args }`: the instruction is copied in when it is sent, so the log says what the agent was told whatever the file says later. An answer may be macros alone. The agent carries each one out as its instruction says, and never asks what a macro means. _Avoid_: command, action, snippet.

**Macro parameter**: one value a **Macro** asks for: a closed list of options (one of them, or with `multiple` any number), text, or a number. Required unless it says `required: false`. A send with a required one empty is held on it once; the next send with the same ones still empty sends them as `null`, for the agent to fill. _Avoid_: argument (that is the value sent), slot.

**Comment**: the operator's note on a span of a Question's body, made by selecting the text and pressing `c` (or ⌘⌥M, the floating button, or the context menu). The span stays highlighted, numbered in body order, and each comment is a card in the stack under the answer box, ahead of the **Macros**. The answer, or deferral, carries the written ones in body order as `{ quote, prefix, suffix, at, text }`: the quote and the text either side of it are what anchor it, and `at` is only a hint for drawing it again. An answer may be comments alone. _Avoid_: annotation, note.

**Keymap**: the inbox page's key bindings: every action it can bind, each bound to one or more triggers (`ctrl+b`, or a sequence after the prefix, `ctrl+space>n`). It is the defaults with `keybindings` applied in order.

**Inbox machine**: a Herdr machine whose Inboxes this machine's app shows beside its own, listed in `config.json`'s `inboxMachines` with the local port its SSH tunnel listens on. Its Inboxes stay in its own log; this machine's server reads and writes them through the tunnel (`operator-inbox tunnel <machine>`). An Inbox id two machines both list is a **clash**, and is refused on both. _Avoid_: remote inbox.
