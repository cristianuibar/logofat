# nabu

## What This Is

nabu is a Pi coding-agent extension (installable via `pi install`) that adds a `/route <prompt>` command to Pi. The command sends the prompt plus an auto-detected list of available external harnesses to Jev (TypeSafe's System One model), which picks the best harness and effort level for the task. nabu then runs the prompt on that external harness and streams live status back inside the Pi session. Anyone who installs nabu gets the same setup, and it works the same on any machine it is installed on.

## Core Value

Type `/route <prompt>` in Pi and have the prompt executed by the best external harness for the job — automatically chosen, with live progress visible in Pi.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] `/route <prompt>` command passes the prompt to Jev with the available-providers list and routes per Jev's answer
- [ ] Auto-detect installed external harnesses on the system and build the available-providers list (v0.1: muse and claude)
- [ ] Provider list refresh command (`route providers refresh` or equivalent) to regenerate the list when harnesses change
- [ ] Static harness capability map (which harness/effort is better for which task kinds) built from open online benchmarks, maintained via code changes
- [ ] Task-difficulty signal for Jev (Jev decides, or documented difficulty examples per task kind)
- [ ] Live subagent display inside Pi: per-harness color, short status line (a few words) tracking remote progress
- [ ] Installable via `pi install` from this repo; works on this system and any other system it is installed on

### Out of Scope

- [Full harness fork] — decided: extension package layering on main Pi releases, not a fork — keeps tracking upstream pi
- [v0.1 harnesses beyond muse + claude] — cursor, codex, grok deferred past v0.1 — keep initial scope to two harnesses
- [Version 1.0 scope] — first milestone is v0.1 — too early for v1 guarantees

## Context

- Main Pi harness: `pi` binary (mise-installed), user config in `~/.pi/agent` (skills, prompts, themes, settings); `pi list` currently shows no packages installed
- Pi extensions are TypeScript modules (`ExtensionAPI`: `registerCommand`, `registerTool`, `on`, providers, UI renderers); distributed via Pi packages / `pi install <source>`
- Jev API: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`, body `{state, model: "jev-latest", questions: {...}}`; answers return under caller-chosen question keys (Choice picks one harness; Score/Noul can carry difficulty/confidence)
- Routing-relevant TypeSafe patterns: intent routing, confidence-gated routing, speculative fan-out
- Execution mechanism for the remote harness run (tmux vs alternatives) is an explicit research item — user expects the research phase to discover this
- Open items carried into research/requirements: exact non-interactive CLI flags for muse + claude; Jev-unreachable fallback (fail loudly vs default harness)

## Constraints

- **[Install]**: Must install via `pi install` source and update via `pi update` — no manual `~/.pi` surgery on target machines
- **[Upstream]**: Extension, not fork — must keep working across main Pi releases
- **[Benchmarks]**: Capability map must come from open benchmark data with usable licensing — no closed/proprietary data
- **[Scope]**: v0.1 proves local-first (works here first); cross-machine portability follows the same install path

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Extension package, not harness fork | Stays on main pi releases; layers on top via `pi install` | — Pending |
| Jev (`jev-latest`) decides harness + effort per prompt | Semantic routing judgment is what System One models are for; code owns execution | — Pending |
| v0.1 routes to muse + claude only | Smallest set that proves the loop; cursor/codex/grok later | — Pending |
| Static capability map in code, updated by commits | Models/harnesses change infrequently; explicit change history | — Pending |
| Execution mechanism (tmux vs alternatives) decided in research | User explicitly deferred; needs ecosystem comparison | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-24 after initialization*
