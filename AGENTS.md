# Operator Inbox: instructions for agents

Operator Inbox is a local app. An agent session posts each question for its operator to an **Inbox**, the operator answers it in a browser, and the session picks the answer up. `GLOSSARY.md` holds the domain words, `docs/architecture.md` how the app is built, and `docs/adr/` the decisions (kept out of the published copy).

## Layout

A pnpm and Turborepo monorepo:

| Package | Path | What it is |
| :-- | :-- | :-- |
| `@operator-inbox/core` | `packages/core` | The domain: the inbox events and their fold, metadata rules, the keymap, the HTTP API's schema. Pure where it can be. |
| `@operator-inbox/cli` | `apps/cli` | The `operator-inbox` binary: the CLI agents call, the hooks, the watcher, and `serve`, which hosts the API and the web build on 127.0.0.1:7184. |
| `@operator-inbox/web` | `apps/web` | The Vite single-page app the operator answers in. |

The skill an agent reads is `apps/cli/assets/SKILL.md`, printed by `operator-inbox skill`.

`scripts/setup.sh` (`pnpm run setup`; bare `pnpm setup` is pnpm's own command) sets the app up on a machine and rebuilds it: install, build, link the bin, the launch agent that runs `serve`, and the hooks. Its `rebuild` mode installs and builds only, and touches a launch agent only when it is already loaded: it restarts it and keeps its plist as installed, except that a `node` the plist names that no longer exists is replaced, that path alone, with this shell's `node`, and the agent reloaded. It never points the agent at the checkout it runs from. After restarting it, it checks the server answers and exits non-zero, naming the log the installed plist writes, when it does not. Its usage is in its header comment and in `docs/install.md`. `operator-inbox doctor` checks an install and changes nothing.

`scripts/desktop-app.sh` builds the optional desktop window, `~/Applications/Operator Inbox.app` (`com.operator-inbox.desktop`), with Pake onto 127.0.0.1:7184 (`build`), and says whether it is installed and current (`check`, which `setup.sh` runs and which never changes anything). A build needs Rust and pake and takes minutes, so nothing runs it but the operator. Bump its `VERSION` whenever anything baked into the bundle changes; `check` calls a window of another version stale.

## The stack

Use these. Departing from a row is a decision to raise first, never one to make quietly.

| | Use |
| :-- | :-- |
| Language and runtime | TypeScript on Effect 4 |
| CLI | `effect/cli` |
| Event log | kairos-es, on one SQLite file |
| State machines | XState 6, bound to Effect through `@xstate/effect` |
| Reactive state | Effect Atom (`effect/reactivity`, `@effect/atom-react`) |
| Styling | Tailwind v4 |
| Components | Base UI |
| Web build | Vite |
| Tooling | pnpm, Turborepo, Biome, vitest |

- **State belongs in an Atom or a machine, not in `useState` and `useEffect` wired together by hand.** Reach for Effect Atom and XState before React hooks. A hook is the escape hatch, not the default.
- **Tailwind, always.** Style with utilities on the element. Custom CSS is only an escape hatch for what Tailwind cannot express, and its comment says why. A value the theme lacks becomes a theme token, never an arbitrary bracketed literal. Never a hybrid of hook classes carrying CSS plus utilities. "Match the surrounding style" never overrides this: where older code uses hook classes, new code still uses utilities.
- **Event sourcing is the default.** New state is events on the log, folded into views.
- **DRY is coupling.** Copy a small helper rather than share it through a package.

## Effect rules

The `@effect/language-service` plugin (`packages/typescript-config/base.json`) makes these errors, and `pnpm check-effect` runs it:

- Read the clock through `DateTime` or `Clock`, never `Date`.
- Make ids with the injected generator, never `Math.random` or `crypto.randomUUID`.
- Write output through `Console`, never `console`.
- Read environment variables through `Config`, never `process.env`.

## Where things live

- Config: `$XDG_CONFIG_HOME/operator-inbox/` (default `~/.config/operator-inbox/`): `config.json` (this machine's settings), `metadata.json`, `keybindings` and `macros.json` (the user's preferences, which may be symlinks; the app only reads them).
- Data: `$XDG_STATE_HOME/operator-inbox/` (default `~/.local/state/operator-inbox/`). Listen mode's audio cache is `readout/` there: derived files, swept, never events.
- The launch agent: `~/Library/LaunchAgents/com.operator-inbox.serve.plist`, rendered per machine by `scripts/setup.sh` and never tracked; its log is `$XDG_STATE_HOME/operator-inbox/serve.log`.
- Nothing is read from or written to the checkout at run time. The web build and the CLI's assets are found relative to the CLI package.
- Environment variables are named `OPERATOR_INBOX_*`.

## The gate

`pnpm verify` runs Biome, the type check, the Effect check, every test and the build. Run it before you push. No CI runs on PRs here: the full gate runs on the public repo, on each replayed PR (`.github/workflows/ci.yml`, which runs only on `publish/` branches).

## Writing

- UK English in code, comments and docs.
- Write markdown without hard wraps: one line per paragraph or list item.
- **This repo is published.** A squash commit on `main` is replayed to a public repo (ADR-0002). So nothing here names another project, a client, a private tool or a private repo, and a comment carries its technical reason, never who decided it or when. ADRs carry dates, never timestamps.
- No agent attribution anywhere: no `Co-Authored-By` naming an AI, no "Generated with" lines, in commits, PRs, code or docs.

## Git

- `main` takes squash-merged PRs only. The squash message is the PR title and body, so write the PR title as the commit subject.
- A commit that must never be published carries a `Publish: no` trailer. A commit and its revert, published in the same batch, both drop.
- `.publish-exclude` lists the paths that never reach the public repo. A file that belongs here only goes there. The publish job is `scripts/publish/`, and `bash scripts/publish/test/run.sh` tests it against two scratch repos it makes.
