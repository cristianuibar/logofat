// Render tests for src/messages.ts (plan 01-03), extended by plan 01-04 into
// character-exact goldens. Pure string checks: no Pi, no PATH, no I/O.
// Cache, emit-gate, and payload-delivery tests live in test/index.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INSTALL_LINES,
  HELP_BODY,
  LOADING_LINE,
  FIRST_DETECTION_NOTE,
  MISSING_KEY_HEADING,
  MISSING_KEY_INTRO,
  NO_HARNESS_HEADING,
  NO_HARNESS_INTRO,
  REFRESH_HELP_BODY,
  REFRESH_NO_CHANGES,
  REFRESH_USAGE_BODY,
  REFRESH_USAGE_HEADING,
  USAGE_BODY,
  USAGE_HEADING,
  countAvailable,
  formatConfirmDialog,
  formatConfirmDialogTitle,
  formatConfirmHeadless,
  formatDecisionLine,
  formatDetectionResult,
  formatExplainLine,
  formatFirstDetectionNote,
  formatHelp,
  formatRefreshDiff,
  formatRefreshHelp,
  formatRefreshUsage,
  formatJevError,
  formatMissingKey,
  formatNoHarness,
  formatProviderList,
  formatRefuseBlock,
  formatRunAborted,
  formatRunDeclined,
  formatRunNonzero,
  formatRunOk,
  formatRunStarted,
  formatRunTimeout,
  formatSpawnError,
  formatStayLine,
  formatSwitchLine,
  formatLowConfidenceStayLine,
  formatUsage,
  sanitizeField,
  toPlainText,
} from "../src/messages.ts";
import { ROUTE_DESCRIPTION } from "../src/index.ts";
import { REASON_NOT_FOUND, REASON_VERSION_FAILED, REASON_VERSION_TIMED_OUT } from "../src/providers.ts";
import type { Provider, ProviderChange, ProviderId } from "../src/providers.ts";
import type { JevDecision, JevFailureClass } from "../src/jev.ts";
import type { EffortLevel } from "../src/capabilities.ts";
import type { TailResult } from "../src/runner/handoff.ts";

test("07: exact sticky announcement copy and floor-only figures", () => {
  assert.equal(formatStayLine("muse"), "Staying on **muse** — no challenger cleared the switch margin.");
  assert.equal(formatSwitchLine("muse", "claude", 0.15), "Switching from **muse** to **claude** — its edge cleared the 0.15 switch margin.");
  assert.equal(formatLowConfidenceStayLine("muse", 0.319), "Staying on **muse** (confidence 0.31) — too close to call, keeping the working harness.");
  assert.equal(formatSwitchLine("muse", "claude", 0.14999999999999997), "Switching from **muse** to **claude** — its edge cleared the 0.14 switch margin.");
  assert.equal(formatLowConfidenceStayLine("muse", 0.49999999999999994), "Staying on **muse** (confidence 0.49) — too close to call, keeping the working harness.");
});

test("07: sticky copy neutralizes injection and degrades hostile ids/figures", () => {
  const id = "\u001b[31m[muse](https://CANARY)\u0000\n" as ProviderId;
  assert.equal(formatStayLine(id), "Staying on **[muse] (https://CANARY)** — no challenger cleared the switch margin.");
  assert.equal(formatSwitchLine(id, id, NaN), "Switching from **[muse] (https://CANARY)** to **[muse] (https://CANARY)** — its edge cleared the switch margin.");
  assert.equal(formatLowConfidenceStayLine(id, 0.31), "Staying on **[muse] (https://CANARY)** (confidence 0.31) — too close to call, keeping the working harness.");
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [null, undefined, {}, [], Symbol("hostile"), revoked.proxy, Infinity, -1, "0.15"]) {
    assert.doesNotThrow(() => formatStayLine(value as ProviderId));
    assert.equal(formatSwitchLine("muse", "claude", value as number), "Switching from **muse** to **claude** — its edge cleared the switch margin.");
    assert.equal(formatLowConfidenceStayLine("muse", value as number), "Staying on **muse** (confidence unknown) — too close to call, keeping the working harness.");
  }
});

const MUSE_OK: Provider = {
  id: "muse",
  binary: "/usr/local/bin/muse",
  version: "Muse Code 1.3.0 (1.3.0-R3401.1)",
  available: true,
};
const CLAUDE_OK: Provider = {
  id: "claude",
  binary: "/opt/claude/bin/claude",
  version: "2.1.281 (Claude Code)",
  available: true,
};
const MUSE_MISSING: Provider = { id: "muse", binary: "muse", version: null, available: false, reason: REASON_NOT_FOUND };
const CLAUDE_MISSING: Provider = {
  id: "claude",
  binary: "claude",
  version: null,
  available: false,
  reason: REASON_NOT_FOUND,
};

const GUIDANCE =
  "**No harnesses detected.**\n" +
  "Install one of the following, then run /route-providers and re-run /route:\n" +
  "- muse: see https://dev.meta.ai/ for install instructions\n" +
  "- claude: curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)";

// Phase 5 fixtures: the fixed §2 golden arguments (muse / standard / 0.63,
// tails of 3 shown / 7 total, the pinned log path).
const LOG_PATH = "/tmp/logofat-run-1a2b3c.log";
const TAIL_3_OF_7: TailResult = {
  shown: ["OUT-5", "OUT-6", "OUT-7"],
  totalLines: 7,
  totalBytes: 41,
  hitLineCap: true,
  hitByteCap: false,
};
const STDERR_3_OF_7: TailResult = {
  shown: ["ERR-5", "ERR-6", "ERR-7"],
  totalLines: 7,
  totalBytes: 41,
  hitLineCap: true,
  hitByteCap: false,
};
const TAIL_EMPTY: TailResult = {
  shown: [],
  totalLines: 0,
  totalBytes: 0,
  hitLineCap: false,
  hitByteCap: false,
};
const TAIL_CUT: TailResult = {
  shown: ["OUT-9"],
  totalLines: 9,
  totalBytes: 21_000,
  hitLineCap: true,
  hitByteCap: true,
};
const STDERR_CUT: TailResult = {
  shown: ["ERR-9"],
  totalLines: 9,
  totalBytes: 5_000,
  hitLineCap: true,
  hitByteCap: true,
};

/** Every Phase 5 rendering, for the whole-surface sweeps below. */
function phase5Blocks(): string[] {
  return [
    formatRunStarted("muse", "standard"),
    formatConfirmDialogTitle("muse"),
    formatConfirmDialog("muse", ["claude"], "standard", 0.63),
    formatConfirmDialog("muse", [], "standard", 0.63),
    formatRunDeclined("muse"),
    formatConfirmHeadless("muse", "standard", 0.63),
    formatRunOk("muse", TAIL_3_OF_7, 0, LOG_PATH),
    formatRunNonzero("muse", 3, null, TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    formatRunTimeout("muse", TAIL_3_OF_7, 0, null, LOG_PATH),
    formatRunAborted("muse", TAIL_3_OF_7, 0, LOG_PATH),
    formatSpawnError("muse"),
  ];
}

function maxConsecutiveBlankLines(text: string): number {
  let max = 0;
  let run = 0;
  for (const line of text.split("\n")) {
    run = line.trim() === "" ? run + 1 : 0;
    if (run > max) max = run;
  }
  return max;
}

test("populated (2/2): heading and both rows with versions, bare list", () => {
  assert.equal(
    formatProviderList([MUSE_OK, CLAUDE_OK]),
    "**Detected providers (2/2):**\n" +
      "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: available (/opt/claude/bin/claude, 2.1.281 (Claude Code))",
  );
});

test("partial (1/2): available row plus unavailable row, bare list", () => {
  assert.equal(
    formatProviderList([MUSE_OK, CLAUDE_MISSING]),
    "**Detected providers (1/2):**\n" +
      "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: unavailable (binary not found on PATH)",
  );
  assert.equal(
    formatProviderList([MUSE_MISSING, CLAUDE_OK]),
    "**Detected providers (1/2):**\n" +
      "- muse: unavailable (binary not found on PATH)\n" +
      "- claude: available (/opt/claude/bin/claude, 2.1.281 (Claude Code))",
  );
});

test("empty (0/2): heading plus both rows with reasons", () => {
  assert.equal(
    formatProviderList([MUSE_MISSING, CLAUDE_MISSING]),
    "**Detected providers (0/2):**\n" +
      "- muse: unavailable (binary not found on PATH)\n" +
      "- claude: unavailable (binary not found on PATH)",
  );
});

test("unavailable rows render all three reason strings verbatim", () => {
  const out = formatProviderList([
    { id: "muse", binary: "/x/muse", version: null, available: false, reason: REASON_VERSION_FAILED },
    { id: "claude", binary: "/x/claude", version: null, available: false, reason: REASON_VERSION_TIMED_OUT },
  ]);
  assert.equal(
    out,
    "**Detected providers (0/2):**\n- muse: unavailable (--version failed)\n- claude: unavailable (--version timed out)",
  );
  assert.equal(
    formatProviderList([MUSE_MISSING, CLAUDE_MISSING]).split("\n")[1],
    "- muse: unavailable (binary not found on PATH)",
  );
});

test("version null omits the version segment", () => {
  const out = formatProviderList([{ ...MUSE_OK, version: null }, CLAUDE_MISSING]);
  assert.equal(out.split("\n")[1], "- muse: available (/usr/local/bin/muse)");
});

test("rows keep the stable [muse, claude] order whatever the input order", () => {
  assert.equal(formatProviderList([CLAUDE_OK, MUSE_OK]), formatProviderList([MUSE_OK, CLAUDE_OK]));
});

test("missing records and missing reasons still render both rows", () => {
  assert.equal(
    formatProviderList([]),
    "**Detected providers (0/2):**\n- muse: unavailable (--version failed)\n- claude: unavailable (--version failed)",
  );
  const noReason = { id: "claude", binary: "claude", version: null, available: false } as Provider;
  assert.equal(formatProviderList([MUSE_OK, noReason]).split("\n")[2], "- claude: unavailable (--version failed)");
});

test("countAvailable counts available known ids only", () => {
  assert.equal(countAvailable([MUSE_OK, CLAUDE_OK]), 2);
  assert.equal(countAvailable([MUSE_OK, CLAUDE_MISSING]), 1);
  assert.equal(countAvailable([]), 0);
});

test("formatNoHarness: heading, refresh wording, both verified install lines", () => {
  const out = formatNoHarness();
  assert.equal(out, GUIDANCE);
  assert.equal(out.split("\n")[0], "**No harnesses detected.**");
  assert.ok(out.includes("then run /route-providers and re-run /route"));
  assert.ok(out.includes("https://code.claude.com/docs/en/setup"));
  assert.ok(out.includes("https://dev.meta.ai/"));
  assert.ok(INSTALL_LINES.claude.startsWith("curl -fsSL https://claude.ai/install.sh | bash"));
});

test("formatDetectionResult at N=0: (0/2) rows, 1 blank line, guidance", () => {
  const out = formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]);
  assert.equal(out, formatProviderList([MUSE_MISSING, CLAUDE_MISSING]) + "\n\n" + GUIDANCE);
});

test("formatDetectionResult at N>=1 is the provider list alone (no guidance)", () => {
  assert.equal(formatDetectionResult([MUSE_OK, CLAUDE_OK]), formatProviderList([MUSE_OK, CLAUDE_OK]));
  assert.ok(!formatDetectionResult([MUSE_OK, CLAUDE_MISSING]).includes("No harnesses detected"));
});

test("formatUsage is the empty-state heading plus body", () => {
  assert.equal(
    formatUsage(),
    "Usage: /route <prompt>\nProvide a prompt after /route, or run /route --help for usage. Nothing was executed.",
  );
});

test("formatHelp is the usage heading plus the help body", () => {
  assert.equal(
    formatHelp(),
    "Usage: /route <prompt>\nRoutes the prompt to the best installed harness via Jev and runs it there.",
  );
});

test("toPlainText strips ** markers and nothing else", () => {
  assert.equal(toPlainText("**Detected providers (2/2):**\n- muse: x"), "Detected providers (2/2):\n- muse: x");
  assert.equal(toPlainText(GUIDANCE), GUIDANCE.replaceAll("**", ""));
  assert.equal(toPlainText(formatUsage()), formatUsage());
});

const ALL_JEV_ERROR_CLASSES: readonly JevFailureClass[] = [
  "timeout",
  "network",
  "rate-limited",
  "server-error",
  "auth",
  "bad-request",
  "bad-response",
  "unknown-harness",
];

test("no copy contains planning language, placeholders, or the old name", () => {
  const all = [
    formatProviderList([MUSE_OK, CLAUDE_OK]),
    formatProviderList([MUSE_OK, CLAUDE_MISSING]),
    formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]),
    formatNoHarness(),
    formatUsage(),
    formatHelp(),
    LOADING_LINE,
    formatMissingKey(),
    formatDecisionLine("muse", "low", 0.9),
    formatDecisionLine("muse", "standard", 0.9),
    formatDecisionLine("muse", "high", 0.9),
    formatDecisionLine("claude", "low", 0.9),
    formatDecisionLine("claude", "standard", 0.9),
    formatDecisionLine("claude", "high", 0.9),
    ...phase5Blocks(),
    formatRefuseBlock("muse", ["claude"], 0.31),
    formatRefuseBlock("muse", [], 0.31),
    formatRefuseBlock("muse", ["claude"], null),
    formatRefuseBlock("muse", [], null),
    ...ALL_JEV_ERROR_CLASSES.map((c) => formatJevError(c)),
  ];
  for (const copy of all) {
    assert.ok(!/Phase \d/.test(copy), copy);
    assert.ok(!copy.includes("<install instructions>"), copy);
    assert.ok(!/nabu/i.test(copy), copy);
  }
});

test("at most 1 consecutive blank line in every rendering", () => {
  const all = [
    formatProviderList([MUSE_OK, CLAUDE_OK]),
    formatProviderList([MUSE_OK, CLAUDE_MISSING]),
    formatProviderList([MUSE_MISSING, CLAUDE_MISSING]),
    formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]),
    formatDetectionResult([MUSE_OK, CLAUDE_OK]),
    formatNoHarness(),
    formatUsage(),
    formatHelp(),
    LOADING_LINE,
    formatMissingKey(),
    formatDecisionLine("muse", "low", 0.9),
    formatDecisionLine("muse", "standard", 0.9),
    formatDecisionLine("muse", "high", 0.9),
    formatDecisionLine("claude", "low", 0.9),
    formatDecisionLine("claude", "standard", 0.9),
    formatDecisionLine("claude", "high", 0.9),
    ...phase5Blocks(),
    formatRefuseBlock("muse", ["claude"], 0.31),
    formatRefuseBlock("muse", [], 0.31),
    formatRefuseBlock("muse", ["claude"], null),
    formatRefuseBlock("muse", [], null),
    ...ALL_JEV_ERROR_CLASSES.map((c) => formatJevError(c)),
  ];
  for (const copy of all) {
    assert.ok(maxConsecutiveBlankLines(copy) <= 1, copy);
    assert.ok(!copy.startsWith("\n") && !copy.endsWith("\n"), copy);
  }
});

test("hostile fields: ANSI escapes, control characters, and markdown links are stripped", () => {
  const out = formatProviderList([
    {
      id: "muse",
      binary: "/tmp/\u001b[31mevil\u001b[0m\n\n\n/[click](https://evil.example)/muse",
      version: "\u001b]8;;https://evil.example\u0007v9\u001b]8;;\u0007 [x](y) \u0007\u0000\u007f\u009b2J‮1.0",
      available: true,
    },
    {
      id: "claude",
      binary: "claude",
      version: null,
      available: false,
      reason: "boom\r\n\u001b[2K![img](http://evil.example/x.png)",
    },
  ]);
  assert.equal(
    out,
    "**Detected providers (1/2):**\n" +
      "- muse: available (/tmp/evil/[click] (https://evil.example)/muse, v9 [x] (y) 1.0)\n" +
      "- claude: unavailable (boom![img] (http://evil.example/x.png))",
  );
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out));
  assert.ok(!out.includes("]("));
  assert.ok(maxConsecutiveBlankLines(out) <= 1);
});

test("sanitizeField keeps plain parentheses, brackets, and paths verbatim", () => {
  assert.equal(sanitizeField("2.1.281 (Claude Code)"), "2.1.281 (Claude Code)");
  assert.equal(sanitizeField("Muse Code 1.3.0 (1.3.0-R3401.1)"), "Muse Code 1.3.0 (1.3.0-R3401.1)");
  assert.equal(sanitizeField("/opt/[beta] tools (x86)/bin/claude"), "/opt/[beta] tools (x86)/bin/claude");
  assert.equal(sanitizeField(null), "");
  assert.equal(sanitizeField(undefined), "");
});

// ---------------------------------------------------------------------------
// Plan 01-04 goldens. The planning docs are not shipped, so these tests are
// the shipped copy contract: any wording change in src/messages.ts must fail
// here first. Every expected string is written out in full, never rebuilt
// from the module under test.
//
// Exit-zero contract: every rendering here is a plain string return. The
// no-harness path is guidance, not an error: the handler emits it and
// resolves normally, so Pi exits 0 (the handler side is pinned in
// test/index.test.ts and the real-Pi exit code in test/smoke-pi.sh).

const GOLDEN_2_OF_2 =
  "**Detected providers (2/2):**\n" +
  "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
  "- claude: available (/opt/claude/bin/claude, 2.1.281 (Claude Code))";

const GOLDEN_1_OF_2 =
  "**Detected providers (1/2):**\n" +
  "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
  "- claude: unavailable (--version timed out)";

const GOLDEN_0_OF_2 =
  "**Detected providers (0/2):**\n" +
  "- muse: unavailable (binary not found on PATH)\n" +
  "- claude: unavailable (--version failed)";

const CLAUDE_TIMED_OUT: Provider = {
  id: "claude",
  binary: "/opt/claude/bin/claude",
  version: null,
  available: false,
  reason: REASON_VERSION_TIMED_OUT,
};
const CLAUDE_FAILED: Provider = {
  id: "claude",
  binary: "/opt/claude/bin/claude",
  version: null,
  available: false,
  reason: REASON_VERSION_FAILED,
};

test("golden: three provider-list fixtures, character-exact (2/2, 1/2, 0/2)", () => {
  assert.equal(formatProviderList([MUSE_OK, CLAUDE_OK]), GOLDEN_2_OF_2);
  assert.equal(formatProviderList([MUSE_OK, CLAUDE_TIMED_OUT]), GOLDEN_1_OF_2);
  assert.equal(formatProviderList([MUSE_MISSING, CLAUDE_FAILED]), GOLDEN_0_OF_2);
});

test("golden: notify plain-text variants strip bold markers and nothing else", () => {
  assert.equal(
    toPlainText(formatProviderList([MUSE_OK, CLAUDE_OK])),
    "Detected providers (2/2):\n" +
      "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: available (/opt/claude/bin/claude, 2.1.281 (Claude Code))",
  );
  assert.equal(
    toPlainText(formatProviderList([MUSE_OK, CLAUDE_TIMED_OUT])),
    "Detected providers (1/2):\n" +
      "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: unavailable (--version timed out)",
  );
  assert.equal(
    toPlainText(formatDetectionResult([MUSE_MISSING, CLAUDE_FAILED])),
    "Detected providers (0/2):\n" +
      "- muse: unavailable (binary not found on PATH)\n" +
      "- claude: unavailable (--version failed)\n" +
      "\n" +
      "No harnesses detected.\n" +
      "Install one of the following, then run /route-providers and re-run /route:\n" +
      "- muse: see https://dev.meta.ai/ for install instructions\n" +
      "- claude: curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)",
  );
  assert.equal(
    toPlainText(formatNoHarness()),
    "No harnesses detected.\n" +
      "Install one of the following, then run /route-providers and re-run /route:\n" +
      "- muse: see https://dev.meta.ai/ for install instructions\n" +
      "- claude: curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)",
  );
  // Usage and help carry no markup, so notify shows them unchanged.
  assert.equal(
    toPlainText(formatUsage()),
    "Usage: /route <prompt>\nProvide a prompt after /route, or run /route --help for usage. Nothing was executed.",
  );
  assert.equal(
    toPlainText(formatHelp()),
    "Usage: /route <prompt>\nRoutes the prompt to the best installed harness via Jev and runs it there.",
  );
});

test("golden: every exported copy constant matches the UI-SPEC wording", () => {
  assert.equal(USAGE_HEADING, "Usage: /route <prompt>");
  assert.equal(USAGE_BODY, "Provide a prompt after /route, or run /route --help for usage. Nothing was executed.");
  assert.equal(HELP_BODY, "Routes the prompt to the best installed harness via Jev and runs it there.");
  assert.equal(NO_HARNESS_HEADING, "**No harnesses detected.**");
  assert.equal(NO_HARNESS_INTRO, "Install one of the following, then run /route-providers and re-run /route:");
  assert.deepEqual({ ...INSTALL_LINES }, {
    muse: "see https://dev.meta.ai/ for install instructions",
    claude: "curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)",
  });
  assert.ok(Object.isFrozen(INSTALL_LINES));
});

test("spacing: bare lists end at the last row, and the checker catches 2+", () => {
  for (const copy of [GOLDEN_2_OF_2, GOLDEN_1_OF_2]) {
    const lines = copy.split("\n");
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("**Detected providers ("));
    assert.notEqual(lines.at(-1), "");
  }
  const n0 = formatDetectionResult([MUSE_MISSING, CLAUDE_FAILED]).split("\n");
  assert.deepEqual(n0.slice(2, 5), ["- claude: unavailable (--version failed)", "", "**No harnesses detected.**"]);
  // The spacing checker itself must flag a violation, or the "at most 1"
  // tests above would pass vacuously.
  assert.equal(maxConsecutiveBlankLines("a\n\nb"), 1);
  assert.equal(maxConsecutiveBlankLines("a\n\n\nb"), 2);
  assert.equal(maxConsecutiveBlankLines("a\n \n\t\nb"), 2);
  assert.equal(maxConsecutiveBlankLines("a\nb"), 0);
});

test("version null is omitted for either harness; nested-paren versions stay verbatim", () => {
  assert.equal(
    formatProviderList([{ ...MUSE_OK, version: null }, { ...CLAUDE_OK, version: null }]),
    "**Detected providers (2/2):**\n" +
      "- muse: available (/usr/local/bin/muse)\n" +
      "- claude: available (/opt/claude/bin/claude)",
  );
  assert.equal(
    formatProviderList([{ ...MUSE_OK, version: "v1 (build (nightly) [x86_64])" }, CLAUDE_OK]).split("\n")[1],
    "- muse: available (/usr/local/bin/muse, v1 (build (nightly) [x86_64]))",
  );
});

// Hostile-input matrix: each attack string with the exact text the
// sanitizer must leave behind.
const HOSTILE: ReadonlyArray<readonly [label: string, input: string, output: string]> = [
  ["CSI color", "\u001b[31mred\u001b[0m", "red"],
  ["CSI erase line", "a\u001b[2Kb", "ab"],
  ["OSC 8 hyperlink (BEL)", "\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007", "link"],
  ["OSC title (ST)", "\u001b]0;pwned\u001b\\after", "after"],
  ["unterminated OSC", "ok\u001b]8;;https://evil.example", "ok"],
  ["8-bit CSI", "\u009b2Jclear", "clear"],
  ["two-byte ESC", "\u001bcreset", "reset"],
  ["C0, DEL, C1", "a\u0000b\u0007c\u0008d\u007fe\u0085f", "abcdef"],
  ["newlines and tabs", "one\r\n\n\ntwo\tthree", "onetwothree"],
  ["bidi overrides", "abc‮def⁦g⁩‎h", "abcdefgh"],
  ["markdown link", "[click](https://evil.example)", "[click] (https://evil.example)"],
  ["markdown image", "![img](http://evil.example/x.png)", "![img] (http://evil.example/x.png)"],
  ["control hidden inside a link", "[a]\u0000(b)", "[a] (b)"],
  ["ANSI hidden inside a link", "[a]\u001b[0m(b)", "[a] (b)"],
  ["surrounding whitespace", "  v1  ", "v1"],
];

for (const [label, input, output] of HOSTILE) {
  test(`hostile ${label}: stripped in binary, version, and reason for both rows`, () => {
    // binary field (available row, fixed version)
    assert.equal(
      formatProviderList([{ ...MUSE_OK, binary: input, version: "1.0" }, CLAUDE_MISSING]),
      "**Detected providers (1/2):**\n" +
        `- muse: available (${output}, 1.0)\n` +
        "- claude: unavailable (binary not found on PATH)",
    );
    assert.equal(
      formatProviderList([MUSE_MISSING, { ...CLAUDE_OK, binary: input, version: "1.0" }]),
      "**Detected providers (1/2):**\n" +
        "- muse: unavailable (binary not found on PATH)\n" +
        `- claude: available (${output}, 1.0)`,
    );
    // version field (available row, fixed binary)
    assert.equal(
      formatProviderList([{ ...MUSE_OK, version: input }, CLAUDE_MISSING]).split("\n")[1],
      `- muse: available (/usr/local/bin/muse, ${output})`,
    );
    assert.equal(
      formatProviderList([MUSE_MISSING, { ...CLAUDE_OK, version: input }]).split("\n")[2],
      `- claude: available (/opt/claude/bin/claude, ${output})`,
    );
    // reason field (unavailable row)
    assert.equal(
      formatProviderList([{ ...MUSE_MISSING, reason: input }, { ...CLAUDE_MISSING, reason: input }]),
      "**Detected providers (0/2):**\n" + `- muse: unavailable (${output})\n` + `- claude: unavailable (${output})`,
    );
    assert.equal(sanitizeField(input), output);
  });
}

test("hostile fields that sanitize to nothing fall back instead of rendering empty", () => {
  const blank = "\u001b[0m\u0000 ‮ ";
  assert.equal(
    formatProviderList([{ ...MUSE_OK, binary: blank, version: blank }, { ...CLAUDE_MISSING, reason: blank }]),
    "**Detected providers (1/2):**\n" + "- muse: available (muse)\n" + "- claude: unavailable (--version failed)",
  );
});

test("hostile id: a record whose id is not a known harness is ignored, rows use the fixed ids", () => {
  const out = formatProviderList([
    { ...MUSE_OK, id: "muse\u001b[31m" as Provider["id"] },
    { ...CLAUDE_OK, id: "[x](y)" as Provider["id"] },
  ]);
  assert.equal(
    out,
    "**Detected providers (0/2):**\n- muse: unavailable (--version failed)\n- claude: unavailable (--version failed)",
  );
});

test("hostile output as a whole: no control characters, no link syntax, spacing intact", () => {
  for (const [, input] of HOSTILE) {
    const out = formatDetectionResult([
      { ...MUSE_OK, binary: input, version: input },
      { ...CLAUDE_MISSING, reason: input },
    ]);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(out), out);
    assert.ok(!out.includes("]("), out);
    assert.ok(maxConsecutiveBlankLines(out) <= 1, out);
    assert.equal(out.split("\n").length, 3, out);
  }
});

// ---------------------------------------------------------------------------
// Plan 02-04 goldens: execution notice, loading line, missing-key guidance,
// decision line, and all 8 per-class Jev error blocks. Character-exact; the
// 02-PLAN.md §2 literals are the single source.
// ---------------------------------------------------------------------------

test("golden: LOADING_LINE matches the §2 literal", () => {
  assert.equal(LOADING_LINE, "Asking Jev to choose a harness…");
});

test("golden: formatMissingKey is heading + intro + 2 setup lines, character-exact", () => {
  assert.equal(MISSING_KEY_HEADING, "**Jev API key missing.**");
  assert.equal(
    MISSING_KEY_INTRO,
    "/route needs a TypeSafe API key to choose a harness. Provide it one of these ways, then re-run /route:",
  );
  assert.equal(
    formatMissingKey(),
    "**Jev API key missing.**\n" +
      "/route needs a TypeSafe API key to choose a harness. Provide it one of these ways, then re-run /route:\n" +
      "- TYPESAFE_API_KEY environment variable (restart Pi after setting it)\n" +
      `- logofat.typesafeApiKey in Pi settings.json, e.g. { "logofat": { "typesafeApiKey": "YOUR_KEY" } }`,
  );
});

test("04-01/T2(a): 6 decision-line goldens name the harness, the effort, and the floored label", () => {
  assert.equal(
    formatDecisionLine("muse", "low", 0.9),
    "Jev routed this prompt to **muse** at low effort (confidence 0.90).",
  );
  assert.equal(
    formatDecisionLine("muse", "standard", 0.9),
    "Jev routed this prompt to **muse** at standard effort (confidence 0.90).",
  );
  assert.equal(
    formatDecisionLine("muse", "high", 0.9),
    "Jev routed this prompt to **muse** at high effort (confidence 0.90).",
  );
  assert.equal(
    formatDecisionLine("claude", "low", 0.9),
    "Jev routed this prompt to **claude** at low effort (confidence 0.90).",
  );
  assert.equal(
    formatDecisionLine("claude", "standard", 0.9),
    "Jev routed this prompt to **claude** at standard effort (confidence 0.90).",
  );
  assert.equal(
    formatDecisionLine("claude", "high", 0.9),
    "Jev routed this prompt to **claude** at high effort (confidence 0.90).",
  );
});

test("04-01/T2(b): label goldens — floored figures, FP-safe rendering, unknown form for garbage", () => {
  assert.equal(formatDecisionLine.length, 3, "the confidence parameter is required (migration pin)");
  const cases: Array<[unknown, string]> = [
    [0.8, "(confidence 0.80)"],
    [0.816, "(confidence 0.81)"],
    [1, "(confidence 1.00)"],
    [0.7999, "(confidence 0.79)"],
    [0.4999, "(confidence 0.49)"],
    [0.29, "(confidence 0.29)"],
    [0.57, "(confidence 0.57)"],
    [0.58, "(confidence 0.58)"],
    [0.7999999999999999, "(confidence 0.79)"],
  ];
  for (const [input, label] of cases) {
    assert.equal(
      formatDecisionLine("muse", "low", input as number),
      `Jev routed this prompt to **muse** at low effort ${label}.`,
      `c=${String(input)}`,
    );
  }
  // Cut coherence: no confirm-tier value displays 0.80, no refuse-tier value 0.50.
  assert.ok(!formatDecisionLine("muse", "low", 0.7999).includes("0.80"));
  assert.ok(!formatDecisionLine("muse", "low", 0.4999).includes("0.50"));
  // Hostile figures render the unknown form, never a number, never a throw.
  for (const input of [Number.NaN, "x", null, 1.7, -0.2]) {
    let line: string | undefined;
    try {
      line = formatDecisionLine("muse", "low", input as unknown as number);
    } catch (err) {
      assert.fail(`formatDecisionLine threw for ${String(input)}: ${String(err)}`);
    }
    assert.equal(line, "Jev routed this prompt to **muse** at low effort (confidence unknown).");
  }
});

test("04-01/T2(c): every decision line matches the exact label vocabulary — numeric confidence only", () => {
  const DECISION_LINE_VOCABULARY = /^Jev routed this prompt to \*\*(muse|claude)\*\* at (low|standard|high) effort \(confidence \d\.\d\d\)\.$/;
  const goldens = [
    formatDecisionLine("muse", "low", 0.9),
    formatDecisionLine("muse", "standard", 0.9),
    formatDecisionLine("muse", "high", 0.9),
    formatDecisionLine("claude", "low", 0.9),
    formatDecisionLine("claude", "standard", 0.9),
    formatDecisionLine("claude", "high", 0.9),
  ];
  assert.equal(goldens.length, 6);
  for (const line of goldens) {
    assert.match(line, DECISION_LINE_VOCABULARY);
    assert.ok(!line.includes("unknown"), line);
  }
});

test("04-01/T2(f): hostile effort values render stripped with the label, never throw", () => {
  const payloads = ["\u001b[31mhigh\u001b[0m", "low\u0000\u0007", "[x](https://evil.example)"];
  for (const payload of payloads) {
    let line: string | undefined;
    try {
      line = formatDecisionLine("muse", payload as EffortLevel, 0.9);
    } catch (err) {
      assert.fail(`formatDecisionLine threw for ${JSON.stringify(payload)}: ${String(err)}`);
    }
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(line), line);
    assert.ok(!line.includes("]("), line);
  }
  assert.equal(
    formatDecisionLine("muse", "\u001b[31mhigh\u001b[0m" as EffortLevel, 0.9),
    "Jev routed this prompt to **muse** at high effort (confidence 0.90).",
  );
  assert.equal(
    formatDecisionLine("claude", "[x](y)" as EffortLevel, 0.9),
    "Jev routed this prompt to **claude** at [x] (y) effort (confidence 0.90).",
  );
});

const JEV_ERROR_GOLDENS: Readonly<Record<JevFailureClass, string>> = {
  timeout:
    "**Jev timed out.**\n" +
    "The routing request timed out after repeated attempts.\n" +
    "Check your network connection and re-run /route.",
  network:
    "**Jev is unreachable.**\n" +
    "Could not reach Jev after repeated attempts.\n" +
    "Check your network connection and re-run /route.",
  "rate-limited":
    "**Jev rate limit exceeded.**\n" +
    "Jev rate-limited the routing request after repeated attempts.\n" +
    "Wait a minute and re-run /route.",
  "server-error":
    "**Jev had an internal error.**\n" +
    "Jev returned server errors after repeated attempts.\n" +
    "Wait a minute and re-run /route.",
  auth:
    "**Jev rejected the API key.**\n" +
    "Jev refused the request (invalid API key).\n" +
    "Check TYPESAFE_API_KEY or logofat.typesafeApiKey in Pi settings.json, then re-run /route.",
  "bad-request":
    "**Jev rejected the request.**\n" +
    "Jev refused the routing request (client error).\n" +
    "Re-run /route; if it persists, please report this as a Logofăt bug.",
  "bad-response":
    "**Jev gave an unusable answer.**\n" +
    "Jev's response was missing the harness choice or difficulty score, or was malformed.\n" +
    "Re-run /route; if it persists, please report this as a Logofăt bug.",
  "unknown-harness":
    "**Jev chose an unavailable harness.**\n" +
    "Jev's choice was not one of the detected harnesses, so /route did not use it.\n" +
    "Re-run /route to ask Jev again.",
};

for (const cls of ALL_JEV_ERROR_CLASSES) {
  test(`golden: formatJevError(${cls}) is the guidance-shaped block, character-exact`, () => {
    assert.equal(formatJevError(cls), JEV_ERROR_GOLDENS[cls]);
  });
}

test("04-02/T1(b): unknown and inherited class names fall back to the bad-request block, zero throws", () => {
  const fallback = JEV_ERROR_GOLDENS["bad-request"];
  for (const cls of ["no-such-class", "constructor", "__proto__", "toString", ""]) {
    let block: string | undefined;
    try {
      block = formatJevError(cls as JevFailureClass);
    } catch (err) {
      assert.fail(`formatJevError threw for ${JSON.stringify(cls)}: ${String(err)}`);
    }
    assert.equal(block, fallback, `class=${JSON.stringify(cls)}`);
  }
});

test("04-02/T1(c): every class block is exactly 3 non-empty lines", () => {
  assert.equal(ALL_JEV_ERROR_CLASSES.length, 8);
  for (const cls of ALL_JEV_ERROR_CLASSES) {
    const lines = formatJevError(cls).split("\n");
    assert.equal(lines.length, 3, cls);
    for (const line of lines) assert.ok(line.length > 0, `${cls}: ${JSON.stringify(line)}`);
  }
});

test("04-02/T4(a): no failure block carries a figure — no digits, no confidence wording", () => {
  for (const cls of ALL_JEV_ERROR_CLASSES) {
    const block = formatJevError(cls);
    assert.ok(!/\d/.test(block), `${cls} contains a digit: ${JSON.stringify(block)}`);
    assert.ok(!/confidence/i.test(block), `${cls} names confidence: ${JSON.stringify(block)}`);
  }
});

test("04-02/T4(b): failure blocks contain no prompt, key, path, or auth material", () => {
  // The provider-LIST block legitimately contains binary paths (D-06), so
  // the path-negative-assertion covers failure blocks only — never the list.
  const secrets = ["TSK-PROMPT-CANARY-4a1f", "TSK-KEY-CANARY-4a1f", "/bin/TSK-PATH-CANARY"];
  for (const cls of ALL_JEV_ERROR_CLASSES) {
    const block = formatJevError(cls);
    for (const secret of secrets) assert.ok(!block.includes(secret), `${cls} leaks ${secret}`);
    assert.ok(!block.includes("Authorization"), `${cls} mentions Authorization`);
    assert.ok(!block.includes("Bearer"), `${cls} mentions Bearer`);
  }
});

test("new blocks: no blank lines inside, no edge newlines, no link syntax", () => {
  const blocks = [
    LOADING_LINE,
    formatMissingKey(),
    formatDecisionLine("muse", "low", 0.9),
    formatDecisionLine("muse", "standard", 0.9),
    formatDecisionLine("muse", "high", 0.9),
    formatDecisionLine("claude", "low", 0.9),
    formatDecisionLine("claude", "standard", 0.9),
    formatDecisionLine("claude", "high", 0.9),
    ...phase5Blocks(),
    formatRefuseBlock("muse", ["claude"], 0.31),
    formatRefuseBlock("muse", [], 0.31),
    formatRefuseBlock("muse", ["claude"], null),
    formatRefuseBlock("muse", [], null),
    ...ALL_JEV_ERROR_CLASSES.map((c) => formatJevError(c)),
  ];
  assert.equal(blocks.length, 31);
  for (const block of blocks) {
    assert.ok(maxConsecutiveBlankLines(block) <= 1, block);
    assert.ok(!block.startsWith("\n") && !block.endsWith("\n"), block);
    assert.ok(!block.includes("]("), block);
  }
});

// ---------------------------------------------------------------------------
// Plan 04-01 goldens: confirm notice + refuse block in all 6 shapes.
// Character-exact; the 04-PLAN.md §2 literals are the single source.
// ---------------------------------------------------------------------------

test("04-01/T2(d): refuse-figure goldens, populated and empty, character-exact", () => {
  assert.equal(
    formatRefuseBlock("muse", ["claude"], 0.31),
    "**Too uncertain to route.**\n" +
      "Jev's top pick was **muse** (confidence 0.31), but that is too low to act on, so /route did not use it. Alternatives: claude.\n" +
      "Re-run /route for a fresh judgment.",
  );
  assert.equal(
    formatRefuseBlock("muse", [], 0.31),
    "**Too uncertain to route.**\n" +
      "Jev's top pick was **muse** (confidence 0.31), but that is too low to act on, so /route did not use it.\n" +
      "Re-run /route for a fresh judgment.",
  );
  // Cut coherence at the renderer: a just-below-LOW figure floors to 0.49, never 0.50.
  assert.equal(
    formatRefuseBlock("muse", [], 0.4999),
    "**Too uncertain to route.**\n" +
      "Jev's top pick was **muse** (confidence 0.49), but that is too low to act on, so /route did not use it.\n" +
      "Re-run /route for a fresh judgment.",
  );
  // Ulp hazard at the renderer: the guarded fallback prints 0.79, never 0.80.
  assert.ok(formatRefuseBlock("muse", [], 0.7999999999999999).includes("(confidence 0.79)"));
});

test("04-01/T2(d): refuse-unknown goldens, populated and empty, character-exact", () => {
  assert.equal(
    formatRefuseBlock("muse", ["claude"], null),
    "**Too uncertain to route.**\n" +
      "Jev's top pick was **muse**, but no usable confidence came back with it, so /route did not use it. Alternatives: claude.\n" +
      "Re-run /route for a fresh judgment.",
  );
  assert.equal(
    formatRefuseBlock("muse", [], null),
    "**Too uncertain to route.**\n" +
      "Jev's top pick was **muse**, but no usable confidence came back with it, so /route did not use it.\n" +
      "Re-run /route for a fresh judgment.",
  );
  // Out-of-range figures join the unknown variant (garbage never renders as a figure).
  assert.equal(formatRefuseBlock("muse", [], 1.7), formatRefuseBlock("muse", [], null));
});

test("04-01/T2(e): no accuracy phrasing in any §2 block — confidence is spread, not accuracy", () => {
  const blocks = [
    formatDecisionLine("muse", "low", 0.9),
    formatConfirmDialog("muse", ["claude"], "standard", 0.63),
    formatConfirmDialog("muse", [], "standard", 0.63),
    formatConfirmHeadless("muse", "standard", 0.63),
    formatRefuseBlock("muse", ["claude"], 0.31),
    formatRefuseBlock("muse", [], 0.31),
    formatRefuseBlock("muse", ["claude"], null),
    formatRefuseBlock("muse", [], null),
  ];
  assert.equal(blocks.length, 8);
  for (const block of blocks) {
    assert.ok(!block.includes("%"), block);
    assert.ok(!/chance/i.test(block), block);
    assert.ok(!/probability/i.test(block), block);
  }
});

test("04-01/T2(f): hostile block inputs render stripped or as empty, never throw", () => {
  const friendlies = [
    formatConfirmDialog("muse", ["claude"], "standard", 0.63),
    formatRefuseBlock("muse", ["claude"], 0.31),
    formatRefuseBlock("muse", ["claude"], null),
  ];
  // Hostile ids and efforts render stripped.
  const hostileId = "muse\u001b[31m[x](y)\u0000" as "muse";
  const hostileEffort = "standard\u0000[x](y)" as "standard";
  const stripped = [
    formatConfirmDialog(hostileId, ["claude"], hostileEffort, 0.63),
    formatRefuseBlock(hostileId, ["claude"], 0.31),
    formatRefuseBlock(hostileId, ["claude"], null),
  ];
  for (const out of stripped) {
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out), out);
    assert.ok(!out.includes("]("), out);
    assert.ok(maxConsecutiveBlankLines(out) <= 1, out);
  }
  // Hostile alternatives render stripped (the dialog reuses the same clause).
  const hostileAlts = formatConfirmDialog(
    "muse",
    ["\u001b[31mclaude\u001b[0m[x](y)" as "claude"],
    "standard",
    0.63,
  );
  assert.ok(hostileAlts.includes("Alternatives: claude[x] (y)."), hostileAlts);
  // Non-array alternatives render as empty (the Alternatives sentence is gone).
  for (const alts of [null, undefined, "claude", 42]) {
    const dialog = formatConfirmDialog("muse", alts as unknown as [], "standard", 0.63);
    const refuse = formatRefuseBlock("muse", alts as unknown as [], 0.31);
    assert.ok(!dialog.includes("Alternatives:"), dialog);
    assert.ok(!refuse.includes("Alternatives:"), refuse);
  }
  // The empty shape has no filler: no "none", no dangling sentence.
  assert.ok(!formatConfirmDialog("muse", [], "standard", 0.63).includes("Alternatives"));
  assert.ok(!/alternatives?:?\s*none/i.test(friendlies.join("\n")));
});

// ---------------------------------------------------------------------------
// Plan 05-03 goldens: run-started line, confirm dialog + title, declined and
// headless blocks, and all five run-outcome reports. Character-exact; the
// 05-PLAN.md §2 literals are the single source. Fixed arguments throughout:
// muse / standard / 0.63, tails of 3 shown / 7 total, the pinned log path.
// ---------------------------------------------------------------------------

test("05-03/T1: started-line golden", () => {
  assert.equal(
    formatRunStarted("muse", "standard"),
    "Running your prompt on **muse** at standard effort…",
  );
});

test("05-03/T1: dialog title + message goldens, populated and empty, character-exact", () => {
  assert.equal(formatConfirmDialogTitle("muse"), "Run on muse?");
  assert.equal(
    formatConfirmDialog("muse", ["claude"], "standard", 0.63),
    "Jev chose muse at standard effort (confidence 0.63), but that is below the auto-run threshold. Alternatives: claude.\n" +
      "\n" +
      "Run it on muse?",
  );
  assert.equal(
    formatConfirmDialog("muse", [], "standard", 0.63),
    "Jev chose muse at standard effort (confidence 0.63), but that is below the auto-run threshold.\n" +
      "\n" +
      "Run it on muse?",
  );
});

test("05-03/T1: declined + headless goldens, character-exact", () => {
  assert.equal(
    formatRunDeclined("muse"),
    "**Run declined.**\n" +
      "/route did not run your prompt on **muse**.\n" +
      "Re-run /route for a fresh judgment.",
  );
  assert.equal(
    formatConfirmHeadless("muse", "standard", 0.63),
    "**Confirmation needed (interactive session required).**\n" +
      "Jev chose **muse** at standard effort (confidence 0.63), but that is below the auto-run threshold, and this session cannot ask for confirmation.\n" +
      "Re-run /route in an interactive Pi session to confirm and run it.",
  );
});

test("05-03/T1: ok golden, character-exact", () => {
  assert.equal(
    formatRunOk("muse", TAIL_3_OF_7, 0, LOG_PATH),
    "**Run finished on muse (exit 0).**\n" +
      "Showing the last 3 of 7 stdout lines:\n" +
      "```text\n" +
      "OUT-5\n" +
      "OUT-6\n" +
      "OUT-7\n" +
      "```\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log",
  );
});

test("05-03/T1: nonzero goldens — code, signal, and neither-usable headings", () => {
  const tail = "Showing the last 3 of 7 stdout lines:\n```text\nOUT-5\nOUT-6\nOUT-7\n```\n";
  const errTail = "Last 3 of 7 stderr lines:\n```text\nERR-5\nERR-6\nERR-7\n```\n";
  const close =
    "Full log: /tmp/logofat-run-1a2b3c.log\nCheck the full log for details, then re-run /route for another attempt.";
  assert.equal(
    formatRunNonzero("muse", 3, null, TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    `**Run on muse exited with code 3.**\n${tail}${errTail}${close}`,
  );
  assert.equal(
    formatRunNonzero("muse", null, "SIGTERM", TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    `**Run on muse was killed (SIGTERM).**\n${tail}${errTail}${close}`,
  );
  assert.equal(
    formatRunNonzero("muse", null, null, TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    `**Run on muse ended without a usable exit status.**\n${tail}${errTail}${close}`,
  );
});

test("05-03/T1: timeout golden, character-exact", () => {
  assert.equal(
    formatRunTimeout("muse", TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    "**Run on muse timed out after 10 minutes.**\n" +
      "The run was stopped after the 10-minute limit; partial output is below.\n" +
      "Showing the last 3 of 7 stdout lines:\n" +
      "```text\n" +
      "OUT-5\n" +
      "OUT-6\n" +
      "OUT-7\n" +
      "```\n" +
      "Last 3 of 7 stderr lines:\n" +
      "```text\n" +
      "ERR-5\n" +
      "ERR-6\n" +
      "ERR-7\n" +
      "```\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log\n" +
      "Re-run /route to try again with a fresh run.",
  );
});

test("05-03/T1: aborted golden, character-exact (no stderr section)", () => {
  const block = formatRunAborted("muse", TAIL_3_OF_7, 0, LOG_PATH);
  assert.equal(
    block,
    "**Run on muse was cancelled.**\n" +
      "The run was stopped before it finished; partial output is below.\n" +
      "Showing the last 3 of 7 stdout lines:\n" +
      "```text\n" +
      "OUT-5\n" +
      "OUT-6\n" +
      "OUT-7\n" +
      "```\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log\n" +
      "Re-run /route when you are ready.",
  );
  assert.ok(!block.includes("stderr lines:"), "a cancellation carries no stderr section");
});

test("05-03/T1: spawn-error golden, character-exact (no tails, no log line)", () => {
  const block = formatSpawnError("muse");
  assert.equal(
    block,
    "**Could not start muse.**\n" +
      "The muse binary could not be started (it may have been moved or removed since detection).\n" +
      "Run /route-providers and re-run /route to re-detect harnesses.",
  );
  assert.ok(!block.includes("stdout lines:"), "nothing ran, so no tail sections");
  assert.ok(!block.includes("Full log:"), "nothing ran, so no log line");
});

test("05-03/T1: cap-note counts line when dropped bytes > 0", () => {
  assert.equal(
    formatRunOk("muse", TAIL_3_OF_7, 512, LOG_PATH),
    "**Run finished on muse (exit 0).**\n" +
      "Showing the last 3 of 7 stdout lines: (output past the 1 MiB capture cap was dropped)\n" +
      "```text\n" +
      "OUT-5\n" +
      "OUT-6\n" +
      "OUT-7\n" +
      "```\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log",
  );
});

test("05-03/T1: excerpt-cut notes — 20 KiB stdout, 4 KiB stderr", () => {
  assert.equal(
    formatRunOk("muse", TAIL_CUT, 0, LOG_PATH),
    "**Run finished on muse (exit 0).**\n" +
      "Showing the last 1 of 9 stdout lines:\n" +
      "```text\nOUT-9\n```\n" +
      "[transcript excerpt cut at 20 KiB]\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log",
  );
  const nonzero = formatRunNonzero("muse", 3, null, TAIL_3_OF_7, 0, STDERR_CUT, LOG_PATH);
  assert.ok(
    nonzero.includes("Last 1 of 9 stderr lines:\n```text\nERR-9\n```\n[transcript excerpt cut at 4 KiB]\n"),
    nonzero,
  );
  assert.ok(!nonzero.includes("20 KiB"), "the stdout note stays off when stdout was not cut");
});

test("05-03/T1: null log path renders the degrade line, never a path", () => {
  const block = formatRunOk("muse", TAIL_3_OF_7, 0, null);
  assert.equal(
    block,
    "**Run finished on muse (exit 0).**\n" +
      "Showing the last 3 of 7 stdout lines:\n" +
      "```text\n" +
      "OUT-5\n" +
      "OUT-6\n" +
      "OUT-7\n" +
      "```\n" +
      "The full log could not be written, so only this excerpt is available.",
  );
  assert.ok(!block.includes("Full log:"));
});

test("05-03/T1: empty stdout renders the counts line plus (no stdout output)", () => {
  assert.equal(
    formatRunOk("muse", TAIL_EMPTY, 0, LOG_PATH),
    "**Run finished on muse (exit 0).**\n" +
      "Showing the last 0 of 0 stdout lines:\n" +
      "(no stdout output)\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log",
  );
});

test("05-03/T1: null stderr tail omits the stderr section entirely (nonzero + timeout)", () => {
  for (const block of [
    formatRunNonzero("muse", 3, null, TAIL_3_OF_7, 0, null, LOG_PATH),
    formatRunTimeout("muse", TAIL_3_OF_7, 0, null, LOG_PATH),
  ]) {
    assert.ok(block.includes("Showing the last 3 of 7 stdout lines:"), block);
    assert.ok(!block.includes("stderr lines:"), block);
    assert.ok(!block.includes("ERR-"), block);
    assert.ok(block.includes("Full log: /tmp/logofat-run-1a2b3c.log"), block);
  }
  assert.equal(
    formatRunNonzero("muse", 3, null, TAIL_3_OF_7, 0, null, LOG_PATH),
    "**Run on muse exited with code 3.**\n" +
      "Showing the last 3 of 7 stdout lines:\n" +
      "```text\n" +
      "OUT-5\n" +
      "OUT-6\n" +
      "OUT-7\n" +
      "```\n" +
      "Full log: /tmp/logofat-run-1a2b3c.log\n" +
      "Check the full log for details, then re-run /route for another attempt.",
  );
});

test("05-03/T1: hostile interpolations strip ANSI/controls/links, structure intact", () => {
  const hostileHarness = "\u001b[31mmuse\u001b[0m[x](y)\u0000" as "muse";
  const hostileEffort = "standard\u0000[x](y)" as "standard";
  const hostileTail: TailResult = {
    shown: ["\u001b[31mOUT\u001b[0m", "a](b)\u0007", "plain"],
    totalLines: 3,
    totalBytes: 20,
    hitLineCap: false,
    hitByteCap: false,
  };
  const hostileLog = "/tmp/\u001b[31mx\u001b[0m[a](b)\u0000.log";
  const blocks: Array<[string, string[]]> = [
    [formatRunStarted(hostileHarness, hostileEffort), ["Running your prompt on", "effort…"]],
    [formatConfirmDialogTitle(hostileHarness), ["Run on muse[x] (y)?"]],
    [
      formatConfirmDialog(hostileHarness, ["claude"], hostileEffort, Number.NaN),
      ["Jev chose muse[x] (y)", "(confidence unknown)", "Run it on muse[x] (y)?"],
    ],
    [formatRunDeclined(hostileHarness), ["**Run declined.**", "**muse[x] (y)**"]],
    [
      formatConfirmHeadless(hostileHarness, hostileEffort, null as unknown as number),
      ["**Confirmation needed", "(confidence unknown)"],
    ],
    [
      formatRunOk(hostileHarness, hostileTail, 1, hostileLog),
      [
        "**Run finished on muse[x] (y) (exit 0).**",
        "Showing the last 3 of 3 stdout lines: (output past the 1 MiB capture cap was dropped)",
        "OUT",
        "a](b)",
        "Full log: /tmp/x[a] (b).log",
      ],
    ],
    [
      formatRunNonzero(hostileHarness, 3, null, hostileTail, 0, hostileTail, hostileLog),
      ["**Run on muse[x] (y) exited with code 3.**", "Last 3 of 3 stderr lines:"],
    ],
    [
      formatRunTimeout(hostileHarness, hostileTail, 0, null, hostileLog),
      ["**Run on muse[x] (y) timed out after 10 minutes.**"],
    ],
    [
      formatRunAborted(hostileHarness, hostileTail, 0, hostileLog),
      ["**Run on muse[x] (y) was cancelled.**"],
    ],
    [formatSpawnError(hostileHarness), ["**Could not start muse[x] (y).**"]],
  ];
  assert.equal(blocks.length, 10);
  for (const [block, markers] of blocks) {
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(block), block);
    // Link syntax in harness output is safe inside its literal fence.
    assert.ok(!block.includes("](") || block.includes("```text\nOUT\na](b)\nplain\n```"), block);
    for (const marker of markers) assert.ok(block.includes(marker), `${marker} missing in ${block}`);
  }
});

test("05-03/T1: hostile exitCode/signal matrix — code/signal/unknown headings, zero throws", () => {
  const throwingCoercion = {
    [Symbol.toPrimitive]() {
      throw new Error("COERCE-PROBE");
    },
  };
  // Labels are precomputed: even the TEST must not String()-coerce the
  // throwing probe (the point is that nothing coerces it).
  const badCodes: Array<[string, unknown]> = [
    ["NaN", Number.NaN],
    ["-1", -1],
    ["1.5", 1.5],
    ['"3"', "3"],
    ["{}", {}],
    ["throwing-coercion", throwingCoercion],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [label, code] of badCodes) {
    let bare: string | undefined;
    let signaled: string | undefined;
    try {
      bare = formatRunNonzero("muse", code as number | null, null, TAIL_3_OF_7, 0, null, LOG_PATH);
      signaled = formatRunNonzero(
        "muse",
        code as number | null,
        "SIGTERM",
        TAIL_3_OF_7,
        0,
        null,
        LOG_PATH,
      );
    } catch (err) {
      assert.fail(`formatRunNonzero threw for code ${label}: ${String(err)}`);
    }
    assert.ok(
      bare.startsWith("**Run on muse ended without a usable exit status.**"),
      `code ${label}: ${bare}`,
    );
    assert.ok(
      signaled.startsWith("**Run on muse was killed (SIGTERM).**"),
      `code ${label}: ${signaled}`,
    );
  }
  // The code heading renders only for finite integers >= 0 (0 counts).
  for (const code of [0, 1, 3, 127]) {
    const block = formatRunNonzero("muse", code, null, TAIL_3_OF_7, 0, null, LOG_PATH);
    assert.ok(block.startsWith(`**Run on muse exited with code ${code}.**`), block);
  }
  // Blank-after-sanitize signals join the unknown heading; laden ones render stripped.
  for (const signal of ["", "   ", "\u0000", "\u0007"]) {
    const block = formatRunNonzero("muse", null, signal, TAIL_3_OF_7, 0, null, LOG_PATH);
    assert.ok(
      block.startsWith("**Run on muse ended without a usable exit status.**"),
      JSON.stringify(signal),
    );
  }
  const ansiSignal = formatRunNonzero(
    "muse",
    null,
    "\u001b[31mSIGTERM\u001b[0m",
    TAIL_3_OF_7,
    0,
    null,
    LOG_PATH,
  );
  assert.ok(ansiSignal.startsWith("**Run on muse was killed (SIGTERM).**"), ansiSignal);
  const linkSignal = formatRunNonzero("muse", null, "SIGKILL[x](y)", TAIL_3_OF_7, 0, null, LOG_PATH);
  assert.ok(linkSignal.startsWith("**Run on muse was killed (SIGKILL[x] (y)).**"), linkSignal);
});

test("05-03/T1: ROUTE_DESCRIPTION golden (HELP_BODY is pinned with the copy constants)", () => {
  assert.equal(ROUTE_DESCRIPTION, "Logofăt: route a prompt to the best installed harness and run it there");
});

test("CR-08: code whitespace and operators survive markdown and plain reports exactly", () => {
  const output = "if True:\n    result = 2 ** 3\n\tprint(`value`, result)  ";
  const tail: TailResult = {
    shown: output.split("\n"), totalLines: 3, totalBytes: Buffer.byteLength(output),
    hitLineCap: false, hitByteCap: false,
  };
  const report = formatRunOk("muse", tail, 0, LOG_PATH);
  assert.equal(report,
    "**Run finished on muse (exit 0).**\nShowing the last 3 of 3 stdout lines:\n" +
    "```text\n" + output + "\n```\nFull log: " + LOG_PATH);
  assert.equal(toPlainText(report),
    "Run finished on muse (exit 0).\nShowing the last 3 of 3 stdout lines:\n" +
    output + "\nFull log: " + LOG_PATH);
});

test("CR-08: hostile fences and links stay literal; only unsafe terminal controls are removed", () => {
  const literal = "```\n[click](https://evil.example)\n![image](x)\n````text\n**literal**\n\t  end";
  const tail: TailResult = {
    shown: (`\u001b[31m${literal}\u001b[0m\u0000\u0007\u202e`).split("\n"),
    totalLines: 6, totalBytes: 100, hitLineCap: false, hitByteCap: false,
  };
  const report = formatRunNonzero("muse", 1, null, TAIL_EMPTY, 0, tail, LOG_PATH);
  const before = "**Run on muse exited with code 1.**\n" +
    "Showing the last 0 of 0 stdout lines:\n(no stdout output)\nLast 6 of 6 stderr lines:\n";
  const after = "\nFull log: " + LOG_PATH +
    "\nCheck the full log for details, then re-run /route for another attempt.";
  assert.equal(report, before + "`````text\n" + literal + "\n`````" + after);
  assert.equal(toPlainText(report), before.replaceAll("**", "") + literal + after);
});

test("05-03/T1: transcript blocks keep the ** + toPlainText contract; dialogs are plain", () => {
  const transcript = [
    formatRunStarted("muse", "standard"),
    formatRunDeclined("muse"),
    formatConfirmHeadless("muse", "standard", 0.63),
    formatRunOk("muse", TAIL_3_OF_7, 0, LOG_PATH),
    formatRunNonzero("muse", 3, null, TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    formatRunTimeout("muse", TAIL_3_OF_7, 0, STDERR_3_OF_7, LOG_PATH),
    formatRunAborted("muse", TAIL_3_OF_7, 0, LOG_PATH),
    formatSpawnError("muse"),
  ];
  for (const block of transcript) {
    assert.ok(block.includes("**"), `expected bold markers in ${block}`);
    assert.ok(!toPlainText(block).includes("**"), block);
  }
  for (const dialog of [
    formatConfirmDialogTitle("muse"),
    formatConfirmDialog("muse", ["claude"], "standard", 0.63),
  ]) {
    assert.ok(!dialog.includes("**"), `dialogs carry no markdown: ${dialog}`);
  }
});

// ---------------------------------------------------------------------------
// Plan 06-02/T1: formatExplainLine goldens.
// ---------------------------------------------------------------------------

/** Decision fixture with a deliberately hostile difficulty (0.99 never renders). */
function explainDecision(
  probabilities: Readonly<Record<string, number>> | null,
  harness: ProviderId = "muse",
): JevDecision {
  return {
    harness,
    confidence: 0.9,
    probabilities,
    difficulty: 0.99,
    scoreConfidence: 0.9,
    scoreProbabilities: { "1": 1 },
    effort: "standard",
  };
}

test("06-02/T1: full shape names the winner, both floored figures, the runner-up, and confidence", () => {
  assert.equal(
    formatExplainLine(explainDecision({ muse: 0.819, claude: 0.121 }), ["muse", "claude"], 0.9),
    "Why **muse**, 0.81 vs **claude** 0.12 (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(explainDecision({ muse: 0.2, claude: 0.75 }, "claude"), ["muse", "claude"], 0.77),
    "Why **claude**, 0.75 vs **muse** 0.20 (confidence 0.77).",
  );
  assert.equal(
    formatExplainLine(explainDecision({ muse: 1, claude: 0 }), ["muse", "claude"], 1),
    "Why **muse**, 1.00 vs **claude** 0.00 (confidence 1.00).",
  );
});

test("06-02/T1: degraded shapes drop the margin clause with no gap and no placeholder", () => {
  assert.equal(
    formatExplainLine(explainDecision(null), ["muse", "claude"], 0.9),
    "Why **muse** (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(explainDecision({ claude: 0.4 }), ["muse", "claude"], 0.9),
    "Why **muse** (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(explainDecision({ muse: 0.99 }), ["muse"], 0.9),
    "Why **muse** (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(explainDecision({ muse: Number.NaN, claude: 0.5 }), ["muse", "claude"], 0.9),
    "Why **muse** (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(explainDecision({ muse: 0.8, claude: 1.7 }), ["muse", "claude"], 0.9),
    "Why **muse** (confidence 0.90).",
  );
});

test("06-02/T1: runner-up is the highest usable figure; ties break by list order", () => {
  assert.equal(
    formatExplainLine(explainDecision({ muse: 0.6, claude: 0.3 }), ["claude", "muse"], 0.9),
    "Why **muse**, 0.60 vs **claude** 0.30 (confidence 0.90).",
  );
  // Ties across three candidate ids (the future-harness shape): first in list order wins.
  assert.equal(
    formatExplainLine(
      explainDecision({ muse: 0.5, claude: 0.3, cursor: 0.3 }),
      ["claude", "cursor", "muse"] as unknown as ProviderId[],
      0.9,
    ),
    "Why **muse**, 0.50 vs **claude** 0.30 (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(
      explainDecision({ muse: 0.5, claude: 0.3, cursor: 0.3 }),
      ["cursor", "claude", "muse"] as unknown as ProviderId[],
      0.9,
    ),
    "Why **muse**, 0.50 vs **cursor** 0.30 (confidence 0.90).",
  );
});

test("06-02/T1: forbidden content never renders — difficulty, foreign keys, unusable highs", () => {
  // difficulty 0.99 (in the fixture) never appears; neither does the higher
  // foreign figure — candidacy comes from the available ids only.
  const line = formatExplainLine(
    explainDecision({ muse: 0.8, claude: 0.1, cursor: 0.95 }),
    ["muse", "claude"],
    0.9,
  );
  assert.equal(line, "Why **muse**, 0.80 vs **claude** 0.10 (confidence 0.90).");
  assert.ok(!line.includes("cursor"));
  assert.ok(!line.includes("0.99"));
  assert.ok(!line.includes("0.95"));
});

test("06-02/T1: hostile inputs degrade, never throw", () => {
  const cases: Array<[unknown, unknown, unknown]> = [
    [null, ["muse", "claude"], 0.9],
    [undefined, ["muse", "claude"], 0.9],
    ["muse", ["muse", "claude"], 0.9],
    [explainDecision("nope" as unknown as Record<string, number>), ["muse", "claude"], 0.9],
    [explainDecision(["muse"] as unknown as Record<string, number>), ["muse", "claude"], 0.9],
    [explainDecision({ muse: Number.POSITIVE_INFINITY, claude: 0.1 }), ["muse", "claude"], 0.9],
    [explainDecision({ muse: -0.2, claude: 0.1 }), ["muse", "claude"], 0.9],
    [explainDecision({ muse: 0.8, claude: Number.NaN }), ["muse", "claude"], 0.9],
    [explainDecision({ muse: 0.8, claude: 0.1 }), null, 0.9],
    [explainDecision({ muse: 0.8, claude: 0.1 }), "muse", 0.9],
    [explainDecision({ muse: 0.8, claude: 0.1 }), [null, 42], 0.9],
  ];
  for (const [decision, ids, confidence] of cases) {
    let line: string | undefined;
    try {
      line = formatExplainLine(decision as JevDecision, ids as readonly ProviderId[], confidence as number);
    } catch (err) {
      assert.fail(`formatExplainLine threw: ${String(err)}`);
    }
    assert.match(line, /^Why \*\*.+\*\* (\(confidence .+\)|, \d\.\d\d vs)/);
  }
  assert.equal(
    formatExplainLine(
      explainDecision({ muse: 0.8, claude: 0.1 }),
      null as unknown as readonly ProviderId[],
      0.9,
    ),
    "Why **muse** (confidence 0.90).",
  );
  assert.equal(
    formatExplainLine(null as unknown as JevDecision, ["muse", "claude"], 0.9),
    "Why **unknown** (confidence 0.90).",
  );
  // A hostile winner id sanitizes for display; the margin drops (no raw-key match).
  assert.equal(
    formatExplainLine(
      { ...explainDecision({ muse: 0.8, claude: 0.1 }), harness: "[x](https://evil.example)" as unknown as ProviderId },
      ["muse", "claude"],
      0.9,
    ),
    "Why **[x] (https://evil.example)** (confidence 0.90).",
  );
  // Throwing getters never escape.
  const evilProbs = {};
  Object.defineProperty(evilProbs, "muse", {
    get() {
      throw new Error("getter boom");
    },
  });
  assert.equal(
    formatExplainLine(explainDecision(evilProbs as Record<string, number>), ["muse", "claude"], 0.9),
    "Why **muse** (confidence 0.90).",
  );
  const evilDecision = {};
  Object.defineProperty(evilDecision, "harness", {
    get() {
      throw new Error("harness boom");
    },
  });
  assert.equal(
    formatExplainLine(evilDecision as unknown as JevDecision, ["muse", "claude"], 0.9),
    "Why **unknown** (confidence 0.90).",
  );
  // Hostile-only: an unusable confidence renders the unknown label with the margin intact.
  assert.equal(
    formatExplainLine(explainDecision({ muse: 0.8, claude: 0.1 }), ["muse", "claude"], Number.NaN),
    "Why **muse**, 0.80 vs **claude** 0.10 (confidence unknown).",
  );
});

// ---------------------------------------------------------------------------
// Plan 06-03/T2: refresh formatter goldens.
// ---------------------------------------------------------------------------

test("06-03/T2: refresh help, usage, first-detection note, and no-changes line", () => {
  assert.equal(
    formatRefreshHelp(),
    "Usage: /route-providers\nRe-detects installed harnesses and shows what changed since the last detection.",
  );
  assert.equal(
    formatRefreshUsage(),
    "Usage: /route-providers\n/route-providers takes no arguments. Run it bare to re-detect harnesses.",
  );
  assert.equal(formatFirstDetectionNote(), "(No previous detection in this session.)");
  assert.equal(formatRefreshDiff([], [MUSE_OK, CLAUDE_OK]), "No changes since the last detection.");
  assert.equal(REFRESH_USAGE_HEADING, "Usage: /route-providers");
  assert.equal(REFRESH_HELP_BODY, "Re-detects installed harnesses and shows what changed since the last detection.");
  assert.equal(REFRESH_USAGE_BODY, "/route-providers takes no arguments. Run it bare to re-detect harnesses.");
  assert.equal(REFRESH_NO_CHANGES, "No changes since the last detection.");
  assert.equal(FIRST_DETECTION_NOTE, "(No previous detection in this session.)");
});

test("06-03/T2: changed-rows section renders every kind in change order", () => {
  assert.equal(
    formatRefreshDiff(
      [
        { id: "muse", kind: "became-available" },
        { id: "claude", kind: "version", previous: "1.0", current: "2.0" },
        { id: "claude", kind: "binary", previous: "/a/claude", current: "/b/claude" },
      ],
      [MUSE_OK, CLAUDE_OK],
    ),
    "- muse: now available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: version 1.0 -> 2.0\n" +
      "- claude: binary /a/claude -> /b/claude",
  );
  assert.equal(
    formatRefreshDiff([{ id: "claude", kind: "became-unavailable" }], [MUSE_OK, CLAUDE_MISSING]),
    "- claude: now unavailable (binary not found on PATH)",
  );
});

test("06-03/T2: availability rows render from the fresh snapshot", () => {
  // Recovery with a null version: binary only, no version segment.
  const recovered: Provider = { id: "muse", binary: "/fx/muse", version: null, available: true };
  assert.equal(
    formatRefreshDiff([{ id: "muse", kind: "became-available" }], [recovered, CLAUDE_MISSING]),
    "- muse: now available (/fx/muse)",
  );
  // Missing record degrades: the bare row, and formatRow's missing-reason rule.
  assert.equal(formatRefreshDiff([{ id: "muse", kind: "became-available" }], [CLAUDE_OK]), "- muse: now available");
  assert.equal(
    formatRefreshDiff([{ id: "muse", kind: "became-unavailable" }], [CLAUDE_OK]),
    "- muse: now unavailable (--version failed)",
  );
  // Null sides of version/binary rows render (none).
  assert.equal(
    formatRefreshDiff([{ id: "muse", kind: "version", previous: null, current: "1.0" }], [MUSE_OK]),
    "- muse: version (none) -> 1.0",
  );
  assert.equal(
    formatRefreshDiff([{ id: "muse", kind: "binary", previous: "/a/muse", current: null }], [MUSE_OK]),
    "- muse: binary /a/muse -> (none)",
  );
});

test("06-03/T2: diff fields sanitize like formatRow — ANSI, controls, link syntax", () => {
  const line = formatRefreshDiff(
    [
      { id: "muse", kind: "version", previous: "\u001b[31m1.0](http://evil.example)", current: "2.0" },
      { id: "muse", kind: "binary", previous: "/a/mu\nse", current: "/b/muse" },
    ],
    [MUSE_OK],
  );
  assert.equal(
    line,
    "- muse: version 1.0] (http://evil.example) -> 2.0\n- muse: binary /a/muse -> /b/muse",
  );
  const snapshot = formatRefreshDiff([{ id: "muse", kind: "became-available" }], [
    { id: "muse", binary: "/fx/\u001b[0mmuse", version: "1.0](x)", available: true },
  ]);
  assert.equal(snapshot, "- muse: now available (/fx/muse, 1.0] (x))");
});

test("06-03/T2: hostile diff inputs degrade, never throw", () => {
  assert.equal(
    formatRefreshDiff(null as unknown as readonly ProviderChange[], [MUSE_OK]),
    "No changes since the last detection.",
  );
  assert.equal(
    formatRefreshDiff("nope" as unknown as readonly ProviderChange[], [MUSE_OK]),
    "No changes since the last detection.",
  );
  assert.equal(
    formatRefreshDiff(
      [null, undefined, {}, { id: "muse" }, { id: "muse", kind: "nope" }] as unknown as readonly ProviderChange[],
      [MUSE_OK],
    ),
    "No changes since the last detection.",
  );
  // A malformed entry is skipped; well-formed siblings still render.
  assert.equal(
    formatRefreshDiff(
      [null, { id: "muse", kind: "version", previous: "1.0", current: "2.0" }] as unknown as readonly ProviderChange[],
      [MUSE_OK],
    ),
    "- muse: version 1.0 -> 2.0",
  );
  // A hostile fresh snapshot degrades per row.
  assert.equal(
    formatRefreshDiff([{ id: "muse", kind: "became-available" }], null as unknown as readonly Provider[]),
    "- muse: now available",
  );
  let threw = false;
  try {
    formatRefreshDiff(
      [{ id: "muse", kind: "version", previous: "1.0", current: "2.0" }],
      "nope" as unknown as readonly Provider[],
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});
