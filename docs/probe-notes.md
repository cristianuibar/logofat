# Harness probe notes

These are facts recorded from real binaries on the development machine. They
are **input for Phase 5 adapter work (plan 05-02)**. Nothing here is acted on
in Phase 1: Logofăt only runs `<bin> --version` to detect harnesses and does
not execute prompts yet.

Home-directory prefixes are redacted to `~`.

## Detector probe findings (2026-09-24)

### `detectProviders()` result on the development machine

Run directly (no Pi) with `MUSE_NO_AUTO_UPDATE=1` exported:

```json
[
  {
    "id": "muse",
    "binary": "~/.local/bin/muse",
    "version": "Muse Code 1.3.0 (1.3.0-R3401.1)",
    "available": true
  },
  {
    "id": "claude",
    "binary": "~/.local/share/mise/installs/claude/latest/claude",
    "version": "2.1.281 (Claude Code)",
    "available": true
  }
]
```

### Resolved binaries

| id | Resolved path | Kind |
|----|---------------|------|
| muse | `~/.local/bin/muse` | Bash launcher script (`#!/usr/bin/env bash`, about 32 KB). It self-updates, then `exec`s the real binary from its install dir. |
| claude | `~/.local/share/mise/installs/claude/latest/claude` | ELF x86-64 executable, installed via mise. `latest` is a mise-managed path; older versions sit next to it. |

### `--version` output (verbatim)

```text
$ muse --version
Muse Code 1.3.0 (1.3.0-R3401.1)

$ claude --version
2.1.281 (Claude Code)
```

Both print one line on stdout and exit 0. The formats differ (product name
first vs. version first), which is why the detector keeps the first non-empty
line as-is and does not parse it.

### `muse --version` side effect (P8 / Q7)

The `muse` launcher is a shell script, not the agent binary. On every
invocation, including `--version` and `--help`, it runs its update logic
before `exec`ing the real binary:

- If `MUSE_NO_AUTO_UPDATE` is not `1` and the last check is older than
  `MUSE_UPDATE_INTERVAL_SECONDS` (default 3600), it writes a timestamp to
  `<install dir>/.muse-update-checked-at`, then forks a background job that
  fetches from the network (`api.meta.ai` channel, `lookaside.facebook.com`
  downloads) and may rewrite the launcher and binary in the install dir.
- The background job runs as `( ... </dev/null >/dev/null 2>&1 & )`. It does
  not hold the probe's stdout/stderr pipes, so it cannot make the
  `--version` probe hang, and execFile's timeout does not need to wait for it.
- `MUSE_NO_AUTO_UPDATE=1` turns the check off. `MUSE_SYNC_UPDATE=1` makes the
  update run in the foreground instead (it would then count against the
  probe timeout).
- If the real binary is missing, the launcher tries a foreground install,
  unless `MUSE_NO_AUTO_UPDATE=1`, in which case it exits non-zero. The detector
  then reports `--version failed`.

**Phase 5 input:** detection probes, real-PATH checks, and smoke runs inherit
this network side effect. Phase 5 should decide whether to set
`MUSE_NO_AUTO_UPDATE=1` in the child env when executing muse, and whether to
document the behavior for users.

### Non-interactive flags from `--help` (Phase 5 input, not implemented)

#### muse

`muse --help` shows that a bare prompt starts the interactive TUI. The headless
entry point is the `exec` subcommand:

```text
Usage: muse exec [OPTIONS] [PROMPT]

  exec             Run one prompt non-interactively (headless)

      --json
          Emit machine-readable JSONL events on stdout
      --prompt-file <PATH>
          Read the prompt from a file instead of an argument
      --model <ID>
          Model id for non-echo providers
      --reasoning-effort <EFFORT>
          Meta reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra
          (default: high)
      --workspace <PATH>
          Root policy-gated workspace tools at PATH
      --max-model-steps <N>
          Cap the number of model steps
      --no-session-log
          Do not persist session event logs to disk
      --user-input-auto-resolve
          Offer request_user_input and auto-cancel prompts (headless)
      --approval-mode <MODE>
          Tool approval mode: untrusted|on-request|never (default: on-request)
      --approval-judge <off|on>
          LLM approval judge for Prompt-bound calls (default: on)

Safety (approval and the sandbox are ON by default):
      --yolo
          Disable approval and sandbox and trust this workspace (this run)
      --trust-workspace
          Load this workspace's skills and rules (this run)
      --disable-approval
          Disable tool approval prompts for this run
```

Candidate invocation for 05-02 (unverified; no prompt was executed):
`muse exec --json [--prompt-file <tmpfile>] <prompt>`. `--prompt-file` avoids
putting the prompt on the command line. `--user-input-auto-resolve` matters
because there is no TTY to answer `request_user_input`. `--reasoning-effort`
is a natural mapping target for the Jev effort score.

#### claude

`claude --help` shows that a bare prompt starts an interactive session. The
headless mode is `-p/--print`:

```text
  -p, --print                           Print response and exit (useful for
                                        pipes). Note: The workspace trust dialog
                                        is skipped when Claude is run in
                                        non-interactive mode (via -p, or when
                                        stdout is not a TTY, e.g. piped or
                                        redirected output). Only use this in
                                        directories you trust.
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming)
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
  --include-partial-messages            Include partial message chunks as they
                                        arrive (only works with --print and
                                        --output-format=stream-json)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (...) or "none"
                                        (nobody: anything that would prompt is
                                        denied automatically)
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session.
  --max-budget-usd <amount>             Maximum dollar amount to spend on API
                                        calls (only works with --print)
  --no-session-persistence              Disable session persistence (only works
                                        with --print)
  --verbose                             Override verbose mode setting from
                                        config
```

Candidate invocation for 05-02 (unverified; no prompt was executed):
`claude -p --output-format stream-json --verbose --permission-prompts none`,
with the prompt on stdin rather than argv. The 01-01 contract probe (P1)
found that an open stdin pipe hung Pi and piped data re-targeted its prompt.
Phase 5 should check whether claude behaves the same way and either close
stdin or write it fully. `--effort` maps directly
onto a Jev effort score.

### Out of scope here

- No adapter code, flag selection, or prompt execution happened in Phase 1.
- The detector does not follow symlinks to a real path. The resolved absolute
  `binary` is the inspectable fact (PATH-shadowing trust boundary T1). An
  execution-time guard belongs to Phase 5.
