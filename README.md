# Operator Inbox

A local inbox for the questions your agent sessions ask you. Each session posts its questions to an Inbox, you answer them in a local web app, and the session picks the answers up.

It runs on your machine only: a CLI, an event log on one SQLite file, and a web app on http://127.0.0.1:7184. It is built for Claude Code sessions, and works from any agent that can run a command.

Work in progress.

## How it works

An agent session opens an Inbox (`operator-inbox open`) and asks each question there (`operator-inbox ask`), with enough context to answer cold. You answer in the app at http://127.0.0.1:7184. The session runs `operator-inbox watch` once, which wakes it when an answer lands. It acts on the answer, then marks the Question done (`operator-inbox done`). Turn on inbox mode (`operator-inbox mode on`) and the app's Claude Code hooks keep every question for you in the Inbox, not the chat.

`operator-inbox skill` prints the full instructions an agent follows. Point your agent at them, or install them as a skill. `operator-inbox --help` lists every command.

`docs/architecture.md` describes how it is built: an event log on one SQLite file, a CLI that is also the server, and a web app.

## Set up

You need macOS, Node 22.16 or later, and pnpm. From the checkout, run:

```sh
bash scripts/setup.sh
```

(or `pnpm run setup`; bare `pnpm setup` is pnpm's own command, not this one). It works from any folder and is safe to re-run. It:

1. installs the dependencies (`pnpm install --frozen-lockfile`) and builds (`pnpm build`);
2. links the `operator-inbox` bin globally (`pnpm link --global`), so your agent sessions can run it;
3. writes a launch agent, `~/Library/LaunchAgents/com.operator-inbox.serve.plist`, that runs `operator-inbox serve` on http://127.0.0.1:7184 at login and keeps it running, and loads it. The plist is rendered for this machine (the absolute paths of your `node` and the built CLI) and is rewritten and reloaded only when it changes; otherwise the running server is restarted onto the new build. The server logs to `~/.local/state/operator-inbox/serve.log` (under `$XDG_STATE_HOME` when that is set);
4. merges the app's Claude Code hooks into `~/.claude/settings.json` (`operator-inbox install-claude-hooks`, which backs the file up first);
5. checks the server answers at http://127.0.0.1:7184/api/inboxes, and prints a summary, which also says whether the optional desktop window (below) is installed and current.

Options:

- `bash scripts/setup.sh rebuild` installs and builds, then, only if the server's launch agent is already loaded, restarts it onto the new build and checks it answers, exiting non-zero and naming the log the installed plist writes when it does not. It keeps the installed plist as it is, so the agent goes on running the checkout, store and environment it was set up with, whichever shell or checkout runs `rebuild` (run from a checkout the agent does not run, it says so). The one change it makes: when the `node` the plist names no longer exists (an upgrade moved it), it replaces that path with the `node` on this shell's PATH, keeps every other byte, and reloads the agent. If the agent then fails to load, it says the `launchctl bootstrap` command that loads it and exits non-zero. It never installs the hooks and never starts an agent that is not loaded, so it is the one to run after a `git pull`, by hand or from an external sync job.
- `--no-hooks` leaves `~/.claude/settings.json` alone.
- `--dry-run` prints every action, and the plist it would write, and changes nothing.

Anywhere but macOS the launch agent step is skipped: run `operator-inbox serve` yourself.

## The desktop window

Optionally, the app can have a window of its own: `~/Applications/Operator Inbox.app`, a [Pake](https://github.com/tw93/Pake) build onto http://127.0.0.1:7184. It needs Rust (`brew install rust`) and pake 3.17.4 or later (`npm install -g pake-cli`), and a build is a Rust compile of a few minutes, so `setup.sh` never builds it. Build it, or rebuild it, with:

```sh
bash scripts/desktop-app.sh build
```

It replaces an earlier build of the window, never another app at that name, and never launches it. If the window is open, quit it with ⌘Q (closing its window only hides it) and reopen it to load the new build. `--dry-run` prints the pake command and changes nothing.

The window has no find bar of WebKit's own, so the build turns on Pake's: ⌘F opens a find-in-page bar at the top right (Enter and ⇧Enter step through the matches, Esc closes it), and ⌘G and ⇧⌘G step from anywhere. They are in the window's Edit menu. In a browser tab ⌘F stays the browser's own find. The app's own search is ⌘P, which searches Questions across Inboxes rather than the text on the page.

`bash scripts/desktop-app.sh check` says whether the window is installed and current, without changing anything; `setup.sh` runs it at the end. A window is stale when it was built from another version of the script, or with another icon. The icon, `scripts/desktop-app/operator-inbox.icns`, is made from the web app's `icon-any-512.png` (the "Oi" mark, written by `node scripts/web-icons/make.mjs`) with the macOS rounded mask by `node scripts/desktop-app/make-icon.mjs`, and committed.

## Listen mode

Listen mode reads the Questions aloud, with a local voice: Kokoro-82M, run on this Mac through [mlx-audio](https://github.com/Blaizzy/mlx-audio). It needs Apple silicon and mlx-audio, installed with:

```sh
uv tool install mlx-audio
```

`setup.sh` runs that for you when [uv](https://docs.astral.sh/uv/) is installed. The model (about 330 MB) downloads the first time a Question is read. The voice is `readout.voice` in `config.json` (default `bm_george`, a British voice). The audio is cached under `~/.local/state/operator-inbox/readout/`, swept to the last 30 days and 256 MiB. If serve cannot find mlx-audio's Python, set `OPERATOR_INBOX_READOUT_PYTHON` to it.

## Stopping the server

To stop the server and remove the launch agent:

```sh
launchctl bootout gui/$(id -u)/com.operator-inbox.serve
rm ~/Library/LaunchAgents/com.operator-inbox.serve.plist
```

`launchctl bootout` on its own stops it until the next login or the next `setup.sh`.

## Configure

Nothing is needed to start. To change anything, edit the files in `~/.config/operator-inbox/` (under `$XDG_CONFIG_HOME` when that is set):

- `config.json`: this machine's settings, such as `databasePath` to move the store, `serve.tailnet` to reach the app from your other devices through `tailscale serve`, and `inboxMachines` to show another machine's Inboxes here. `readout.voice` is listen mode's voice. Display settings live there too: `chaseAfterMinutes`, and `diagramSize` (diagram size: `"box"`, the default, fills the box a picture may take; `"area"` also limits its area, so a tall or a wide picture takes about the same room), and `priorityPull`, how the page pulls you back to the priority Inbox after an answer elsewhere (`"interjection"`, the default, shows a card saying what waits there; `"boomerang"` goes straight there and back), and `wideBlocks`, how a table or a picture wider than the text widens (`"both"`, the default, centres it on the text and grows it both ways while there is room, then to the right; `"right"` keeps it to the text's left edge and grows it right only, as code blocks always do).
- `metadata.json`: the metadata keys your Inboxes and Questions carry. `operator-inbox keys` shows the rules in force.
- `keybindings`: your own key bindings for the page.
- `macros.json`: your macros, slash commands for the answer box. Each has a name, a line saying what it is for, an instruction for the agent and its parameters, each a closed list of options (one of them, or with `"multiple": true` any of them), text or a number; every parameter is required unless it says `"required": false`. Type `/` at the start of a word in the answer box to pick one. `operator-inbox macros` checks the file and prints what it offers.

```json
{
  "macros": [
    {
      "name": "todo",
      "description": "Add a to-do for me",
      "instruction": "Add this to the operator's to-do list, tied to this question's work, at the given priority (1 is the highest).",
      "params": [
        { "name": "text", "type": "text", "placeholder": "what to do" },
        { "name": "priority", "type": "number", "min": 1, "max": 4, "default": 2, "required": false }
      ]
    },
    {
      "name": "park",
      "description": "Park this thread",
      "instruction": "Stop work on this thread. Write down where it stands, and pick it up only when the operator asks.",
      "params": []
    }
  ]
}
```

`operator-inbox info` prints where everything is.

## Develop

```sh
pnpm install
pnpm verify
```

`pnpm verify` runs Biome, the type check, the Effect check, every test and the build. `AGENTS.md` holds the codebase's rules, and `GLOSSARY.md` its words.

## Issues

Bug reports and ideas are welcome as issues. Pull requests from outside are not taken for now.

## Licence

BSD-3-Clause. See `LICENSE`.
