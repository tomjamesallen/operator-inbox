# Installing Operator Inbox

This guide takes a machine from nothing to an agent session asking you its first Question. The short version is in the `README.md`.

- [Requirements](#requirements)
- [Install](#install)
- [What setup.sh does](#what-setupsh-does)
- [First use with Claude Code](#first-use-with-claude-code)
- [Other agents](#other-agents)
- [The desktop window](#the-desktop-window)
- [Listen mode](#listen-mode)
- [Updating](#updating)
- [Where everything lives](#where-everything-lives)
- [Troubleshooting](#troubleshooting)
- [Stopping and uninstalling](#stopping-and-uninstalling)

## Requirements

| | Needed for | Version |
| :-- | :-- | :-- |
| Node | everything | 22.16 or later |
| pnpm | installing and building | 9 or later (the repo pins 9.15.4 through `packageManager`, so `corepack enable` gives you that one) |
| macOS | the launch agent that keeps the server running, and the desktop window | any current release |
| Claude Code | the skill and the hooks | optional: any agent that can run a command can use the CLI |
| uv and mlx-audio, on Apple silicon | listen mode, which reads Questions aloud | optional |
| Rust and pake | building the desktop window | optional: Rust 1.85 or later (`brew install rust`), pake 3.17.4 or later (`npm install -g pake-cli`) |

On Linux or another platform, everything but the launch agent and the desktop window works: you run `operator-inbox serve` yourself, or under your own service manager.

## Install

```sh
git clone https://github.com/tomjamesallen/operator-inbox.git
cd operator-inbox
bash scripts/setup.sh
```

`pnpm run setup` runs the same script. (Bare `pnpm setup` is pnpm's own command, not this one.) The script works from any folder and is safe to re-run. Keep the checkout: the launch agent runs the CLI built inside it.

Then open http://127.0.0.1:7184, and check the install:

```sh
operator-inbox doctor
```

Its options:

- `--no-hooks` leaves `~/.claude/settings.json` alone. You can add the hooks later with `operator-inbox install-claude-hooks`.
- `--dry-run` prints every action, and the launch agent plist it would write, and changes nothing.
- `rebuild` is for updating; see [Updating](#updating).

## What setup.sh does

1. Installs the dependencies (`pnpm install --frozen-lockfile`) and builds (`pnpm build`).
2. Links the `operator-inbox` bin globally (`pnpm link --global`), so your agent sessions can run it. pnpm's global bin folder must be on your `PATH`; `pnpm setup` adds it if it is not.
3. On macOS, writes a launch agent, `~/Library/LaunchAgents/com.operator-inbox.serve.plist`, that runs `operator-inbox serve` on http://127.0.0.1:7184 at login and keeps it running, and loads it. The plist is rendered for this machine, with the absolute paths of your `node` and the built CLI, and the `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `OPERATOR_INBOX_DATABASE_PATH` and `OPERATOR_INBOX_READOUT_PYTHON` your shell has set. It is rewritten and reloaded only when it changes; otherwise the running server is restarted onto the new build. The server logs to `~/.local/state/operator-inbox/serve.log`.
4. Merges the app's Claude Code hooks into `~/.claude/settings.json` (`operator-inbox install-claude-hooks`), unless you pass `--no-hooks`. It backs the file up first, to the first free `settings.json.pre-operator-inbox` name, and touches no other key or hook. The three hooks are `operator-inbox guard` on Stop, `operator-inbox hook pre-tool` on PreToolUse and `operator-inbox hook prompt` on UserPromptSubmit. They act only in a session that has turned inbox mode on, and do nothing anywhere else. Sessions already running keep the hooks they started with.
5. Installs listen mode's voice with `uv tool install mlx-audio` when uv is installed and mlx-audio is not. This step never fails the setup.
6. Checks the server answers at http://127.0.0.1:7184/api/inboxes, says whether the desktop window is installed and current, and prints a summary.

It does not install the skill, and it never builds the desktop window.

## First use with Claude Code

Install the skill, which tells an agent how to use the Inbox. It ships with the CLI, so install it from the version you run:

```sh
mkdir -p ~/.claude/skills/operator-inbox
operator-inbox skill > ~/.claude/skills/operator-inbox/SKILL.md
```

Re-run the second line after each update; `operator-inbox doctor` says when the installed skill differs from the CLI's.

Then, in a Claude Code session, type:

```text
/operator-inbox
```

The session opens an Inbox named after itself (`operator-inbox open`), turns on inbox mode (`operator-inbox mode on`), and starts a watcher (`operator-inbox watch`) that wakes it when you answer. From then on it posts each question to the Inbox rather than asking in the chat, with the hooks holding it to that. Answer at http://127.0.0.1:7184; the session picks the answer up, acts on it and marks the Question done.

`/operator-inbox off` turns inbox mode off for the session. `/operator-inbox <id>` adopts an Inbox another session opened.

## Other agents

Any agent that can run a command can use the CLI: `operator-inbox open --label <name>`, `operator-inbox ask --title <title> --body-file <file>`, `operator-inbox answers`, `operator-inbox done <n>`. The CLI ties an Inbox to a Claude Code session by itself; from anywhere else, pass the Inbox's three-letter code, which `open` prints, as `--inbox <code>` to each command. `operator-inbox skill` prints the full instructions, which you can give the agent as they are. `operator-inbox --help` lists every command, and `operator-inbox <command> --help` its flags. The hooks are Claude Code's; without them, inbox mode is only an instruction the agent follows.

## The desktop window

Optionally, the app can have a window of its own: `~/Applications/Operator Inbox.app`, a [Pake](https://github.com/tw93/Pake) build onto http://127.0.0.1:7184. A build is a Rust compile of a few minutes, so `setup.sh` never builds it. Build it, or rebuild it, with:

```sh
bash scripts/desktop-app.sh build
```

It needs Rust 1.85 or later and pake 3.17.4 or later, and says which is missing. It replaces an earlier build of the window, never another app at that name, and never launches it. If the window is open, quit it with ⌘Q (closing its window only hides it) and reopen it to load the new build. `--dry-run` prints the pake command and changes nothing.

`bash scripts/desktop-app.sh check` says whether the window is installed and current, without changing anything; `setup.sh` and `operator-inbox doctor` both run it. A window is stale when it was built from another version of the script, or with another icon.

The window has no find bar of WebKit's own, so the build turns on Pake's: ⌘F opens a find-in-page bar at the top right (Enter and ⇧Enter step through the matches, Esc closes it), and ⌘G and ⇧⌘G step from anywhere. The app's own search is ⌘P, which searches Questions across Inboxes.

## Listen mode

Listen mode reads the Questions aloud with a local voice: Kokoro-82M, run on your Mac through [mlx-audio](https://github.com/Blaizzy/mlx-audio). It needs Apple silicon and mlx-audio:

```sh
uv tool install mlx-audio
```

`setup.sh` runs that for you when [uv](https://docs.astral.sh/uv/) is installed. The model, about 330 MB, downloads the first time a Question is read. The voice is `readout.voice` in `config.json` (default `bm_george`). The audio is cached under `~/.local/state/operator-inbox/readout/`, kept to the last 30 days and 256 MiB. If the server cannot find mlx-audio's Python, set `OPERATOR_INBOX_READOUT_PYTHON` to it, then re-run `setup.sh` so the launch agent sees it.

## Updating

```sh
git pull
bash scripts/setup.sh rebuild
```

`rebuild` installs and builds, then, only if the launch agent is already loaded, restarts it onto the new build and checks it answers. It exits non-zero, naming the server's log, when it does not. It keeps the installed plist as it is, so the server goes on running the checkout, store and environment it was set up with. The one exception: when the `node` the plist names no longer exists (a Node upgrade moved it), it points the plist at the `node` on your `PATH` and reloads the agent. It never installs the hooks and never starts an agent that is not loaded, so it is safe to run from a scheduled job.

After an update, reinstall the skill (see [First use](#first-use-with-claude-code)), and run `bash scripts/setup.sh` without `rebuild` if `doctor` says the hooks are out of date.

## Where everything lives

`operator-inbox info` prints every path (`--json` for a script).

| What | Where |
| :-- | :-- |
| Settings: `config.json`, `metadata.json`, `keybindings`, `macros.json` | `~/.config/operator-inbox/` (under `$XDG_CONFIG_HOME` when that is set) |
| The event log, a SQLite file | `~/.local/state/operator-inbox/inbox.sqlite` (under `$XDG_STATE_HOME`; `databasePath` in `config.json` or `OPERATOR_INBOX_DATABASE_PATH` moves it) |
| Attachments, listen mode's audio cache, the server's log | beside the event log, in `~/.local/state/operator-inbox/` |
| The launch agent | `~/Library/LaunchAgents/com.operator-inbox.serve.plist` |
| The hooks | `~/.claude/settings.json` |
| The skill | `~/.claude/skills/operator-inbox/SKILL.md` |
| The desktop window | `~/Applications/Operator Inbox.app` |

Nothing is written to the checkout at run time. To back the Inboxes up, copy the state folder while the server is stopped.

## Troubleshooting

Start with:

```sh
operator-inbox doctor
```

It checks Node, the bin on `PATH`, `config.json`, the event log, the server, the launch agent, the Claude Code hooks, the skill, the desktop window and listen mode's voice. Each row reads `ok`, `warn` or `fail`, with a one-line fix under any that is not ok. It exits non-zero when a row fails, and `--json` prints the report as JSON. It changes nothing: it never writes `settings.json`, never makes the event log, and never builds or launches anything. `--port` checks a server on another port.

Common cases:

- **The page does not load.** The server is not running. On macOS, run `bash scripts/setup.sh`, and if it still does not answer, read `~/.local/state/operator-inbox/serve.log`. Elsewhere, run `operator-inbox serve`.
- **`cannot listen on 127.0.0.1:7184: the address is already in use`.** Another `operator-inbox serve` is already running, most likely the launch agent's.
- **The launch agent's `node` is gone** after a Node upgrade: `bash scripts/setup.sh rebuild` points it at the current one.
- **An agent says `operator-inbox: command not found`.** pnpm's global bin folder is not on that shell's `PATH`; run `pnpm setup`, open a new shell, and re-run `bash scripts/setup.sh`.
- **The hooks do nothing.** Sessions read hooks when they start, so start a new one. The hooks act only once a session has run `operator-inbox mode on`.
- **`install-claude-hooks` refuses to write.** `~/.claude/settings.json` does not parse; fix it by hand, then re-run.

## Stopping and uninstalling

Stop the server until the next login or the next `setup.sh`:

```sh
launchctl bootout gui/$(id -u)/com.operator-inbox.serve
```

To remove it all:

1. Stop the server and remove its launch agent:

   ```sh
   launchctl bootout gui/$(id -u)/com.operator-inbox.serve
   rm ~/Library/LaunchAgents/com.operator-inbox.serve.plist
   ```

2. Remove the bin: `rm "$(pnpm bin --global)/operator-inbox"`.
3. Remove the hooks: edit `~/.claude/settings.json` and delete the three hook entries whose command runs `operator-inbox guard`, `operator-inbox hook pre-tool` and `operator-inbox hook prompt`. The `settings.json.pre-operator-inbox` backups beside it hold the file as it was before each install.
4. Remove the skill: `rm -r ~/.claude/skills/operator-inbox`.
5. Remove the desktop window, if you built it: `rm -r ~/Applications/Operator\ Inbox.app`.
6. Remove your Inboxes and settings, if you no longer want them: `rm -r ~/.local/state/operator-inbox ~/.config/operator-inbox`. This deletes every Question and answer for good.
7. Remove mlx-audio, if you installed it for listen mode: `uv tool uninstall mlx-audio`.
8. Delete the checkout.
