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
import type { Provider, ProviderChange, ProviderId } from "./providers.ts";
import type { JevDecision, JevFailureClass } from "./jev.ts";
import type { EffortLevel } from "./capabilities.ts";
import type { TailResult } from "./runner/handoff.ts";

/** Notify-only pre-emit on the Jev path. Never sent via sendMessage. */
export const LOADING_LINE = "Asking Jev to choose a harness…";

export const MISSING_KEY_HEADING = "**Jev API key missing.**";

export const MISSING_KEY_INTRO =
  "/route needs a TypeSafe API key to choose a harness. Provide it one of these ways, then re-run /route:";

export const USAGE_HEADING = "Usage: /route <prompt>";

export const USAGE_BODY = "Provide a prompt after /route, or run /route --help for usage. Nothing was executed.";

export const HELP_BODY = "Routes the prompt to the best installed harness via Jev and runs it there.";

export const NO_HARNESS_HEADING = "**No harnesses detected.**";

/** Refresh (not restart) is the cache truth: /route-providers re-detects mid-session. */
export const NO_HARNESS_INTRO = "Install one of the following, then run /route-providers and re-run /route:";

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

/** Output is literal: preserve indentation, tabs and punctuation, remove unsafe controls. */
export function sanitizeOutput(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(ANSI_SEQUENCES, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "");
}

/** Remove application markup, preserving all bytes inside generated literal blocks. */
export function toPlainText(copy: string): string {
  let fence: string | null = null;
  const plain: string[] = [];
  for (const line of copy.split("\n")) {
    if (fence !== null) {
      if (line === fence) fence = null;
      else plain.push(line);
      continue;
    }
    const opening = /^(`{3,})text$/.exec(line);
    if (opening) fence = opening[1]!;
    else plain.push(line.replaceAll("**", ""));
  }
  return plain.join("\n");
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

/** A confidence figure the transcript may print: a finite number within [0, 1]. */
function isUsableConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * FP-safe floor to 2 decimals, shared by `formatConfidence` and the explain
 * formatter. FLOOR, not round, so no confirm-tier value ever displays `0.80`
 * and no refuse-tier value `0.50`: plain `Math.floor(v * 100) / 100`
 * misrenders exact-looking inputs (`0.29 * 100` is `28.999…` in doubles),
 * so an exact hundredth at or below the input snaps up to it; the guarded
 * fallback covers the ulp hazard (`0.7999999999999999 * 100` rounds to
 * exactly `80`, which unguarded code would print as `0.80`). Every branch
 * yields `shown <= value`. Unusable figures render as null. Private: the
 * goldens pin the behavior, not the helper.
 */
function floor2(value: unknown): number | null {
  if (!isUsableConfidence(value)) return null;
  const n = Math.floor(value * 100);
  const up = (n + 1) / 100;
  return up <= value ? up : n / 100 <= value ? n / 100 : (n - 1) / 100;
}

/**
 * Confidence label. Usable figures render floored to 2 decimals (see
 * `floor2`); anything else renders `confidence unknown` — garbage signal
 * never renders as a figure.
 */
function formatConfidence(value: unknown): string {
  const shown = floor2(value);
  return shown === null ? "confidence unknown" : `confidence ${shown.toFixed(2)}`;
}

/** ` Alternatives: a, b.` clause, or "" when there is nothing to name. Never throws. */
function alternativesClause(alternatives: unknown): string {
  if (!Array.isArray(alternatives)) return "";
  const ids = alternatives.map((id) => sanitizeField(id)).filter((id) => id !== "");
  return ids.length === 0 ? "" : ` Alternatives: ${ids.join(", ")}.`;
}

/**
 * Success decision line. The id and effort are valid by construction upstream
 * (allowlisted id, validated effort); both are still routed through
 * sanitizeField for defense in depth (validated values render verbatim).
 * There is no fallback word — a fallback would be a default effort.
 * The confidence label floors to 2 decimals (see formatConfidence); the
 * handler only calls this on auto/confirm paths where the gate guarantees a
 * usable figure.
 */
export function formatDecisionLine(harness: ProviderId, effort: EffortLevel, confidence: number): string {
  return `Jev routed this prompt to **${sanitizeField(harness)}** at ${sanitizeField(effort)} effort (${formatConfidence(confidence)}).`;
}

/** Session hysteresis copy; ids sanitize and figures use the same floor rule. */
export function formatStayLine(incumbent: ProviderId): string {
  return `Staying on **${sanitizeField(incumbent)}** — no challenger cleared the switch margin.`;
}

export function formatSwitchLine(incumbent: ProviderId, challenger: ProviderId, margin: number): string {
  const shown = floor2(margin);
  const bar = shown === null ? "" : `${shown.toFixed(2)} `;
  return `Switching from **${sanitizeField(incumbent)}** to **${sanitizeField(challenger)}** — its edge cleared the ${bar}switch margin.`;
}

export function formatLowConfidenceStayLine(incumbent: ProviderId, confidence: number): string {
  return `Staying on **${sanitizeField(incumbent)}** (${formatConfidence(confidence)}) — too close to call, keeping the working harness.`;
}

/**
 * The margin infix for the explain line (`<p-win> vs **<runner-up>** <p-run>`),
 * or "" when the margin clause must drop. The winner figure and the
 * runner-up figure must BOTH be usable (finite, in [0, 1]); the runner-up is
 * the highest usable figure among the available ids other than the winner,
 * ties broken by available-list order (first wins). Candidate ids come from
 * `availableIds` only — probability keys outside it never render, however
 * high. Figures render floored to 2 decimals; no difference is computed.
 */
function explainMargin(decision: JevDecision, availableIds: readonly ProviderId[]): string {
  const src = decision as unknown as { harness?: unknown; probabilities?: unknown } | null | undefined;
  const rawHarness = src?.harness;
  const probs = src?.probabilities;
  if (typeof rawHarness !== "string" || probs === null || typeof probs !== "object") return "";
  const figures = probs as Readonly<Record<string, unknown>>;
  const winFigure = floor2(figures[rawHarness]);
  if (winFigure === null || !Array.isArray(availableIds)) return "";
  let runnerUp: string | null = null;
  let runnerRaw = -1;
  for (const id of availableIds) {
    if (typeof id !== "string" || id === rawHarness) continue;
    const value = figures[id];
    if (typeof value !== "number" || floor2(value) === null) continue;
    if (value > runnerRaw) {
      runnerRaw = value;
      runnerUp = id;
    }
  }
  if (runnerUp === null) return "";
  const runFigure = floor2(runnerRaw);
  if (runFigure === null) return "";
  const safeRunnerUp = sanitizeField(runnerUp) || "unknown";
  return `${winFigure.toFixed(2)} vs **${safeRunnerUp}** ${runFigure.toFixed(2)}`;
}

/**
 * Routing-explanation line (Phase 6, EXEC-03): the winner-vs-runner-up
 * margin plus the confidence, built from the decision's own numbers only.
 * Full shape: `Why **<winner>**, <p-win> vs **<runner-up>** <p-run>
 * (confidence <c>).`; when either figure is unusable (or no runner-up
 * exists) the margin clause drops with no gap and no placeholder:
 * `Why **<winner>** (confidence <c>).` Forbidden by construction (only
 * numbers + available ids flow in): benchmark claims, criteria text, raw
 * difficulty, and foreign probability keys. Total: hostile input degrades
 * to the winner + confidence shape, never throws.
 */
export function formatExplainLine(
  decision: JevDecision,
  availableIds: readonly ProviderId[],
  confidence: number,
): string {
  let winner = "unknown";
  try {
    winner =
      sanitizeField((decision as { harness?: unknown } | null | undefined)?.harness) || "unknown";
  } catch {
    winner = "unknown";
  }
  const label = formatConfidence(confidence);
  let margin = "";
  try {
    margin = explainMargin(decision, availableIds);
  } catch {
    margin = "";
  }
  return margin === "" ? `Why **${winner}** (${label}).` : `Why **${winner}**, ${margin} (${label}).`;
}

/**
 * Low-confidence (or malformed-confidence) block: heading + the refused top
 * pick + the re-run instruction. A usable figure renders floored (same floor
 * rule as the label); `null` — any malformed shape, the gate already
 * normalized it — or any other value passed directly renders the "unknown"
 * sentence with NO digits. Garbage signal never renders as a figure, even
 * on direct hostile calls.
 */
export function formatRefuseBlock(
  topPick: ProviderId,
  alternatives: readonly ProviderId[],
  confidence: number | null,
): string {
  const body = isUsableConfidence(confidence)
    ? `Jev's top pick was **${sanitizeField(topPick)}** (${formatConfidence(confidence)}), but that is too low to act on, so /route did not use it.${alternativesClause(alternatives)}`
    : `Jev's top pick was **${sanitizeField(topPick)}**, but no usable confidence came back with it, so /route did not use it.${alternativesClause(alternatives)}`;
  return ["**Too uncertain to route.**", body, "Re-run /route for a fresh judgment."].join("\n");
}

// ---------------------------------------------------------------------------
// Run + handoff copy (Phase 5). Transcript functions keep the `**` +
// toPlainText contract; dialog strings are PLAIN (dialogs may not parse
// markdown) but still sanitizeField every interpolation.
// ---------------------------------------------------------------------------

/** Notify-only pre-emit at spawn. Never sent via sendMessage. */
export function formatRunStarted(harness: ProviderId, effort: EffortLevel): string {
  return `Running your prompt on **${sanitizeField(harness)}** at ${sanitizeField(effort)} effort…`;
}

/** Confirm dialog title. Plain — dialogs may not parse markdown. */
export function formatConfirmDialogTitle(harness: ProviderId): string {
  return `Run on ${sanitizeField(harness)}?`;
}

/**
 * Confirm dialog message. Plain — no bold, no link syntax to neutralize —
 * but every interpolation still goes through sanitizeField. The dialog IS
 * the ask: confirmed runs carry no notice in the transcript.
 */
export function formatConfirmDialog(
  harness: ProviderId,
  alternatives: readonly ProviderId[],
  effort: EffortLevel,
  confidence: number,
): string {
  const safeHarness = sanitizeField(harness);
  return (
    `Jev chose ${safeHarness} at ${sanitizeField(effort)} effort (${formatConfidence(confidence)}), ` +
    `but that is below the auto-run threshold.${alternativesClause(alternatives)}\n\n` +
    `Run it on ${safeHarness}?`
  );
}

/** Declined-confirm block: no spawn happened. */
export function formatRunDeclined(harness: ProviderId): string {
  return [
    "**Run declined.**",
    `/route did not run your prompt on **${sanitizeField(harness)}**.`,
    "Re-run /route for a fresh judgment.",
  ].join("\n");
}

/** Headless confirm block: fail closed — the session cannot ask, so nothing runs. */
export function formatConfirmHeadless(
  harness: ProviderId,
  effort: EffortLevel,
  confidence: number,
): string {
  return [
    "**Confirmation needed (interactive session required).**",
    `Jev chose **${sanitizeField(harness)}** at ${sanitizeField(effort)} effort (${formatConfidence(confidence)}), but that is below the auto-run threshold, and this session cannot ask for confirmation.`,
    "Re-run /route in an interactive Pi session to confirm and run it.",
  ].join("\n");
}

/** Defensive read: hostile TailResult shapes degrade to the empty tail. */
function readTail(tail: TailResult): { shown: string[]; totalLines: number; hitByteCap: boolean } {
  if (tail === null || typeof tail !== "object") return { shown: [], totalLines: 0, hitByteCap: false };
  return {
    shown: Array.isArray(tail.shown) ? tail.shown : [],
    totalLines:
      typeof tail.totalLines === "number" && Number.isFinite(tail.totalLines) && tail.totalLines >= 0
        ? Math.floor(tail.totalLines)
        : 0,
    hitByteCap: tail.hitByteCap === true,
  };
}

/**
 * One tail section as lines: the counts line (always rendered, even 0 of
 * 0, with the capture-cap note when dropped bytes > 0), the sanitized
 * shown lines, and the excerpt-cut note when the byte guard cut. Empty
 * STDOUT renders the `(no stdout output)` filler; the stderr section is
 * omitted-when-empty by the caller passing null instead.
 */
function tailSection(kind: "stdout" | "stderr", tail: TailResult, droppedBytes: number): string[] {
  const { shown, totalLines, hitByteCap } = readTail(tail);
  const drained = typeof droppedBytes === "number" && droppedBytes > 0;
  const counts =
    kind === "stdout"
      ? `Showing the last ${shown.length} of ${totalLines} stdout lines:`
      : `Last ${shown.length} of ${totalLines} stderr lines:`;
  const lines = [drained ? `${counts} (output past the 1 MiB capture cap was dropped)` : counts];
  if (shown.length === 0 && kind === "stdout") {
    lines.push("(no stdout output)");
    return lines;
  }
  if (shown.length > 0) {
    const output = shown.map(sanitizeOutput).join("\n");
    // A longer fence than any run in the output cannot be closed by harness text.
    const longest = Math.max(0, ...Array.from(output.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    lines.push(`${fence}text`, output, fence);
  }
  if (hitByteCap) {
    lines.push(kind === "stdout" ? "[transcript excerpt cut at 20 KiB]" : "[transcript excerpt cut at 4 KiB]");
  }
  return lines;
}

/** Log pointer, or the degrade line when the log is unavailable (null) or unusable. */
function logPointerLine(logPath: string | null): string {
  const safe = sanitizeField(logPath);
  return safe === ""
    ? "The full log could not be written, so only this excerpt is available."
    : `Full log: ${safe}`;
}

/** `ok` report: heading + stdout tail + log pointer. No next-step line — the log pointer closes it. */
export function formatRunOk(
  harness: ProviderId,
  stdoutTail: TailResult,
  stdoutDroppedBytes: number,
  logPath: string | null,
): string {
  return [
    `**Run finished on ${sanitizeField(harness)} (exit 0).**`,
    ...tailSection("stdout", stdoutTail, stdoutDroppedBytes),
    logPointerLine(logPath),
  ].join("\n");
}

/**
 * `nonzero` report: heading + stdout tail + stderr tail (when non-null) +
 * log pointer + next step. The heading rule is total: a usable exit code
 * (finite integer >= 0) names the code; else a usable signal names the
 * killer; else (hostile-only) the unknown-status heading. Non-strings
 * short-circuit before rendering — no String() coercions, so throwing
 * coercions never fire.
 */
export function formatRunNonzero(
  harness: ProviderId,
  exitCode: number | null,
  signal: string | null,
  stdoutTail: TailResult,
  stdoutDroppedBytes: number,
  stderrTail: TailResult | null,
  logPath: string | null,
): string {
  const safeHarness = sanitizeField(harness);
  const usableCode =
    typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : null;
  const safeSignal = typeof signal === "string" ? sanitizeField(signal) : "";
  const heading =
    usableCode !== null
      ? `**Run on ${safeHarness} exited with code ${usableCode}.**`
      : safeSignal !== ""
        ? `**Run on ${safeHarness} was killed (${safeSignal}).**`
        : `**Run on ${safeHarness} ended without a usable exit status.**`;
  return [
    heading,
    ...tailSection("stdout", stdoutTail, stdoutDroppedBytes),
    ...(stderrTail === null || typeof stderrTail !== "object" ? [] : tailSection("stderr", stderrTail, 0)),
    logPointerLine(logPath),
    "Check the full log for details, then re-run /route for another attempt.",
  ].join("\n");
}

/** `timeout` report: heading + partial-output tails + log pointer + re-run line. */
export function formatRunTimeout(
  harness: ProviderId,
  stdoutTail: TailResult,
  stdoutDroppedBytes: number,
  stderrTail: TailResult | null,
  logPath: string | null,
): string {
  return [
    `**Run on ${sanitizeField(harness)} timed out after 10 minutes.**`,
    "The run was stopped after the 10-minute limit; partial output is below.",
    ...tailSection("stdout", stdoutTail, stdoutDroppedBytes),
    ...(stderrTail === null || typeof stderrTail !== "object" ? [] : tailSection("stderr", stderrTail, 0)),
    logPointerLine(logPath),
    "Re-run /route to try again with a fresh run.",
  ].join("\n");
}

/** `aborted` report: a cancellation is not a failure, so no stderr section. */
export function formatRunAborted(
  harness: ProviderId,
  stdoutTail: TailResult,
  stdoutDroppedBytes: number,
  logPath: string | null,
): string {
  return [
    `**Run on ${sanitizeField(harness)} was cancelled.**`,
    "The run was stopped before it finished; partial output is below.",
    ...tailSection("stdout", stdoutTail, stdoutDroppedBytes),
    logPointerLine(logPath),
    "Re-run /route when you are ready.",
  ].join("\n");
}

/**
 * `spawn-error` report: no tail sections, no log line — nothing ran, no
 * file is written. (The run tuple still logs; the outcome record needs no
 * log file.)
 */
export function formatSpawnError(harness: ProviderId): string {
  const safe = sanitizeField(harness);
  return [
    `**Could not start ${safe}.**`,
    `The ${safe} binary could not be started (it may have been moved or removed since detection).`,
    "Run /route-providers and re-run /route to re-detect harnesses.",
  ].join("\n");
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
    "Jev's response was missing the harness choice or difficulty score, or was malformed.",
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
  const block = Object.hasOwn(JEV_ERROR_BLOCKS, failureClass)
    ? JEV_ERROR_BLOCKS[failureClass]
    : JEV_ERROR_BLOCKS["bad-request"];
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

// ---------------------------------------------------------------------------
// Refresh copy (Phase 6, ROUTE-03). The /route-providers command re-detects
// and shows what changed; rendering mirrors the /route usage grammar.
// ---------------------------------------------------------------------------

export const REFRESH_USAGE_HEADING = "Usage: /route-providers";

export const REFRESH_HELP_BODY =
  "Re-detects installed harnesses and shows what changed since the last detection.";

export const REFRESH_USAGE_BODY = "/route-providers takes no arguments. Run it bare to re-detect harnesses.";

export const REFRESH_NO_CHANGES = "No changes since the last detection.";

export const FIRST_DETECTION_NOTE = "(No previous detection in this session.)";

/** Null/absent side of a version/binary diff row. */
const DIFF_NULL_VALUE = "(none)";

/** `/route-providers --help` and `/route-providers -h`. */
export function formatRefreshHelp(): string {
  return `${REFRESH_USAGE_HEADING}\n${REFRESH_HELP_BODY}`;
}

/** `/route-providers` with any other arguments: usage, with no probe. */
export function formatRefreshUsage(): string {
  return `${REFRESH_USAGE_HEADING}\n${REFRESH_USAGE_BODY}`;
}

/** The note replacing the diff section when no settled baseline exists. */
export function formatFirstDetectionNote(): string {
  return FIRST_DETECTION_NOTE;
}

function diffValue(value: unknown): string {
  return sanitizeField(value) || DIFF_NULL_VALUE;
}

/**
 * One diff row, or null when the change is malformed (skipped, never thrown).
 * Availability rows read binary/version/reason from the FRESH snapshot: the
 * changes carry no payload for those kinds. ASCII `->`, no interior blank
 * lines; every field sanitized like `formatRow`.
 */
function refreshChangeRow(change: ProviderChange, fresh: readonly Provider[]): string | null {
  try {
    const src = change as unknown as {
      id?: unknown;
      kind?: unknown;
      previous?: unknown;
      current?: unknown;
    } | null | undefined;
    const rawId = src?.id;
    if (typeof rawId !== "string") return null;
    const id = sanitizeField(rawId) || "unknown";
    const kind = src?.kind;
    const record = Array.isArray(fresh) ? findRecord(fresh, rawId as ProviderId) : undefined;
    if (kind === "became-available") {
      if (record === undefined) return `- ${id}: now available`;
      const binary = sanitizeField(record.binary) || id;
      const version = sanitizeField(record.version);
      return version === ""
        ? `- ${id}: now available (${binary})`
        : `- ${id}: now available (${binary}, ${version})`;
    }
    if (kind === "became-unavailable") {
      const reason = sanitizeField(record?.reason) || REASON_VERSION_FAILED;
      return `- ${id}: now unavailable (${reason})`;
    }
    if (kind === "version" || kind === "binary") {
      return `- ${id}: ${kind} ${diffValue(src?.previous)} -> ${diffValue(src?.current)}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The refresh diff section: changed rows joined by single `\n`, or the
 * no-changes line when nothing changed (or nothing usable was passed).
 * Never throws.
 */
export function formatRefreshDiff(
  changes: readonly ProviderChange[],
  fresh: readonly Provider[],
): string {
  try {
    if (!Array.isArray(changes)) return REFRESH_NO_CHANGES;
    const rows: string[] = [];
    for (const change of changes) {
      const row = refreshChangeRow(change, fresh);
      if (row !== null) rows.push(row);
    }
    return rows.length === 0 ? REFRESH_NO_CHANGES : rows.join("\n");
  } catch {
    return REFRESH_NO_CHANGES;
  }
}
