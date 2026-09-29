// Pure session-routing rules. No I/O or state at import or call time.
import type { ProviderId } from "./providers.ts";
import type { RunOutcome } from "./runner/spawn.ts";

export const STICKY_MARGIN = 0.15;

type StickyOptions = {
  winner: ProviderId;
  probabilities: Readonly<Record<string, number>> | null;
  incumbent: ProviderId | null;
  availableIds: readonly ProviderId[];
};

function read(object: unknown, key: string): unknown {
  try {
    return object !== null && typeof object === "object"
      ? (object as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function available(ids: unknown, id: unknown): boolean {
  try {
    return Array.isArray(ids) && Array.prototype.includes.call(ids, id);
  } catch {
    return false;
  }
}

function probability(distribution: unknown, id: ProviderId): number {
  try {
    if (Array.isArray(distribution)) return 0;
    const value = read(distribution, id);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
      ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * FR-2/E-3/E-8: a challenger must strictly clear the margin. Missing or
 * hostile figures read as zero; unavailable incumbents do not engage.
 * Subtraction uses native doubles: 0.55 - 0.40 is 0.15000000000000002,
 * so that decimal-looking equality switches; computational equality stays.
 * Winner validation belongs upstream; an unavailable winner passes through.
 */
export function applyStickiness(options: StickyOptions): { harness: ProviderId; stayed: boolean } {
  const winner = read(options, "winner") as ProviderId;
  const incumbent = read(options, "incumbent") as ProviderId | null | undefined;
  const ids = read(options, "availableIds");
  if (incumbent == null || !available(ids, incumbent) || !available(ids, winner)) {
    return { harness: winner, stayed: false };
  }
  if (winner === incumbent) return { harness: winner, stayed: true };
  const probabilities = read(options, "probabilities");
  const diff = probability(probabilities, winner) - probability(probabilities, incumbent);
  return diff > STICKY_MARGIN
    ? { harness: winner, stayed: false }
    : { harness: incumbent, stayed: true };
}

/** FR-1/SP-A4: cancellation carries no fitness signal; unknown settles dethrone. */
export function nextIncumbent(
  incumbent: ProviderId | null,
  outcome: RunOutcome,
  harness: ProviderId,
): ProviderId | null {
  if (outcome === "ok") return harness === "muse" || harness === "claude" ? harness : null;
  if (outcome === "aborted") return incumbent === "muse" || incumbent === "claude" ? incumbent : null;
  return null;
}
