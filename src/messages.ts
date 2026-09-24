// Logofăt: user-facing copy for /route.
//
// Pure functions only: no I/O, no Pi imports, no state. Every string the
// /route handler shows comes from here, and every automated check derives
// its expected marker from this module instead of pasting copy.
//
// The copy follows the Phase 1 UI-SPEC Copywriting Contract (amended by plan
// 01-03). The planning docs are not shipped, so the committed tests in
// test/messages.test.ts are the shipped contract for this copy.
//
// Install-command sources (verified 2026-09-24):
// - claude: `curl -fsSL https://claude.ai/install.sh | bash`, the native
//   install command from the official Claude Code setup page,
//   https://code.claude.com/docs/en/setup
// - muse: no public install page or installer command exists. Following the
//   UI-SPEC fallback (link the project URL, never invent a command), the
//   line names the official launcher URL, https://api.meta.ai/muse-launcher.sh.
//   That URL is the `launcher_url` embedded in the muse launcher itself and
//   serves the launcher. The "available to Meta employees" wording is the
//   launcher's own HTTP 403 message.
//
// Sanitizing: every interpolated field (id, binary path, version, reason)
// passes through sanitizeField before rendering. PATH directory names and
// `--version` output are untrusted, so terminal escapes, control characters,
// and markdown link syntax must not reach the transcript. Plain parentheses,
// brackets, and paths stay verbatim.

import { PROVIDER_IDS, REASON_VERSION_FAILED } from "./providers.ts";
import type { Provider, ProviderId } from "./providers.ts";

/** Shown 1 blank line after the provider rows, only when at least one harness is available. */
export const ROUTING_NOTICE = "Automatic routing isn't available yet — this list is the detection result only.";

export const USAGE_HEADING = "Usage: /route <prompt>";

export const USAGE_BODY = "Provide a prompt after /route, or run /route --help for usage. Nothing was executed.";

export const HELP_BODY =
  "Routes a prompt via the best harness (detection only for now; automatic routing lands in a later release).";

export const NO_HARNESS_HEADING = "**No harnesses detected.**";

/** "restart Pi" is the cache truth: detection results live for the Pi session. */
export const NO_HARNESS_INTRO = "Install one of the following, then restart Pi and re-run /route:";

export const INSTALL_LINES: Readonly<Record<ProviderId, string>> = Object.freeze({
  muse:
    "no public installer; Muse Code is available to Meta employees through Meta's internal install instructions (launcher: https://api.meta.ai/muse-launcher.sh)",
  claude: "curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)",
});

// ANSI/VT escape sequences: CSI (7-bit and 8-bit), OSC (terminated by BEL or
// ST, or unterminated to end of string), and two-byte ESC sequences.
const ANSI_SEQUENCES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[ -/]*[0-~]/g;

// C0 controls, DEL, C1 controls, and bidi override/isolate/mark characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

// Markdown inline link / image syntax is `[text](url)` with nothing between
// `]` and `(`. Inserting a space breaks the link without dropping characters.
const LINK_JOIN = /\]\(/g;

/**
 * Shared strip for every interpolated field. Removes terminal escape
 * sequences and non-printable control characters, then neutralizes markdown
 * link syntax. Nothing else changes.
 */
export function sanitizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(ANSI_SEQUENCES, "").replace(CONTROL_CHARS, "").replace(LINK_JOIN, "] (").trim();
}

/** Removes the `**` bold markers. The result is what `ctx.ui.notify` shows. */
export function toPlainText(copy: string): string {
  return copy.replaceAll("**", "");
}

function findRecord(providers: readonly Provider[], id: ProviderId): Provider | undefined {
  return providers.find((p) => p !== null && typeof p === "object" && p.id === id);
}

function isAvailable(record: Provider | undefined): boolean {
  return record !== undefined && record.available === true;
}

function formatRow(id: ProviderId, record: Provider | undefined): string {
  const safeId = sanitizeField(id);
  if (record !== undefined && record.available === true) {
    const binary = sanitizeField(record.binary) || safeId;
    const version = sanitizeField(record.version);
    return version === ""
      ? `- ${safeId}: available (${binary})`
      : `- ${safeId}: available (${binary}, ${version})`;
  }
  // A missing record or a missing reason cannot come from detectProviders();
  // render them like a failed probe rather than dropping the row.
  const reason = sanitizeField(record?.reason) || REASON_VERSION_FAILED;
  return `- ${safeId}: unavailable (${reason})`;
}

/** Number of harnesses with `available: true`, counted over the known ids. */
export function countAvailable(providers: readonly Provider[]): number {
  return PROVIDER_IDS.filter((id) => isAvailable(findRecord(providers, id))).length;
}

/**
 * Heading plus one row per known harness in the stable [muse, claude] order,
 * always, even at (0/2). The routing notice follows after 1 blank line only
 * when at least one harness is available.
 */
export function formatProviderList(providers: readonly Provider[]): string {
  const available = countAvailable(providers);
  const heading = `**Detected providers (${available}/${PROVIDER_IDS.length}):**`;
  const rows = PROVIDER_IDS.map((id) => formatRow(id, findRecord(providers, id)));
  const list = [heading, ...rows].join("\n");
  return available >= 1 ? `${list}\n\n${ROUTING_NOTICE}` : list;
}

/** The no-harness guidance block (D-06). The handler appends it after the (0/2) rows. */
export function formatNoHarness(): string {
  return [
    NO_HARNESS_HEADING,
    NO_HARNESS_INTRO,
    ...PROVIDER_IDS.map((id) => `- ${id}: ${INSTALL_LINES[id]}`),
  ].join("\n");
}

/**
 * The full /route response for a detection result: the provider list, plus
 * the guidance block after 1 blank line when nothing is available.
 */
export function formatDetectionResult(providers: readonly Provider[]): string {
  const list = formatProviderList(providers);
  return countAvailable(providers) === 0 ? `${list}\n\n${formatNoHarness()}` : list;
}

/** Empty `/route`: usage heading plus body. Nothing is executed or probed. */
export function formatUsage(): string {
  return `${USAGE_HEADING}\n${USAGE_BODY}`;
}

/** `/route --help` and `/route -h`. */
export function formatHelp(): string {
  return `${USAGE_HEADING}\n${HELP_BODY}`;
}
