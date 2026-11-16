---
name: operator-inbox
description: Give this session an Inbox it shares with the operator — post each question there with full context, the operator answers it in the local Operator Inbox app, and you pick the answers up. Use when the operator types `/operator-inbox` (open or find this session's Inbox and turn inbox mode on), `/operator-inbox <id>` (adopt one another session handed over), `/operator-inbox off` (turn inbox mode off), or says "check your inbox". Not for a question the operator is waiting on live in this turn while inbox mode is off (ask that inline), and not for sending the operator a notification.
---

# operator-inbox

The operator loses track of questions that scroll away in a long session. An **Inbox** holds them outside the transcript. You post a **Question**; the operator answers it at a URL in the local app; you read the answer, act on it, and mark it done. Then it moves to the operator's **Processed** queue, where they can still see it.

Every command below is a subcommand of the `operator-inbox` binary. `operator-inbox <command> --help` lists its flags.

## 1. Open the Inbox

| The operator typed | Run |
| :-- | :-- |
| `/operator-inbox` | `operator-inbox open`, then `operator-inbox mode on` |
| `/operator-inbox <id>` | `operator-inbox open --inbox <id>`, then `operator-inbox mode on` |
| `/operator-inbox off` | `operator-inbox mode off` (see §1a) |

`open` is safe to repeat: it returns the Inbox this session already has.

**If it says this session has no inbox yet, open one with a name.** By default the name is this session's own title, the name the operator sees in their sidebar:

- In the Claude desktop app, call `mcp__ccd_session_mgmt__get_session` with `session_id: "self"` and use its `title`. If the tool is deferred, load it first with ToolSearch `select:mcp__ccd_session_mgmt__get_session`.
- In a Herdr or tmux session, use the tab or window name.
- If there is no title, use a few words saying what this session is doing.

```sh
operator-inbox open --label "<this session's title>"
```

**Names are unique** (compared ignoring case and extra spaces). If the name is taken, `open` exits 3, says `an inbox named "…" already exists: <id>`, and prints the id alone on stdout. Look at that Inbox (`operator-inbox list`, or `http://127.0.0.1:7184/inbox/<id>`):

- If it is this same work continued (say, from a previous session), adopt it: `operator-inbox open --inbox <id>`.
- If it is other work, choose a more specific name: add a distinguishing word.

**If the session is retitled later, rename the Inbox to match:** `operator-inbox rename "<new title>"` (or `open --label "<new title>"`, which renames an Inbox that already exists). A rename refuses a taken name the same way. A renamed Inbox gives up its old name, so another Inbox may take it.

Then arm the watcher (§3), and reply with the URL `open` printed, on its own line. Every Inbox is also listed at `http://127.0.0.1:7184/inbox`, where the operator can see all their questions in one place.

**After a compaction**, run `operator-inbox open` again. It finds this session's Inbox. Do not run `operator-inbox mode on` then: the mode is kept on the inbox log and survives the compaction, and an operator who turned it off meant it. Then run `operator-inbox answers`, because answers may have landed while you were compacting, and check that the watcher (§3) is still armed.

## 1a. Inbox mode

Typing `/operator-inbox` turns on **inbox mode** for this session (`operator-inbox mode on`, which you run after `open`). While it is on, every question you have for the operator goes to the Inbox, and hooks hold you to it:

- **AskUserQuestion is refused**, and so is a next-step box (`mcp__ccd_turn__wrap_up`) with an `ask` in it. The refusal names `operator-inbox ask`. Call `wrap_up` again without the `ask`.
- **A turn that ends on a question for the operator is sent back.** The Stop hook asks a small model whether your last message asks the operator something. If it does, post the question with `operator-inbox ask` and end the turn again. If your message held no question for the operator, simply end the turn again: the hook never blocks twice in a row.
- **When the operator types in the session, you may answer and ask inline in that one reply** (a *pause*). The next turn is back under the mode. A watcher wake-up is not the operator typing and does not pause it.

**Turning it off.** The operator turns it off with `/operator-inbox off`, or by typing one of these on its own: "inbox off", "stop using the inbox", "ask me here". For `/operator-inbox off`, run `operator-inbox mode off`. Either way, then ask the operator inline whether to archive the Inbox (§5), and archive it only on a yes. Turning the mode off never archives anything, and asking inline is allowed once it is off.

**The hooks live in the operator's Claude Code user settings, not in this skill.** They do nothing in a session whose mode is off. They are the entries in `~/.claude/settings.json` that run `operator-inbox guard` (Stop), `operator-inbox hook pre-tool` (PreToolUse on `AskUserQuestion|mcp__ccd_turn__wrap_up`) and `operator-inbox hook prompt` (UserPromptSubmit). If they are missing, the operator runs `operator-inbox install-claude-hooks` themselves. Never run it for them. Without the hooks, the mode is only this section's instruction, so keep to it anyway.

The classification prompt the Stop hook sends ships with the CLI as `assets/classify-question.md`.

## 2. Ask a Question

Once the Inbox is open, every question you would have asked the operator in the chat goes to the Inbox instead. While inbox mode is on (§1a), that holds even when the operator seems to be waiting live, except in the one reply to a prompt they typed.

```sh
operator-inbox ask --title "<the decision, as a question>" --body-file <path>
```

It prints the Question's **code**, such as `asv#3` (see *Question codes* below). Write the body to a scratch file first (or pipe it on stdin). Add `--inbox <id>` to ask in an Inbox this session has not opened. The body is GitHub-flavoured markdown: headings, lists, task lists, tables, strikethrough, images and code fences render (raw HTML shows as text). **Mermaid diagrams are supported:** a ```mermaid fence is drawn as a diagram, folded under a *Diagram* fold that the operator opens, with a full-screen view. Use one for a flow, a sequence or a state machine the operator has to follow. A diagram Mermaid cannot parse shows its error and its source, so check the syntax. A ```svg fence renders as a diagram too, shown as an image, which suits a small hand-drawn sketch. Otherwise prefer a pseudocode block, a file tree or a table.

**The operator will read it cold, maybe days later, with nothing else open.** So each body holds:

1. **Context** — two or three sentences: what you are doing and what led here. Name files and commands exactly.
2. **The point, drawn small.** The smallest view that makes it clear: a pseudocode block, a call tree, a short diff or a two-column table, never a wall of prose. Skip it if one sentence does the job.
3. **The question** — one decision. Two decisions are two Questions.
4. **The options**, each one line, and **your recommendation** with its reason.

The title names the decision (`Keep the old flag, or remove it now?`), not the topic (`Flags`).

### Metadata

An Inbox and each Question carry a metadata dictionary of named values, which the operator sees in the app, in a card behind `<>` under each Question. Use it for facts a person or a later session would filter or match on, such as the repo, the branch, or a PR. It is not a place for context the operator needs to answer: that goes in the body.

```sh
operator-inbox open --label "<title>" --meta repo=<owner>/<repo> --meta branch=main --meta session=<session id>
operator-inbox ask --title "<question>" --body-file <path> --meta pr=https://github.com/<owner>/<repo>/pull/68
operator-inbox meta                                      # print the Inbox's
operator-inbox meta asv#3 --meta pr=69 --unset topic  # change asv#3's
operator-inbox meta asv#3 --json                      # print asv#3's as JSON
```

`--meta` on `open` sets the keys on an Inbox that already exists too. A change works on an archived Inbox and on a Question in any state; `answers` shows each Question's metadata as `meta key=value` lines.

**Metadata rules.** The rules say which keys an Inbox and its Questions carry. By default they are `repo`, `branch` and `pr`, each expected, plus the built-ins `session`, `sessionLink` and `sessionTitle`, expected on every Inbox. The app shows `sessionTitle` under the Inbox's name in its lists, so the operator can find an Inbox by its session. A project or an operator may declare more keys, or change these, in `~/.config/operator-inbox/metadata.json`. Run `operator-inbox keys` to see the rules this machine expects: each key's type, its presence, its level, and what it is for (`--json` for the rules whole). Set each key wherever it applies, using exactly that name. If you do not, the operator cannot filter or find the work by it. A key that does not apply is left out: do not invent a value to fill it.

- `required` keys refuse: `open` for a new Inbox and `ask` fail, writing nothing, until the key is set. `expected` keys warn on stderr. `optional` keys say nothing. Read the warning, set the keys that apply with `operator-inbox meta --meta key=value` (or `meta <n>` for a Question), and leave out the ones that do not.
- A key's level says where its presence counts: `inbox`, `question` or `both`. An `inbox` key neither refuses nor warns on `ask`, and a `question` key neither refuses nor warns on `open`.
- A value is a string, number, boolean, list or object. The rules give `--meta` text its type, so `--meta attempt=2` is a number when `attempt` is one. A dot reaches into an object (`--meta model.chapter=C02`, `--unset model.chapter`). Use `--meta-json` for a list or an object whole: `--meta-json 'links=[{"url":"https://example.com"}]'`. Both flags repeat, one key each.
- A value that does not fit the rules is refused, with the key named. `meta` checks only the values you set, so it works on an older Inbox that lacks a required key.
- Use the name as written. `prs` is not `pr`, and nothing renames or fills in a near miss for you. A key the rules do not name is an extra: kept unless the rules' `extras` is `refuse`, and listed after the rules' keys.
- Set what you know when you open the Inbox, and put on each Question whatever is specific to it. A key on the Inbox counts as set for its Questions, so set `repo` and `branch` once on the Inbox and `pr` on the Question it concerns.
- `session` is set on `open` and is not a Question key: session metadata belongs to the Inbox. Do not put it on `ask` or `meta <n>`. When you adopt an Inbox, set it to your own session id on that `open`.
- **The session link.** `sessionLink` and `sessionTitle` fill themselves: inside a Claude desktop session, `open` adds the `claude://` link that takes the operator to this session and the session's title, read from the desktop app's session files, and replaces them on an Inbox you adopt. Leave them alone. After `open`, run `operator-inbox meta` and check they are there. A terminal session has neither, so `open` warns that `sessionLink` and `sessionTitle` are missing: that is expected. It still passes `session`.
- `group` stays a string: it is the page's filter.
- Nothing is read from your working directory: the values come from you, `sessionLink` and `sessionTitle` aside.

**Groups.** The `group` key puts a Question in a group. The operator filters by group in the app: once any Question in the Inbox has a group, the sidebar nests the groups under the Inbox, plus "Default" for the Questions with none. A group is only a filter, so use one when the Inbox holds questions about separate threads of work.

```sh
operator-inbox ask --title "<question>" --body-file <path> --meta group=store  # ask in a group
operator-inbox meta asv#3 --meta group=ui                                   # move asv#3 to another group
operator-inbox meta asv#3 --unset group                                     # move asv#3 back to Default
```

### Question codes

Every Question has a code: its Inbox's code, then `#` and its number, such as `asv#3`. The Inbox's code is three random lower-case letters, unique on this machine, set once when the Inbox is opened, and a rename never changes it. The operator sees the code on each card in the app, and clicking it copies the Question for this session.

- **Quote the code whenever you mention a Question**, in the session and in a Question's body: `asv#3`, not `#3`. The operator may have many Inboxes open, and the code says which one.
- **Every command that takes a question number takes the code too**: `done`, `edit`, `withdraw`, `meta`, `highlight`, `unhighlight` and `move`. A code names its Inbox, so it needs neither this session nor `--inbox`: `operator-inbox done asv#3` works from any session. When the operator pastes a code, use it as it is.
- A plain number (`operator-inbox done 3`) still works, in this session's Inbox or the one `--inbox` names. Give every Question in one command as a code or every one as a number, from one Inbox.
- `--inbox` and `move --to` take an Inbox's code (`asv`) as well as its id.
- `open` prints the Inbox's code in brackets after its name, `list` prints it after each id, and `answers` names each Question by its code (`"code"` under `--json`). An Inbox opened before codes gets its code when `operator-inbox serve` next starts; until then it shows `#3`, and its numbers work as before.
- Codes once had two letters from the Inbox's name in front (`op-asv#3`). `serve` moves each such Inbox to its three letters when it next starts (`asv#3`, or a fresh three when another Inbox already has them), and every command still takes the older form, so a code quoted in an older transcript still finds its Question. Quote the current form from then on.

### Linking to a Question

To point the operator at one Question, link to the Question itself, not just its Inbox: `http://127.0.0.1:7184/inbox/<id>#q=<n>`. The page scrolls to that card and marks it.

### Highlights

When the operator asks you to show them the questions about something ("show me the questions relating to this"), find them and highlight them. A highlighted Question keeps its place in time order, in its own Inbox and in the All view, and carries a yellow dot beside it, on the minimap and on its Inbox in the sidebar. The operator steps between highlighted Questions with a key. Only a Question waiting for the operator can be highlighted. A new highlight leaves the others in place. A highlight stays until the operator dismisses it in the app or you remove it, even after the Question is answered.

```sh
operator-inbox highlight asv#2 asv#5 --note "about the store"  # the note shows above the title
operator-inbox unhighlight asv#2                                  # remove its highlight
operator-inbox unhighlight                                           # remove every highlight in the Inbox
```

`ask --highlight` highlights a new Question as it is asked. Add `--inbox <id>` to highlight in another session's Inbox. Remove highlights that no longer help, so the yellow dots stay meaningful.

### Moving a Question to another Inbox

A Question asked in the wrong Inbox, or one that belongs with another session's work, moves whole: its text, answer, state, metadata and highlight go with it, in any state. It takes the next number in the Inbox it joins, and so that Inbox's code: `move` prints the new one. Its old number stays used here, and an answer or a change to it is refused with where it went.

```sh
operator-inbox move asv#2 asv#5 --to <inbox id or code>  # from the Inbox the codes name
operator-inbox move 3 --inbox <from id> --to <id>               # by number, from another Inbox
```

The Inbox it joins must not be archived.

## 3. Get the answers: arm the watcher

As soon as the Inbox is open, arm the watcher, so the operator's answer, or a Question the operator asks you from the app, wakes you in seconds without anyone saying "check your inbox". Arm it once per session; it runs until the session ends. Keep it running while the Inbox is empty: the operator can ask you a Question at any time, and with no watcher it would wait unseen. Never stop it because nothing waits; archive the Inbox (§5) when its work is finished instead.

1. **Drain first.** Run `operator-inbox answers` and act on anything there. The watcher reports only answers that land after it starts.
2. **Arm it with the `Monitor` tool**, persistent if your harness offers that option. Each line it prints is one wake-up:

   ```sh
   operator-inbox watch --owner-pid "$CLAUDE_PID"
   ```

   Write `$CLAUDE_PID` as it is, for the shell to expand. It names this session's process, so the watcher stops when the session dies. Without it, the watcher stops after 4 hours (`--max-duration <seconds>`). Add `--inbox <id>` to watch an Inbox this session has not opened.
3. **When it wakes you** (`inbox: N new answers in "…" — run operator-inbox answers`), run `operator-inbox answers` and work each one as §4 says.

Keep working on anything that does not depend on an answer while it waits.

**If your harness's `Monitor` has a time limit and no persistent option**, it stops the watcher at the limit. Arm it again when that happens, and run `operator-inbox answers` straight after, in case an answer landed in the gap.

**You cannot forget it.** The Stop hook (`operator-inbox guard`, installed in user settings, §1a) checks this too. When you end a turn while the Inbox is open and no watcher runs, even with nothing waiting, the turn does not end: the hook tells you to arm the watcher, or to archive the Inbox if its work is finished. `ask` also prints a reminder on stderr when nothing is watching. Watchers record themselves beside the inbox's event log, so the hook can tell when one is running.

`operator-inbox wait` still exists for a short, one-off wait: it exits at the first answer, or after 10 minutes (`--timeout <minutes>`, at most 60). When the operator says "check your inbox", run `operator-inbox answers` (`--json` for JSON).

## 4. Act, then mark it done

For each answer: act on it, then mark it processed. There is no other step: no "processing" mark, nothing to set while you work. Think and act, then run `done`.

```sh
operator-inbox done asv#3
```

It takes more than one (`operator-inbox done asv#3 asv#4`), and plain numbers in this session's Inbox (`operator-inbox done 3 4`). A processed Question moves to the **Processed** queue of the operator's page, with their answer under it, and leaves your `answers`. If the answer opens a new question, ask a **new** Question, and quote what you need from the old one in its body: nothing else links them. If the answer closes the line of inquiry, you are done with it.

Do not mark a Question done before you have acted on it. Until you do, it stays in the operator's **With the agent** queue.

### A Question the operator asks you

The operator can ask you a Question from the app. It arrives the way an answer does: the watcher wakes you, and `answers` lists it with `(the operator asks)` before its title (`"operatorQuestion": true` under `--json`). The text under it is their question, not an answer to one of yours. Act on it, and answer it in the session. If the operator is not reading the session, ask a new Question that carries your answer. Then mark it done, as you do an answer: `operator-inbox done <code>`.

### A deferred answer: the call is yours

The operator can answer **Defer to agent** instead of choosing. `answers` opens such an answer with `DEFERRED TO AGENT: you decide. Record what you chose and why.` (`"deferred": true` under `--json`). The text under that line, if any, is their note ("lean B", "not the costly one"). Treat the note as a steer, not a decision the operator made.

1. **Decide.** Your recommendation in the Question is the starting point. Change it only for a reason you can state.
2. **Record what you chose, and who chose it.** Write the decision where this work records its decisions (a decision record, the project's docs, a commit or PR description), and say in the same sentence that it was deferred to the agent: *the agent's call, not the operator's decision*. If you do not, it reads later as "the operator decided X", which is false, and it hides the deferral the operator wants to be able to count.
3. **Tell the operator in the session**, in one line: what you chose and why.
4. Run `operator-inbox done <code>`, as for any answer.

The Processed queue shows it as "You deferred to the agent:", so deferrals can be found and counted later.

### An answer that asks for your reply highlighted

The operator can mark an answer, or a Question they ask you, **Highlight reply**. `answers` then opens it with `HIGHLIGHT YOUR RESPONSE: ask your follow-up with --highlight` (`"highlightReply": true` under `--json`). It means the operator will look for your reply among many: **the Question you ask in response must be highlighted.** Ask it with `--highlight`, which highlights it as it is asked:

```sh
operator-inbox ask --title "<the follow-up>" --body-file <path> --highlight
```

If you have already asked it, highlight it now: `operator-inbox highlight asv#7`. If the answer needs no Question back, there is nothing to highlight: act on it and run `done` as usual.

### Withdrawing a Question

If a Question you asked becomes moot or wrong before the operator answers it, withdraw it with a reason. A reason is required: you may not take anything out of the operator's inbox without saying why.

```sh
operator-inbox withdraw asv#3 --reason "Settled by the test run; Postgres it is."
```

Withdrawing marks the Question processed. It moves to the operator's Processed queue with "Withdrawn by the agent:" and your reason. Write the reason for the operator, reading cold. You can withdraw only a Question the operator has not answered yet; once they have, act on the answer and run `done`.

### Editing a Question

If a Question is still right but its wording or context is wrong, edit it instead:

```sh
operator-inbox edit asv#3 --title "<new title>" --body-file <path>
```

Either flag may be left out to keep that field. Like withdrawing, editing works only before the operator answers. If the operator was typing an answer to the old text, their Send is refused with "#3 changed after you opened it", so they read the new text first.

## 5. Archive the Inbox when the work is finished

When the session's work is finished and nothing waits on either side (no Question awaiting the operator, no answer awaiting you), archive the Inbox:

```sh
operator-inbox archive
```

Its Questions leave the operator's All view, and it moves to the sidebar's collapsed **Archived** section. Nothing is lost, and it keeps its name, so a later session finds it when it asks for that name and can adopt it. Answering, `done`, `edit` and `withdraw` still work in an archived Inbox. Asking a new question into it brings it back automatically, so the operator sees the question. `operator-inbox unarchive` brings it back by hand. The operator can also archive and unarchive an Inbox in the app. Both take `--inbox <id>` for an Inbox this session has not opened.

## 6. When it fails

Each command fails with one line naming the missing piece. `operator-inbox list` shows every Inbox on this machine, the archived ones last. If the store is unavailable, the line says so, with the file or the reason when it has them: point the operator at it and at `operator-inbox install`, which makes the store and prints where it is, then ask your question in the chat for now.

## Setup (once per machine, by the operator)

Nothing is needed: the Inbox's event log is a SQLite file, `~/.local/state/operator-inbox/inbox.sqlite` (under `$XDG_STATE_HOME` when that is set), made on first use. `operator-inbox install` makes it now and prints where it is, and `operator-inbox info` (`--json`) prints the config directory, the state directory, the database path, the port and the web build. To move the store, set `databasePath` in `~/.config/operator-inbox/config.json` to an absolute path. `OPERATOR_INBOX_DATABASE_PATH` also works and wins over the config, but only for processes that see it: a server started by a launch agent or service manager does not read your shell's exports, so the app would not follow it. `serve` keeps the file it opened: after changing `databasePath`, or replacing the file, restart it.

The page is served by `operator-inbox serve`, on `http://127.0.0.1:7184`, which must be running. The hooks of §1a are installed with `operator-inbox install-claude-hooks`, and `operator-inbox skill` prints this skill.
