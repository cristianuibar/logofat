// Render tests for src/messages.ts (plan 01-03). Plan 01-04 extends these
// into character-exact goldens. Pure string checks: no Pi, no PATH, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ROUTING_NOTICE,
  INSTALL_LINES,
  countAvailable,
  formatDetectionResult,
  formatHelp,
  formatNoHarness,
  formatProviderList,
  formatUsage,
  sanitizeField,
  toPlainText,
} from "../src/messages.ts";
import { REASON_NOT_FOUND, REASON_VERSION_FAILED, REASON_VERSION_TIMED_OUT } from "../src/providers.ts";
import type { Provider } from "../src/providers.ts";

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
  "- muse: no public installer; Muse Code is available to Meta employees through Meta's internal install instructions (launcher: https://api.meta.ai/muse-launcher.sh)\n" +
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

test("ROUTING_NOTICE is the UI-SPEC copy", () => {
  assert.equal(ROUTING_NOTICE, "Automatic routing isn't available yet — this list is the detection result only.");
});

test("populated (2/2): heading, both rows with versions, 1 blank line, notice", () => {
  assert.equal(
    formatProviderList([MUSE_OK, CLAUDE_OK]),
    "**Detected providers (2/2):**\n" +
      "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: available (/opt/claude/bin/claude, 2.1.281 (Claude Code))\n" +
      "\n" +
      ROUTING_NOTICE,
  );
});

test("partial (1/2): available row plus unavailable row, notice present", () => {
  assert.equal(
    formatProviderList([MUSE_OK, CLAUDE_MISSING]),
    "**Detected providers (1/2):**\n" +
      "- muse: available (/usr/local/bin/muse, Muse Code 1.3.0 (1.3.0-R3401.1))\n" +
      "- claude: unavailable (binary not found on PATH)\n" +
      "\n" +
      ROUTING_NOTICE,
  );
  assert.equal(
    formatProviderList([MUSE_MISSING, CLAUDE_OK]),
    "**Detected providers (1/2):**\n" +
      "- muse: unavailable (binary not found on PATH)\n" +
      "- claude: available (/opt/claude/bin/claude, 2.1.281 (Claude Code))\n" +
      "\n" +
      ROUTING_NOTICE,
  );
});

test("empty (0/2): heading plus both rows with reasons, no notice", () => {
  const out = formatProviderList([MUSE_MISSING, CLAUDE_MISSING]);
  assert.equal(
    out,
    "**Detected providers (0/2):**\n" +
      "- muse: unavailable (binary not found on PATH)\n" +
      "- claude: unavailable (binary not found on PATH)",
  );
  assert.ok(!out.includes(ROUTING_NOTICE));
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
  assert.ok(out.includes("https://api.meta.ai/muse-launcher.sh"));
  assert.ok(INSTALL_LINES.claude.startsWith("curl -fsSL https://claude.ai/install.sh | bash"));
});

test("formatDetectionResult at N=0: (0/2) rows, 1 blank line, guidance, no notice", () => {
  const out = formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]);
  assert.equal(out, formatProviderList([MUSE_MISSING, CLAUDE_MISSING]) + "\n\n" + GUIDANCE);
  assert.ok(!out.includes(ROUTING_NOTICE));
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
    "Usage: /route <prompt>\nRoutes a prompt via the best harness (detection only for now; automatic routing lands in a later release).",
  );
});

test("toPlainText strips ** markers and nothing else", () => {
  assert.equal(toPlainText("**Detected providers (2/2):**\n- muse: x"), "Detected providers (2/2):\n- muse: x");
  assert.equal(toPlainText(GUIDANCE), GUIDANCE.replaceAll("**", ""));
  assert.equal(toPlainText(formatUsage()), formatUsage());
});

test("no copy contains planning language, placeholders, or the old name", () => {
  const all = [
    formatProviderList([MUSE_OK, CLAUDE_OK]),
    formatProviderList([MUSE_OK, CLAUDE_MISSING]),
    formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]),
    formatNoHarness(),
    formatUsage(),
    formatHelp(),
    ROUTING_NOTICE,
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
      "- claude: unavailable (boom![img] (http://evil.example/x.png))\n" +
      "\n" +
      ROUTING_NOTICE,
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
