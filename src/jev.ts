// Jev client for Logofăt (Phase 2: Jev Client Core).
//
// NEVER-THROW boundary module (providers.ts precedent): every failure becomes
// a JevResult / null, never a throw. Importing this module has no side
// effects: no network, no timers, no spawn, no env reads at import time.
//
// Layout (02-PLAN.md §1): single src/jev.ts — pure buildRequest/parseDecision
// plus the request wrapper plus key resolution. Phase 3 imports the public
// contracts below; keep their names stable.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Provider, ProviderId } from "./providers.ts";

/** Jev System One endpoint (pinned, no configurability in v0.1). */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Jev model (pinned, no configurability in v0.1). */
export const JEV_MODEL = "jev-latest";

/** Caller-chosen question id. The id is not sent to the model; answers return under it. */
export const JEV_QUESTION_ID = "harness";

/** Per-attempt request timeout in ms (02-PLAN.md D-17). */
export const JEV_TIMEOUT_MS = 15_000;

/** Max attempts including the first (02-PLAN.md D-17). */
export const JEV_MAX_ATTEMPTS = 3;

/** Backoff base in ms: sleep `base * 2^(n-1)` before attempts 2..N (02-PLAN.md D-17). */
export const JEV_BACKOFF_BASE_MS = 500;

// Request instructions (code constant, never surfaced). Backticks are literal:
// they reference `state` fields per the TypeSafe skill.
const INSTRUCTIONS =
  "Which of the available harnesses in `providers` should execute the coding task in `prompt`?";

/** POST body for the Jev System One call. Exact shape per 02-PLAN.md 02-01/T1. */
export type JevRequest = {
  state: {
    prompt: string;
    providers: Array<{ id: ProviderId; version: string | null }>;
  };
  model: string;
  questions: Record<
    string,
    {
      type: "choice";
      instructions: string;
      criteria: Record<string, null>;
    }
  >;
};

/** Failure classes for the Jev call. One distinct block per class (D-18). */
export type JevFailureClass =
  | "timeout"
  | "network"
  | "rate-limited"
  | "server-error"
  | "auth"
  | "bad-request"
  | "bad-response"
  | "unknown-harness";

/** A typed Jev failure. Built from status codes + fixed copy only; the key and response bodies never appear here. */
export type JevFailure = { class: JevFailureClass };

/**
 * A validated Jev decision. `confidence`/`probabilities` ride opaquely
 * (Phase 4 owns gating); malformed values arrive as null, never as a failure.
 */
export type JevDecision = {
  harness: ProviderId;
  confidence: number | null;
  probabilities: Readonly<Record<string, number>> | null;
};

/** The result of a Jev call: a decision or a typed failure. Never a throw. */
export type JevResult = { ok: true; decision: JevDecision } | { ok: false; failure: JevFailure };

/**
 * Builds the Jev request body. Pure: no I/O, no env, never throws for
 * well-formed input.
 *
 * Rules: prompt verbatim (no trim/truncate); criteria keys = available ids
 * only, all null (Phase 3 owns grounding); `version` key always present
 * (null when unknown); no `binary`/path/env fields anywhere. An empty
 * `available` array still builds — the handler never calls it that way
 * (D-19), so there is no guard here and no throw.
 */
export function buildRequest(prompt: string, available: readonly Provider[]): JevRequest {
  const criteria: Record<string, null> = {};
  for (const p of available) criteria[p.id] = null;
  return {
    state: {
      prompt,
      providers: available.map((p) => ({ id: p.id, version: p.version })),
    },
    model: JEV_MODEL,
    questions: {
      [JEV_QUESTION_ID]: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria,
      },
    },
  };
}

/**
 * Validates a Jev response body against the available ids. Pure and total:
 * never throws for any input — throwing getters yield `bad-response`, never
 * propagate.
 *
 * Rules (02-RESEARCH §5): `body.answers["harness"]` must be an object with
 * `type === "choice"` and a non-empty string `choice`, else `bad-response`.
 * A choice outside `availableIds` is `unknown-harness` (never coerce, never
 * default; the unknown value appears nowhere in the result). Extra answer
 * keys are ignored (Phase 3 Score forward-compat). `confidence` carries when
 * a finite number, else null; `probabilities` carries when a plain object of
 * all-finite-numbers (copied), else null — no range clamping, and a valid
 * choice never fails over confidence shape.
 */
export function parseDecision(body: unknown, availableIds: readonly ProviderId[]): JevResult {
  const bad = (): JevResult => ({ ok: false, failure: { class: "bad-response" } });
  try {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad();
    let answers: unknown;
    try {
      answers = (body as Record<string, unknown>)["answers"];
    } catch {
      return bad();
    }
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return bad();
    let answer: unknown;
    try {
      answer = (answers as Record<string, unknown>)[JEV_QUESTION_ID];
    } catch {
      return bad();
    }
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return bad();
    const rec = answer as Record<string, unknown>;
    let type: unknown;
    let choice: unknown;
    try {
      type = rec["type"];
      choice = rec["choice"];
    } catch {
      return bad();
    }
    if (type !== "choice") return bad();
    if (typeof choice !== "string" || choice.length === 0) return bad();
    const allowed: readonly unknown[] = Array.isArray(availableIds) ? availableIds : [];
    if (!allowed.includes(choice)) return { ok: false, failure: { class: "unknown-harness" } };
    // Opaque carry-through: malformed confidence shape degrades to null and
    // never fails the valid choice (Phase 4 owns confidence UX).
    let confidence: number | null = null;
    try {
      const c: unknown = rec["confidence"];
      if (typeof c === "number" && Number.isFinite(c)) confidence = c;
    } catch {
      confidence = null;
    }
    let probabilities: Record<string, number> | null = null;
    try {
      const p: unknown = rec["probabilities"];
      if (typeof p === "object" && p !== null && !Array.isArray(p)) {
        const carried: Record<string, number> = {};
        let allFinite = true;
        for (const [k, v] of Object.entries(p)) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            allFinite = false;
            break;
          }
          carried[k] = v;
        }
        if (allFinite) probabilities = carried;
      }
    } catch {
      probabilities = null;
    }
    return { ok: true, decision: { harness: choice as ProviderId, confidence, probabilities } };
  } catch {
    return bad();
  }
}

/** Injectable seams for requestDecision (the DetectOptions precedent). */
export type RequestDecisionOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
};

function pickPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Retriable while attempts remain: 429/5xx outcomes, timeouts, network errors. */
function isRetriable(failure: JevFailureClass): boolean {
  return (
    failure === "rate-limited" || failure === "server-error" || failure === "timeout" || failure === "network"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportFailure(err: unknown, aborted: boolean): JevResult {
  if (aborted) return { ok: false, failure: { class: "timeout" } };
  let name: unknown;
  try {
    name = (err as { name?: unknown } | null | undefined)?.name;
  } catch {
    name = undefined;
  }
  if (name === "AbortError") return { ok: false, failure: { class: "timeout" } };
  return { ok: false, failure: { class: "network" } };
}

/**
 * Maps one settled fetch to a JevResult. 2xx bodies go through parseDecision
 * (invalid JSON → bad-response); error statuses map per the 02-02/T2 table.
 * Error bodies are never read or echoed. Never throws.
 */
async function handleResponse(res: unknown, available: readonly Provider[]): Promise<JevResult> {
  try {
    if (typeof res !== "object" || res === null) return { ok: false, failure: { class: "bad-response" } };
    const rec = res as { ok?: unknown; status?: unknown; json?: unknown };
    if (rec.ok === true) {
      if (typeof rec.json !== "function") return { ok: false, failure: { class: "bad-response" } };
      let json: unknown;
      try {
        json = await (rec.json as () => Promise<unknown>)();
      } catch {
        return { ok: false, failure: { class: "bad-response" } };
      }
      return parseDecision(json, available.map((p) => p.id));
    }
    const status = typeof rec.status === "number" ? rec.status : 0;
    if (status === 429) return { ok: false, failure: { class: "rate-limited" } };
    if (status >= 500 && status <= 599) return { ok: false, failure: { class: "server-error" } };
    if (status === 401 || status === 403) return { ok: false, failure: { class: "auth" } };
    return { ok: false, failure: { class: "bad-request" } };
  } catch {
    return { ok: false, failure: { class: "bad-response" } };
  }
}

/**
 * One Jev attempt: POST the buildRequest body with a fresh AbortController +
 * timeout, then map the outcome. The timer is always cleared on settle.
 * Never throws: sync throws and non-abort rejections become `network`,
 * aborts become `timeout`.
 */
function attemptOnce(
  prompt: string,
  available: readonly Provider[],
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<JevResult> {
  const controller = new AbortController();
  return new Promise<JevResult>((resolve) => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const settle = (result: JevResult): void => {
      clearTimeout(timer);
      resolve(result);
    };
    let sent: unknown;
    try {
      sent = fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(buildRequest(prompt, available)),
        signal: controller.signal,
      });
    } catch {
      settle({ ok: false, failure: { class: "network" } });
      return;
    }
    Promise.resolve(sent).then(
      (res) => {
        handleResponse(res, available).then(settle, () =>
          settle({ ok: false, failure: { class: "bad-response" } }),
        );
      },
      (err: unknown) => settle(transportFailure(err, controller.signal.aborted)),
    );
  });
}

/**
 * Sends the prompt + available providers to Jev and validates the choice.
 * Bounded loop (02-02/T2): up to maxAttempts attempts with backoff
 * `backoffBaseMs * 2^(n-1)` between attempts. Retried while attempts remain:
 * 429, 500–599, timeout, network error (last error wins on mixed runs).
 * Immediate: 401/403 → auth, other 4xx → bad-request, 2xx parse outcomes.
 * Never throws.
 */
export async function requestDecision(
  prompt: string,
  available: readonly Provider[],
  key: string,
  opts: RequestDecisionOptions = {},
): Promise<JevResult> {
  try {
    const timeoutMs = pickPositive(opts.timeoutMs, JEV_TIMEOUT_MS);
    const maxAttempts = pickPositive(opts.maxAttempts, JEV_MAX_ATTEMPTS);
    const backoffBaseMs = pickPositive(opts.backoffBaseMs, JEV_BACKOFF_BASE_MS);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    let last: JevResult = { ok: false, failure: { class: "network" } };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await attemptOnce(prompt, available, key, fetchImpl, timeoutMs);
      if (result.ok) return result;
      last = result;
      if (!isRetriable(result.failure.class) || attempt >= maxAttempts) return result;
      await sleep(backoffBaseMs * 2 ** (attempt - 1));
    }
    return last;
  } catch {
    return { ok: false, failure: { class: "network" } };
  }
}

/** Injectable seams for resolveApiKey (the DetectOptions.env precedent). */
export type ResolveApiKeyOptions = {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
};

/**
 * Resolves the Pi agent directory. Pure (02-PLAN.md 02-03/T1): explicit
 * `agentDir` wins, else a non-empty `PI_CODING_AGENT_DIR` (a leading `~/`
 * expands against `home`, mirroring Pi's expandTildePath), else
 * `join(home, ".pi", "agent")`. Project `.pi/settings.json` is never
 * consulted (trust boundary, T-06).
 */
export function resolveAgentDir(env: NodeJS.ProcessEnv, home: string, agentDir?: string): string {
  if (typeof agentDir === "string" && agentDir.length > 0) return agentDir;
  const fromEnv = env.PI_CODING_AGENT_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (fromEnv.startsWith("~/")) return path.join(home, fromEnv.slice(2));
    return fromEnv;
  }
  return path.join(home, ".pi", "agent");
}

/** Extracts `logofat.typesafeApiKey` from settings.json text. Never throws, never logs. */
function extractKey(text: string): string | null {
  try {
    const root: unknown = JSON.parse(text);
    if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
    const logofat: unknown = (root as Record<string, unknown>)["logofat"];
    if (typeof logofat !== "object" || logofat === null || Array.isArray(logofat)) return null;
    const key: unknown = (logofat as Record<string, unknown>)["typesafeApiKey"];
    if (typeof key !== "string") return null;
    const trimmed = key.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the TypeSafe API key. Total and never-throw: `TYPESAFE_API_KEY`
 * env (non-empty after trim) wins, else `logofat.typesafeApiKey` in the
 * agent-dir settings.json (same trim rule). Missing file, unreadable file,
 * invalid JSON, and wrong-typed values all resolve as absent (null). Fresh
 * on every call, never cached or logged; file contents and the key are never
 * quoted anywhere.
 */
export async function resolveApiKey(opts: ResolveApiKeyOptions = {}): Promise<string | null> {
  try {
    const env = opts.env ?? process.env;
    const fromEnv = env.TYPESAFE_API_KEY;
    if (typeof fromEnv === "string") {
      const trimmed = fromEnv.trim();
      if (trimmed.length > 0) return trimmed;
    }
    const dir = resolveAgentDir(env, homedir(), opts.agentDir);
    let text: string;
    try {
      text = await readFile(path.join(dir, "settings.json"), "utf8");
    } catch {
      return null;
    }
    return extractKey(text);
  } catch {
    return null;
  }
}
