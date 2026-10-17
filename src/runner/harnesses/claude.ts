// Logofăt: `claude` harness adapter (Phase 5, plan 05-02).
//
// Pinned non-interactive contract, probed 2026-09-25 on Claude Code 2.1.281:
// `claude -p [prompt]` — "-p, --print: Print response and exit (useful for
// pipes)". The prompt is a positional argv element (`Arguments: prompt —
// Your prompt`), conveyed verbatim as ONE element under `shell: false`
// (05-RESEARCH §1.2). Effort knob `--effort <level>` (low, medium, high,
// xhigh, max): low → low, standard → medium, high → high; `xhigh`/`max`
// stay unused — no harness runs hotter than Jev judged. No
// policy/permission flags, no structured-output flags.
//
// Pure argv builder: no spawn, no I/O, no state. Asserts nothing —
// `resolveAdapter`/`buildRunArgv` in ./index.ts validate with `hasOwn`
// BEFORE calling, so this never sees a hostile effort (the effortFromScore
// precedent: no bad-input branch in the pure function, the no-default rule
// enforced at the boundary).

import type { EffortLevel } from "../../capabilities.ts";

/** Jev effort → `--effort` flag value. Frozen. */
const EFFORT_FLAG: Readonly<Record<EffortLevel, string>> = Object.freeze({
  low: "low",
  standard: "medium",
  high: "high",
});

export function buildArgv({ effort, prompt }: { effort: EffortLevel; prompt: string }): string[] {
  return ["-p", "--effort", EFFORT_FLAG[effort], "--", prompt];
}
