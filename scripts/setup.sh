#!/usr/bin/env bash
# Set up Operator Inbox on this machine, or rebuild and restart it.
#
#   bash scripts/setup.sh [all] [--no-hooks] [--dry-run]
#   bash scripts/setup.sh rebuild [--dry-run]
#
# all (the default): install the dependencies, build, link the
# `operator-inbox` bin globally, write the launch agent that runs
# `operator-inbox serve` and (re)load it, install the Claude Code hooks
# (unless --no-hooks), then check the server answers.
#
# rebuild: install the dependencies, build, and restart the launch agent only
# if it is already loaded. It never installs hooks and never loads an agent
# that is not loaded, so an external sync job can run it after a pull.
#
# --dry-run prints every action and changes nothing.
#
# Safe to re-run: the launch agent's plist is rendered for this machine on
# every run and is rewritten and reloaded only when it differs from the one
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
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  local dirs=("$(dirname "$NODE")") tool dir out="" d
  for tool in herdr; do
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
  for name in XDG_CONFIG_HOME XDG_STATE_HOME OPERATOR_INBOX_DATABASE_PATH; do
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

setup_agent() {
  local rendered
  rendered="$(mktemp "${TMPDIR:-/tmp}/operator-inbox-plist.XXXXXX")"
  # shellcheck disable=SC2064 # expand now: the path is local to this function
  trap "rm -f '$rendered'" RETURN
  render_plist >"$rendered"
  plutil -lint -s "$rendered" >/dev/null || {
    echo "setup: the rendered launch agent plist does not lint:" >&2
    plutil -lint "$rendered" >&2 || true
    exit 1
  }

  if [[ -f "$PLIST" ]] && cmp -s "$rendered" "$PLIST"; then
    say "launch agent plist $PLIST is up to date"
    if is_loaded; then
      run "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
      note "launch agent $LABEL restarted onto the new build"
    else
      run "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
      note "launch agent $LABEL loaded"
    fi
  else
    if ((DRY_RUN)); then
      say "would write $PLIST:"
      sed 's/^/    /' "$rendered"
    else
      mkdir -p "$LAUNCH_AGENTS_DIR"
      cp "$rendered" "$PLIST"
      say "wrote $PLIST"
    fi
    if is_loaded; then
      run "$LAUNCHCTL" bootout "$DOMAIN/$LABEL"
    fi
    run "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
    note "launch agent $LABEL written and loaded ($PLIST)"
  fi
  AGENT_RUNNING=1
}

restart_agent_if_loaded() {
  if is_loaded; then
    run "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
    note "launch agent $LABEL restarted onto the new build"
  else
    say "launch agent $LABEL is not loaded; left alone (run setup.sh to install it)"
    note "launch agent not loaded, so not restarted"
  fi
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
  restart_agent_if_loaded
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

# --- Answer check ----------------------------------------------------------

if [[ "$MODE" == all ]] && ((AGENT_RUNNING)); then
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
      note "serve did NOT answer at $HEALTH_URL yet; see $LOG_FILE"
    fi
  fi
fi

echo
say "summary${DRY_LABEL:+ (dry run: nothing changed)}:"
for line in "${SUMMARY[@]}"; do
  printf '  - %s\n' "$line"
done
