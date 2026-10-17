// Tests for src/capabilities.ts (Phase 3, plan 03-01).
//
// The versioned, frozen, cited capability map + renderCriteria. Imports are
// limited to ../src/capabilities.ts, ../src/providers.ts (types), and node
// built-ins (03-01/T2 exit check).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITIES_VERSION,
  HARNESS_CAPABILITIES,
  effortFromScore,
  renderCriteria,
} from "../src/capabilities.ts";
import type { ProviderId } from "../src/providers.ts";

// ---------------------------------------------------------------------------
// 03-01/T1: map module
// ---------------------------------------------------------------------------

const SUITABILITY_MUSE =
  "muse is a general-purpose coding CLI for routine edits through complex " +
  "open-ended tasks (code generation, issue resolution, and terminal-ops task kinds). " +
  "Public benchmarks measure models, not this CLI wrapper — no harness-level ranking is claimed.";

const SUITABILITY_CLAUDE =
  "claude is a general-purpose coding CLI for routine edits through complex " +
  "open-ended tasks (code generation, issue resolution, and terminal-ops task kinds). " +
  "Public benchmarks measure models, not this CLI wrapper — no harness-level ranking is claimed.";

const SOURCES_GOLDEN = [
  { dataset: "HumanEval", url: "https://github.com/openai/human-eval", license: "MIT" },
  {
    dataset: "Terminal-Bench 2.0",
    url: "https://github.com/laude-institute/terminal-bench",
    license: "Apache-2.0",
  },
  {
    dataset: "SWE-bench Multilingual",
    url: "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual",
    license: "MIT",
  },
];

const EFFORT_NOTES_GOLDEN = {
  low: "Single quick pass with minimal exploration or verification.",
  standard: "Normal multi-step execution with diagnosis and verification.",
  high: "Extended execution with exploration budget for ambiguous or cross-cutting work.",
};

test("03-01/T1(a): CAPABILITIES_VERSION is \"1\"", () => {
  assert.equal(CAPABILITIES_VERSION, "1");
});

test("03-01/T1(b): row keys are exactly [muse, claude]", () => {
  assert.deepEqual(Object.keys(HARNESS_CAPABILITIES), ["muse", "claude"]);
});

test("03-01/T1(c): frozen top-to-bottom (map, rows, sources, source objects, effortNotes)", () => {
  assert.ok(Object.isFrozen(HARNESS_CAPABILITIES));
  for (const id of ["muse", "claude"] as const) {
    const row = HARNESS_CAPABILITIES[id];
    assert.ok(Object.isFrozen(row), `${id} row`);
    assert.ok(Object.isFrozen(row.sources), `${id} sources array`);
    for (const source of row.sources) assert.ok(Object.isFrozen(source), `${id} source object`);
    assert.ok(Object.isFrozen(row.effortNotes), `${id} effortNotes record`);
  }
});

test("03-01/T1(d): suitability goldens match the §2 literals character-for-character", () => {
  assert.equal(HARNESS_CAPABILITIES["muse"].suitability, SUITABILITY_MUSE);
  assert.equal(HARNESS_CAPABILITIES["claude"].suitability, SUITABILITY_CLAUDE);
});

test("03-01/T1(e): sources deep-equal the §2 triples in order on both rows", () => {
  assert.deepEqual([...HARNESS_CAPABILITIES["muse"].sources], SOURCES_GOLDEN);
  assert.deepEqual([...HARNESS_CAPABILITIES["claude"].sources], SOURCES_GOLDEN);
});

test("03-01/T1(f): effortNotes deep-equal the §2 descriptors on both rows", () => {
  assert.deepEqual({ ...HARNESS_CAPABILITIES["muse"].effortNotes }, EFFORT_NOTES_GOLDEN);
  assert.deepEqual({ ...HARNESS_CAPABILITIES["claude"].effortNotes }, EFFORT_NOTES_GOLDEN);
});

test("03-01/T1(g): renderCriteria goldens per available-subset", () => {
  assert.deepEqual(renderCriteria(["muse"]), { muse: SUITABILITY_MUSE });
  assert.deepEqual(renderCriteria(["claude"]), { claude: SUITABILITY_CLAUDE });
  assert.deepEqual(renderCriteria(["muse", "claude"]), { muse: SUITABILITY_MUSE, claude: SUITABILITY_CLAUDE });
  assert.deepEqual(renderCriteria(["claude", "muse"]), { muse: SUITABILITY_MUSE, claude: SUITABILITY_CLAUDE });
});

test("03-03/T1: effortFromScore boundary matrix (nearest-level rounding over [0, 2])", () => {
  const cases: Array<[number, string]> = [
    [0, "low"],
    [0.4999, "low"],
    [0.5, "standard"],
    [1, "standard"],
    [1.4999, "standard"],
    [1.5, "high"],
    [2, "high"],
  ];
  for (const [score, level] of cases) {
    assert.equal(effortFromScore(score), level, `score ${score}`);
  }
});

test("03-03/T1: out-of-contract pin — NaN falls through the comparisons to high (validation upstream guarantees finite input)", () => {
  assert.equal(effortFromScore(Number.NaN), "high");
});

test("03-01/T1(h): unknown ids skipped, non-array yields {}, zero throws", () => {
  const cases: Array<[string, unknown]> = [
    ["unknown id", ["muse", "cursor" as ProviderId]],
    ["non-array string", "muse"],
    ["non-array null", null],
    ["non-array undefined", undefined],
    ["non-array object", { muse: true }],
    ["empty array", []],
  ];
  const expected: Array<Record<string, string>> = [
    { muse: SUITABILITY_MUSE },
    {},
    {},
    {},
    {},
    {},
  ];
  cases.forEach(([label, input], i) => {
    let result: Record<string, string> | undefined;
    try {
      result = renderCriteria(input as unknown as readonly ProviderId[]);
    } catch (err) {
      assert.fail(`${label} threw: ${String(err)}`);
    }
    assert.deepEqual(result, expected[i], label);
  });
});
