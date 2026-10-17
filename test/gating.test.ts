// Tests for src/gating.ts (Phase 4: Routing Safety Rails).
//
// Plan 04-01: threshold constants, the evaluateGate truth table (boundary +
// malformed matrices), the Score-confidence-ignored proof, and hostile-input
// totality. Pure value checks: no Pi, no PATH, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  evaluateGate,
  failureTuple,
  runTuple,
  successTuple,
  writeTuple,
} from "../src/gating.ts";
import type { FailureTuple, GateResult, RunTuple, SuccessTuple, Verdict } from "../src/gating.ts";
import { parseDecision } from "../src/jev.ts";
import type { JevDecision } from "../src/jev.ts";

test("07: additive success telemetry defaults and explicitly captured original pick", () => {
  const input = { decision: decisionWith(0.9), verdict: "auto" as const, latencyMs: 2, availableIds: ["muse", "claude"] as const };
  const defaults = successTuple(input);
  assert.deepEqual({ incumbent: defaults.incumbent, sticky: defaults.sticky, jevHarness: defaults.jevHarness }, { incumbent: null, sticky: "none", jevHarness: "muse" });
  for (const sticky of ["stay", "switch", "none"] as const) {
    const tuple = successTuple({ ...input, incumbent: "claude", sticky, jevHarness: "claude" });
    assert.deepEqual({ harness: tuple.harness, incumbent: tuple.incumbent, sticky: tuple.sticky, jevHarness: tuple.jevHarness }, { harness: "muse", incumbent: "claude", sticky, jevHarness: "claude" });
    assert.deepEqual(Object.keys(tuple).slice(-5), ["verdict", "incumbent", "sticky", "jevHarness", "latencyMs"]);
  }
});

test("07: new tuple fields carry only harness ids and sticky enum, never secrets", () => {
  const input = { decision: decisionWith(0.9), verdict: "auto" as const, latencyMs: 2, availableIds: ["muse", "claude"] as const };
  const allowed = ["ok", "harness", "effort", "difficulty", "confidence", "probabilities", "scoreConfidence", "verdict", "incumbent", "sticky", "jevHarness", "latencyMs"];
  for (const value of ["TSK-KEY-CANARY", "TSK-PROMPT-CANARY", "/bin/TSK-PATH-CANARY", {}, null, undefined, NaN, Symbol("hostile")]) {
    const tuple = successTuple({ ...input, incumbent: value, sticky: value, jevHarness: value } as unknown as Parameters<typeof successTuple>[0]);
    for (const key of Object.keys(tuple)) assert.ok(allowed.includes(key), `NEVER field: ${key}`);
    assert.deepEqual({ incumbent: tuple.incumbent, sticky: tuple.sticky, jevHarness: tuple.jevHarness }, { incumbent: null, sticky: "none", jevHarness: value === undefined ? "muse" : "" });
    assert.ok(!JSON.stringify(tuple).includes("CANARY"));
  }
  for (const key of ["incumbent", "sticky", "jevHarness"]) {
    const hostile = Object.defineProperty({ ...input }, key, { get() { throw new Error("TSK-KEY-CANARY"); } });
    const tuple = successTuple(hostile);
    assert.deepEqual({ incumbent: tuple.incumbent, sticky: tuple.sticky, jevHarness: tuple.jevHarness }, { incumbent: null, sticky: "none", jevHarness: "" });
    assert.ok(!JSON.stringify(tuple).includes("CANARY"));
  }
});

/** Full decision with a caller-chosen Choice confidence (Score fields fixed). */
function decisionWith(confidence: unknown): JevDecision {
  return {
    harness: "muse",
    confidence: confidence as number | null,
    probabilities: { muse: 1 },
    difficulty: 1,
    scoreConfidence: 0.9,
    scoreProbabilities: { "1": 1 },
    effort: "standard",
  };
}

test("04-01/T1(a): threshold constants are the locked 0.5 / 0.8 cuts", () => {
  assert.deepEqual(CONFIDENCE_LOW, 0.5);
  assert.deepEqual(CONFIDENCE_HIGH, 0.8);
});

test("04-01/T1(b): boundary matrix — exact-equality on both cut points", () => {
  const rows: Array<[number, Verdict]> = [
    [1, "auto"],
    [0.8001, "auto"],
    [0.8, "auto"],
    [0.7999, "confirm"],
    [0.63, "confirm"],
    [0.5001, "confirm"],
    [0.5, "confirm"],
    [0.4999, "refuse"],
    [0.31, "refuse"],
    [0, "refuse"],
  ];
  for (const [input, verdict] of rows) {
    assert.deepEqual(evaluateGate(decisionWith(input)), { verdict, confidence: input }, `c=${input}`);
  }
});

test("04-01/T1(c): malformed matrix — every unusable figure fail-closes to refuse + null", () => {
  const malformed: unknown[] = [null, Number.NaN, Infinity, -Infinity, -0.2, 1.7, "0.9", undefined];
  for (const input of malformed) {
    const result = evaluateGate(decisionWith(input));
    assert.deepEqual(result, { verdict: "refuse", confidence: null }, `c=${String(input)}`);
  }
  // Missing key entirely.
  const { confidence: _dropped, ...rest } = decisionWith(0.9);
  assert.deepEqual(evaluateGate(rest as JevDecision), { verdict: "refuse", confidence: null });
});

test("04-01/T1(d): Score confidence is never read — differing scoreConfidence yields identical results", () => {
  const low = { ...decisionWith(0.9), scoreConfidence: 0.1 };
  const high = { ...decisionWith(0.9), scoreConfidence: 0.99 };
  const a = evaluateGate(low);
  const b = evaluateGate(high);
  assert.deepEqual(a, b);
  assert.deepEqual(a, { verdict: "auto", confidence: 0.9 });
});

test("04-01/T1(e): hostile decision input fail-closes with zero throws", () => {
  const throwing = {};
  Object.defineProperty(throwing, "confidence", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  const inputs: unknown[] = [null, undefined, 42, "x", {}, throwing];
  const expected: GateResult = { verdict: "refuse", confidence: null };
  for (const input of inputs) {
    let result: GateResult | undefined;
    try {
      result = evaluateGate(input as JevDecision);
    } catch (err) {
      assert.fail(`evaluateGate threw for ${String(input)}: ${String(err)}`);
    }
    assert.deepEqual(result, expected, `input=${String(input)}`);
  }
});

// ---------------------------------------------------------------------------
// Plan 04-03: tuple builders + writer. Fixed allowlists pinned by key-ORDER
// snapshots; the NEVER-field sweep pins what the record must not contain.
// ---------------------------------------------------------------------------

test("04-03/T1(a): success-tuple snapshot — key order pinned, values verbatim, probabilities filtered", () => {
  const decision = decisionWith(0.63);
  const tuple = successTuple({ decision, verdict: "confirm", latencyMs: 12, availableIds: ["muse", "claude"] });
  assert.deepEqual(Object.keys(tuple), [
    "ok",
    "harness",
    "effort",
    "difficulty",
    "confidence",
    "probabilities",
    "scoreConfidence",
    "verdict",
    "incumbent",
    "sticky",
    "jevHarness",
    "latencyMs",
  ]);
  assert.deepEqual(tuple, {
    ok: true,
    harness: "muse",
    effort: "standard",
    difficulty: 1,
    confidence: 0.63,
    probabilities: { muse: 1 },
    scoreConfidence: 0.9,
    verdict: "confirm",
    incumbent: null,
    sticky: "none",
    jevHarness: "muse",
    latencyMs: 12,
  });
  // The filtered map is a copy, not an alias.
  assert.notStrictEqual(tuple.probabilities, decision.probabilities);
  // Null confidences ride verbatim.
  const nulled = successTuple({
    decision: { ...decision, confidence: null, scoreConfidence: null },
    verdict: "refuse",
    latencyMs: 0,
    availableIds: ["muse", "claude"],
  });
  assert.equal(nulled.confidence, null);
  assert.equal(nulled.scoreConfidence, null);
  // Unknown keys are dropped; known keys stay.
  const mixed = successTuple({
    decision: { ...decision, probabilities: { muse: 0.4, cursor: 0.6 } },
    verdict: "auto",
    latencyMs: 3,
    availableIds: ["muse", "claude"],
  });
  assert.deepEqual(mixed.probabilities, { muse: 0.4 });
  // Non-empty input filtering to empty yields null (malformed-distribution signal).
  const allUnknown = successTuple({
    decision: { ...decision, probabilities: { cursor: 1 } },
    verdict: "auto",
    latencyMs: 3,
    availableIds: ["muse", "claude"],
  });
  assert.equal(allUnknown.probabilities, null);
  // Null stays null and {} stays {}.
  const nullIn = successTuple({
    decision: { ...decision, probabilities: null },
    verdict: "auto",
    latencyMs: 3,
    availableIds: ["muse", "claude"],
  });
  assert.equal(nullIn.probabilities, null);
  const emptyIn = successTuple({
    decision: { ...decision, probabilities: {} },
    verdict: "auto",
    latencyMs: 3,
    availableIds: ["muse", "claude"],
  });
  assert.deepEqual(emptyIn.probabilities, {});
});

test("04-03/T1(b): failure-tuple snapshot — exactly ok/class/latencyMs, confidence keys absent", () => {
  const tuple = failureTuple({ class: "timeout", latencyMs: 46500 });
  assert.deepEqual(Object.keys(tuple), ["ok", "class", "latencyMs"]);
  assert.deepEqual(tuple, { ok: false, class: "timeout", latencyMs: 46500 });
  assert.ok(!("confidence" in tuple), "confidence must be absent, not null");
  assert.ok(!("probabilities" in tuple), "probabilities must be absent, not null");
});

test("04-03/T1(c): NEVER-field sweep — hostile sibling fields never reach the tuple JSON", () => {
  const secrets = [
    "TSK-PROMPT-CANARY-4a1f",
    "TSK-KEY-CANARY-4a1f",
    "/bin/TSK-PATH-CANARY",
    "TSK-VERSION-9.9",
    "TSK-AUTH-4a1f",
  ];
  const hostileDecision = {
    ...decisionWith(0.9),
    probabilities: { "TSK-PROMPT-CANARY-4a1f": 1 },
    prompt: "TSK-PROMPT-CANARY-4a1f",
    apiKey: "TSK-KEY-CANARY-4a1f",
    binary: "/bin/TSK-PATH-CANARY",
    version: "TSK-VERSION-9.9",
    Authorization: "Bearer TSK-AUTH-4a1f",
  };
  const success = successTuple({
    decision: hostileDecision as unknown as JevDecision,
    verdict: "auto",
    latencyMs: 5,
    availableIds: ["muse", "claude"],
    prompt: "TSK-PROMPT-CANARY-4a1f",
  } as unknown as { decision: JevDecision; verdict: Verdict; latencyMs: number; availableIds: ["muse", "claude"] });
  const successJson = JSON.stringify(success);
  for (const secret of secrets) assert.ok(!successJson.includes(secret), `success tuple leaks ${secret}`);
  assert.ok(!successJson.includes("Authorization"), "success tuple mentions Authorization");
  assert.ok(!successJson.includes("Bearer"), "success tuple mentions Bearer");
  const failure = failureTuple({
    class: "network",
    latencyMs: 5,
    prompt: "TSK-PROMPT-CANARY-4a1f",
    apiKey: "TSK-KEY-CANARY-4a1f",
  } as unknown as { class: "timeout"; latencyMs: number });
  const failureJson = JSON.stringify(failure);
  for (const secret of secrets) assert.ok(!failureJson.includes(secret), `failure tuple leaks ${secret}`);
});

test("04-03/T1(d): writer — one call with the JSON line; hostile sink/input never throw", () => {
  const tuple = successTuple({
    decision: decisionWith(0.9),
    verdict: "auto",
    latencyMs: 9,
    availableIds: ["muse", "claude"],
  });
  const seen: string[] = [];
  writeTuple((line) => {
    seen.push(line);
  }, tuple);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], JSON.stringify(tuple));
  assert.ok(!seen[0].includes("\n"), "the tuple is a single line");
  // A throwing sink never breaks the write path.
  let threw = false;
  try {
    writeTuple(() => {
      throw new Error("sink boom");
    }, tuple);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  // Undefined / primitive tuple input still calls the sink once with a JSON line.
  const odd: string[] = [];
  writeTuple((line) => {
    odd.push(line);
  }, undefined as unknown as SuccessTuple);
  writeTuple((line) => {
    odd.push(line);
  }, 42 as unknown as FailureTuple);
  assert.deepEqual(odd, ["null", "42"]);
  // Hostile builder input yields the locked degenerates, zero throws.
  let success: SuccessTuple | undefined;
  let failure: FailureTuple | undefined;
  try {
    success = successTuple(null as unknown as never);
    failure = failureTuple(null as unknown as never);
  } catch (err) {
    assert.fail(`tuple builder threw: ${String(err)}`);
  }
  assert.deepEqual(success, {
    ok: true,
    harness: "",
    effort: "low",
    difficulty: 0,
    confidence: null,
    probabilities: null,
    scoreConfidence: null,
    verdict: "refuse",
    incumbent: null,
    sticky: "none",
    jevHarness: "",
    latencyMs: 0,
  });
  assert.deepEqual(failure, { ok: false, class: "bad-response", latencyMs: 0 });
});

test("04-03/T1(e): parser→builder canary proof — canary-keyed probabilities never reach the tuple", () => {
  const body = {
    answers: {
      harness: {
        type: "choice",
        choice: "muse",
        confidence: 0.9,
        probabilities: { muse: 0.5, "TSK-PROMPT-CANARY-4a1f": 0.5 },
      },
      difficulty: { type: "score", score: 1 },
    },
  };
  const parsed = parseDecision(body, ["muse", "claude"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // Sanity: the parser really carried the hostile key (else the proof is vacuous).
  assert.ok(JSON.stringify(parsed.decision.probabilities).includes("TSK-PROMPT-CANARY-4a1f"));
  const tuple = successTuple({
    decision: parsed.decision,
    verdict: "auto",
    latencyMs: 11,
    availableIds: ["muse", "claude"],
  });
  assert.ok(!JSON.stringify(tuple).includes("TSK-PROMPT-CANARY-4a1f"));
  assert.deepEqual(tuple.probabilities, { muse: 0.5 });
});

// ---------------------------------------------------------------------------
// Plan 05-03/T3(a): run tuples — one fixed-shape JSON record per settled run.
// Pure value checks: no Pi, no PATH, no I/O.
// ---------------------------------------------------------------------------

test("05-03/T3(a): runTuple allowlist — fixed keys in pinned order, type first, runLatencyMs last", () => {
  const tuple = runTuple({
    harness: "muse",
    effort: "standard",
    outcome: "nonzero",
    exitCode: 3,
    signal: null,
    timedOut: false,
    runLatencyMs: 41,
  });
  assert.equal(
    Object.keys(tuple).join(","),
    "type,harness,effort,outcome,exitCode,timedOut,runLatencyMs",
  );
  assert.deepEqual(tuple, {
    type: "run",
    harness: "muse",
    effort: "standard",
    outcome: "nonzero",
    exitCode: 3,
    timedOut: false,
    runLatencyMs: 41,
  });
  const signaled = runTuple({
    harness: "claude",
    effort: "high",
    outcome: "timeout",
    exitCode: null,
    signal: "SIGKILL",
    timedOut: true,
    runLatencyMs: 600_001,
  });
  assert.equal(
    Object.keys(signaled).join(","),
    "type,harness,effort,outcome,signal,timedOut,runLatencyMs",
  );
  assert.equal(signaled.signal, "SIGKILL");
  assert.equal(signaled.timedOut, true);
});

test("05-03/T3(a): absent numerics are omitted, never null", () => {
  const tuple = runTuple({
    harness: "muse",
    effort: "low",
    outcome: "spawn-error",
    exitCode: null,
    signal: null,
    timedOut: false,
    runLatencyMs: 0,
  });
  assert.ok(!("exitCode" in tuple));
  assert.ok(!("signal" in tuple));
  assert.equal(JSON.stringify(tuple).includes("null"), false);
  assert.deepEqual(tuple, {
    type: "run",
    harness: "muse",
    effort: "low",
    outcome: "spawn-error",
    timedOut: false,
    runLatencyMs: 0,
  });
  // Unusable-but-present numerics join the absence rule (omitted, record kept).
  const hostileNumbers = runTuple({
    harness: "muse",
    effort: "low",
    outcome: "nonzero",
    exitCode: Number.NaN,
    signal: "",
    timedOut: false,
    runLatencyMs: 7,
  });
  assert.ok(!("exitCode" in hostileNumbers));
  assert.ok(!("signal" in hostileNumbers));
  assert.equal(hostileNumbers.outcome, "nonzero");
});

test("05-03/T3(a): hostile input yields the locked degenerate, never throws", () => {
  const degenerate: RunTuple = {
    type: "run",
    harness: "" as unknown as RunTuple["harness"],
    effort: "low",
    outcome: "spawn-error",
    timedOut: false,
    runLatencyMs: 0,
  };
  const hostileInputs: unknown[] = [
    null,
    undefined,
    42,
    "run",
    { harness: "cursor", effort: "low", outcome: "ok", exitCode: 0, signal: null, timedOut: false, runLatencyMs: 1 },
    { harness: "muse", effort: "ultra", outcome: "ok", exitCode: 0, signal: null, timedOut: false, runLatencyMs: 1 },
    { harness: "muse", effort: "low", outcome: "bogus", exitCode: 0, signal: null, timedOut: false, runLatencyMs: 1 },
    { harness: "muse", effort: "low", outcome: "ok", exitCode: 0, signal: null, timedOut: "yes", runLatencyMs: 1 },
    { harness: "muse", effort: "low", outcome: "ok", exitCode: 0, signal: null, timedOut: false, runLatencyMs: Number.NaN },
  ];
  for (const input of hostileInputs) {
    let tuple: RunTuple | undefined;
    try {
      tuple = runTuple(input as never);
    } catch (err) {
      assert.fail(`runTuple threw: ${String(err)}`);
    }
    assert.deepEqual(tuple, degenerate, JSON.stringify(input)?.slice(0, 80));
  }
});

test("05-03/T3(a): run tuples carry no prompt, key, path, version, output, or raw-error fields", () => {
  const allowed = ["type", "harness", "effort", "outcome", "exitCode", "signal", "timedOut", "runLatencyMs"];
  for (const tuple of [
    runTuple({
      harness: "muse",
      effort: "standard",
      outcome: "ok",
      exitCode: 0,
      signal: null,
      timedOut: false,
      runLatencyMs: 12,
    }),
    runTuple({
      harness: "claude",
      effort: "high",
      outcome: "timeout",
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      runLatencyMs: 600_001,
    }),
    runTuple(null as unknown as never),
  ]) {
    for (const key of Object.keys(tuple)) assert.ok(allowed.includes(key), `NEVER field: ${key}`);
    const line = JSON.stringify(tuple);
    assert.ok(!line.includes("TSK-PROMPT-CANARY"), line);
    assert.ok(!line.includes("TSK-KEY-CANARY"), line);
  }
});
