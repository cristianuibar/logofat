// Logofăt: versioned static harness-capability map (Phase 3: Routing Evidence).
//
// Inert-data module: types + frozen constants + pure functions only.
// Importing it has no side effects: no network, no child processes, no
// timers, no env reads, no filesystem access. It never throws.
//
// The rows are deliberately near-identical qualitative prose under the D-25
// honesty rule (03-RESEARCH §6): public benchmarks measure models, not the
// harness CLI wrappers, and no public harness-level measurements exist for
// `muse` vs `claude`. Per-harness differentiation lands via RTE-01 when
// harness-level evidence exists. Do not "improve" the prose with ungrounded
// differentiation.

import type { ProviderId } from "./providers.ts";

/** Abstract effort scale (D-30). Selected by effortFromScore in 03-03. */
export type EffortLevel = "low" | "standard" | "high";

/** One license-verified open dataset citation (D-25). */
export type CapabilitySource = { dataset: string; url: string; license: string };

/** One map row: suitability prose + source citations + effort descriptors. */
export type HarnessCapabilities = {
  suitability: string;
  sources: readonly CapabilitySource[];
  effortNotes: Record<EffortLevel, string>;
};

/** Map version. Bump on any row change, by commit (G-3). */
export const CAPABILITIES_VERSION = "1";

function freezeSource(source: CapabilitySource): CapabilitySource {
  return Object.freeze({ ...source });
}

function freezeRow(row: HarnessCapabilities): HarnessCapabilities {
  return Object.freeze({
    suitability: row.suitability,
    sources: Object.freeze(row.sources.map(freezeSource)),
    effortNotes: Object.freeze({ ...row.effortNotes }),
  });
}

function suitabilityFor(id: ProviderId): string {
  return (
    `${id} is a general-purpose coding CLI for routine edits through complex ` +
    `open-ended tasks (code generation, issue resolution, and terminal-ops task kinds). ` +
    `Public benchmarks measure models, not this CLI wrapper — no harness-level ranking is claimed.`
  );
}

function sourcesFor(): CapabilitySource[] {
  return [
    { dataset: "HumanEval", url: "https://github.com/openai/human-eval", license: "MIT" },
    {
      dataset: "Terminal-Bench 2.0",
      url: "https://github.com/laude-institute/terminal-bench",
      license: "Apache-2.0",
    },
    {
      dataset: "SWE-bench Multilingual",
      url: "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual",
      license: "MIT",
    },
  ];
}

function effortNotesFor(): Record<EffortLevel, string> {
  return {
    low: "Single quick pass with minimal exploration or verification.",
    standard: "Normal multi-step execution with diagnosis and verification.",
    high: "Extended execution with exploration budget for ambiguous or cross-cutting work.",
  };
}

/**
 * Versioned capability map, one row per v0.1 harness. Frozen top-to-bottom:
 * the map, each row, each sources array, each source object, each
 * effortNotes record.
 */
export const HARNESS_CAPABILITIES: Readonly<Record<ProviderId, HarnessCapabilities>> = Object.freeze({
  muse: freezeRow({ suitability: suitabilityFor("muse"), sources: sourcesFor(), effortNotes: effortNotesFor() }),
  claude: freezeRow({
    suitability: suitabilityFor("claude"),
    sources: sourcesFor(),
    effortNotes: effortNotesFor(),
  }),
});

/**
 * Selects the effort level for a difficulty Score. Pure.
 *
 * Precondition: `score` is a finite number. Validation lives upstream:
 * `parseDecision` rejects missing, mistyped, non-finite, and out-of-range
 * scores before this function ever sees them, so there is no NaN branch
 * here — the no-default rule is enforced at that boundary. Out-of-contract
 * input (NaN, negative, above range) falls through the plain comparisons
 * below to a deterministic level; callers must never rely on that.
 *
 * Cut points are nearest-level rounding over the `[0, 2]` Score range
 * (score.md §Reading a Score): `score < 0.5 → low`, `score < 1.5 →
 * standard`, else `high`. Each Score level corresponds 1:1 to an effort
 * level; fractional scores round to the nearest.
 */
export function effortFromScore(score: number): EffortLevel {
  if (score < 0.5) return "low";
  if (score < 1.5) return "standard";
  return "high";
}

/**
 * Builds the Choice `criteria` map for the available ids: exactly those ids
 * as keys, each value the capability prose from the map. Pure and total:
 * ids with no row are skipped (never throw, no fallback prose — fabricated
 * text would violate D-25); non-array input yields `{}`.
 */
export function renderCriteria(availableIds: readonly ProviderId[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  try {
    if (!Array.isArray(availableIds)) return {};
    for (const id of availableIds) {
      try {
        const row: HarnessCapabilities | undefined = (
          HARNESS_CAPABILITIES as Readonly<Record<string, HarnessCapabilities>>
        )[id as string];
        if (row === undefined || row === null || typeof row !== "object") continue;
        if (typeof row.suitability !== "string") continue;
        criteria[id as string] = row.suitability;
      } catch {
        continue;
      }
    }
  } catch {
    return {};
  }
  return criteria;
}
