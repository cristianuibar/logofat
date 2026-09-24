// Logofăt: Pi extension entry point.
//
// Importing this module has no side effects. The default export is a factory
// that Pi calls with its ExtensionAPI, and it only registers the /route
// command. It does no detection, spawning, fetching, or timers.
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
 * Placeholder notice for a non-empty prompt, used until 01-03 wires provider
 * detection. 01-03 replaces it with the canonical ROUTING_NOTICE in
 * src/messages.ts.
 */
export const PLACEHOLDER_NOTICE =
  "Routing via Jev lands in Phase 2. Logofăt received your prompt, but provider detection is not wired yet, so nothing was executed.";

/**
 * Picks the response text for the raw `args` string. This is a pure
 * function. Everything after `/route` is one opaque prompt string. It is
 * trimmed only to classify help and blank input, and never split.
 */
export function renderRoute(args: string): string {
  const trimmed = args.trim();
  if (trimmed === "") return USAGE_HINT;
  if (trimmed === "--help" || trimmed === "-h") return HELP_TEXT;
  return PLACEHOLDER_NOTICE;
}

function emit(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
  ctx.ui.notify(text, "info");
  if (!ctx.hasUI) {
    pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true });
  }
}

export default function logofat(pi: ExtensionAPI): void {
  pi.registerCommand("route", {
    description: ROUTE_DESCRIPTION,
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      emit(pi, ctx, renderRoute(args));
    },
  });
}
