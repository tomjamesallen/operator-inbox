#!/usr/bin/env bash
# Build Operator Inbox's desktop window, or check the one installed.
#
#   bash scripts/desktop-app.sh check
#   bash scripts/desktop-app.sh build [--dry-run]
#
# The window is `~/Applications/Operator Inbox.app`: a Pake build (Tauri over
# the system WebView) onto the server's page, http://127.0.0.1:7184. It shows
# nothing until `operator-inbox serve` is running. macOS only.
#
# check: read-only. Prints one line saying whether the window is installed and
# current, and exits 0 when it is (or when this is not macOS), 1 when it is
# missing, stale or another app sits at its name. setup.sh runs it and puts
# the line in its summary.
#
# build: needs Rust (rustc 1.85 or newer: brew install rust) and pake (3.17.4
# or newer: npm install -g pake-cli). A build is a Rust compile of minutes and
# fetches from the network (crates, pnpm). It installs the window, replacing
# an earlier build of it; a bundle at the name that is not this app is never
# overwritten. It never launches the window.
#
# --dry-run prints the pake command and changes nothing.
#
# Overrides, mostly for testing the script without touching the machine:
#   OPERATOR_INBOX_APPLICATIONS_DIR  where the window goes (default ~/Applications)

set -euo pipefail

NAME="Operator Inbox"
IDENTIFIER=com.operator-inbox.desktop
# serve's default port (SERVE_DEFAULT_PORT in packages/core/src/api/serve-port.ts).
# The URL is baked into the bundle, so a move needs a rebuild.
URL=http://127.0.0.1:7184
# The build's version, baked into the bundle as CFBundleShortVersionString.
# check calls an installed window stale when its version differs. Bump it
# whenever anything baked into the bundle changes: the URL, the name or the
# pake options below. (A changed icon is caught without a bump: check compares
# the bundled icon with the committed one.)
VERSION=1.3.0
PAKE_MIN=3.17.4
RUSTC_MIN=1.85

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Made from the web app's "Oi" icon (icon-any-512.png) by
# scripts/desktop-app/make-icon.mjs, with the macOS rounded mask, and committed.
# Pake bundles a local .icns as it is; with no --icon it would look an icon up
# online instead.
ICON="$ROOT/scripts/desktop-app/operator-inbox.icns"

APPS_DIR="${OPERATOR_INBOX_APPLICATIONS_DIR:-$HOME/Applications}"
BUNDLE="$APPS_DIR/$NAME.app"
# The hidden folders a build makes in APPS_DIR, each removed by the run that
# made it. One still there was left by a run that was killed.
STAGING_PREFIX=.operator-inbox-install-
PREVIOUS_PREFIX=.operator-inbox-previous-

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

MODE=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    check | build) MODE="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "desktop-app: unknown argument '$arg'" >&2
      usage >&2
      exit 2
      ;;
  esac
done
if [[ -z "$MODE" ]]; then
  usage >&2
  exit 2
fi

say() { printf 'desktop-app: %s\n' "$*"; }
die() {
  printf 'desktop-app: %s\n' "$*" >&2
  exit 1
}

# A key from a bundle's Info.plist, or nothing when it cannot be read.
plist_key() {
  /usr/bin/plutil -extract "$2" raw "$1/Contents/Info.plist" 2>/dev/null || true
}

# What sits at BUNDLE, into OBSERVED: absent, ours, or foreign, with why in
# FOREIGN_WHY. Globals rather than output, so it is never run in a subshell.
OBSERVED=""
FOREIGN_WHY=""
observe() {
  OBSERVED=foreign
  if [[ ! -e "$BUNDLE" ]]; then
    OBSERVED=absent
    return
  fi
  if [[ ! -f "$BUNDLE/Contents/Info.plist" ]]; then
    FOREIGN_WHY="it has no Contents/Info.plist"
    return
  fi
  local id
  id="$(plist_key "$BUNDLE" CFBundleIdentifier)"
  if [[ -z "$id" ]]; then
    FOREIGN_WHY="its Info.plist names no CFBundleIdentifier"
  elif [[ "$id" != "$IDENTIFIER" ]]; then
    FOREIGN_WHY="it is another app ($id, not $IDENTIFIER)"
  else
    OBSERVED=ours
  fi
}

# Why an installed window of ours is stale, or nothing when it is current.
staleness() {
  local version icon_file
  version="$(plist_key "$BUNDLE" CFBundleShortVersionString)"
  if [[ "$version" != "$VERSION" ]]; then
    printf 'its build is %s, this checkout builds %s' "${version:-unversioned}" "$VERSION"
    return
  fi
  icon_file="$(plist_key "$BUNDLE" CFBundleIconFile)"
  [[ -n "$icon_file" && "$icon_file" != *.icns ]] && icon_file="$icon_file.icns"
  if [[ -z "$icon_file" ]] || ! cmp -s "$BUNDLE/Contents/Resources/$icon_file" "$ICON"; then
    printf 'its icon differs from the committed one'
  fi
}

left_behind() {
  local d
  for d in "$APPS_DIR/$STAGING_PREFIX"* "$APPS_DIR/$PREVIOUS_PREFIX"*; do
    [[ -e "$d" ]] && printf '%s\n' "$d"
  done
  return 0
}

# --- check -----------------------------------------------------------------

check() {
  if [[ "$(uname -s)" != Darwin ]]; then
    echo "desktop window: not macOS, not checked"
    return 0
  fi
  local fix="bash scripts/desktop-app.sh build"
  local extra="" leftovers
  leftovers="$(left_behind | tr '\n' ' ')"
  [[ -n "$leftovers" ]] && extra="; also left behind by an earlier build, check and remove by hand: ${leftovers% }"
  observe
  case "$OBSERVED" in
    absent)
      echo "desktop window: $BUNDLE is not installed (optional; build it with: $fix)$extra"
      return 1
      ;;
    foreign)
      echo "desktop window: $BUNDLE is not this app: $FOREIGN_WHY (move it aside, then: $fix)$extra"
      return 1
      ;;
  esac
  local why
  why="$(staleness)"
  if [[ -n "$why" ]]; then
    echo "desktop window: $BUNDLE is stale, $why (rebuild it with: $fix)$extra"
    return 1
  fi
  echo "desktop window: $BUNDLE is current ($VERSION)$extra"
}

# --- build -----------------------------------------------------------------

# Is version "$1" at least "$2"? Numeric, part by part; a missing part is 0.
version_at_least() {
  local IFS=.
  # shellcheck disable=SC2206 # split on dots, on purpose
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    if ((10#$x != 10#$y)); then
      ((10#$x > 10#$y))
      return
    fi
  done
  return 0
}

# The first x.y or x.y.z in "$1", or nothing.
first_version() {
  [[ "$1" =~ ([0-9]+\.[0-9]+(\.[0-9]+)?) ]] && printf '%s' "${BASH_REMATCH[1]}"
  return 0
}

# Every missing or old tool is named in one go, so a fresh machine learns the
# whole list in one run.
check_toolchain() {
  local problems=() have
  if command -v pake >/dev/null 2>&1; then
    have="$(first_version "$(pake --version 2>/dev/null || true)")"
    if [[ -z "$have" ]] || ! version_at_least "$have" "$PAKE_MIN"; then
      problems+=("pake ${have:-of unknown version} is older than $PAKE_MIN; upgrade it with: npm install -g pake-cli@latest")
    fi
  else
    problems+=("pake is not on PATH; install it with: npm install -g pake-cli")
  fi
  if command -v rustc >/dev/null 2>&1; then
    have="$(first_version "$(rustc --version 2>/dev/null || true)")"
    if [[ -z "$have" ]] || ! version_at_least "$have" "$RUSTC_MIN"; then
      problems+=("rustc ${have:-of unknown version} is older than $RUSTC_MIN; upgrade it with: brew upgrade rust")
    fi
  else
    problems+=("rustc is not on PATH; install it with: brew install rust")
  fi
  command -v node >/dev/null 2>&1 || problems+=("node is not on PATH; it reads pake's result")
  if ((${#problems[@]})); then
    printf 'desktop-app: cannot build yet:\n' >&2
    printf '  - %s\n' "${problems[@]}" >&2
    exit 1
  fi
}

PAKE_ARGV=(
  pake "$URL"
  --name "$NAME"
  --identifier "$IDENTIFIER"
  --icon "$ICON"
  --app-version "$VERSION"
  --targets app
  # A Pake app otherwise reopens the URL it was last on, ahead of the baked-in
  # one, so a rebuild onto a new URL would still open the old one.
  --no-restore-last-url
  # WKWebView has no find bar of its own, so Cmd+F did nothing in the window.
  # This adds Pake's: Find, Find Next and Find Previous in the Edit menu on
  # Cmd+F, Cmd+G and Cmd+Shift+G, opening an in-page bar Pake injects
  # (src-tauri/src/inject/find.js; Enter and Shift+Enter step, Esc closes).
  # The menu's accelerators fire only in the window, so in a browser tab Cmd+F
  # stays the browser's own.
  --enable-find
  # macOS: no title bar. The traffic lights float over the page's top edge
  # and the page lays its header into the strip (apps/web/src/desktop-titlebar.ts
  # marks the root; index.css's titlebar: variant lay it out). Pake's own drag
  # bar there would take the header's clicks, so the page hides it and marks
  # its own empty header data-tauri-drag-region.
  --hide-title-bar
  # One JSON result on stdout, logs on stderr, Pake's own prompts off.
  --json
)

# The path of the .app pake reports in its JSON result "$1", or a reason on
# stderr and a non-zero exit.
built_app_path() {
  # shellcheck disable=SC2016 # JavaScript, not shell: nothing to expand
  node -e '
    const fs = require("node:fs");
    let r;
    try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8").trim()); }
    catch { console.error("pake printed no JSON result"); process.exit(1); }
    if (!r.ok) {
      const e = r.error ?? {};
      console.error(`pake reported ok:false: ${e.code ?? ""} ${e.message ?? ""}${e.hint ? ` (hint: ${e.hint})` : ""}`);
      process.exit(1);
    }
    const app = (r.outputs ?? []).find((o) => o.format === "app");
    if (!app) { console.error("pake reported ok:true but built no app"); process.exit(1); }
    process.stdout.write(app.path);
  ' "$1"
}

STAGING=""
BUILD_DIR=""
cleanup() {
  [[ -n "$STAGING" ]] && rm -rf "$STAGING"
  [[ -n "$BUILD_DIR" ]] && rm -rf "$BUILD_DIR"
  return 0
}

# Refuse unless BUNDLE is absent or ours.
plan() {
  observe
  if [[ "$OBSERVED" == foreign ]]; then
    die "refusing to overwrite $BUNDLE: $FOREIGN_WHY; move it aside and re-run"
  fi
}

# Swap the staged bundle "$1" in at BUNDLE. Our earlier build is moved into a
# hidden folder first, and put back if the swap fails.
place() {
  local staged="$1"
  plan
  if [[ ! -e "$BUNDLE" ]]; then
    mv "$staged" "$BUNDLE"
    return
  fi
  local keep
  keep="$(mktemp -d "$APPS_DIR/${PREVIOUS_PREFIX}XXXXXX")"
  mv "$BUNDLE" "$keep/"
  if mv "$staged" "$BUNDLE"; then
    rm -rf "$keep" || say "the previous build could not be removed; remove $keep by hand"
  else
    mv "$keep/$NAME.app" "$BUNDLE" && rmdir "$keep"
    die "could not move the new build to $BUNDLE; the previous build was put back"
  fi
}

build() {
  [[ "$(uname -s)" == Darwin ]] || die "the desktop window is a macOS app bundle; not built"
  [[ -f "$ICON" ]] || die "the icon $ICON is missing; nothing was built (without a local icon Pake looks one up online)"
  plan
  local leftover
  while IFS= read -r leftover; do
    [[ -n "$leftover" ]] && say "left behind by an earlier build: $leftover; check what is in it, then remove it by hand"
  done < <(left_behind)

  if ((DRY_RUN)); then
    printf 'desktop-app: would run:'
    printf ' %q' "${PAKE_ARGV[@]}"
    printf '\n'
    say "would install it at $BUNDLE"
    return
  fi
  check_toolchain

  trap cleanup EXIT
  # A closed terminal stops the build rather than leaving it compiling.
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -p "$APPS_DIR"
  # Made before the build, so a folder that cannot be written fails in
  # seconds rather than after minutes of Rust.
  STAGING="$(mktemp -d "$APPS_DIR/${STAGING_PREFIX}XXXXXX")"
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/operator-inbox-pake.XXXXXX")"

  say "building a window onto $URL with Pake (minutes; its progress follows)"
  local result="$BUILD_DIR/result.json" code=0
  (cd "$BUILD_DIR" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${PAKE_ARGV[@]}" </dev/null >"$result") || code=$?
  local built
  if ! built="$(built_app_path "$result")"; then
    die "pake exited $code; nothing was installed"
  fi
  [[ "$built" == /* ]] || built="$BUILD_DIR/$built"

  local built_id
  built_id="$(plist_key "$built" CFBundleIdentifier)"
  [[ "$built_id" == "$IDENTIFIER" ]] || die "pake built $built with CFBundleIdentifier ${built_id:-unreadable}, not $IDENTIFIER; nothing was installed"

  ditto "$built" "$STAGING/$NAME.app"
  place "$STAGING/$NAME.app"
  say "installed $BUNDLE ($VERSION)"
  say "it shows nothing until operator-inbox serve is running; if it is open, quit it with Cmd-Q (closing its window only hides it) and reopen it to load this build"
}

case "$MODE" in
  check) check ;;
  build) build ;;
esac
