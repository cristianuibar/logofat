// Logofăt: harness adapter dispatch (Phase 5, plan 05-02).
//
// Pure: no spawn, no I/O, no state. The handler calls `buildRunArgv` only;
// `null` (unknown harness or effort — hostile-only, `parseDecision`
// allowlists upstream) maps to `spawn-error` without spawning: never a
// default harness, never a throw.

import { buildArgv as buildClaudeArgv } from "./claude.ts";
import { buildArgv as buildMuseArgv } from "./muse.ts";
import type { EffortLevel } from "../../capabilities.ts";
import type { ProviderId } from "../../providers.ts";

export type HarnessAdapter = {
  buildArgv: (opts: { effort: EffortLevel; prompt: string }) => string[];
};

const ADAPTERS: Record<ProviderId, HarnessAdapter> = {
  muse: { buildArgv: buildMuseArgv },
  claude: { buildArgv: buildClaudeArgv },
};

/**
 * The effort values the adapters express. Validated with `hasOwn` before
 * any `buildArgv` call, so a hostile effort yields `null`, never a spawn
 * with a hole in argv. (One set for both adapters: their flag maps share
 * exactly these keys; drift fails closed to `spawn-error`.)
 */
const KNOWN_EFFORTS: Readonly<Record<EffortLevel, true>> = Object.freeze({
  low: true,
  standard: true,
  high: true,
});

/** Returns the adapter for a known harness id, else `null`. */
export function resolveAdapter(harness: ProviderId): HarnessAdapter | null {
  if (typeof harness !== "string" || !Object.hasOwn(ADAPTERS, harness)) return null;
  return ADAPTERS[harness];
}

/**
 * Validates harness AND effort, then builds the exact spawn argv. Returns
 * `null` on any hostile input (unknown harness/effort, non-string prompt).
 */
export function buildRunArgv(
  harness: ProviderId,
  effort: EffortLevel,
  prompt: string,
): string[] | null {
  const adapter = resolveAdapter(harness);
  if (adapter === null) return null;
  if (typeof effort !== "string" || !Object.hasOwn(KNOWN_EFFORTS, effort)) return null;
  if (typeof prompt !== "string") return null;
  return adapter.buildArgv({ effort, prompt });
}
