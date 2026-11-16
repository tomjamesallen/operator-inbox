#!/usr/bin/env bash
# Set up Operator Inbox on this machine, or rebuild and restart it.
#
#   bash scripts/setup.sh [all] [--no-hooks] [--dry-run]
#   bash scripts/setup.sh rebuild [--dry-run]
#
# all (the default): install the dependencies, build, link the
# `operator-inbox` bin globally, write the launch agent that runs
# `operator-inbox serve` and (re)load it, install the Claude Code hooks
# (unless --no-hooks), install listen mode's voice (`uv tool install
# mlx-audio`, when uv is here and it is not installed; never fatal), then
# check the server answers.
#
# Both modes end by saying whether the optional desktop window is installed
# and current (scripts/desktop-app.sh check). Neither builds it.
#
# rebuild: install the dependencies, build, and, only if the launch agent is
# already loaded, restart it and check the server answers, exiting non-zero
# when it does not. The installed plist is kept as it is, with one exception:
# when the node it names no longer exists (an upgrade moved it), that one path
# is replaced with this shell's node, every other byte kept, and the agent
# reloaded. So it never points the agent at a different checkout, store or
# environment, whatever shell or checkout runs it. It never installs hooks
# and never loads an agent that is not loaded, so an external sync job can
# run it after a pull.
#
# --dry-run prints every action and changes nothing.
#
# Safe to re-run: all renders the launch agent's plist for this machine on
# every run and rewrites and reloads it only when it differs from the one
# installed; otherwise a loaded agent is just restarted onto the new build.
#
# Overrides, mostly for testing the script without touching the machine:
#   OPERATOR_INBOX_LAUNCH_AGENTS_DIR  where the plist goes (default ~/Library/LaunchAgents)
#   OPERATOR_INBOX_LAUNCHCTL          the launchctl to run (default launchctl)
#   OPERATOR_INBOX_PNPM_LINK          the pnpm that runs `link --global` (default pnpm)

set -euo pipefail

LABEL=com.operator-inbox.serve
# serve's default port (SERVE_DEFAULT_PORT in packages/core/src/api/serve-port.ts).
# The agent runs `serve` with no --port, so this is only where the check looks.
PORT=7184
HEALTH_URL="http://127.0.0.1:${PORT}/api/inboxes"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CLI_DIR="$ROOT/apps/cli"
# The CLI package's bin (apps/cli/package.json), which the build writes.
ENTRY="$CLI_DIR/dist/index.js"

LAUNCH_AGENTS_DIR="${OPERATOR_INBOX_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/operator-inbox"
LOG_FILE="$LOG_DIR/serve.log"
LAUNCHCTL="${OPERATOR_INBOX_LAUNCHCTL:-launchctl}"
PNPM_LINK="${OPERATOR_INBOX_PNPM_LINK:-pnpm}"
DOMAIN="gui/$(id -u)"

usage() {
  sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE=all
HOOKS=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    all | rebuild) MODE="$arg" ;;
    --no-hooks) HOOKS=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "setup: unknown argument '$arg'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

DRY_LABEL=""
((DRY_RUN)) && DRY_LABEL=", dry run"
SUMMARY=()
say() { printf 'setup: %s\n' "$*"; }
note() { SUMMARY+=("$*"); }

# Run a command, or under --dry-run only say it.
run() {
  if ((DRY_RUN)); then
    printf 'setup: would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    printf 'setup: running:'
    printf ' %q' "$@"
    printf '\n'
    "$@"
  fi
}

# --- Prerequisites ---------------------------------------------------------

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "setup: node is not on PATH. Install Node 22.16 or later, then re-run." >&2
  exit 1
fi
# The real file, not a shim or a symlink (nvm, Homebrew), so launchd runs the
# very node this shell has.
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"
if [[ -L "$NODE" ]]; then
  NODE="$(readlink -f "$NODE" 2>/dev/null || echo "$NODE")"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "setup: pnpm is not on PATH. Install it (corepack enable, or npm i -g pnpm), then re-run." >&2
  exit 1
fi

say "repo $ROOT ($MODE$DRY_LABEL)"
say "node $NODE ($("$NODE" --version))"

# --- Install and build -----------------------------------------------------

cd "$ROOT"
run pnpm install --frozen-lockfile
run pnpm build
if ((!DRY_RUN)) && [[ ! -f "$ENTRY" ]]; then
  echo "setup: the build did not write $ENTRY" >&2
  exit 1
fi
note "built $ENTRY"

if [[ "$MODE" == all ]]; then
  (cd "$CLI_DIR" && run "$PNPM_LINK" link --global)
  note "linked operator-inbox globally"
fi

# --- Launch agent ----------------------------------------------------------

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# PATH for the agent: node's own folder, the folder of any tool serve spawns
# (Herdr, for the Inbox machines), then the system folders.
agent_path() {
  # The tools serve spawns, one entry each.
  local tools=(herdr)
  local dirs=("$(dirname "$NODE")") tool dir out="" d
  for tool in "${tools[@]}"; do
    if dir="$(command -v "$tool" 2>/dev/null)"; then
      dirs+=("$(dirname "$dir")")
    fi
  done
  dirs+=(/usr/bin /bin /usr/sbin /sbin)
  for d in "${dirs[@]}"; do
    case ":$out:" in *":$d:"*) ;; *) out="${out:+$out:}$d" ;; esac
  done
  printf '%s' "$out"
}

# One <key>/<string> pair per variable that is set, so the agent reads the
# same config and store as the CLI in this shell.
env_entries() {
  local name
  printf '    <key>PATH</key>\n    <string>%s</string>\n' "$(xml_escape "$(agent_path)")"
  printf '    <key>HOME</key>\n    <string>%s</string>\n' "$(xml_escape "$HOME")"
  for name in XDG_CONFIG_HOME XDG_STATE_HOME OPERATOR_INBOX_DATABASE_PATH OPERATOR_INBOX_READOUT_PYTHON; do
    if [[ -n "${!name:-}" ]]; then
      printf '    <key>%s</key>\n    <string>%s</string>\n' "$name" "$(xml_escape "${!name}")"
    fi
  done
}

# The plist for this machine. ProgramArguments are node and the built entry,
# never a shell: macOS refuses a launchd job run by /bin/sh reads under
# ~/Documents, where a checkout often lives, while node itself is allowed.
render_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$ENTRY")</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
$(env_entries)
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$HOME")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
PLIST
}

is_loaded() {
  "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

AGENT_RUNNING=0
# The log the agent writes: this shell's, unless rebuild finds the installed
# plist names another.
AGENT_LOG="$LOG_FILE"

# Render the plist into "$1" and lint it.
render_checked() {
  render_plist >"$1"
  plutil -lint -s "$1" >/dev/null || {
    echo "setup: the rendered launch agent plist does not lint:" >&2
    plutil -lint "$1" >&2 || true
    exit 1
  }
}

# Is the installed plist the one rendered into "$1"?
plist_current() {
  [[ -f "$PLIST" ]] && cmp -s "$1" "$PLIST"
}

# Install the plist rendered into "$1", or under --dry-run show it.
write_plist() {
  if ((DRY_RUN)); then
    say "would write $PLIST:"
    sed 's/^/    /' "$1"
  else
    mkdir -p "$LAUNCH_AGENTS_DIR"
    cp "$1" "$PLIST"
    say "wrote $PLIST"
  fi
}

# Load the agent from its plist. Just after a bootout, launchd can refuse a
# bootstrap for a moment (error 5, an input/output error), so it is tried a few
# times. If it never loads, say the one command that loads it and stop.
load_agent() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if run "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"; then
      return 0
    fi
    if ((attempt < 5)); then
      say "bootstrap failed; trying again"
      sleep 1
    fi
  done
  echo "setup: the launch agent $LABEL is not loaded; load it with: launchctl bootstrap $DOMAIN $(printf '%q' "$PLIST")" >&2
  exit 1
}

# Unload the agent, then load it again from its plist.
reload_agent() {
  run "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
  load_agent
}

setup_agent() {
  local rendered
  rendered="$(mktemp "${TMPDIR:-/tmp}/operator-inbox-plist.XXXXXX")"
  # shellcheck disable=SC2064 # expand now: the path is local to this function
  trap "rm -f '$rendered'" RETURN
  render_checked "$rendered"

  if plist_current "$rendered"; then
    say "launch agent plist $PLIST is up to date"
    if is_loaded; then
      run "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
      note "launch agent $LABEL restarted onto the new build"
    else
      load_agent
      note "launch agent $LABEL loaded"
    fi
  else
    write_plist "$rendered"
    if is_loaded; then
      reload_agent
    else
      load_agent
    fi
    note "launch agent $LABEL written and loaded ($PLIST)"
  fi
  AGENT_RUNNING=1
}

# The node a plist runs: the first string of its ProgramArguments, in the
# layout render_plist writes. Empty when it is not in that layout.
plist_node() {
  awk '
    /<key>ProgramArguments<\/key>/ { args = 1; next }
    args && /<string>.*<\/string>/ {
      sub(/^[^<]*<string>/, ""); sub(/<\/string>[[:space:]]*$/, "")
      gsub(/&lt;/, "<"); gsub(/&gt;/, ">"); gsub(/&amp;/, "\\&")
      print; exit
    }
  ' "$1"
}

# The string a plist gives key "$2", in the layout render_plist writes (the
# <string> on the line after the <key>). Empty when it has none.
plist_string() {
  KEY="$2" awk '
    want && /<string>.*<\/string>/ {
      sub(/^[^<]*<string>/, ""); sub(/<\/string>[[:space:]]*$/, "")
      gsub(/&lt;/, "<"); gsub(/&gt;/, ">"); gsub(/&amp;/, "\\&")
      print; exit
    }
    { want = ($0 ~ ("<key>" ENVIRON["KEY"] "</key>")) }
  ' "$1"
}

# The entry a plist runs: the second string of its ProgramArguments.
plist_entry() {
  awk '
    /<key>ProgramArguments<\/key>/ { args = 1; next }
    args && /<string>.*<\/string>/ {
      if (++n == 2) {
        sub(/^[^<]*<string>/, ""); sub(/<\/string>[[:space:]]*$/, "")
        gsub(/&lt;/, "<"); gsub(/&gt;/, ">"); gsub(/&amp;/, "\\&")
        print; exit
      }
    }
  ' "$1"
}

# Write into "$2" the plist "$1" with only its node line changed, to this
# shell's node; every other line is copied as it is.
swap_node() {
  SWAP_NODE="$(xml_escape "$NODE")" awk '
    /<key>ProgramArguments<\/key>/ { args = 1; print; next }
    args && !done && /<string>.*<\/string>/ {
      match($0, /^[^<]*/)
      printf "%s<string>%s</string>\n", substr($0, 1, RLENGTH), ENVIRON["SWAP_NODE"]
      done = 1; next
    }
    { print }
  ' "$1" >"$2"
}

# rebuild: a loaded agent is restarted onto the new build, from the plist it
# was loaded with. The plist is changed only when the node it names is gone,
# and then only that path. An agent that is not loaded is left alone.
rebuild_agent() {
  if ! is_loaded; then
    say "launch agent $LABEL is not loaded; left alone (run setup.sh to install it)"
    note "launch agent not loaded, so not restarted"
    return
  fi
  local installed_node installed_entry
  if [[ -f "$PLIST" ]]; then
    installed_node="$(plist_node "$PLIST")"
    installed_entry="$(plist_entry "$PLIST")"
    local log
    log="$(plist_string "$PLIST" StandardOutPath)"
    [[ -n "$log" ]] || log="$(plist_string "$PLIST" StandardErrorPath)"
    [[ -n "$log" ]] && AGENT_LOG="$log"
  else
    say "warning: launch agent $LABEL is loaded but $PLIST is missing; restarting it as loaded (run setup.sh to write it)"
    installed_node=""
    installed_entry=""
  fi
  if [[ -n "$installed_entry" && "$installed_entry" != "$ENTRY" ]]; then
    say "launch agent $LABEL runs $installed_entry, not this checkout's build; it is restarted onto that one, and left pointing at it"
    note "launch agent runs $installed_entry, not this checkout"
  fi

  if [[ -z "$installed_node" ]] || [[ -f "$installed_node" && -x "$installed_node" ]]; then
    run "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
    note "launch agent $LABEL restarted onto the new build"
  else
    say "launch agent plist $PLIST names node $installed_node, which is gone; pointing it at $NODE"
    local swapped
    swapped="$(mktemp "${TMPDIR:-/tmp}/operator-inbox-plist.XXXXXX")"
    # shellcheck disable=SC2064 # expand now: the path is local to this function
    trap "rm -f '$swapped'" RETURN
    swap_node "$PLIST" "$swapped"
    if [[ "$(plist_node "$swapped")" != "$NODE" ]]; then
      echo "setup: could not replace the node in $PLIST; left it alone (run setup.sh to rewrite it)" >&2
      exit 1
    fi
    if command -v plutil >/dev/null 2>&1 && ! plutil -lint -s "$swapped" >/dev/null; then
      echo "setup: $PLIST with its node replaced does not lint; left it alone (run setup.sh to rewrite it)" >&2
      exit 1
    fi
    write_plist "$swapped"
    reload_agent
    note "launch agent $LABEL plist pointed at node $NODE, and the agent reloaded ($PLIST)"
  fi
  AGENT_RUNNING=1
}

if [[ "$(uname -s)" != Darwin ]]; then
  say "not macOS, so no launch agent; run 'operator-inbox serve' yourself"
  note "launch agent skipped (not macOS)"
elif [[ "$MODE" == all ]]; then
  if ((DRY_RUN)); then
    say "would make $LOG_DIR"
  else
    mkdir -p "$LOG_DIR"
  fi
  setup_agent
else
  rebuild_agent
fi

# --- Hooks -----------------------------------------------------------------

if [[ "$MODE" == all ]]; then
  if ((HOOKS)); then
    run "$NODE" "$ENTRY" install-claude-hooks
    note "Claude Code hooks installed (~/.claude/settings.json)"
    if ((!DRY_RUN)) && ! command -v operator-inbox >/dev/null 2>&1; then
      say "warning: operator-inbox is not on PATH in this shell, and the hooks run it from PATH; check pnpm's global bin folder is on PATH (pnpm setup)"
    fi
  else
    note "Claude Code hooks skipped (--no-hooks)"
  fi
fi

# --- Listen mode -----------------------------------------------------------

# Listen mode reads the Questions aloud with a local voice, Kokoro through
# mlx-audio (apps/cli/src/readout-kokoro.ts), which serve finds by the
# console script `uv tool install` puts in ~/.local/bin. Optional: setup
# installs it when uv is here, says how when it is not, and never fails for
# it. Only all does this; rebuild, which a sync job runs, installs nothing.
if [[ "$MODE" == all ]]; then
  if [[ -n "${OPERATOR_INBOX_READOUT_PYTHON:-}" ]] ||
    command -v mlx_audio.tts.generate >/dev/null 2>&1 ||
    [[ -x "$HOME/.local/bin/mlx_audio.tts.generate" ]]; then
    note "listen mode's voice (mlx-audio) is installed"
  elif command -v uv >/dev/null 2>&1; then
    if run uv tool install mlx-audio; then
      note "listen mode's voice (mlx-audio) installed with uv; its model downloads on first use"
    else
      note "listen mode's voice (mlx-audio) did not install; listen mode stays off until: uv tool install mlx-audio"
    fi
  else
    note "listen mode needs uv to install its voice: install uv, then run: uv tool install mlx-audio"
  fi
fi

# --- Answer check ----------------------------------------------------------

# Whether serve answered after a restart; rebuild fails when it did not (below).
answered=1
if ((AGENT_RUNNING)); then
  if ((DRY_RUN)); then
    say "would check $HEALTH_URL answers"
  else
    answered=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS -o /dev/null --max-time 2 "$HEALTH_URL" 2>/dev/null; then
        answered=1
        break
      fi
      sleep 1
    done
    if ((answered)); then
      note "serve answers at $HEALTH_URL"
    else
      note "serve did NOT answer at $HEALTH_URL yet; see $AGENT_LOG"
    fi
  fi
fi

# --- Desktop window --------------------------------------------------------

# The window is optional and its build takes minutes, so setup never builds
# it: it only says whether it is installed and current (read-only).
DESKTOP_APP="$ROOT/scripts/desktop-app.sh"
if [[ -f "$DESKTOP_APP" ]]; then
  note "$(bash "$DESKTOP_APP" check || true)"
fi

echo
say "summary${DRY_LABEL:+ (dry run: nothing changed)}:"
for line in "${SUMMARY[@]}"; do
  printf '  - %s\n' "$line"
done
if ((!DRY_RUN)); then
  echo
  say "to check this install at any time: operator-inbox doctor"
fi

# rebuild is what an unattended sync job runs, so a restart onto a build that
# does not answer is a failure it must see. all leaves it as a summary note:
# a person reads that summary, and the hooks and bin it set up stand anyway.
if [[ "$MODE" == rebuild ]] && ((!answered)); then
  echo "setup: serve did not answer at $HEALTH_URL after the restart; read $AGENT_LOG" >&2
  exit 1
fi
