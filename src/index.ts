// Logofăt: Pi extension entry point.
//
// Importing this module has no side effects. The default export is a factory
// that Pi calls with its ExtensionAPI, and it only registers the /route
// command. It does no detection, spawning, fetching, or timers, and it
// subscribes to no events.
//
// Detection is LAZY-ONLY (CONTEXT D-05, amended by plan 01-03). There is no
// startup probe and no session-lifecycle subscription. The first /route with
// a real prompt probes once; concurrent first callers share the in-flight
// promise; the settled result is cached in the factory closure for the rest
// of the session. Empty args and --help never probe.
//
// Output contract (test/output-contract.md):
// - Always call ctx.ui.notify(text, "info") once, with plain text only,
//   because notify renders `**` literally.
// - Also call the factory-captured pi.sendMessage with customType
//   CUSTOM_TYPE, but only when !ctx.hasUI (json/print modes). Under TUI or
//   RPC the custom message would display twice and enter model context.
// - The command context has no sendMessage method, and custom UI components
//   are prohibited. The host discards the handler's return value, so every
//   path must emit.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectProviders, PROVIDER_IDS, REASON_VERSION_FAILED } from "./providers.ts";
import type { Provider } from "./providers.ts";

/** customType literal named in test/output-contract.md. */
export const CUSTOM_TYPE = "logofat";

/** Short description shown in Pi's command list. */
export const ROUTE_DESCRIPTION = "Logofăt: route a prompt to the best installed harness (detection only in v0.1)";

/** `/route --help` copy (UI-SPEC). */
export const HELP_TEXT =
  "Usage: /route <prompt>\n" +
  "Routes a prompt via the best harness (detection only in v0.1; Jev routing lands in Phase 2).";

/** Empty-state copy (UI-SPEC): heading plus body. */
export const USAGE_HINT =
  "Usage: /route <prompt>\n" +
  "Provide a prompt after /route, or run /route --help for usage. Nothing was executed.";

/**
 * Placeholder notice for a non-empty prompt, used until the provider list is
 * rendered. Plan 01-03 task 2 replaces it with src/messages.ts copy.
 */
export const PLACEHOLDER_NOTICE =
  "Routing via Jev lands in Phase 2. Logofăt received your prompt, but provider detection is not wired yet, so nothing was executed.";

/** Injectable seams for createRoute. Tests pass fake detectors here. */
export type RouteDeps = {
  detect?: typeof detectProviders;
};

/**
 * The result used when detection rejects or returns something unusable:
 * every known harness as an unavailable row with the `--version failed`
 * reason. Detection failures never propagate to the handler.
 */
export function allUnavailable(): Provider[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    binary: id,
    version: null,
    available: false,
    reason: REASON_VERSION_FAILED,
  }));
}

/**
 * Picks the response text for usage-level input, or null when `args` is a
 * real prompt. This is a pure function. Everything after `/route` is one
 * opaque prompt string. It is trimmed only to classify help and blank input,
 * and never split.
 */
export function renderUsage(args: string): string | null {
  const trimmed = args.trim();
  if (trimmed === "") return USAGE_HINT;
  if (trimmed === "--help" || trimmed === "-h") return HELP_TEXT;
  return null;
}

function emit(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
  ctx.ui.notify(text, "info");
  if (!ctx.hasUI) {
    pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true });
  }
}

/**
 * Registers /route on `pi`. Internal seam: the default export calls this
 * with the real detector, and tests call it with fakes.
 *
 * The session cache lives in THIS closure, never at module scope, so two
 * factory calls (separate sessions, /reload, or tests) never share state.
 */
export function createRoute(pi: ExtensionAPI, deps: RouteDeps = {}): void {
  const detect = deps.detect ?? detectProviders;
  const state: { cached: Provider[] | null; inflight: Promise<Provider[]> | null } = {
    cached: null,
    inflight: null,
  };

  // Phase 6 (ROUTE-03) adds the user-facing `providers refresh` command. It
  // reuses detectProviders() and resets this cache; nothing here builds it.
  function getProviders(): Promise<Provider[]> {
    if (state.cached !== null) return Promise.resolve(state.cached);
    if (state.inflight === null) {
      state.inflight = Promise.resolve()
        .then(() => detect())
        .then(
          (result) => (Array.isArray(result) ? result : allUnavailable()),
          () => allUnavailable(),
        )
        .then((result) => {
          state.cached = result;
          state.inflight = null;
          return result;
        });
    }
    return state.inflight;
  }

  pi.registerCommand("route", {
    description: ROUTE_DESCRIPTION,
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const usage = renderUsage(args);
      if (usage !== null) {
        emit(pi, ctx, usage);
        return;
      }
      await getProviders();
      emit(pi, ctx, PLACEHOLDER_NOTICE);
    },
  });
}

export default function logofat(pi: ExtensionAPI): void {
  createRoute(pi);
}
