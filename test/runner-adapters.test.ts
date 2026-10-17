// Tests for src/runner/harnesses/* (Phase 5: Remote Execution + Result Handoff).
//
// Plan 05-02: char-for-char argv goldens (2 harnesses × 3 efforts), the
// prompt-verbatim proof (the prompt is ONE argv element, never split or
// interpolated), and hostile dispatch (unknown harness/effort → null).
// Pure value checks: no spawn, no I/O, no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";

import { buildArgv as buildClaudeArgv } from "../src/runner/harnesses/claude.ts";
import { buildArgv as buildMuseArgv } from "../src/runner/harnesses/muse.ts";
import { buildRunArgv, resolveAdapter } from "../src/runner/harnesses/index.ts";
import type { EffortLevel } from "../src/capabilities.ts";
import type { ProviderId } from "../src/providers.ts";

const EFFORTS: readonly EffortLevel[] = ["low", "standard", "high"];

/** The locked §1 argv arrays, keyed by harness × effort. */
function expectedArgv(harness: ProviderId, effort: EffortLevel, prompt: string): string[] {
  const flag = { low: "low", standard: "medium", high: "high" }[effort];
  return harness === "muse"
    ? ["exec", "--reasoning-effort", flag, "--", prompt]
    : ["-p", "--effort", flag, "--", prompt];
}

test("05-02/T1: muse argv goldens — exact arrays for all 3 efforts", () => {
  for (const effort of EFFORTS) {
    assert.deepEqual(buildMuseArgv({ effort, prompt: "hello" }), expectedArgv("muse", effort, "hello"));
  }
  // Element count + order + spelling, pinned literally (not derived).
  assert.deepEqual(buildMuseArgv({ effort: "low", prompt: "hello" }), [
    "exec",
    "--reasoning-effort",
    "low",
    "--",
    "hello",
  ]);
  assert.deepEqual(buildMuseArgv({ effort: "standard", prompt: "hello" }), [
    "exec",
    "--reasoning-effort",
    "medium",
    "--",
    "hello",
  ]);
  assert.deepEqual(buildMuseArgv({ effort: "high", prompt: "hello" }), [
    "exec",
    "--reasoning-effort",
    "high",
    "--",
    "hello",
  ]);
});

test("05-02/T1: claude argv goldens — exact arrays for all 3 efforts", () => {
  for (const effort of EFFORTS) {
    assert.deepEqual(
      buildClaudeArgv({ effort, prompt: "hello" }),
      expectedArgv("claude", effort, "hello"),
    );
  }
  assert.deepEqual(buildClaudeArgv({ effort: "low", prompt: "hello" }), [
    "-p",
    "--effort",
    "low",
    "--",
    "hello",
  ]);
  assert.deepEqual(buildClaudeArgv({ effort: "standard", prompt: "hello" }), [
    "-p",
    "--effort",
    "medium",
    "--",
    "hello",
  ]);
  assert.deepEqual(buildClaudeArgv({ effort: "high", prompt: "hello" }), [
    "-p",
    "--effort",
    "high",
    "--",
    "hello",
  ]);
});

test("05-02/T1: buildRunArgv wires dispatch to the same exact arrays", () => {
  const harnesses: readonly ProviderId[] = ["muse", "claude"];
  for (const harness of harnesses) {
    for (const effort of EFFORTS) {
      assert.deepEqual(buildRunArgv(harness, effort, "hello"), expectedArgv(harness, effort, "hello"));
    }
  }
});

test("05-02/T1: prompt travels verbatim as ONE argv element (both harnesses)", () => {
  const hostile =
    '  leading and trailing  \nnewline\n"quotes" \'single\' ünïcodé --reasoning-effort xhigh $(touch /tmp/pwned)';
  const harnesses: readonly ProviderId[] = ["muse", "claude"];
  for (const harness of harnesses) {
    const argv = buildRunArgv(harness, "standard", hostile);
    assert.ok(argv !== null);
    assert.equal(argv.length, 5);
    assert.equal(argv[4], hostile);
  }
});

test("CR-05: leading-dash prompts survive a real strict option parser as literals", () => {
  for (const harness of ["muse", "claude"] as const) {
    for (const prompt of ["--version", "--logofat-invalid-flag", "--effort=high"]) {
      const argv = buildRunArgv(harness, "low", prompt)!;
      const parsed = parseArgs({
        args: harness === "muse" ? argv.slice(1) : argv,
        strict: true,
        allowPositionals: true,
        options: {
          p: { type: "boolean" },
          effort: { type: "string" },
          "reasoning-effort": { type: "string" },
          version: { type: "boolean" },
        },
      });
      assert.deepEqual(parsed.positionals, [prompt]);
      assert.equal(parsed.values.version, undefined);
      assert.equal(parsed.values[harness === "muse" ? "reasoning-effort" : "effort"], "low");
    }
  }
});

test("05-02/T1: hostile effort → buildRunArgv null (never a spawn with a hole in argv)", () => {
  const hostileEfforts: unknown[] = ["ultra", "max", "", "LOW", null, undefined, 0, {}, []];
  for (const effort of hostileEfforts) {
    assert.equal(buildRunArgv("muse", effort as EffortLevel, "hello"), null, JSON.stringify(effort));
    assert.equal(
      buildRunArgv("claude", effort as EffortLevel, "hello"),
      null,
      JSON.stringify(effort),
    );
  }
});

test("05-02/T1: hostile harness → buildRunArgv null and resolveAdapter null", () => {
  const hostileHarnesses: unknown[] = ["cursor", "codex", "grok", "", "MUSE", null, undefined, 0, {}];
  for (const harness of hostileHarnesses) {
    assert.equal(
      buildRunArgv(harness as ProviderId, "standard", "hello"),
      null,
      JSON.stringify(harness),
    );
    assert.equal(resolveAdapter(harness as ProviderId), null, JSON.stringify(harness));
  }
});

test("05-02/T1: resolveAdapter returns working adapters for known ids", () => {
  for (const id of ["muse", "claude"] as const) {
    const adapter = resolveAdapter(id);
    assert.ok(adapter !== null);
    assert.deepEqual(
      adapter.buildArgv({ effort: "high", prompt: "hello" }),
      expectedArgv(id, "high", "hello"),
    );
  }
});
