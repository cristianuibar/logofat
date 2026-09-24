#!/usr/bin/env bash
# In-Pi smoke test for Logofăt /route (plan 01-04, task 3).
#
# Loads src/index.ts into the real `pi` binary in isolation and proves the
# Phase 1 success criteria end to end, plus the committed unit suite:
#
#   (1) env-report     real PATH: populated list with the routing notice, OR
#                      the no-harness guidance on a zero-harness machine
#   (2) golden         generated fixture PATH with fake muse/claude: the full
#                      expected provider list, character for character
#   (3) usage          bare /route: usage copy, no probe
#   (4) no-harness     fixture PATH with no harnesses: guidance, exit 0
#   (5) unit-suite     node --test 'test/*.test.ts' under the TAP wrapper
#
# Every Pi call uses the isolation set from test/output-contract.md
# (temp PI_CODING_AGENT_DIR and session dir, --no-session, --no-extensions,
# --no-skills, --no-context-files, --no-themes, </dev/null, per-call
# timeout 60) and is judged by test/lib/pi-json.mjs, never by pi's exit code.
# Markers are derived from src/messages.ts at run time, never pasted.
#
# Output: one `PASS (n) ...` or `FAIL (n) ...` line per check, evidence on
# indented lines below it, then a SUMMARY line. Exits non-zero if any check
# fails or if any of the five checks did not run.
#
# Automated checks only. The interactive TUI UAT is a separate human gate.
# Needs no model or API key: slash-command dispatch in print mode is
# credential-free.

set -uo pipefail

# Bound the whole run even when invoked directly (the plan's verify wraps it
# in `timeout 300` as well).
if [ -z "${LOGOFAT_SMOKE_BOUNDED:-}" ]; then
  export LOGOFAT_SMOKE_BOUNDED=1
  exec timeout 300 bash "$0" "$@"
fi

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO" || exit 1

WORK=$(mktemp -d "${TMPDIR:-/tmp}/logofat-smoke.XXXXXX") || exit 1
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The muse launcher self-updates in the background on --version; keep the
# real-PATH probe from touching the network.
export MUSE_NO_AUTO_UPDATE=1

# --- Node guard -------------------------------------------------------------

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
NODE_REAL=$(readlink -f "$(command -v node)")
echo "pi:   $PI_REAL $(timeout 30 "$PI_REAL" --version </dev/null 2>/dev/null | head -1)"

HELPER="$REPO/test/lib/pi-json.mjs"
MESSAGES_URL="file://$REPO/src/messages.ts"

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

# Builds a fixture bin dir holding only pi and node (plus whatever the caller adds).
make_fixture() {
  local dir=$1
  mkdir -p "$dir"
  ln -s "$PI_REAL" "$dir/pi"
  ln -s "$NODE_REAL" "$dir/node"
}

# run_pi <name> <PATH value> <prompt>: output lands in $WORK/<name>/.
run_pi() {
  local dir="$WORK/$1" path_value=$2 prompt=$3
  mkdir -p "$dir/agent" "$dir/sess"
  timeout 60 env PATH="$path_value" PI_CODING_AGENT_DIR="$dir/agent" \
    "$PI_REAL" --no-session --session-dir "$dir/sess" --no-extensions --no-skills \
    --no-context-files --no-themes --extension "$REPO/src/index.ts" \
    --print --mode json "$prompt" >"$dir/out.json" 2>"$dir/err.txt" </dev/null
  echo $? >"$dir/rc"
}

# assert_pi <dir> <marker>: runs the helper; its verdict line goes to $VERDICT.
VERDICT=""
assert_pi() {
  VERDICT=$(node "$HELPER" "$1/out.json" "$1/err.txt" "$2" 2>&1)
}

HEADING_RE='\*\*Detected providers \([0-2]/2\):\*\*'

# --- (1) env-report: real PATH ----------------------------------------------

check_env() {
  local n=1 label="env-report (real PATH)" dir="$WORK/env"
  run_pi env "$PATH" "/route smoke env report"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc" "$dir"
    return
  fi
  local notice guidance heading
  notice=$(marker ROUTING_NOTICE) || { fail $n "$label" "could not derive ROUTING_NOTICE"; return; }
  guidance=$(marker formatNoHarness) || { fail $n "$label" "could not derive formatNoHarness"; return; }
  heading=$(grep -oE "$HEADING_RE" "$dir/out.json" | head -1)

  if assert_pi "$dir" "$notice" && [ -n "$heading" ]; then
    pass $n "$label: populated branch" "heading: $heading" "notice: $notice" "$VERDICT"
    return
  fi
  local populated_verdict=$VERDICT
  if assert_pi "$dir" "$guidance"; then
    pass $n "$label: zero-harness guidance branch" "heading: ${heading:-<none>}" \
      "guidance: $(printf '%s' "$guidance" | head -1)" "$VERDICT"
    return
  fi
  fail $n "$label" "neither the populated branch (${populated_verdict}; heading='${heading}') nor the guidance branch ($VERDICT) matched" "$dir"
}

# --- (2) deterministic available-path golden --------------------------------

check_golden() {
  local n=2 label="golden (fixture muse + claude)" fix="$WORK/fix-golden/bin" dir="$WORK/golden"
  make_fixture "$fix"
  printf '#!/bin/sh\necho "Muse Code 7.7.7 (smoke)"\n' >"$fix/muse"
  printf '#!/bin/sh\necho "2.1.999 (Claude Code)"\n' >"$fix/claude"
  chmod +x "$fix/muse" "$fix/claude"

  local expected
  expected=$(LOGOFAT_MESSAGES_URL="$MESSAGES_URL" MUSE_BIN="$fix/muse" CLAUDE_BIN="$fix/claude" \
    node --input-type=module -e '
      const m = await import(process.env.LOGOFAT_MESSAGES_URL);
      process.stdout.write(m.formatProviderList([
        { id: "muse", binary: process.env.MUSE_BIN, version: "Muse Code 7.7.7 (smoke)", available: true },
        { id: "claude", binary: process.env.CLAUDE_BIN, version: "2.1.999 (Claude Code)", available: true },
      ]));
    ') || { fail $n "$label" "could not derive the expected list"; return; }

  run_pi golden "$fix:/usr/bin:/bin" "/route smoke golden"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc" "$dir"
    return
  fi
  if assert_pi "$dir" "$expected"; then
    pass $n "$label: full expected list matched" "$(printf '%s' "$expected" | sed -n 2p)" \
      "$(printf '%s' "$expected" | sed -n 3p)" "$VERDICT"
  else
    fail $n "$label" "$VERDICT; expected content:" "$dir"
    printf '%s\n' "$expected" | sed 's/^/    > /'
  fi
}

# --- (3) empty /route: usage ------------------------------------------------

check_usage() {
  local n=3 label="usage (bare /route)" dir="$WORK/usage"
  local usage
  usage=$(marker formatUsage) || { fail $n "$label" "could not derive formatUsage"; return; }
  run_pi usage "$PATH" "/route"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc" "$dir"
    return
  fi
  if assert_pi "$dir" "$usage"; then
    pass $n "$label" "$(printf '%s' "$usage" | head -1)" "$VERDICT"
  else
    fail $n "$label" "$VERDICT" "$dir"
  fi
}

# --- (4) no-harness fixture: guidance, exit 0 -------------------------------

check_no_harness() {
  local n=4 label="no-harness (fixture PATH)" fix="$WORK/fix-empty/bin" dir="$WORK/noharness"
  make_fixture "$fix"
  local d
  for d in "$fix" /usr/bin /bin; do
    if [ -e "$d/muse" ] || [ -e "$d/claude" ]; then
      fail $n "$label" "invalid fixture: $d contains a muse or claude binary"
      return
    fi
  done
  local guidance
  guidance=$(marker formatNoHarness) || { fail $n "$label" "could not derive formatNoHarness"; return; }
  run_pi noharness "$fix:/usr/bin:/bin" "/route smoke no harness"
  local rc
  rc=$(cat "$dir/rc")
  if [ "$rc" != "0" ]; then
    fail $n "$label" "pi exited $rc (the guidance path must exit 0)" "$dir"
    return
  fi
  local heading
  heading=$(grep -oE "$HEADING_RE" "$dir/out.json" | head -1)
  if ! assert_pi "$dir" "$guidance"; then
    fail $n "$label" "$VERDICT" "$dir"
    return
  fi
  if [ "$heading" != '**Detected providers (0/2):**' ]; then
    fail $n "$label" "guidance present but heading is '${heading:-<none>}', expected (0/2)" "$dir"
    return
  fi
  pass $n "$label: guidance with exit 0" "heading: $heading" \
    "guidance: $(printf '%s' "$guidance" | head -1)" "$VERDICT"
}

# --- (5) unit suite ---------------------------------------------------------

check_units() {
  local n=5 label="unit suite (node --test 'test/*.test.ts')"
  local out rc
  out=$(node --test --test-reporter=tap 'test/*.test.ts' 2>&1)
  rc=$?
  # Here-strings, not pipes: under pipefail an early-exiting `grep -q` can
  # SIGPIPE the writer and turn a match into status 141.
  local f0 p1 notok skip t0
  grep -qE '^# fail 0$' <<<"$out"; f0=$?
  grep -qE '^# pass [1-9][0-9]*$' <<<"$out"; p1=$?
  grep -qE '^not ok' <<<"$out"; notok=$?
  grep -q '# SKIP' <<<"$out"; skip=$?
  grep -qE '^# todo 0$' <<<"$out"; t0=$?
  local flags="rc=$rc f0=$f0 p1=$p1 notok=$notok skip=$skip t0=$t0"
  if [ $rc -eq 0 ] && [ $f0 -eq 0 ] && [ $p1 -eq 0 ] && [ $notok -ne 0 ] && [ $skip -ne 0 ] && [ $t0 -eq 0 ]; then
    pass $n "$label" "$(grep -E '^# (tests|pass|fail|todo) ' <<<"$out" | tr '\n' ' ')" "$flags"
  else
    fail $n "$label" "$flags"
    tail -40 <<<"$out" | sed 's/^/    | /'
  fi
}

check_env
check_golden
check_usage
check_no_harness
check_units

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
