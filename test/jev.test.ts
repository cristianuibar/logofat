// Tests for src/jev.ts (Phase 2: Jev Client Core).
//
// Plan 02-01: pure buildRequest/parseDecision mapping, testable without a
// network. No live Jev calls in automated tests, ever.
//
// Imports are limited to ../src/jev.ts, ../src/providers.ts (types), and node
// built-ins (02-01/T3 exit check).

import { test, after } from "node:test";
import assert from "node:assert/strict";

test("CR-01/02: route abort settles a hanging Jev fetch without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  const entered = Promise.withResolvers<AbortSignal>();
  const pending = requestDecision("hello", [MUSE_OK], "fake", {
    signal: controller.signal,
    fetchImpl: ((_url, init) => {
      calls++;
      entered.resolve(init!.signal!);
      return new Promise(() => {});
    }) as typeof fetch,
  });
  const signal = await entered.promise;
  controller.abort();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test("CR-01/02: route abort interrupts retry backoff", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = requestDecision("hello", [MUSE_OK], "fake", {
    signal: controller.signal,
    backoffBaseMs: 60_000,
    fetchImpl: (async () => { calls++; return new Response("", { status: 503 }); }) as typeof fetch,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await pending;
  assert.equal(calls, 1);
});
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  JEV_BACKOFF_BASE_MS,
  JEV_ENDPOINT,
  JEV_MAX_ATTEMPTS,
  JEV_MODEL,
  JEV_QUESTION_ID,
  JEV_SCORE_ID,
  JEV_TIMEOUT_MS,
  buildChoiceQuestion,
  buildRequest,
  buildScoreQuestion,
  parseDecision,
  requestDecision,
  resolveAgentDir,
  resolveApiKey,
} from "../src/jev.ts";
import type { ChoiceQuestion, JevFailureClass, JevResult, ScoreQuestion } from "../src/jev.ts";
import { renderCriteria } from "../src/capabilities.ts";
import { formatDecisionLine, formatJevError, formatMissingKey } from "../src/messages.ts";
import type { Provider, ProviderId } from "../src/providers.ts";

// ---------------------------------------------------------------------------
// 02-01/T1: buildRequest + wire constants
// ---------------------------------------------------------------------------

const MUSE_OK: Provider = {
  id: "muse",
  binary: "/fx/muse",
  version: "Muse Code 1.3.0",
  available: true,
};
const CLAUDE_OK: Provider = {
  id: "claude",
  binary: "/fx/claude",
  version: "2.1.281 (Claude Code)",
  available: true,
};

const INSTRUCTIONS_LITERAL =
  "Which of the available harnesses in `providers` should execute the coding task in `prompt`?";

const SCORE_INSTRUCTIONS_LITERAL = "How difficult is the coding task described in `prompt`?";

const SCORE_LEVELS_LITERAL = [
  "Routine: a single small change with a clear location and verifiable outcome, such as a typo fix, a rename, or a one-function edit.",
  "Standard: a multi-step task in one area, such as a small feature or a bug fix needing diagnosis, touching a few files with testable behavior.",
  "Complex: open-ended or cross-cutting work, such as an architecture change, unfamiliar-codebase exploration, ambiguous requirements, or high-blast-radius edits.",
];

test("03-02/T1(a): two-provider body deep-equals the full two-question shape", () => {
  assert.deepEqual(buildRequest("fix the login bug", [MUSE_OK, CLAUDE_OK]), {
    state: {
      prompt: "fix the login bug",
      providers: [
        { id: "muse", version: "Muse Code 1.3.0" },
        { id: "claude", version: "2.1.281 (Claude Code)" },
      ],
    },
    model: "jev-latest",
    questions: {
      harness: {
        type: "choice",
        instructions: INSTRUCTIONS_LITERAL,
        criteria: renderCriteria(["muse", "claude"]),
      },
      difficulty: {
        type: "score",
        instructions: SCORE_INSTRUCTIONS_LITERAL,
        criteria: SCORE_LEVELS_LITERAL,
      },
    },
  });
});

test("03-02/T1(b): single-provider input yields single-key Choice criteria, Score unchanged", () => {
  const body = buildRequest("hello", [CLAUDE_OK]);
  assert.deepEqual(body.questions["harness"], {
    type: "choice",
    instructions: INSTRUCTIONS_LITERAL,
    criteria: renderCriteria(["claude"]),
  });
  assert.deepEqual(body.questions["difficulty"], {
    type: "score",
    instructions: SCORE_INSTRUCTIONS_LITERAL,
    criteria: SCORE_LEVELS_LITERAL,
  });
  assert.deepEqual(body.state.providers, [{ id: "claude", version: "2.1.281 (Claude Code)" }]);
});

test("03-02/T1(e): built questions are fresh per call — deep mutation never aliases the next build", () => {
  const available = [MUSE_OK, CLAUDE_OK];
  const first = buildRequest("hello", available);
  const pristine = buildRequest("hello", available);
  // Deep-mutate the first build: a 4th Score level plus an overwritten Choice value.
  (first.questions["difficulty"] as ScoreQuestion).criteria.push("Bogus fourth level");
  (first.questions["harness"] as ChoiceQuestion).criteria["muse"] = "Bogus prose";
  const second = buildRequest("hello", available);
  assert.deepEqual(second, pristine);
  // The two builds share no criteria object identity.
  assert.notStrictEqual(
    (second.questions["difficulty"] as ScoreQuestion).criteria,
    (pristine.questions["difficulty"] as ScoreQuestion).criteria,
  );
  assert.notStrictEqual(
    (second.questions["harness"] as ChoiceQuestion).criteria,
    (pristine.questions["harness"] as ChoiceQuestion).criteria,
  );
});

test("03-02/T1(f): JEV_SCORE_ID is \"difficulty\"", () => {
  assert.equal(JEV_SCORE_ID, "difficulty");
});

test("03-02/T1(g): builders return fresh definitions per call (direct units)", () => {
  const a = buildScoreQuestion();
  const b = buildScoreQuestion();
  assert.deepEqual(a, b);
  assert.equal(a.type, "score");
  assert.deepEqual(a.criteria, SCORE_LEVELS_LITERAL);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.criteria, b.criteria);
  assert.deepEqual(buildChoiceQuestion(["muse"]), {
    type: "choice",
    instructions: INSTRUCTIONS_LITERAL,
    criteria: renderCriteria(["muse"]),
  });
});

test("02-01/T1(c): prompt passes through byte-identical, whitespace included", () => {
  for (const prompt of ["  leading", "trailing  ", "\t both \n", "", "  "]) {
    const body = buildRequest(prompt, [MUSE_OK]);
    assert.equal(body.state.prompt, prompt);
  }
});

test("02-01/T1(d): serialized body carries no binary, path, or env material", () => {
  const CANARY = "TSK-BINARY-CANARY-9f8e7d6c5b4a";
  const fixturePath = "/fixture/secret/path";
  const body = buildRequest("hello", [
    { ...MUSE_OK, binary: `${fixturePath}/muse-${CANARY}` },
    { ...CLAUDE_OK, binary: `${fixturePath}/claude` },
  ]);
  const json = JSON.stringify(body);
  assert.ok(!json.includes("binary"), json);
  assert.ok(!json.includes(fixturePath), json);
  assert.ok(!json.includes(CANARY), json);
  // A process.env value probe must not appear either (buildRequest reads no env).
  process.env["LOGOFAT_JEV_TEST_PROBE"] = "LOGOFAT-PROBE-VALUE-7f3e9a1c";
  try {
    assert.ok(!JSON.stringify(buildRequest("hello", [MUSE_OK])).includes("LOGOFAT-PROBE-VALUE-7f3e9a1c"));
  } finally {
    delete process.env["LOGOFAT_JEV_TEST_PROBE"];
  }
});

test("02-01/T1(e): wire constants equal the locked literals", () => {
  assert.equal(JEV_ENDPOINT, "https://api.typesafe.ai/v1/systemone");
  assert.equal(JEV_MODEL, "jev-latest");
  assert.equal(JEV_QUESTION_ID, "harness");
  assert.equal(JEV_TIMEOUT_MS, 15_000);
  assert.equal(JEV_MAX_ATTEMPTS, 3);
  assert.equal(JEV_BACKOFF_BASE_MS, 500);
});

test("02-01/T1: version null stays present as a null key (never dropped)", () => {
  const body = buildRequest("hello", [{ ...MUSE_OK, version: null }]);
  assert.deepEqual(body.state.providers, [{ id: "muse", version: null }]);
  assert.ok("version" in body.state.providers[0]);
});

// ---------------------------------------------------------------------------
// 02-01/T2: parseDecision allowlist validation
// ---------------------------------------------------------------------------

const BOTH_IDS: readonly ProviderId[] = ["muse", "claude"];

function validBody(choice: string = "muse"): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      harness: {
        type: "choice",
        choice,
        probabilities: { muse: 0.88, claude: 0.12 },
        confidence: 0.81,
      },
      difficulty: {
        type: "score",
        score: 1.43,
        confidence: 0.35,
        probabilities: { "0": 0.0, "1": 0.57, "2": 0.43 },
      },
    },
    usage: { input_tokens: 318, output_tokens: 34 },
  };
}

/** Minimal two-answer body with a caller-chosen score value. */
function scoreBody(score: unknown): unknown {
  return {
    answers: {
      harness: { type: "choice", choice: "muse" },
      difficulty: { type: "score", score },
    },
  };
}

test("03-02/T2(a): golden valid two-answer body parses to harness + difficulty + score fields", () => {
  assert.deepEqual(parseDecision(validBody("muse"), BOTH_IDS), {
    ok: true,
    decision: {
      harness: "muse",
      confidence: 0.81,
      probabilities: { muse: 0.88, claude: 0.12 },
      difficulty: 1.43,
      scoreConfidence: 0.35,
      scoreProbabilities: { "0": 0.0, "1": 0.57, "2": 0.43 },
      effort: "standard",
    },
  });
  const claude = parseDecision(validBody("claude"), BOTH_IDS);
  assert.equal(claude.ok, true);
  if (claude.ok) {
    assert.equal(claude.decision.harness, "claude");
    assert.equal(claude.decision.difficulty, 1.43);
    assert.equal(claude.decision.effort, "standard");
  }
  // Boundary scores parse.
  for (const score of [0, 2]) {
    const result = parseDecision(scoreBody(score), BOTH_IDS);
    assert.equal(result.ok, true, `score ${score} must parse`);
    if (result.ok) assert.equal(result.decision.difficulty, score);
  }
});

test("03-03/T1: decisions carry the effort level selected from the Score", () => {
  const cases: Array<[number, string]> = [
    [0.2, "low"],
    [1.0, "standard"],
    [1.9, "high"],
  ];
  for (const [score, effort] of cases) {
    const result = parseDecision(scoreBody(score), BOTH_IDS);
    assert.equal(result.ok, true, `score ${score} must parse`);
    if (result.ok) {
      assert.equal(result.decision.difficulty, score);
      assert.equal(result.decision.effort, effort, `score ${score}`);
    }
  }
});

test("03-02/T2(b-h): malformed difficulty answers all yield bad-response", () => {
  const harness = { type: "choice", choice: "muse" };
  const cases: Array<[string, unknown]> = [
    ["missing difficulty key", { answers: { harness } }],
    ["difficulty null", { answers: { harness, difficulty: null } }],
    ["difficulty is a string", { answers: { harness, difficulty: "1" } }],
    ["wrong difficulty type", { answers: { harness, difficulty: { type: "choice", score: 1 } } }],
    ["string score", scoreBody("1")],
    ["NaN score", scoreBody(Number.NaN)],
    ["Infinity score", scoreBody(Number.POSITIVE_INFINITY)],
    ["negative score", scoreBody(-0.1)],
    ["just-over-range score", scoreBody(2.0001)],
    ["score 3 (retired probe value)", scoreBody(3)],
  ];
  for (const [label, body] of cases) {
    assert.deepEqual(parseDecision(body, BOTH_IDS), { ok: false, failure: { class: "bad-response" } }, label);
  }
});

test("03-02/T2(i): missing harness with valid difficulty is bad-response", () => {
  assert.deepEqual(
    parseDecision({ answers: { difficulty: { type: "score", score: 1 } } }, BOTH_IDS),
    { ok: false, failure: { class: "bad-response" } },
  );
});

test("02-01/T2(b-f): malformed answers all yield bad-response", () => {
  const cases: Array<[string, unknown]> = [
    ["missing answers", { model: "jev-1.13.0" }],
    ["missing harness key", { answers: { difficulty: { type: "choice", choice: "muse" } } }],
    ["wrong answer type", { answers: { harness: { type: "noul", choice: "muse" } } }],
    ["non-string choice", { answers: { harness: { type: "choice", choice: 42 } } }],
    ["empty-string choice", { answers: { harness: { type: "choice", choice: "" } } }],
    ["null body", null],
    ["array body", []],
    ["answers is an array", { answers: [] }],
    ["harness answer is a string", { answers: { harness: "muse" } }],
    ["harness answer is null", { answers: { harness: null } }],
  ];
  for (const [label, body] of cases) {
    assert.deepEqual(parseDecision(body, BOTH_IDS), { ok: false, failure: { class: "bad-response" } }, label);
  }
});

test("02-01/T2(g): choice outside the available subset is unknown-harness, value never echoed", () => {
  const UNKNOWN = "cursor-unknown-harness-4d2e";
  const result = parseDecision(validBody(UNKNOWN), ["muse"]);
  assert.deepEqual(result, { ok: false, failure: { class: "unknown-harness" } });
  assert.ok(!JSON.stringify(result).includes(UNKNOWN));
  assert.ok(!JSON.stringify(result).includes("cursor"));
});

test("03-02/T2(n): out-of-range score 3 is bad-response (inverted 02-01/T2(h) probe)", () => {
  const body = {
    answers: {
      harness: { type: "choice", choice: "claude", confidence: 0.7, probabilities: { claude: 1 } },
      difficulty: { type: "score", score: 3 },
    },
  };
  assert.deepEqual(parseDecision(body, BOTH_IDS), { ok: false, failure: { class: "bad-response" } });
});

test("03-02/T2(k): unknown extra answer keys are ignored, valid body still parses", () => {
  const body = {
    answers: {
      harness: { type: "choice", choice: "claude", confidence: 0.7, probabilities: { claude: 1 } },
      difficulty: { type: "score", score: 1 },
      future: { type: "noul", probability: 0.5 },
    },
  };
  const result = parseDecision(body, BOTH_IDS);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.decision.harness, "claude");
    assert.equal(result.decision.difficulty, 1);
  }
});

test("03-02/T2(l): malformed score confidence/probabilities degrade to null, decision still parses", () => {
  const body = {
    answers: {
      harness: { type: "choice", choice: "muse" },
      difficulty: { type: "score", score: 1, confidence: "high", probabilities: [0.5] },
    },
  };
  assert.deepEqual(parseDecision(body, BOTH_IDS), {
    ok: true,
    decision: {
      harness: "muse",
      confidence: null,
      probabilities: null,
      difficulty: 1,
      scoreConfidence: null,
      scoreProbabilities: null,
      effort: "standard",
    },
  });
});

test("03-02/T2(m): throwing getters in the difficulty subtree yield bad-response, zero throws", () => {
  const throwingDifficulty: { answers: Record<string, unknown> } = {
    answers: { harness: { type: "choice", choice: "muse" } },
  };
  Object.defineProperty(throwingDifficulty.answers, "difficulty", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });
  const throwingScore: Record<string, unknown> = { type: "score" };
  Object.defineProperty(throwingScore, "score", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });
  const bodies: Array<[string, unknown]> = [
    ["throwing difficulty getter", throwingDifficulty],
    [
      "throwing score getter",
      { answers: { harness: { type: "choice", choice: "muse" }, difficulty: throwingScore } },
    ],
  ];
  for (const [label, body] of bodies) {
    let result;
    try {
      result = parseDecision(body, BOTH_IDS);
    } catch (err) {
      assert.fail(`${label} threw: ${String(err)}`);
    }
    assert.deepEqual(result, { ok: false, failure: { class: "bad-response" } }, label);
  }
});

test("03-02/T2(p): dual failure reports the harness class (unknown-harness wins over missing difficulty)", () => {
  assert.deepEqual(parseDecision({ answers: { harness: { type: "choice", choice: "cursor" } } }, ["muse"]), {
    ok: false,
    failure: { class: "unknown-harness" },
  });
});

test("02-01/T2(i): malformed confidence/probabilities degrade to null, choice still parses", () => {
  const difficulty = { type: "score", score: 1 };
  const body = {
    answers: {
      harness: { type: "choice", choice: "muse", confidence: "high", probabilities: [0.5] },
      difficulty,
    },
  };
  assert.deepEqual(parseDecision(body, BOTH_IDS), {
    ok: true,
    decision: {
      harness: "muse",
      confidence: null,
      probabilities: null,
      difficulty: 1,
      scoreConfidence: null,
      scoreProbabilities: null,
      effort: "standard",
    },
  });
  const nonFinite = {
    answers: {
      harness: {
        type: "choice",
        choice: "muse",
        confidence: Number.NaN,
        probabilities: { muse: Number.POSITIVE_INFINITY },
      },
      difficulty,
    },
  };
  assert.deepEqual(parseDecision(nonFinite, BOTH_IDS), {
    ok: true,
    decision: {
      harness: "muse",
      confidence: null,
      probabilities: null,
      difficulty: 1,
      scoreConfidence: null,
      scoreProbabilities: null,
      effort: "standard",
    },
  });
  // No range clamping: out-of-range but finite numbers still carry.
  const unclamped = {
    answers: {
      harness: { type: "choice", choice: "muse", confidence: 99, probabilities: { muse: -1 } },
      difficulty,
    },
  };
  const result = parseDecision(unclamped, BOTH_IDS);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.decision.confidence, 99);
    assert.deepEqual(result.decision.probabilities, { muse: -1 });
    assert.equal(result.decision.difficulty, 1);
  }
});

test("02-01/T2(j): fuzz loop settles to bad-response with zero throws", () => {
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "answers", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });
  const inputs: unknown[] = [undefined, null, 0, "", [], throwingGetter];
  for (const input of inputs) {
    let result;
    try {
      result = parseDecision(input, BOTH_IDS);
    } catch (err) {
      assert.fail(`parseDecision threw for ${String(input)}: ${String(err)}`);
    }
    assert.deepEqual(result, { ok: false, failure: { class: "bad-response" } });
  }
});

// ---------------------------------------------------------------------------
// 02-02/T1: single-attempt fetch with timeout
// ---------------------------------------------------------------------------

type StubInit = {
  method?: unknown;
  headers?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal | null;
};

function okJson(body: unknown): unknown {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

test("02-02/T1(a): success posts URL + method + headers + buildRequest body", async () => {
  const CANARY = "TSK-TRANSPORT-CANARY-1a2b3c";
  const seen: Array<{ url: unknown; init: StubInit }> = [];
  const fetchImpl = (async (url: unknown, init: StubInit) => {
    seen.push({ url, init });
    return okJson(validBody("claude"));
  }) as unknown as typeof fetch;
  const prompt = "fix the login bug";
  const available = [MUSE_OK, CLAUDE_OK];
  const result = await requestDecision(prompt, available, CANARY, { fetchImpl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, JEV_ENDPOINT);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers?.["Content-Type"], "application/json");
  assert.equal(seen[0].init.headers?.["Authorization"], `Bearer ${CANARY}`);
  assert.deepEqual(JSON.parse(seen[0].init.body as string), buildRequest(prompt, available));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.decision.harness, "claude");
});

test("02-02/T1(b): hanging stub + tiny timeout yields timeout after abort", async () => {
  let observed: AbortSignal | null = null;
  let calls = 0;
  const hanging = ((url: unknown, init: StubInit) => {
    calls += 1;
    observed = init.signal ?? null;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: hanging,
    timeoutMs: 5,
    maxAttempts: 1,
  });
  assert.deepEqual(result, { ok: false, failure: { class: "timeout" } });
  assert.equal(calls, 1);
  assert.ok(observed !== null, "the stub must observe the signal");
  assert.equal((observed as AbortSignal).aborted, true);
});

test("02-02/T1(c): fetch rejecting TypeError yields network", async () => {
  let calls = 0;
  const failing = (() => {
    calls += 1;
    return Promise.reject(new TypeError("fetch failed"));
  }) as unknown as typeof fetch;
  const result = await requestDecision("hello", [MUSE_OK], "KEY", { fetchImpl: failing, maxAttempts: 1 });
  assert.deepEqual(result, { ok: false, failure: { class: "network" } });
  assert.equal(calls, 1);
});

test("02-02/T1(d): fetch throwing synchronously yields network, never throws", async () => {
  let calls = 0;
  const throwing = (() => {
    calls += 1;
    throw new Error("sync boom");
  }) as unknown as typeof fetch;
  let result;
  try {
    result = await requestDecision("hello", [MUSE_OK], "KEY", { fetchImpl: throwing, maxAttempts: 1 });
  } catch (err) {
    assert.fail(`requestDecision threw: ${String(err)}`);
  }
  assert.deepEqual(result, { ok: false, failure: { class: "network" } });
  assert.equal(calls, 1);
});

test("02-02/T1(e): 200 with invalid JSON yields bad-response", async () => {
  const badJson = (async () => ({
    ok: true,
    status: 200,
    json: () => Promise.reject(new Error("unexpected token")),
  })) as unknown as typeof fetch;
  const result = await requestDecision("hello", [MUSE_OK], "KEY", { fetchImpl: badJson });
  assert.deepEqual(result, { ok: false, failure: { class: "bad-response" } });
});

test("02-02/T1(f): timer hygiene — a fast success with a long timeout leaves no hanging timer", async () => {
  const fast = (async () => okJson(validBody("muse"))) as unknown as typeof fetch;
  const start = Date.now();
  const result = await requestDecision("hello", [MUSE_OK], "KEY", { fetchImpl: fast, timeoutMs: 30_000 });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - start < 5000, "must resolve immediately, not at the timeout");
  // The suite itself proves no leaked timer: a forgotten 30s timer would hang
  // the test process here.
});

// ---------------------------------------------------------------------------
// 02-02/T2: bounded retry + status mapping
// ---------------------------------------------------------------------------

function statusStub(statuses: number[], body: unknown = validBody("muse")): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let n = 0;
  const fetchImpl = (async () => {
    const status = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

test("02-02/T2(a): 429,429,200-valid retries twice then decides ok", async () => {
  const stub = statusStub([429, 429, 200]);
  const result = await requestDecision("hello", [MUSE_OK, CLAUDE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    backoffBaseMs: 1,
  });
  assert.equal(stub.calls(), 3);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.decision.harness, "muse");
});

test("02-02/T2(b): 429 x3 exhausts to rate-limited", async () => {
  const stub = statusStub([429]);
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    backoffBaseMs: 1,
  });
  assert.equal(stub.calls(), 3);
  assert.deepEqual(result, { ok: false, failure: { class: "rate-limited" } });
});

test("02-02/T2(c): 500,503,529 exhaust to server-error", async () => {
  const stub = statusStub([500, 503, 529]);
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    backoffBaseMs: 1,
  });
  assert.equal(stub.calls(), 3);
  assert.deepEqual(result, { ok: false, failure: { class: "server-error" } });
});

test("02-02/T2(d): 401 never retries even when the next attempt would succeed", async () => {
  const stub = statusStub([401, 200]);
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    backoffBaseMs: 1,
  });
  assert.equal(stub.calls(), 1);
  assert.deepEqual(result, { ok: false, failure: { class: "auth" } });
});

test("02-02/T2(e): 403/422/400 fail immediately with auth/bad-request/bad-request", async () => {
  for (const [status, cls] of [
    [403, "auth"],
    [422, "bad-request"],
    [400, "bad-request"],
  ] as const) {
    const stub = statusStub([status, 200]);
    const result = await requestDecision("hello", [MUSE_OK], "KEY", {
      fetchImpl: stub.fetchImpl,
      backoffBaseMs: 1,
    });
    assert.equal(stub.calls(), 1, `status ${status} must not retry`);
    assert.deepEqual(result, { ok: false, failure: { class: cls } }, `status ${status}`);
  }
});

test("02-02/T2(f): timeout x3 exhausts to timeout", async () => {
  let calls = 0;
  const hanging = ((url: unknown, init: StubInit) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: hanging,
    timeoutMs: 5,
    backoffBaseMs: 1,
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: false, failure: { class: "timeout" } });
});

test("02-02/T2(g): network error x3 exhausts to network", async () => {
  let calls = 0;
  const failing = (() => {
    calls += 1;
    return Promise.reject(new TypeError("fetch failed"));
  }) as unknown as typeof fetch;
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: failing,
    backoffBaseMs: 1,
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: false, failure: { class: "network" } });
});

test("02-02/T2(h): 200 with an unknown harness never retries", async () => {
  const stub = statusStub([200], validBody("cursor"));
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    backoffBaseMs: 1,
  });
  assert.equal(stub.calls(), 1);
  assert.deepEqual(result, { ok: false, failure: { class: "unknown-harness" } });
});

test("02-02/T2(i): invalid numeric opts fall back to defaults (3 attempts)", async () => {
  const stub = statusStub([429]);
  const result = await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    timeoutMs: -1,
    maxAttempts: 0,
    backoffBaseMs: 1,
  });
  assert.equal(stub.calls(), 3, "maxAttempts 0 must fall back to 3, not 0");
  assert.deepEqual(result, { ok: false, failure: { class: "rate-limited" } });
});

test("02-02/T2: backoff sleeps between attempts (lower-bound timing proof)", async () => {
  const stub = statusStub([429]);
  const start = Date.now();
  await requestDecision("hello", [MUSE_OK], "KEY", {
    fetchImpl: stub.fetchImpl,
    backoffBaseMs: 50,
    maxAttempts: 3,
  });
  // Sleeps are 50ms + 100ms = 150ms; assert a generous lower bound (robust:
  // timers never fire early, only late).
  assert.ok(Date.now() - start >= 140, "must sleep ~150ms across two backoffs");
  assert.equal(stub.calls(), 3);
});

// ---------------------------------------------------------------------------
// 02-02/T3: exit check — no key material in any JevResult serialization
// ---------------------------------------------------------------------------

test("02-02/T3: every JevResult serialization lacks the key (8 classes + success)", async () => {
  const CANARY = "TSK-RESULT-CANARY-5e6f7a8b";
  const hanging = ((url: unknown, init: StubInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;
  const results = [
    ["timeout", await requestDecision("hi", [MUSE_OK], CANARY, { fetchImpl: hanging, timeoutMs: 5, maxAttempts: 1 })],
    [
      "network",
      await requestDecision("hi", [MUSE_OK], CANARY, {
        fetchImpl: (() => Promise.reject(new TypeError("down"))) as unknown as typeof fetch,
        maxAttempts: 1,
      }),
    ],
    [
      "rate-limited",
      await requestDecision("hi", [MUSE_OK], CANARY, {
        fetchImpl: statusStub([429]).fetchImpl,
        maxAttempts: 1,
      }),
    ],
    [
      "server-error",
      await requestDecision("hi", [MUSE_OK], CANARY, {
        fetchImpl: statusStub([500]).fetchImpl,
        maxAttempts: 1,
      }),
    ],
    [
      "auth",
      await requestDecision("hi", [MUSE_OK], CANARY, { fetchImpl: statusStub([401]).fetchImpl }),
    ],
    [
      "bad-request",
      await requestDecision("hi", [MUSE_OK], CANARY, { fetchImpl: statusStub([400]).fetchImpl }),
    ],
    [
      "bad-response",
      await requestDecision("hi", [MUSE_OK], CANARY, {
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("bad json")),
        })) as unknown as typeof fetch,
      }),
    ],
    [
      "unknown-harness",
      await requestDecision("hi", [MUSE_OK], CANARY, {
        fetchImpl: statusStub([200], validBody("cursor")).fetchImpl,
      }),
    ],
    [
      "success",
      await requestDecision("hi", [MUSE_OK], CANARY, {
        fetchImpl: statusStub([200], validBody("muse")).fetchImpl,
      }),
    ],
  ] as const;
  assert.equal(results.length, 9);
  for (const [label, result] of results) {
    const json = JSON.stringify(result);
    assert.ok(!json.includes(CANARY), `${label}: result leaks the key: ${json}`);
    assert.ok(!json.includes("Authorization"), `${label}: result mentions Authorization`);
    assert.ok(!json.includes("Bearer"), `${label}: result mentions Bearer`);
  }
  // Sanity: the matrix really covered every class (else the sweep is vacuous).
  assert.deepEqual(
    results.map(([label]) => label),
    ["timeout", "network", "rate-limited", "server-error", "auth", "bad-request", "bad-response", "unknown-harness", "success"],
  );
});

// ---------------------------------------------------------------------------
// 02-03/T1: resolveApiKey (env, else Pi settings)
// ---------------------------------------------------------------------------

const KEY_TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of KEY_TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp agent dir; writes settings.json only when content is given. */
function makeAgentDir(settings: string | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "logofat-jev-key-"));
  KEY_TEMP_DIRS.push(dir);
  if (settings !== null) writeFileSync(path.join(dir, "settings.json"), settings);
  return dir;
}

function settingsWith(keyFragment: string): string {
  return `{"logofat": {"typesafeApiKey": ${keyFragment}}}`;
}

test("02-03/T1(a): env key wins over a settings key", async () => {
  const dir = makeAgentDir(settingsWith('"SETTINGS-KEY-a1"'));
  assert.equal(
    await resolveApiKey({ env: { TYPESAFE_API_KEY: "ENV-KEY-a1" }, agentDir: dir }),
    "ENV-KEY-a1",
  );
});

test("02-03/T1(b): whitespace-only env falls through to the settings key", async () => {
  const dir = makeAgentDir(settingsWith('"SETTINGS-KEY-b2"'));
  assert.equal(
    await resolveApiKey({ env: { TYPESAFE_API_KEY: "  \t\n " }, agentDir: dir }),
    "SETTINGS-KEY-b2",
  );
});

test("02-03/T1(c): neither env nor settings yields null", async () => {
  const dir = makeAgentDir(null);
  assert.equal(await resolveApiKey({ env: {}, agentDir: dir }), null);
});

test("02-03/T1(d): settings key is trimmed before return", async () => {
  const dir = makeAgentDir(settingsWith('"  K-trim-d4  "'));
  assert.equal(await resolveApiKey({ env: {}, agentDir: dir }), "K-trim-d4");
  const envDir = makeAgentDir(null);
  assert.equal(
    await resolveApiKey({ env: { TYPESAFE_API_KEY: "  ENV-TRIM-d4\n" }, agentDir: envDir }),
    "ENV-TRIM-d4",
  );
});

test("02-03/T1(e-h): missing/invalid/wrong-typed settings all yield null, zero throws", async () => {
  const cases: Array<[string, string | null]> = [
    ["missing file", null],
    ["invalid JSON", "{not json"],
    ["array root", "[]"],
    ["null root", "null"],
    ["wrong-typed key", settingsWith("42")],
    ["missing logofat object", '{"other": {}}'],
    ["logofat is a string", '{"logofat": "x"}'],
    ["whitespace-only key", settingsWith('"   "')],
  ];
  for (const [label, settings] of cases) {
    const dir = makeAgentDir(settings);
    let result: string | null | undefined;
    try {
      result = await resolveApiKey({ env: {}, agentDir: dir });
    } catch (err) {
      assert.fail(`${label} threw: ${String(err)}`);
    }
    assert.equal(result, null, label);
  }
});

test("02-03/T1(i): explicit agentDir redirect is honored", async () => {
  // The key value is unique to this fixture: only the redirected dir holds it.
  const dir = makeAgentDir(settingsWith('"REDIRECTED-KEY-i9"'));
  assert.equal(await resolveApiKey({ env: {}, agentDir: dir }), "REDIRECTED-KEY-i9");
});

test("02-03/T1(j): resolveAgentDir precedence with an injected home (no filesystem)", () => {
  const home = path.join("home", "fakeuser");
  const fallback = path.join(home, ".pi", "agent");
  assert.equal(resolveAgentDir({}, home, path.join("custom", "dir")), path.join("custom", "dir"));
  assert.equal(
    resolveAgentDir({ PI_CODING_AGENT_DIR: path.join("env", "dir") }, home),
    path.join("env", "dir"),
  );
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "" }, home), fallback);
  assert.equal(resolveAgentDir({}, home), fallback);
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/work" }, home), path.join(home, "work"));
  // Explicit agentDir beats the env var.
  assert.equal(
    resolveAgentDir({ PI_CODING_AGENT_DIR: path.join("env", "dir") }, home, path.join("custom", "dir")),
    path.join("custom", "dir"),
  );
});

// ---------------------------------------------------------------------------
// 02-04/T4: canary / no-leak proof (success criterion 3)
// ---------------------------------------------------------------------------

// Fixed canary: looks key-like but is NOT a real key — never provision this
// value anywhere. Every key-hygiene assertion keys off it.
const KEY_CANARY = "TSK-CANARY-7f3e2a9c1d4e";
const DECOY_1 = "DECOY-SECRET-aaa111";
const DECOY_2 = "DECOY-SECRET-bbb222";

const ALL_FAILURE_CLASSES: readonly JevFailureClass[] = [
  "timeout",
  "network",
  "rate-limited",
  "server-error",
  "auth",
  "bad-request",
  "bad-response",
  "unknown-harness",
];

/** One JevResult per failure class + success via the real requestDecision. Records every fetch init. */
async function keyedMatrix(
  key: string,
  seen: StubInit[],
): Promise<Array<{ label: string; result: JevResult }>> {
  const record = (impl: (url: unknown, init: StubInit) => Promise<unknown>): typeof fetch =>
    (async (url: unknown, init: StubInit) => {
      seen.push(init);
      return impl(url, init);
    }) as unknown as typeof fetch;
  const hanging = record(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  );
  const failing = record(() => Promise.reject(new TypeError("down")));
  const status = (statuses: number[], body: unknown = validBody("muse")) =>
    record(
      statusStub(statuses, body).fetchImpl as unknown as (
        url: unknown,
        init: StubInit,
      ) => Promise<unknown>,
    );
  const badJson = record(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) }),
  );
  const tiny = { timeoutMs: 5, maxAttempts: 1, backoffBaseMs: 1 };
  const rows: Array<[string, typeof fetch]> = [
    ["timeout", hanging],
    ["network", failing],
    ["rate-limited", status([429])],
    ["server-error", status([500])],
    ["auth", status([401])],
    ["bad-request", status([400])],
    ["bad-response", badJson],
    ["unknown-harness", status([200], validBody("cursor"))],
    ["success", status([200], validBody("muse"))],
  ];
  const out: Array<{ label: string; result: JevResult }> = [];
  for (const [label, fetchImpl] of rows) {
    out.push({ label, result: await requestDecision("hi", [MUSE_OK], key, { fetchImpl, ...tiny }) });
  }
  return out;
}

test("02-04/T4(a): header carries the canary; no JevResult serialization does (8 classes + success)", async () => {
  const seen: StubInit[] = [];
  const matrix = await keyedMatrix(KEY_CANARY, seen);
  assert.equal(matrix.length, 9);
  assert.equal(seen.length, 9);
  for (const init of seen) {
    assert.equal(init.headers?.["Authorization"], `Bearer ${KEY_CANARY}`);
  }
  for (const { label, result } of matrix) {
    assert.ok(!JSON.stringify(result).includes(KEY_CANARY), `${label} leaks the key`);
  }
});

test("02-04/T4(b): settings canary + decoys never reach surfaced copy or result serializations", async () => {
  const dir = makeAgentDir(
    JSON.stringify({
      logofat: { typesafeApiKey: KEY_CANARY },
      other: { token: DECOY_1, nested: { secret: DECOY_2 } },
    }),
  );
  assert.equal(await resolveApiKey({ env: {}, agentDir: dir }), KEY_CANARY);
  const secrets = [KEY_CANARY, DECOY_1, DECOY_2];
  const surfaced = [
    formatMissingKey(),
    formatDecisionLine("muse", "low", 0.9),
    formatDecisionLine("muse", "standard", 0.9),
    formatDecisionLine("muse", "high", 0.9),
    formatDecisionLine("claude", "low", 0.9),
    formatDecisionLine("claude", "standard", 0.9),
    formatDecisionLine("claude", "high", 0.9),
    ...ALL_FAILURE_CLASSES.map((c) => formatJevError(c)),
  ];
  for (const copy of surfaced) {
    for (const secret of secrets) assert.ok(!copy.includes(secret), `surfaced copy leaks ${secret}`);
  }
  const matrix = await keyedMatrix(KEY_CANARY, []);
  for (const { label, result } of matrix) {
    const json = JSON.stringify(result);
    for (const secret of secrets) assert.ok(!json.includes(secret), `${label} leaks ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// 04-02/T2: bounded-total-time proof (the never-hangs test)
// ---------------------------------------------------------------------------
//
// The production bound is arithmetic over the shipped constants:
// 15000×3 + 500×(2^0 + 2^1) = 46500ms. These tests pin the arithmetic AND
// the terminating behavior, both hermetic. The formula pins the CONFIGURED
// budget; event-loop and parse epsilon ride on top — it is not an
// unconditional wall-clock guarantee, which is why the behavioral tests use
// a generous ceiling plus an independent test-option deadline.

test("04-02/T2(a): bound formula over the shipped constants equals 46500ms", () => {
  assert.equal(
    JEV_TIMEOUT_MS * JEV_MAX_ATTEMPTS + JEV_BACKOFF_BASE_MS * (2 ** (JEV_MAX_ATTEMPTS - 1) - 1),
    46500,
  );
});

test(
  "04-02/T2(b): scaled hanging fetch resolves timeout — completion itself is the assertion",
  { timeout: 5000 },
  async () => {
    const hanging = ((url: unknown, init: StubInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const start = Date.now();
    const result = await requestDecision("hello", [MUSE_OK], "KEY", {
      fetchImpl: hanging,
      timeoutMs: 50,
      maxAttempts: 3,
      backoffBaseMs: 10,
    });
    assert.deepEqual(result, { ok: false, failure: { class: "timeout" } });
    assert.ok(Date.now() - start < 5000, "must complete in seconds, not hang");
  },
);

test(
  "04-02/T2(c): mixed retriable run (429, 500) terminates with the last error winning",
  { timeout: 5000 },
  async () => {
    const stub = statusStub([429, 500]);
    const result = await requestDecision("hello", [MUSE_OK], "KEY", {
      fetchImpl: stub.fetchImpl,
      maxAttempts: 3,
      backoffBaseMs: 10,
    });
    assert.equal(stub.calls(), 3);
    assert.deepEqual(result, { ok: false, failure: { class: "server-error" } });
  },
);

test(
  "04-02/T2(d): stalled body (headers arrived, body never settles) classifies as timeout and retries",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const stalled = ((url: unknown, init: StubInit) => {
      calls += 1;
      const signal = init.signal ?? null;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      });
    }) as unknown as typeof fetch;
    const result = await requestDecision("hello", [MUSE_OK], "KEY", {
      fetchImpl: stalled,
      timeoutMs: 50,
      maxAttempts: 3,
      backoffBaseMs: 10,
    });
    assert.equal(calls, 3, "a stalled body retries like any other timeout");
    assert.deepEqual(result, { ok: false, failure: { class: "timeout" } });
  },
);
