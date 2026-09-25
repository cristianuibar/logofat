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
// - muse: no public installer command exists. Following the UI-SPEC fallback
//   (link the project URL, never invent a command), the line points at
//   https://dev.meta.ai/, the install reference the user supplied at the
//   01-04 UAT checkpoint.
//
// Sanitizing: every interpolated field (id, binary path, version, reason)
// passes through sanitizeField before rendering. PATH directory names and
// `--version` output are untrusted, so terminal escapes, control characters,
// and markdown link syntax must not reach the transcript. Plain parentheses,
// brackets, and paths stay verbatim.

import { PROVIDER_IDS, REASON_VERSION_FAILED } from "./providers.ts";
import type { Provider, ProviderId } from "./providers.ts";
import type { JevFailureClass } from "./jev.ts";

/** Shown after the decision line on the Jev success path (Phase 2: decision only, execution later). */
export const EXECUTION_NOTICE =
  "The prompt was not executed — running it on the chosen harness lands in a later release.";

/** Notify-only pre-emit on the Jev path. Never sent via sendMessage. */
export const LOADING_LINE = "Asking Jev to choose a harness…";

export const MISSING_KEY_HEADING = "**Jev API key missing.**";

export const MISSING_KEY_INTRO =
  "/route needs a TypeSafe API key to choose a harness. Provide it one of these ways, then re-run /route:";

export const USAGE_HEADING = "Usage: /route <prompt>";

export const USAGE_BODY = "Provide a prompt after /route, or run /route --help for usage. Nothing was executed.";

export const HELP_BODY = "Shows the Jev-chosen harness for a prompt (execution lands in a later release).";

export const NO_HARNESS_HEADING = "**No harnesses detected.**";

/** "restart Pi" is the cache truth: detection results live for the Pi session. */
export const NO_HARNESS_INTRO = "Install one of the following, then restart Pi and re-run /route:";

export const INSTALL_LINES: Readonly<Record<ProviderId, string>> = Object.freeze({
  muse: "see https://dev.meta.ai/ for install instructions",
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
 * always, even at (0/2). Bare list only: the handler appends the decision or
 * guidance block after 1 blank line.
 */
export function formatProviderList(providers: readonly Provider[]): string {
  const available = countAvailable(providers);
  const heading = `**Detected providers (${available}/${PROVIDER_IDS.length}):**`;
  const rows = PROVIDER_IDS.map((id) => formatRow(id, findRecord(providers, id)));
  return [heading, ...rows].join("\n");
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

/** Missing-key guidance: heading + intro + 2 setup lines. Key values never appear here. */
export function formatMissingKey(): string {
  return [
    MISSING_KEY_HEADING,
    MISSING_KEY_INTRO,
    "- TYPESAFE_API_KEY environment variable (restart Pi after setting it)",
    `- logofat.typesafeApiKey in Pi settings.json, e.g. { "logofat": { "typesafeApiKey": "YOUR_KEY" } }`,
  ].join("\n");
}

/**
 * Success decision line. The id passed allowlist validation already; it is
 * still routed through sanitizeField for defense in depth (validated ids
 * render verbatim).
 */
export function formatDecisionLine(harness: ProviderId): string {
  return `Jev routed this prompt to **${sanitizeField(harness)}**.`;
}

/** Per-class Jev error blocks: heading + what-happened + next step. */
const JEV_ERROR_BLOCKS: Readonly<Record<JevFailureClass, readonly [string, string, string]>> = Object.freeze({
  timeout: Object.freeze([
    "**Jev timed out.**",
    "The routing request timed out after repeated attempts.",
    "Check your network connection and re-run /route.",
  ]),
  network: Object.freeze([
    "**Jev is unreachable.**",
    "Could not reach Jev after repeated attempts.",
    "Check your network connection and re-run /route.",
  ]),
  "rate-limited": Object.freeze([
    "**Jev rate limit exceeded.**",
    "Jev rate-limited the routing request after repeated attempts.",
    "Wait a minute and re-run /route.",
  ]),
  "server-error": Object.freeze([
    "**Jev had an internal error.**",
    "Jev returned server errors after repeated attempts.",
    "Wait a minute and re-run /route.",
  ]),
  auth: Object.freeze([
    "**Jev rejected the API key.**",
    "Jev refused the request (invalid API key).",
    "Check TYPESAFE_API_KEY or logofat.typesafeApiKey in Pi settings.json, then re-run /route.",
  ]),
  "bad-request": Object.freeze([
    "**Jev rejected the request.**",
    "Jev refused the routing request (client error).",
    "Re-run /route; if it persists, please report this as a Logofăt bug.",
  ]),
  "bad-response": Object.freeze([
    "**Jev gave an unusable answer.**",
    "Jev's response was missing the harness choice or was malformed.",
    "Re-run /route; if it persists, please report this as a Logofăt bug.",
  ]),
  "unknown-harness": Object.freeze([
    "**Jev chose an unavailable harness.**",
    "Jev's choice was not one of the detected harnesses, so /route did not use it.",
    "Re-run /route to ask Jev again.",
  ]),
});

/** Renders one per-class Jev error block. Unknown classes fall back to bad-request (never throws). */
export function formatJevError(failureClass: JevFailureClass): string {
  const block = JEV_ERROR_BLOCKS[failureClass] ?? JEV_ERROR_BLOCKS["bad-request"];
  return block.join("\n");
}

/** Empty `/route`: usage heading plus body. Nothing is executed or probed. */
export function formatUsage(): string {
  return `${USAGE_HEADING}\n${USAGE_BODY}`;
}

/** `/route --help` and `/route -h`. */
export function formatHelp(): string {
  return `${USAGE_HEADING}\n${HELP_BODY}`;
}
