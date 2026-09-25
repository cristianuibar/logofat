// Render tests for src/messages.ts (plan 01-03), extended by plan 01-04 into
// character-exact goldens. Pure string checks: no Pi, no PATH, no I/O.
// Cache, emit-gate, and payload-delivery tests live in test/index.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_NOTICE,
  INSTALL_LINES,
  HELP_BODY,
  LOADING_LINE,
  MISSING_KEY_HEADING,
  MISSING_KEY_INTRO,
  NO_HARNESS_HEADING,
  NO_HARNESS_INTRO,
  USAGE_BODY,
  USAGE_HEADING,
  countAvailable,
  formatDecisionLine,
  formatDetectionResult,
  formatHelp,
  formatJevError,
  formatMissingKey,
  formatNoHarness,
  formatProviderList,
  formatUsage,
  sanitizeField,
  toPlainText,
} from "../src/messages.ts";
import { REASON_NOT_FOUND, REASON_VERSION_FAILED, REASON_VERSION_TIMED_OUT } from "../src/providers.ts";
import type { Provider } from "../src/providers.ts";
import type { JevFailureClass } from "../src/jev.ts";

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
  "Install one of the following, then restart Pi and re-run /route:\n" +
  "- muse: see https://dev.meta.ai/ for install instructions\n" +
  "- claude: curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)";

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

test("formatNoHarness: heading, restart wording, both verified install lines", () => {
  const out = formatNoHarness();
  assert.equal(out, GUIDANCE);
  assert.equal(out.split("\n")[0], "**No harnesses detected.**");
  assert.ok(out.includes("then restart Pi and re-run /route"));
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
    "Usage: /route <prompt>\nShows the Jev-chosen harness for a prompt (execution lands in a later release).",
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
    EXECUTION_NOTICE,
    LOADING_LINE,
    formatMissingKey(),
    formatDecisionLine("muse"),
    formatDecisionLine("claude"),
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
    EXECUTION_NOTICE,
    LOADING_LINE,
    formatMissingKey(),
    formatDecisionLine("muse"),
    formatDecisionLine("claude"),
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
      "Install one of the following, then restart Pi and re-run /route:\n" +
      "- muse: see https://dev.meta.ai/ for install instructions\n" +
      "- claude: curl -fsSL https://claude.ai/install.sh | bash (source: https://code.claude.com/docs/en/setup)",
  );
  assert.equal(
    toPlainText(formatNoHarness()),
    "No harnesses detected.\n" +
      "Install one of the following, then restart Pi and re-run /route:\n" +
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
    "Usage: /route <prompt>\nShows the Jev-chosen harness for a prompt (execution lands in a later release).",
  );
});

test("golden: every exported copy constant matches the UI-SPEC wording", () => {
  assert.equal(USAGE_HEADING, "Usage: /route <prompt>");
  assert.equal(USAGE_BODY, "Provide a prompt after /route, or run /route --help for usage. Nothing was executed.");
  assert.equal(HELP_BODY, "Shows the Jev-chosen harness for a prompt (execution lands in a later release).");
  assert.equal(NO_HARNESS_HEADING, "**No harnesses detected.**");
  assert.equal(NO_HARNESS_INTRO, "Install one of the following, then restart Pi and re-run /route:");
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

test("golden: EXECUTION_NOTICE and LOADING_LINE match the §2 literals", () => {
  assert.equal(
    EXECUTION_NOTICE,
    "The prompt was not executed — running it on the chosen harness lands in a later release.",
  );
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

test("golden: formatDecisionLine names the Jev-chosen harness, id bolded", () => {
  assert.equal(formatDecisionLine("muse"), "Jev routed this prompt to **muse**.");
  assert.equal(formatDecisionLine("claude"), "Jev routed this prompt to **claude**.");
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
    "Jev's response was missing the harness choice or was malformed.\n" +
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

test("new blocks: no blank lines inside, no edge newlines, no link syntax", () => {
  const blocks = [
    EXECUTION_NOTICE,
    LOADING_LINE,
    formatMissingKey(),
    formatDecisionLine("muse"),
    formatDecisionLine("claude"),
    ...ALL_JEV_ERROR_CLASSES.map((c) => formatJevError(c)),
  ];
  assert.equal(blocks.length, 13);
  for (const block of blocks) {
    assert.ok(maxConsecutiveBlankLines(block) <= 1, block);
    assert.ok(!block.startsWith("\n") && !block.endsWith("\n"), block);
    assert.ok(!block.includes("]("), block);
  }
});
