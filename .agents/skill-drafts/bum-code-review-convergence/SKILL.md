---
name: bum-code-review-convergence
description: Review-to-fix convergence loop after execute-phase — multi-reviewer code rounds until MUST/SHOULD findings resolve. Use when the user types /bum-code-review-convergence.
---

# bum-code-review-convergence

Manual trigger: `/bum-code-review-convergence <phase> [--codex] [--claude] [--gemini] [--opencode] [--qwen] [--cursor] [--agy] [--all] [--max-cycles N] [--ws <name>]`.

## Inputs

- Phase number (required) + `--max-cycles N` (default 8) + `--ws <name>` passthrough.
- Reviewer lane flags: `--codex`, `--claude`, `--gemini`, `--opencode`, `--qwen`, `--cursor`, `--agy`, plus `--all` (every detected lane). Selection rule: explicit lane flags select EXACTLY those reviewers (overrides config); else `review.default_reviewers` from `.planning/config.json` when set; else all detected lanes. Drop any reviewer matching the implementer family. Selected-but-undetected lanes are reported as blocked; if none remain, run one inline code review (`bum-code-review` discipline: MUST/SHOULD/NIT with file:line + concrete fix, at least one key claim verified by native reads) as that round's review and mark it fallback. Genuinely unknown flags (typos, non-lane) are ignored no-ops. Context: read phase dir, PLAN.md, and SUMMARY.md with native file tools; diff via `git diff` scoped to phase files.

## Steps

1. Validate the phase exists in ROADMAP.md (error with available phases if not). Require executed work: stop with guidance to run `/bum-execute-phase N` first when no SUMMARY.md exists; stop when PLAN.md is missing (the review brief needs plan-fidelity grounding). Assemble the diff bundle: phase files from SUMMARY/PROGRESS plus `git diff` scoped to them. Print the startup banner (phase, resolved reviewers + source — flags/config/all — and max cycles).
2. Cycle: review the diff bundle with the resolved external reviewers (invoke each selected CLI directly, read-only, with the diff bundle; brief angles: correctness, edge cases, error handling, tests, security basics, plan fidelity) → parse the `CYCLE_SUMMARY` for unresolved MUST plus actionable SHOULD/NIT findings. Severity map for the gate: P0 = MUST (must-fix), P1 = SHOULD (should-fix), P2 = NIT (nice-to-have); the gate evaluates adjudicated (accepted, not declined) findings, deriving the P1/P2 split from the reviews' per-finding severities.
3. Adjudicate inline: accept/decline each finding with a one-line reason, recorded in `{phase_dir}/{padded_phase}-CODE-REVIEWS.md` (cumulative finding IDs F-01…, cycle-first-seen, status). Oscillation guard: a finding that reappears verbatim after its fix was applied and verified is marked `disputed` — disputed P1/P2 are declined with residuals noted; disputed P0s escalate (they block convergence, never silently declined).
4. Fix loop (accepted findings, severity desc): apply the smallest sufficient fix per finding with `muse.edit_file` (`muse.write_file` only for new files; one fix attempt per finding), then run its focused verification (the finding's repro or targeted test). If verification fails, revert that fix's files, mark the finding `blocked`, and continue to the next finding. After the pass, run the full project test command once (detect: Makefile `test` target, Justfile, `npm test`, `cargo test`, `go test ./...`, `pytest`; prefer one-shot mode, bounded timeout). If the suite passes, commit the pass atomically (`fix(<phase-slug>): review cycle N — F-01, F-02, …`); if red, revert the whole pass, mark its findings `blocked` with the suite evidence, and escalate (stop the loop). Never claim a fix is verified without running the relevant tests.
5. Two-phase gate. Cycles 1–3: if unresolved P0 or actionable P1/P2 remain and cycles are left, fix in this session, then re-review the full phase diff. After cycle 3: continue ONLY while adjudicated P0/P1 findings remain, up to `--max-cycles` (default 8); NITs-only converges with the residuals noted. If clean: converge and report with routing to `/bum-verify-work N`. If max cycles reached with P0/P1 open: escalate with the residual list. (`--max-cycles N` with N < 4 means the extended phase never runs.)
6. Stall display only — the inner review/fix gates do not apply to this outer loop.

## Outputs

- Converged code (fix commits + `{phase_dir}/{padded_phase}-CODE-REVIEWS.md` with per-cycle findings, adjudication, and CYCLE_SUMMARYs) with routing to `/bum-verify-work N` — or escalation listing unresolved P0/P1/blocked concerns + cycle count.

## Notes

- Single session, no nested delegation — all review orchestration and fixing stays on main; children must not spawn further agents. External reviewer CLIs are invoked read-only; all edits run inline.
- Invoking this skill authorizes the fix loop — no per-fix confirmation prompt (unlike the standalone `/bum-code-review` fix gate); escalation is the stop.
- Position: `execute-phase -> code-review-convergence -> verify-work`. Fixes land before verification so VERIFICATION.md evidence is recorded against final code.
- Diffs cost more per lane than plan bundles — setting `review.default_reviewers` to 1–2 lanes in `.planning/config.json` is recommended for code rounds.
