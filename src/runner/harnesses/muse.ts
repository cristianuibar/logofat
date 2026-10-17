// Logofăt: `muse` harness adapter (Phase 5, plan 05-02).
//
// Pinned non-interactive contract, probed 2026-09-25 on Muse Code 1.4.0
// (1.4.0-R4161.1): `muse exec [OPTIONS] [PROMPT]` — "run one prompt
// non-interactively (headless)". The prompt is a positional argv element,
// conveyed verbatim as ONE element under `shell: false` (05-RESEARCH
// §1.1). Effort knob `--reasoning-effort
// none|minimal|low|medium|high|xhigh|max|ultra`: low → low, standard →
// medium, high → high — the three names exist verbatim in the probed value
// list, the ordering is monotonic, and the always-explicit flag removes the
// `high` default from the equation, so the Jev-chosen effort is what runs.
// No policy/permission flags, no structured-output flags.
//
// Pure argv builder: no spawn, no I/O, no state. Asserts nothing —
// `resolveAdapter`/`buildRunArgv` in ./index.ts validate with `hasOwn`
// BEFORE calling, so this never sees a hostile effort (the effortFromScore
// precedent: no bad-input branch in the pure function, the no-default rule
// enforced at the boundary).

import type { EffortLevel } from "../../capabilities.ts";

/** Jev effort → `--reasoning-effort` flag value. Frozen. */
const EFFORT_FLAG: Readonly<Record<EffortLevel, string>> = Object.freeze({
  low: "low",
  standard: "medium",
  high: "high",
});

export function buildArgv({ effort, prompt }: { effort: EffortLevel; prompt: string }): string[] {
  return ["exec", "--reasoning-effort", EFFORT_FLAG[effort], "--", prompt];
}
