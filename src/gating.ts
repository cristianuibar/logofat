// Logofăt: three-tier confidence gating for Jev decisions (Phase 4).
//
// NEVER-THROW boundary module (providers.ts precedent): hostile input yields
// a fail-closed `{ verdict: "refuse", confidence: null }`, never a throw.
// Pure, no I/O, no state; importing this module has no side effects.
//
// The gate reads `decision.confidence` ONLY (D-39): Score confidence is
// difficulty uncertainty, never routing signal. The full `JevDecision` is the
// input so Phase 5 / future stakes can extend the signature compatibly (D-37).

import type { JevDecision, JevFailureClass } from "./jev.ts";
import type { EffortLevel } from "./capabilities.ts";
import type { ProviderId } from "./providers.ts";
import type { RunOutcome } from "./runner/spawn.ts";

/**
 * Refuse floor: below this the model is genuinely unsure (the TypeSafe
 * confidence doc's own 0.5 floor). Never moves without tuning evidence.
 */
export const CONFIDENCE_LOW = 0.5;

/**
 * Auto cut: at or above this the route proceeds without confirmation.
 * Conservative start (in the 2-harness case, >=90% of the probability mass
 * sits on the choice); moves within 0.7–0.9 only with a recorded rationale.
 */
export const CONFIDENCE_HIGH = 0.8;

/** Gating outcome: run automatically, ask for confirmation, or ask-or-refuse. */
export type Verdict = "auto" | "confirm" | "refuse";

/**
 * Verdict plus the usable confidence figure, or `null` when the figure was
 * malformed — the single malformed-check site feeding both the verdict and
 * the render branch (figure vs "unknown" wording).
 */
export type GateResult = { verdict: Verdict; confidence: number | null };

function refuseUnknown(): GateResult {
  return { verdict: "refuse", confidence: null };
}

/**
 * Gates a Jev decision through the three tiers. Malformed FIRST: a `null`,
 * non-number, non-finite, or out-of-`[0, 1]` confidence yields
 * `{ verdict: "refuse", confidence: null }` (the decision itself stays
 * valid — only the figure is unusable). Otherwise `c >= 0.8 → auto`,
 * `0.5 <= c < 0.8 → confirm`, `c < 0.5 → refuse`, each carrying `c`.
 * Total: hostile decision input (null, primitives, throwing getters)
 * yields the fail-closed refuse, zero throws.
 */
export function evaluateGate(decision: JevDecision): GateResult {
  let confidence: unknown;
  try {
    confidence = (decision as { confidence?: unknown } | null | undefined)?.confidence;
  } catch {
    return refuseUnknown();
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return refuseUnknown();
  if (confidence < 0 || confidence > 1) return refuseUnknown();
  if (confidence >= CONFIDENCE_HIGH) return { verdict: "auto", confidence };
  if (confidence >= CONFIDENCE_LOW) return { verdict: "confirm", confidence };
  return { verdict: "refuse", confidence };
}

// ---------------------------------------------------------------------------
// Decision tuples (Phase 4, plan 04-03): one fixed-shape JSON record per
// settled Jev call, written to stderr for later tuning. Fixed allowlists
// only: the record never contains the prompt, the API key, binary paths,
// versions, or response bodies.
// ---------------------------------------------------------------------------

/**
 * Success record. Key order is pinned by test (`ok` first, `latencyMs`
 * last): any new key needs a plan edit plus a NEVER-field review first.
 * `probabilities` holds the availableIds-filtered copy (malformed
 * distributions degrade to null); `scoreProbabilities` stays out — the
 * Score distribution is not routing signal.
 */
export type SuccessTuple = {
  ok: true;
  harness: ProviderId;
  effort: EffortLevel;
  difficulty: number;
  confidence: number | null;
  probabilities: Readonly<Record<string, number>> | null;
  scoreConfidence: number | null;
  verdict: Verdict;
  incumbent: ProviderId | null;
  sticky: "stay" | "switch" | "none";
  jevHarness: ProviderId;
  latencyMs: number;
};

/**
 * Failure record. Carries NO confidence keys (absent, not null) — the
 * never-invent proof.
 */
export type FailureTuple = { ok: false; class: JevFailureClass; latencyMs: number };

/** Where one tuple line goes. Production default is a lazy console.error. */
export type LogSink = (line: string) => void;

/**
 * Shallow-copies `probabilities` keeping `availableIds` keys only
 * (distribution keys are untrusted model output — verbatim logging would
 * exfiltrate model-output text to stderr). Unknown keys are dropped; a
 * non-empty input filtering to empty yields null (malformed-distribution
 * signal); null stays null and {} stays {}.
 */
function filterProbabilities(
  probabilities: Readonly<Record<string, number>> | null,
  availableIds: readonly ProviderId[],
): Readonly<Record<string, number>> | null {
  if (probabilities === null) return null;
  const allowed: readonly unknown[] = Array.isArray(availableIds) ? availableIds : [];
  const entries = Object.entries(probabilities);
  if (entries.length === 0) return {};
  const kept: Record<string, number> = {};
  let keptAny = false;
  for (const [key, value] of entries) {
    if (allowed.includes(key)) {
      kept[key] = value;
      keptAny = true;
    }
  }
  return keptAny ? kept : null;
}

/** Locked degenerate for hostile successTuple input (allowlist-shaped, recognizably bogus). */
function degenerateSuccess(): SuccessTuple {
  return {
    ok: true,
    // The bogus marker: "" is not a ProviderId, so this shape is
    // unreachable from the handler, which passes typed values.
    harness: "" as unknown as ProviderId,
    effort: "low",
    difficulty: 0,
    confidence: null,
    probabilities: null,
    scoreConfidence: null,
    verdict: "refuse",
    incumbent: null,
    sticky: "none",
    jevHarness: "" as unknown as ProviderId,
    latencyMs: 0,
  };
}

/**
 * Builds the success record, picking exactly the allowlist (decision
 * fields verbatim, verdict + timing from the call, probabilities filtered).
 * Pure and total: hostile input yields the locked degenerate, never throws.
 */
export function successTuple(input: {
  decision: JevDecision;
  verdict: Verdict;
  latencyMs: number;
  availableIds: readonly ProviderId[];
  incumbent?: ProviderId | null;
  sticky?: "stay" | "switch" | "none";
  jevHarness?: ProviderId;
}): SuccessTuple {
  try {
    const { decision, verdict, latencyMs, availableIds, incumbent = null, sticky = "none", jevHarness = decision.harness } = input;
    return {
      ok: true,
      harness: decision.harness,
      effort: decision.effort,
      difficulty: decision.difficulty,
      confidence: decision.confidence,
      probabilities: filterProbabilities(decision.probabilities, availableIds),
      scoreConfidence: decision.scoreConfidence,
      verdict,
      incumbent: incumbent === "muse" || incumbent === "claude" ? incumbent : null,
      sticky: sticky === "stay" || sticky === "switch" ? sticky : "none",
      jevHarness: jevHarness === "muse" || jevHarness === "claude" ? jevHarness : "" as unknown as ProviderId,
      latencyMs,
    };
  } catch {
    return degenerateSuccess();
  }
}

/**
 * Builds the failure record. Pure and total: hostile input yields
 * `{ok: false, class: "bad-response", latencyMs: 0}` (malformed input ≈
 * unusable answer), never throws.
 */
export function failureTuple(input: { class: JevFailureClass; latencyMs: number }): FailureTuple {
  try {
    return { ok: false, class: input.class, latencyMs: input.latencyMs };
  } catch {
    return { ok: false, class: "bad-response", latencyMs: 0 };
  }
}

/**
 * Writes one tuple as a single JSON line. Never throws, even on a hostile
 * sink or unstringifiable input — tuple loss must not break the route.
 */
export function writeTuple(sink: LogSink, tuple: SuccessTuple | FailureTuple | RunTuple): void {
  try {
    const line = JSON.stringify(tuple) ?? "null";
    try {
      sink(line);
    } catch {
      // The sink failed; the route continues without its tuple.
    }
  } catch {
    // Unstringifiable input; nothing to write, still no throw.
  }
}

// ---------------------------------------------------------------------------
// Run tuples (Phase 5, plan 05-03): one fixed-shape JSON record per settled
// run, through the same sink-injectable writer — no new sink seam. The Jev
// tuple records the routing judgment; the run tuple records what the
// judgment bought (effort calibration needs outcomes). Correlation with the
// Jev tuple is timestamp interleave. NEVER fields: prompt text, key, paths,
// versions, output excerpts, raw errors.
// ---------------------------------------------------------------------------

/**
 * Run record. Key order is pinned by test (`type` first, `runLatencyMs`
 * last). Absent numerics are OMITTED (never null — the D-42 absence rule).
 */
export type RunTuple = {
  type: "run";
  harness: ProviderId;
  effort: EffortLevel;
  outcome: RunOutcome;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  runLatencyMs: number;
};

/** Locked degenerate for hostile runTuple input (allowlist-shaped, recognizably bogus). */
function degenerateRun(): RunTuple {
  return {
    type: "run",
    // The bogus marker: "" is not a ProviderId, so this shape is
    // unreachable from the handler, which passes typed values.
    harness: "" as unknown as ProviderId,
    effort: "low",
    outcome: "spawn-error",
    timedOut: false,
    runLatencyMs: 0,
  };
}

/**
 * Builds the run record. Pure and total: identity fields (harness, effort,
 * outcome, timedOut, runLatencyMs) are validated — hostile values yield
 * the locked degenerate — while the measurement fields (exitCode, signal)
 * are omitted when unusable, never null. Never throws.
 */
export function runTuple(input: {
  harness: ProviderId;
  effort: EffortLevel;
  outcome: RunOutcome;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  runLatencyMs: number;
}): RunTuple {
  try {
    const { harness, effort, outcome, exitCode, signal, timedOut, runLatencyMs } = input;
    if (harness !== "muse" && harness !== "claude") return degenerateRun();
    if (effort !== "low" && effort !== "standard" && effort !== "high") return degenerateRun();
    if (
      outcome !== "ok" &&
      outcome !== "nonzero" &&
      outcome !== "timeout" &&
      outcome !== "aborted" &&
      outcome !== "spawn-error"
    ) {
      return degenerateRun();
    }
    if (typeof timedOut !== "boolean") return degenerateRun();
    if (typeof runLatencyMs !== "number" || !Number.isFinite(runLatencyMs)) return degenerateRun();
    return {
      type: "run",
      harness,
      effort,
      outcome,
      // Usable exit code (finite integer >= 0, the renderer's rule) or
      // omitted; usable signal (non-empty string) or omitted.
      ...(typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0
        ? { exitCode }
        : {}),
      ...(typeof signal === "string" && signal !== "" ? { signal } : {}),
      timedOut,
      runLatencyMs,
    };
  } catch {
    return degenerateRun();
  }
}
