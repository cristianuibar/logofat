#!/usr/bin/env bash
# Install-contract test for Logofăt (plan 06-04, task 1).
#
# Proves `pi install <checkout>` + both commands + `pi update --extensions`
# against the real `pi` binary in isolation:
#
#   (1) install        pi install <repo> (absolute local path): rc=0, `pi
#                      list` names it, settings declaration exists
#   (2) route-help     /route --help through the INSTALLED package (no
#                      --extension, no --no-extensions): help marker, clean stderr
#   (3) refresh-help   /route-providers --help through the INSTALLED package
#   (4) refresh-list   bare /route-providers (real-PATH detection-only probe,
#                      key stripped, no Jev): heading + first-detection note
#   (5) update         pi update --extensions: rc=0 (never bare pi update)
#
# Every Pi call uses an isolated HOME + PI_CODING_AGENT_DIR, strips
# TYPESAFE_API_KEY, sets MUSE_NO_AUTO_UPDATE=1, and runs under per-call
# timeout 60 with </dev/null and separate out/err files. Command output is
# judged by test/lib/pi-json.mjs, never by pi's exit code alone. Markers are
# derived from src/messages.ts at run time, never pasted.
#
# Output: one `PASS (n) ...` or `FAIL (n) ...` line per check, evidence on
# indented lines below it, then a SUMMARY line. Exits non-zero if any check
# fails or if any of the five checks did not run.
#
# Needs no model or API key: slash-command dispatch in print mode is
# credential-free, and the key is stripped so no Jev call is possible (the
# refresh path resolves no key at all).

set -uo pipefail

# Bound the whole run even when invoked directly.
if [ -z "${LOGOFAT_INSTALL_BOUNDED:-}" ]; then
  export LOGOFAT_INSTALL_BOUNDED=1
  exec timeout 300 bash "$0" "$@"
fi

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO" || exit 1

WORK=$(mktemp -d "${TMPDIR:-/tmp}/logofat-install.XXXXXX") || exit 1
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The muse launcher self-updates in the background on --version; keep the
# real-PATH probe from touching the network.
export MUSE_NO_AUTO_UPDATE=1

# --- Node + pi guards (mirroring smoke-pi.sh) --------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node not found on PATH (Node >= 24 required)" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
echo "node: $(command -v node) $(node --version) ($(node -p process.execPath))"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "FATAL: Node >= 24 is required for native .ts type stripping (found $(node --version))" >&2
  exit 1
fi

PI_BIN=$(command -v pi 2>/dev/null || true)
if [ -z "$PI_BIN" ]; then
  echo "FATAL: pi not found on PATH" >&2
  exit 1
fi
PI_REAL=$(readlink -f "$PI_BIN")
echo "pi:   $PI_REAL $(timeout 30 "$PI_REAL" --version </dev/null 2>/dev/null | head -1)"

HELPER="$REPO/test/lib/pi-json.mjs"
MESSAGES_URL="file://$REPO/src/messages.ts"

# Isolated identity for every pi call below: nothing touches the real HOME
# or the real agent dir.
HOME_DIR="$WORK/home"
AGENT_DIR="$WORK/agent"
mkdir -p "$HOME_DIR" "$AGENT_DIR"

# --- Helpers ----------------------------------------------------------------

FAILURES=0
RAN=""

pass() { # n label evidence...
  local n=$1 label=$2
  shift 2
  echo "PASS ($n) $label"
  local line
  for line in "$@"; do printf '    %s\n' "$line"; done
  RAN="$RAN $n"
}

fail() { # n label reason [dir]
  local n=$1 label=$2 reason=$3 dir=${4:-}
  echo "FAIL ($n) $label: $reason"
  if [ -n "$dir" ]; then
    printf '    pi exit code: %s\n' "$(cat "$dir/rc" 2>/dev/null || echo '?')"
    echo "    --- stdout ($dir/out.json) ---"
    sed 's/^/    | /' "$dir/out.json" 2>/dev/null | head -40
    echo "    --- stderr ($dir/err.txt) ---"
    sed 's/^/    | /' "$dir/err.txt" 2>/dev/null | head -40
  fi
  FAILURES=$((FAILURES + 1))
  RAN="$RAN $n"
}

# Prints an export of src/messages.ts: a constant, or a zero-argument function's result.
marker() {
  LOGOFAT_MESSAGES_URL="$MESSAGES_URL" node --input-type=module -e '
    const m = await import(process.env.LOGOFAT_MESSAGES_URL);
    const v = m[process.argv[1]];
    if (v === undefined) { console.error("unknown export " + process.argv[1]); process.exit(2); }
    process.stdout.write(typeof v === "function" ? v() : v);
  ' "$1"
}

# Management commands (install/list/update) use an inline `env` under
# `timeout` at each call site — a shell function is not an executable and
# cannot sit under `timeout`, so there is deliberately no helper for them.

# run_installed <name> <PATH value> <prompt>: output lands in $WORK/<name>/.
# Like smoke-pi.sh's run_pi, but through the INSTALLED package: no
# --extension flag and no --no-extensions.
run_installed() {
  local dir="$WORK/$1" path_value=$2 prompt=$3
  mkdir -p "$dir/sess"
  timeout 60 env -u TYPESAFE_API_KEY PATH="$path_value" HOME="$HOME_DIR" PI_CODING_AGENT_DIR="$AGENT_DIR" \
    MUSE_NO_AUTO_UPDATE=1 \
    "$PI_REAL" --no-session --session-dir "$dir/sess" --no-skills \
    --no-context-files --no-themes \
    --print --mode json "$prompt" >"$dir/out.json" 2>"$dir/err.txt" </dev/null
  echo $? >"$dir/rc"
}

# assert_pi <dir> <marker>: runs the helper; its verdict line goes to $VERDICT.
VERDICT=""
assert_pi() {
  VERDICT=$(node "$HELPER" "$1/out.json" "$1/err.txt" "$2" 2>&1)
}

HEADING_RE='\*\*Detected providers \([0-2]/2\):\*\*'

# --- (1) install: pi install <repo> -------------------------------------------

check_install() {
  local n=1 label="install (pi install <repo>)" dir="$WORK/install"
  mkdir -p "$dir"
  timeout 60 env -u TYPESAFE_API_KEY HOME="$HOME_DIR" PI_CODING_AGENT_DIR="$AGENT_DIR" \
    "$PI_REAL" install "$REPO" >"$dir/out.json" 2>"$dir/err.txt" </dev/null
  local rc=$?
  echo "$rc" >"$dir/rc"
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi install exited $rc" "$dir"
    return
  fi
  local list
  list=$(timeout 60 env -u TYPESAFE_API_KEY HOME="$HOME_DIR" PI_CODING_AGENT_DIR="$AGENT_DIR" \
    "$PI_REAL" list </dev/null 2>"$dir/list-err.txt") || {
    fail $n "$label" "pi list failed" "$dir"
    return
  }
  # Local packages list by path, not by package name.
  if ! printf '%s' "$list" | grep -qF "$REPO"; then
    fail $n "$label" "pi list does not name the repo path: $(printf '%s' "$list" | head -5 | tr '\n' ';')" "$dir"
    return
  fi
  if [ ! -f "$AGENT_DIR/settings.json" ]; then
    fail $n "$label" "no settings declaration at $AGENT_DIR/settings.json" "$dir"
    return
  fi
  if ! grep -q '"packages"' "$AGENT_DIR/settings.json"; then
    fail $n "$label" "settings declaration has no packages entry" "$dir"
    return
  fi
  pass $n "$label" "rc=0" "pi list names the repo path" "settings: $AGENT_DIR/settings.json"
}

# --- (2) /route --help through the installed package --------------------------

check_route_help() {
  local n=2 label="route-help (installed /route --help)" dir="$WORK/routehelp"
  local help
  help=$(marker formatHelp) || { fail $n "$label" "could not derive formatHelp"; return; }
  run_installed routehelp "$PATH" "/route --help"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc" "$dir"
    return
  fi
  if assert_pi "$dir" "$help"; then
    pass $n "$label" "$(printf '%s' "$help" | head -1)" "$VERDICT"
  else
    fail $n "$label" "$VERDICT" "$dir"
  fi
}

# --- (3) /route-providers --help through the installed package ----------------

check_refresh_help() {
  local n=3 label="refresh-help (installed /route-providers --help)" dir="$WORK/refreshhelp"
  local help
  help=$(marker formatRefreshHelp) || { fail $n "$label" "could not derive formatRefreshHelp"; return; }
  run_installed refreshhelp "$PATH" "/route-providers --help"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc" "$dir"
    return
  fi
  if assert_pi "$dir" "$help"; then
    pass $n "$label" "$(printf '%s' "$help" | head -1)" "$VERDICT"
  else
    fail $n "$label" "$VERDICT" "$dir"
  fi
}

# --- (4) bare /route-providers through the installed package ------------------

check_refresh_list() {
  local n=4 label="refresh-list (installed bare /route-providers)" dir="$WORK/reflist"
  local note
  note=$(marker formatFirstDetectionNote) || { fail $n "$label" "could not derive formatFirstDetectionNote"; return; }
  run_installed reflist "$PATH" "/route-providers"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc" "$dir"
    return
  fi
  local heading
  heading=$(grep -oE "$HEADING_RE" "$dir/out.json" | head -1)
  if [ -z "$heading" ]; then
    fail $n "$label" "no provider heading in output" "$dir"
    return
  fi
  if assert_pi "$dir" "$note"; then
    pass $n "$label" "heading: $heading" "note: $note" "$VERDICT"
  else
    fail $n "$label" "$VERDICT" "$dir"
  fi
}

# --- (5) update: pi update --extensions ---------------------------------------

check_update() {
  local n=5 label="update (pi update --extensions)" dir="$WORK/update"
  mkdir -p "$dir"
  # NEVER bare `pi update`: it updates Pi itself (network + self-modification).
  timeout 60 env -u TYPESAFE_API_KEY HOME="$HOME_DIR" PI_CODING_AGENT_DIR="$AGENT_DIR" \
    "$PI_REAL" update --extensions >"$dir/out.json" 2>"$dir/err.txt" </dev/null
  local rc=$?
  echo "$rc" >"$dir/rc"
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi update --extensions exited $rc" "$dir"
    return
  fi
  pass $n "$label" "rc=0" "$(head -2 "$dir/out.json" | tr '\n' ';')"
}

check_install
check_route_help
check_refresh_help
check_refresh_list
check_update

if [ "$(echo $RAN)" != "1 2 3 4 5" ]; then
  echo "FAIL (set) expected checks 1 2 3 4 5 to run, ran:${RAN:- none}"
  FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "SUMMARY: $FAILURES failure(s)"
  exit 1
fi
echo "SUMMARY: 5/5 checks passed"
exit 0
