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
5. checks the server answers at http://127.0.0.1:7184/api/inboxes, and prints a summary.

Options:

- `bash scripts/setup.sh rebuild` installs and builds, then, only if the server's launch agent is already loaded, restarts it onto the new build and checks it answers, exiting non-zero and naming the log the installed plist writes when it does not. It keeps the installed plist as it is, so the agent goes on running the checkout, store and environment it was set up with, whichever shell or checkout runs `rebuild` (run from a checkout the agent does not run, it says so). The one change it makes: when the `node` the plist names no longer exists (an upgrade moved it), it replaces that path with the `node` on this shell's PATH, keeps every other byte, and reloads the agent. If the agent then fails to load, it says the `launchctl bootstrap` command that loads it and exits non-zero. It never installs the hooks and never starts an agent that is not loaded, so it is the one to run after a `git pull`, by hand or from an external sync job.
- `--no-hooks` leaves `~/.claude/settings.json` alone.
- `--dry-run` prints every action, and the plist it would write, and changes nothing.

Anywhere but macOS the launch agent step is skipped: run `operator-inbox serve` yourself.

To stop the server and remove the launch agent:

```sh
launchctl bootout gui/$(id -u)/com.operator-inbox.serve
rm ~/Library/LaunchAgents/com.operator-inbox.serve.plist
```

`launchctl bootout` on its own stops it until the next login or the next `setup.sh`.

## Configure

Nothing is needed to start. To change anything, edit the files in `~/.config/operator-inbox/` (under `$XDG_CONFIG_HOME` when that is set):

- `config.json`: this machine's settings, such as `databasePath` to move the store, `serve.tailnet` to reach the app from your other devices through `tailscale serve`, and `inboxMachines` to show another machine's Inboxes here.
- `metadata.json`: the metadata keys your Inboxes and Questions carry. `operator-inbox keys` shows the rules in force.
- `keybindings`: your own key bindings for the page.

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
