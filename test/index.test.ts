// Unit tests for src/index.ts: factory purity, argument handling, the emit
// gate, the factory-closure detection cache (plan 01-04, task 1), and the
// Jev/key handler paths with injected fakes (plan 02-04, task 3).
//
// Test doubles follow the real host contract (test/output-contract.md):
// - the stub `pi` records registerCommand / on / sendMessage calls;
// - the stub `ctx` carries ONLY genuine command-context members (ui.notify,
//   ui.confirm, mode, hasUI, signal). It has no sendMessage: that method
//   does not exist on the real command context, so a double offering it
//   would hide a bug.
// - the handler contract is Promise<void>. The host discards return values,
//   so every assertion is on recorded notify / sendMessage calls.
//
// Detection is always injected through createRoute(pi, { detect }) so no test
// here spawns a real harness. The one exception is the import-purity proof at
// the end, which runs in a CHILD node process against a generated fixture PATH
// (the test process PATH is never mutated).

import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import logofat, {
  CONFIRM_DIALOG_TIMEOUT_MS,
  CANCEL_ROUTE_SHORTCUT,
  CUSTOM_TYPE,
  REFRESH_DESCRIPTION,
  ROUTE_DESCRIPTION,
  allUnavailable,
  createRoute,
  renderUsage,
} from "../src/index.ts";
import {
  LOADING_LINE,
  formatDecisionLine,
  formatDetectionResult,
  formatFirstDetectionNote,
  formatHelp,
  formatJevError,
  formatMissingKey,
  formatNoHarness,
  formatProviderList,
  formatRefuseBlock,
  formatRefreshHelp,
  formatRefreshUsage,
  formatUsage,
  toPlainText,
} from "../src/messages.ts";
import { REASON_NOT_FOUND, REASON_VERSION_FAILED } from "../src/providers.ts";
import type { Provider, ProviderId } from "../src/providers.ts";
import { requestDecision } from "../src/jev.ts";
import type { JevDecision, JevFailureClass, JevResult } from "../src/jev.ts";
import type { EffortLevel } from "../src/capabilities.ts";
import { __runCount, killAllRuns, nextRunId, runHarness } from "../src/runner/spawn.ts";
import type { RunOptions, RunSettled } from "../src/runner/spawn.ts";
import { STICKY_MARGIN } from "../src/sticky.ts";

function stickyDecision(overrides: Partial<JevDecision> = {}): JevResult {
  return { ok: true, decision: {
    harness: "muse", confidence: 0.9, probabilities: { muse: 0.55, claude: 0.45 },
    difficulty: 1, scoreConfidence: 0.9, scoreProbabilities: { "1": 1 }, effort: "standard",
    ...overrides,
  } };
}

/** Sequential calls share real closure state; only the existing I/O seams are fake. */
function stickyScenario(decisions: JevResult[], outcomes: Partial<RunSettled>[] = []) {
  const pi = makePi();
  const lines: Record<string, unknown>[] = [];
  const seen: RunOptions[] = [];
  let calls = 0;
  let providers = [MUSE_OK, CLAUDE_OK];
  let key: string | null = "STUB-KEY";
  let rejectRun = false;
  const prompts: string[] = [];
  createRoute(pi.api, {
    detect: async () => providers,
    resolveKey: async () => key,
    requestDecision: async (prompt) => {
      prompts.push(prompt);
      assert.ok(calls < decisions.length, "unexpected Jev call");
      return decisions[calls++];
    },
    logSink: (line) => lines.push(JSON.parse(line)),
    logDir: tempLogDir(),
    run: async (opts) => {
      seen.push(opts);
      if (rejectRun) throw new Error("hostile runner");
      return settledRun(opts, outcomes[seen.length - 1]);
    },
  });
  return { pi, lines, seen, prompts,
    calls: () => calls,
    providers: (fresh: Provider[]) => { providers = fresh; },
    key: (fresh: string | null) => { key = fresh; },
    rejectRun: (value: boolean) => { rejectRun = value; },
    invoke: async (ctx = makeCtx(false), prompt = "same near-tie prompt") => {
      await run(routeHandler(pi), prompt, ctx.ctx);
      return ctx;
    },
    refresh: async () => run(refreshHandler(pi), "", makeCtx(false).ctx),
  };
}

function stickyLines(copy: string): string[] {
  return copy.split("\n").filter((line) => /^(Staying on|Switching from) /.test(line));
}

function lastSuccess(s: ReturnType<typeof stickyScenario>): Record<string, unknown> {
  return s.lines.filter((line) => line.ok === true).at(-1)!;
}

test("07 AC-1/5/6/9: alternating Jev picks stay; score effort and argv remain independent", async () => {
  const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", probabilities: { claude: 0.55, muse: 0.45 }, effort: "high", difficulty: 2 }), stickyDecision({ effort: "low", difficulty: 0 })]);
  await s.invoke();
  assert.deepEqual(stickyLines(s.pi.sent[0].content), []);
  assert.deepEqual({ incumbent: lastSuccess(s).incumbent, sticky: lastSuccess(s).sticky, jevHarness: lastSuccess(s).jevHarness }, { incumbent: null, sticky: "none", jevHarness: "muse" });
  await s.invoke();
  assert.equal(s.calls(), 2);
  assert.deepEqual(s.prompts, ["same near-tie prompt", "same near-tie prompt"]);
  assert.equal(s.seen[1].harness, "muse");
  assert.equal(s.seen[1].binary, MUSE_OK.binary);
  assert.equal(s.seen[1].effort, "high");
  assert.deepEqual(s.seen[1].argv, ["exec", "--reasoning-effort", "high", "--", "same near-tie prompt"]);
  assert.deepEqual(stickyLines(s.pi.sent[1].content), ["Staying on **muse** — no challenger cleared the switch margin."]);
  assert.deepEqual({ harness: lastSuccess(s).harness, incumbent: lastSuccess(s).incumbent, sticky: lastSuccess(s).sticky, jevHarness: lastSuccess(s).jevHarness }, { harness: "muse", incumbent: "muse", sticky: "stay", jevHarness: "claude" });
  assert.deepEqual(lastSuccess(s).probabilities, { claude: 0.55, muse: 0.45 });
  assert.equal(lastSuccess(s).difficulty, 2);
  await s.invoke();
  assert.equal(s.seen[2].effort, "low");
  assert.equal(s.seen[2].harness, "muse");
  assert.equal(lastSuccess(s).jevHarness, "muse");
});

for (const [challenger, incumbent, switches] of [[0.15, 0, false], [0.3, 0.15, false], [0.16, 0, true], [0.14, 0, false], [0.55, 0.40, true]] as const) {
  test(`07 AC-2/6: handler boundary ${challenger}-${incumbent}, switch=${switches}`, async () => {
    const diff = challenger - incumbent;
    if (challenger === 0.15 || challenger === 0.3) assert.equal(diff, STICKY_MARGIN);
    else assert.equal(diff > STICKY_MARGIN, switches);
    const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", probabilities: { claude: challenger, muse: incumbent }, effort: "low", difficulty: 0 })]);
    await s.invoke(); await s.invoke();
    const chosen = switches ? "claude" : "muse";
    assert.equal(s.seen[1].harness, chosen);
    assert.equal(s.seen[1].binary, switches ? CLAUDE_OK.binary : MUSE_OK.binary);
    assert.equal(s.seen[1].effort, "low");
    assert.deepEqual(s.seen[1].argv, switches ? ["-p", "--effort", "low", "--", "same near-tie prompt"] : ["exec", "--reasoning-effort", "low", "--", "same near-tie prompt"]);
    assert.equal(lastSuccess(s).sticky, switches ? "switch" : "stay");
    assert.equal(lastSuccess(s).jevHarness, "claude");
    assert.deepEqual(stickyLines(s.pi.sent[1].content), [switches ? "Switching from **muse** to **claude** — its edge cleared the 0.15 switch margin." : "Staying on **muse** — no challenger cleared the switch margin."]);
  });
}

test("07 AC-7: numeric refuse forces incumbent even when the challenger clears margin", async () => {
  for (const probabilities of [{ claude: 0.9, muse: 0.1 }, { claude: 0.55, muse: 0.45 }]) {
    const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", confidence: 0.31, probabilities, effort: "high" })]);
    await s.invoke(); await s.invoke();
    assert.equal(s.seen.length, 2);
    assert.equal(s.seen[1].binary, MUSE_OK.binary);
    assert.deepEqual(s.seen[1].argv, ["exec", "--reasoning-effort", "high", "--", "same near-tie prompt"]);
    const tuple = lastSuccess(s);
    assert.deepEqual({ harness: tuple.harness, incumbent: tuple.incumbent, verdict: tuple.verdict, sticky: tuple.sticky, jevHarness: tuple.jevHarness }, { harness: "muse", incumbent: "muse", verdict: "refuse", sticky: "stay", jevHarness: "claude" });
    const copy = s.pi.sent[1].content;
    assert.deepEqual(stickyLines(copy), ["Staying on **muse** (confidence 0.31) — too close to call, keeping the working harness."]);
    assert.ok(copy.includes("Jev routed this prompt to **muse** at high effort (confidence 0.31).\n\nWhy **muse**"));
    assert.ok(copy.indexOf("Why **muse**") < copy.indexOf("\n\nStaying on"));
    assert.ok(copy.includes("working harness.\n\n**Run finished on muse"));
  }
});

test("07 AC-7: null confidence with incumbent is original-named and byte-identical; retains state", async () => {
  const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", confidence: null, probabilities: { claude: 0.55, muse: 0.45 } }), stickyDecision({ harness: "claude", probabilities: null })]);
  await s.invoke(); await s.invoke();
  assert.equal(s.seen.length, 1);
  assert.equal(s.pi.sent[1].content, `${formatDetectionResult([MUSE_OK, CLAUDE_OK])}\n\n${formatRefuseBlock("claude", ["muse"], null)}`);
  const t = lastSuccess(s);
  assert.deepEqual({ harness: t.harness, incumbent: t.incumbent, verdict: t.verdict, sticky: t.sticky, jevHarness: t.jevHarness }, { harness: "claude", incumbent: "muse", verdict: "refuse", sticky: "none", jevHarness: "claude" });
  assert.deepEqual(stickyLines(s.pi.sent[1].content), []);
  await s.invoke();
  assert.equal(s.seen[1].harness, "muse");
  assert.equal(lastSuccess(s).sticky, "stay");
});

test("07 AC-7/10: numeric and null refusal without incumbent keep current goldens", async () => {
  for (const confidence of [0.31, null]) {
    const s = stickyScenario([stickyDecision({ harness: "claude", confidence })]);
    await s.invoke();
    assert.equal(s.pi.sent[0].content, `${formatDetectionResult([MUSE_OK, CLAUDE_OK])}\n\n${formatRefuseBlock("claude", ["muse"], confidence)}`);
    assert.equal(s.seen.length, 0);
    assert.equal(lastSuccess(s).sticky, "none");
    assert.deepEqual(stickyLines(s.pi.sent[0].content), []);
  }
});

for (const switches of [false, true]) {
  for (const permission of ["granted", "declined", "headless"] as const) {
    test(`07 AC-5/8: confirm ${permission} ${switches ? "switch" : "stay"} names selected harness and emits one line`, async () => {
      const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", confidence: 0.63, probabilities: switches ? { claude: 0.9, muse: 0.1 } : { claude: 0.55, muse: 0.45 } }), stickyDecision({ harness: "claude", probabilities: { claude: 0.55, muse: 0.45 } })]);
      await s.invoke();
      const ctx = makeCtx(permission !== "headless", { confirm: async () => permission === "granted" });
      await s.invoke(ctx);
      const chosen = switches ? "claude" : "muse";
      assert.equal(ctx.confirms.length, permission === "headless" ? 0 : 1);
      if (permission !== "headless") {
        assert.equal(ctx.confirms[0].title, `Run on ${chosen}?`);
        assert.ok(ctx.confirms[0].message.startsWith(`Jev chose ${chosen} at standard effort (confidence 0.63)`));
        assert.ok(ctx.confirms[0].message.endsWith(`Run it on ${chosen}?`));
        assert.ok(ctx.confirms[0].message.includes(`Alternatives: ${switches ? "muse" : "claude"}.`));
        assert.equal(ctx.confirms[0].timeout, CONFIRM_DIALOG_TIMEOUT_MS);
      }
      assert.equal(s.seen.length, permission === "granted" ? 2 : 1);
      if (permission === "granted") assert.equal(s.seen[1].harness, chosen);
      const copy = permission === "headless" ? s.pi.sent.at(-1)!.content : ctx.notes.at(-1)!.text;
      assert.equal(stickyLines(copy).length, 1);
      assert.ok(copy.includes(`Why ${permission === "headless" ? `**${chosen}**` : chosen}`));
      const marker = switches ? "Switching from" : "Staying on";
      assert.ok(copy.indexOf("Why ") < copy.indexOf(marker));
      const tail = permission === "headless" ? "**Confirmation needed" : permission === "declined" ? "Run declined" : "Run finished";
      assert.ok(copy.indexOf(marker) < copy.indexOf(tail));
      assert.ok(!copy.includes("\n\n\n"));
      assert.equal(lastSuccess(s).harness, chosen);
      assert.equal(lastSuccess(s).sticky, switches ? "switch" : "stay");
      await s.invoke();
      assert.equal(lastSuccess(s).incumbent, permission === "granted" ? chosen : "muse");
      assert.equal(s.seen.at(-1)!.harness, permission === "granted" ? chosen : "muse");
    });
  }
}

test("07 AC-8: incumbent agreement still confirms; dismiss/expiry/throw leave state intact", async () => {
  for (const confirm of [async () => false, async () => undefined as unknown as boolean, async () => { throw new Error("dismissed"); }]) {
    const s = stickyScenario([stickyDecision(), stickyDecision({ confidence: 0.63 }), stickyDecision({ harness: "claude", probabilities: null })]);
    await s.invoke();
    const ctx = makeCtx(true, { confirm });
    await s.invoke(ctx);
    assert.equal(ctx.confirms[0].title, "Run on muse?");
    assert.equal(s.seen.length, 1);
    assert.equal(stickyLines(ctx.notes.at(-1)!.text).length, 1);
    await s.invoke();
    assert.equal(s.seen[1].harness, "muse");
    assert.equal(lastSuccess(s).incumbent, "muse");
  }
});

test("07 AC-8: aborted confirm spawns nothing and preserves incumbent", async () => {
  const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", confidence: 0.63, probabilities: null }), stickyDecision({ harness: "claude", probabilities: null })]);
  await s.invoke();
  const controller = new AbortController();
  await s.invoke(makeCtx(true, { signal: controller.signal, confirm: async () => { controller.abort(); return true; } }));
  assert.equal(s.seen.length, 1);
  await s.invoke();
  assert.equal(s.seen[1].harness, "muse");
  assert.equal(lastSuccess(s).incumbent, "muse");
});

for (const outcome of ["nonzero", "timeout", "spawn-error", "aborted"] as const) {
  test(`07 AC-3/4/9: settle ${outcome} ${outcome === "aborted" ? "preserves" : "clears"} incumbent`, async () => {
    const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", probabilities: null }), stickyDecision({ harness: "claude", probabilities: null })], [{}, { outcome, exitCode: outcome === "nonzero" ? 3 : null, timedOut: outcome === "timeout" }]);
    await s.invoke(); await s.invoke();
    assert.equal(s.lines.at(-1)!.outcome, outcome);
    assert.equal(s.lines.at(-1)!.harness, "muse");
    await s.invoke();
    assert.equal(lastSuccess(s).incumbent, outcome === "aborted" ? "muse" : null);
    assert.equal(lastSuccess(s).sticky, outcome === "aborted" ? "stay" : "none");
    assert.equal(s.seen[2].harness, outcome === "aborted" ? "muse" : "claude");
    assert.equal(stickyLines(s.pi.sent[2].content).length, outcome === "aborted" ? 1 : 0);
  });
}

test("07 AC-3: rejecting runner synthesizes spawn-error and dethrones", async () => {
  const s = stickyScenario([stickyDecision(), stickyDecision(), stickyDecision({ harness: "claude", probabilities: null })]);
  await s.invoke(); s.rejectRun(true); await s.invoke(); s.rejectRun(false);
  assert.equal(s.lines.at(-1)!.outcome, "spawn-error");
  await s.invoke();
  assert.equal(lastSuccess(s).incumbent, null);
  assert.equal(s.seen[2].harness, "claude");
});

test("07 AC-3: unresolved provider record synthesizes spawn-error and clears retained incumbent", async () => {
  const s = stickyScenario([stickyDecision(), stickyDecision(), stickyDecision({ harness: "claude", probabilities: null })]);
  await s.invoke(); s.providers([MUSE_MISSING, CLAUDE_OK]); await s.refresh();
  // Hostile fake names a now-unresolvable harness; real Jev validates ids.
  await s.invoke();
  assert.equal(s.seen.length, 1);
  assert.equal(s.lines.at(-1)!.outcome, "spawn-error");
  s.providers([MUSE_OK, CLAUDE_OK]); await s.refresh(); await s.invoke();
  assert.equal(lastSuccess(s).incumbent, null);
  assert.equal(s.seen[1].harness, "claude");
});

test("07: refresh ignores unavailable incumbent without clearing it, restore re-engages", async () => {
  const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", confidence: 0.63, probabilities: null }), stickyDecision({ harness: "claude", probabilities: null })]);
  await s.invoke(); s.providers([MUSE_MISSING, CLAUDE_OK]); await s.refresh(); await s.invoke();
  const tuple = lastSuccess(s);
  assert.deepEqual({ harness: tuple.harness, incumbent: tuple.incumbent, sticky: tuple.sticky, jevHarness: tuple.jevHarness }, { harness: "claude", incumbent: "muse", sticky: "none", jevHarness: "claude" });
  assert.equal(s.seen.length, 1);
  assert.deepEqual(stickyLines(s.pi.sent.at(-1)!.content), []);
  const fresh = stickyScenario([stickyDecision({ harness: "claude", confidence: 0.63, probabilities: null })]);
  fresh.providers([MUSE_MISSING, CLAUDE_OK]); await fresh.invoke();
  assert.equal(s.pi.sent.at(-1)!.content, fresh.pi.sent.at(-1)!.content, "unavailable incumbent composition matches fresh routing byte-for-byte");
  s.providers([MUSE_OK, CLAUDE_OK]); await s.refresh(); await s.invoke();
  assert.equal(lastSuccess(s).incumbent, "muse");
  assert.equal(s.seen[1].harness, "muse");
});

test("07 AC-9: null/tied distributions distinguish agreement from overridden original pick", async () => {
  for (const probabilities of [null, { muse: 0.5, claude: 0.5 }]) {
    for (const harness of ["muse", "claude"] as const) {
      const s = stickyScenario([stickyDecision(), stickyDecision({ harness, probabilities })]);
      await s.invoke(); await s.invoke();
      assert.equal(lastSuccess(s).harness, "muse");
      assert.equal(lastSuccess(s).jevHarness, harness);
      assert.equal(lastSuccess(s).sticky, "stay");
    }
  }
});

test("07: incumbent is session-local and set from settled harness before run-tuple sink", async () => {
  const a = stickyScenario([stickyDecision(), stickyDecision({ probabilities: null })], [{ harness: "claude" }]);
  await a.invoke(); await a.invoke();
  assert.equal(lastSuccess(a).incumbent, "claude");
  assert.equal(a.seen[1].harness, "claude");
  const b = stickyScenario([stickyDecision({ probabilities: null })]);
  await b.invoke();
  assert.equal(lastSuccess(b).incumbent, null);
  assert.deepEqual(stickyLines(b.pi.sent[0].content), []);
});

test("07 AC-5/10: Jev failures, missing key and zero providers keep baselines with no sticky line", async () => {
  for (const failure of FAILURE_CLASSES) {
    const s = stickyScenario([stickyDecision(), { ok: false, failure: { class: failure } }, stickyDecision({ harness: "claude", probabilities: null })]);
    await s.invoke(); await s.invoke();
    assert.equal(s.pi.sent[1].content, `${formatDetectionResult([MUSE_OK, CLAUDE_OK])}\n\n${formatJevError(failure)}`);
    assert.deepEqual(stickyLines(s.pi.sent[1].content), []);
    await s.invoke(); assert.equal(s.seen[1].harness, "muse");
  }
  const s = stickyScenario([stickyDecision(), stickyDecision({ harness: "claude", probabilities: null })]);
  await s.invoke(); s.key(null); await s.invoke();
  assert.equal(s.pi.sent.at(-1)!.content, `${formatDetectionResult([MUSE_OK, CLAUDE_OK])}\n\n${formatMissingKey()}`);
  assert.deepEqual(stickyLines(s.pi.sent.at(-1)!.content), []);
  s.providers([MUSE_MISSING, CLAUDE_MISSING]); await s.refresh(); await s.invoke();
  assert.equal(s.pi.sent.at(-1)!.content, formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]));
  assert.deepEqual(stickyLines(s.pi.sent.at(-1)!.content), []);
  assert.equal(s.calls(), 1);
  s.providers([MUSE_OK, CLAUDE_OK]); s.key("STUB-KEY"); await s.refresh(); await s.invoke();
  assert.equal(lastSuccess(s).incumbent, "muse");
  assert.equal(s.seen[1].harness, "muse");
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Registration = { name: string; description: string; handler: Handler };
type SentMessage = { customType: string; content: string; display: boolean };

type StubPi = {
  api: ExtensionAPI;
  registrations: Registration[];
  onCalls: unknown[][];
  sent: SentMessage[];
  shortcuts: { key: string; handler: () => void }[];
};

function makePi(): StubPi {
  const registrations: Registration[] = [];
  const onCalls: unknown[][] = [];
  const sent: SentMessage[] = [];
  const shortcuts: StubPi["shortcuts"] = [];
  const api = {
    registerShortcut(key: string, options: { handler: () => void }) {
      shortcuts.push({ key, handler: options.handler });
    },
    registerCommand(name: string, options: { description: string; handler: Handler }) {
      registrations.push({ name, description: options.description, handler: options.handler });
    },
    on(...args: unknown[]) {
      onCalls.push(args);
    },
    sendMessage(message: SentMessage, ...rest: unknown[]) {
      assert.equal(rest.length, 0, "pi.sendMessage must be called with the message only");
      sent.push(message);
    },
  };
  return { api: api as unknown as ExtensionAPI, registrations, onCalls, sent, shortcuts };
}

type StubCtx = {
  ctx: ExtensionCommandContext;
  notes: { text: string; level: string }[];
  confirms: { title: string; message: string; timeout: unknown }[];
  statuses: { key: string; text: string | undefined }[];
};

/**
 * hasUI true = TUI/RPC shape; hasUI false = --print --mode json shape.
 * `confirm` injects dialog behavior — the default throws if called, so
 * auto-tier and headless paths (which must never open a dialog) prove it
 * by passing. Every call is recorded with its timeout option. `signal`
 * wires an abort signal (absent = undefined, the not-streaming normal).
 * `setStatus: true` adds a recorded `ctx.ui.setStatus` (absent by default,
 * proving the feature-detect fallback on the paths that omit it).
 */
function makeCtx(
  hasUI: boolean,
  opts?: {
    confirm?: (title: string, message: string, opts: { timeout?: number }) => Promise<boolean>;
    signal?: AbortSignal;
    setStatus?: boolean;
  },
): StubCtx {
  const notes: { text: string; level: string }[] = [];
  const confirms: StubCtx["confirms"] = [];
  const statuses: StubCtx["statuses"] = [];
  const behavior =
    opts?.confirm ?? (() => Promise.reject(new Error("confirm must not run on this path")));
  const raw: Record<string, unknown> = {
    mode: hasUI ? "tui" : "json",
    hasUI,
    ui: {
      notify(text: string, level: string) {
        notes.push({ text, level });
      },
      confirm: (title: string, message: string, o?: { timeout?: number }) => {
        confirms.push({ title, message, timeout: o?.timeout });
        return behavior(title, message, o ?? {});
      },
      ...(opts?.setStatus === true
        ? {
            setStatus(key: string, text: string | undefined) {
              statuses.push({ key, text });
            },
          }
        : {}),
    },
  };
  if (opts?.signal !== undefined) raw["signal"] = opts.signal;
  assert.ok(!("sendMessage" in raw), "the ctx double must not offer ctx.sendMessage");
  return { ctx: raw as unknown as ExtensionCommandContext, notes, confirms, statuses };
}

function routeHandler(pi: StubPi): Handler {
  const reg = pi.registrations.find((r) => r.name === "route");
  assert.ok(reg !== undefined, "expected a route registration");
  return reg.handler;
}

function refreshHandler(pi: StubPi): Handler {
  const reg = pi.registrations.find((r) => r.name === "route-providers");
  assert.ok(reg !== undefined, "expected a route-providers registration");
  return reg.handler;
}

/** Runs the handler and asserts it resolves to undefined (void contract, no throw). */
async function run(handler: Handler, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const result = await handler(args, ctx);
  assert.equal(result, undefined, "handler must resolve to undefined (the host discards return values)");
}

const MUSE_OK: Provider = { id: "muse", binary: "/fx/muse", version: "Muse Code 1.3.0", available: true };
const CLAUDE_OK: Provider = { id: "claude", binary: "/fx/claude", version: "2.1.281 (Claude Code)", available: true };
const MUSE_MISSING: Provider = { id: "muse", binary: "muse", version: null, available: false, reason: REASON_NOT_FOUND };
const CLAUDE_MISSING: Provider = {
  id: "claude",
  binary: "claude",
  version: null,
  available: false,
  reason: REASON_NOT_FOUND,
};

type CountingDetect = { detect: () => Promise<Provider[]>; calls: () => number };

function counting(result: () => Promise<Provider[]>): CountingDetect {
  let n = 0;
  return {
    detect: () => {
      n += 1;
      return result();
    },
    calls: () => n,
  };
}

function throwIfCalled(): Promise<Provider[]> {
  throw new Error("detection must not run for usage-level input");
}

// --- Jev/key fakes (plan 02-04, task 3). Fakes return JevResult values
// directly; no fake reimplements parsing. ---

type KeyFake = { fake: () => Promise<string | null>; calls: () => number };
type DecideFake = {
  fake: (prompt: string, available: readonly Provider[], key: string) => Promise<JevResult>;
  calls: () => number;
};

function keyFake(impl: () => Promise<string | null>): KeyFake {
  let n = 0;
  return {
    fake: () => {
      n += 1;
      return impl();
    },
    calls: () => n,
  };
}

function decideFake(impl: () => Promise<JevResult>): DecideFake {
  let n = 0;
  return {
    fake: () => {
      n += 1;
      return impl();
    },
    calls: () => n,
  };
}

function nullKey(): KeyFake {
  return keyFake(() => Promise.resolve(null));
}

function stubKey(key = "STUB-KEY"): KeyFake {
  return keyFake(() => Promise.resolve(key));
}

function okDecision(
  harness: ProviderId,
  effort: EffortLevel = "standard",
  confidence: number | null = 0.9,
): DecideFake {
  return decideFake(() =>
    Promise.resolve({
      ok: true,
      decision: {
        harness,
        confidence,
        probabilities: { [harness]: 1 },
        difficulty: 1,
        scoreConfidence: 0.9,
        scoreProbabilities: { "1": 1 },
        effort,
      },
    }),
  );
}

function failDecision(cls: JevFailureClass): DecideFake {
  return decideFake(() => Promise.resolve({ ok: false, failure: { class: cls } }));
}

function throwKey(): KeyFake {
  return keyFake(() => {
    throw new Error("key resolution must not run on this path");
  });
}

function throwJev(): DecideFake {
  return decideFake(() => {
    throw new Error("Jev must not run on this path");
  });
}

/** Shared no-op sink for setups that settle decide() without asserting tuples. */
const nullSink = (): void => {};

// --- Run fakes (plan 05-03, task 3). The fake returns fixed settled values
// AND captures the RunOptions it was called with; each case asserts the
// captured binary + argv (the EXEC-01 proof — the exact argv reaches the
// spawn call). `writeRunLog` runs for real with an injected temp logDir. ---

type RunFake = {
  fake: (opts: RunOptions) => Promise<RunSettled>;
  calls: () => number;
  captured: () => RunOptions[];
};

function runFake(impl: (opts: RunOptions) => RunSettled | Promise<RunSettled>): RunFake {
  let n = 0;
  const seen: RunOptions[] = [];
  return {
    fake: (opts) => {
      n += 1;
      seen.push(opts);
      return Promise.resolve().then(() => impl(opts));
    },
    calls: () => n,
    captured: () => seen,
  };
}

/** A run fake that proves its path never spawns: any call rejects AND counts. */
function throwRun(): RunFake {
  return runFake(() => {
    throw new Error("run must not spawn on this path");
  });
}

/** Fixed settled value echoing the invocation's ids, with caller-chosen outcome fields. */
function settledRun(opts: RunOptions, overrides: Partial<RunSettled> = {}): RunSettled {
  return {
    runId: opts.runId,
    harness: opts.harness,
    effort: opts.effort,
    outcome: "ok",
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "OUT-1\nOUT-2\n",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    startedAt: "2026-09-25T00:00:00.000Z",
    settledAt: "2026-09-25T00:00:01.000Z",
    ...overrides,
  };
}

// Tripwire (04-03/T2(g)): every pre-existing createRoute setup whose path
// settles decide() injects an explicit sink. Any setup missed there leaks
// its tuple through the default console.error sink and fails its own test
// here. T2(f) is exempt by construction (it replaces console.error wholesale).
const LEAKED_TUPLES: string[] = [];
const REAL_CONSOLE_ERROR = console.error;
before(() => {
  console.error = (...args: unknown[]) => {
    const line = args.map((arg) => String(arg)).join(" ");
    if (/"latencyMs":/.test(line)) LEAKED_TUPLES.push(line);
    REAL_CONSOLE_ERROR(...args);
  };
});
beforeEach(() => {
  LEAKED_TUPLES.length = 0;
});
afterEach(() => {
  assert.deepEqual(LEAKED_TUPLES, [], `tuple leaked through the default sink: ${JSON.stringify(LEAKED_TUPLES)}`);
});
after(() => {
  console.error = REAL_CONSOLE_ERROR;
});

// Temp log dirs (05-03/T3(b)): handler tests inject RouteDeps.logDir, so
// the real writeRunLog under test never touches the real tmpdir.
const LOG_DIRS: string[] = [];
function tempLogDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "logofat-route-test-"));
  LOG_DIRS.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of LOG_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Registry hygiene (05-03/T3(f)): the runner registry is module-level and
// shared across factory calls — tests must not leak tracked children.
afterEach(async () => {
  await killAllRuns("shutdown", 50);
  assert.equal(__runCount(), 0);
});

const FAILURE_CLASSES: readonly JevFailureClass[] = [
  "timeout",
  "network",
  "rate-limited",
  "server-error",
  "auth",
  "bad-request",
  "bad-response",
  "unknown-harness",
];

// ---------------------------------------------------------------------------
// Factory purity and registration

test("factory: nothing is registered until the factory runs, then route + route-providers, route first", () => {
  const pi = makePi();
  // The module is already imported at the top of this file. Importing it gave
  // the module no `pi` to touch, and the stub records nothing until called.
  assert.equal(pi.registrations.length, 0);
  assert.equal(pi.onCalls.length, 0);
  assert.equal(pi.sent.length, 0);

  const ret = logofat(pi.api);
  assert.equal(ret, undefined);
  assert.deepEqual(
    pi.registrations.map((r) => r.name),
    ["route", "route-providers"],
  );
  assert.equal(pi.registrations[0].description, ROUTE_DESCRIPTION);
  assert.equal(pi.registrations[1].description, REFRESH_DESCRIPTION);
  assert.equal(typeof pi.registrations[0].handler, "function");
  assert.equal(typeof pi.registrations[1].handler, "function");
  // One subscription only: the session_shutdown drain (D-51). Detection
  // stays lazy-only — no session_start probe, no spawn, no fetch, no timers.
  assert.equal(pi.onCalls.length, 1);
  assert.equal(pi.onCalls[0][0], "session_shutdown");
  assert.equal(typeof pi.onCalls[0][1], "function");
  assert.equal(pi.sent.length, 0, "the factory emits nothing");
});

test("factory: registering does not call the detector", () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
  createRoute(pi.api, { detect: det.detect });
  assert.equal(det.calls(), 0);
  assert.deepEqual(
    pi.registrations.map((r) => r.name),
    ["route", "route-providers"],
  );
});

test("CUSTOM_TYPE is the contract literal and the descriptions name Logofăt", () => {
  assert.equal(CUSTOM_TYPE, "logofat");
  assert.ok(ROUTE_DESCRIPTION.startsWith("Logofăt: "));
  assert.ok(!/nabu/i.test(ROUTE_DESCRIPTION));
  assert.ok(REFRESH_DESCRIPTION.startsWith("Logofăt: "));
  assert.ok(!/nabu/i.test(REFRESH_DESCRIPTION));
});

// ---------------------------------------------------------------------------
// Usage-level input: never probes

for (const args of ["", " ", "   ", "\t", " \n "]) {
  test(`usage: args ${JSON.stringify(args)} emits formatUsage without detection (json shape)`, async () => {
    const pi = makePi();
    createRoute(pi.api, { detect: throwIfCalled });
    const { ctx, notes } = makeCtx(false);
    await run(routeHandler(pi), args, ctx);
    assert.deepEqual(notes, [{ text: toPlainText(formatUsage()), level: "info" }]);
    assert.deepEqual(pi.sent, [{ customType: "logofat", content: formatUsage(), display: true }]);
  });
}

for (const args of ["--help", "-h", "  --help  ", " -h"]) {
  test(`help: args ${JSON.stringify(args)} emits formatHelp without detection`, async () => {
    const pi = makePi();
    const det = counting(throwIfCalled);
    createRoute(pi.api, { detect: det.detect });
    const { ctx, notes } = makeCtx(false);
    await run(routeHandler(pi), args, ctx);
    assert.equal(det.calls(), 0);
    assert.deepEqual(notes, [{ text: toPlainText(formatHelp()), level: "info" }]);
    assert.deepEqual(pi.sent, [{ customType: "logofat", content: formatHelp(), display: true }]);
  });
}

test("renderUsage classifies only blank and help input; prompts are never split", () => {
  assert.equal(renderUsage(""), formatUsage());
  assert.equal(renderUsage("  "), formatUsage());
  assert.equal(renderUsage("--help"), formatHelp());
  assert.equal(renderUsage("-h"), formatHelp());
  assert.equal(renderUsage("hello"), null);
  assert.equal(renderUsage("--help me fix this"), null);
  assert.equal(renderUsage(" fix  the   login bug "), null);
});

// ---------------------------------------------------------------------------
// Emit gate matrix: notify always, pi.sendMessage only when !hasUI

test("gate: hasUI true (TUI/RPC) -> one notify, zero pi.sendMessage (usage)", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: throwIfCalled });
  const { ctx, notes } = makeCtx(true);
  await run(routeHandler(pi), "", ctx);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, toPlainText(formatUsage()));
  assert.equal(pi.sent.length, 0);
});

test("gate: hasUI true (TUI/RPC) -> one notify, zero pi.sendMessage (missing-key path)", async () => {
  const pi = makePi();
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
  });
  const { ctx, notes } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  const copy = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatMissingKey()}`;
  assert.deepEqual(notes, [{ text: toPlainText(copy), level: "info" }]);
  assert.ok(!notes[0].text.includes("**"), "notify text is plain (no bold markers)");
  assert.equal(pi.sent.length, 0);
  assert.equal(key.calls(), 1);
  assert.equal(jev.calls(), 0);
});

test("gate: hasUI false (json) -> one notify plus one pi.sendMessage with the markdown copy", async () => {
  const pi = makePi();
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_MISSING]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const copy = `${formatProviderList([MUSE_OK, CLAUDE_MISSING])}\n\n${formatMissingKey()}`;
  assert.deepEqual(notes, [{ text: toPlainText(copy), level: "info" }]);
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: copy, display: true }]);
  assert.equal(key.calls(), 1);
  assert.equal(jev.calls(), 0);
});

test("the prompt text is passed through unsplit and never echoed into the payload", async () => {
  const pi = makePi();
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
  });
  const { ctx } = makeCtx(false);
  await run(routeHandler(pi), " secret  prompt   text ", ctx);
  assert.equal(pi.sent.length, 1);
  assert.ok(!pi.sent[0].content.includes("secret"));
  assert.equal(jev.calls(), 0);
});

// ---------------------------------------------------------------------------
// No-crash paths and the composed N=0 payload

test("composed N=0 payload: (0/2) rows + exactly 1 blank line + full guidance, no notice", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: () => Promise.resolve([MUSE_MISSING, CLAUDE_MISSING]) });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);

  const expected =
    "**Detected providers (0/2):**\n" +
    "- muse: unavailable (binary not found on PATH)\n" +
    "- claude: unavailable (binary not found on PATH)\n" +
    "\n" +
    formatNoHarness();
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].content, expected);
  assert.equal(pi.sent[0].content, formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]));
  assert.ok(!pi.sent[0].content.includes("\n\n\n"), "at most 1 consecutive blank line");
  assert.deepEqual(notes, [{ text: toPlainText(expected), level: "info" }]);
});

test("detection rejection -> all-unavailable '--version failed' rows, resolves, cached (no re-probe)", async () => {
  const pi = makePi();
  const det = counting(() => Promise.reject(new Error("probe exploded")));
  createRoute(pi.api, { detect: det.detect });
  const handler = routeHandler(pi);

  const first = makeCtx(false);
  await run(handler, "hello", first.ctx);
  const expected = formatDetectionResult(allUnavailable());
  assert.ok(expected.startsWith(
    "**Detected providers (0/2):**\n" +
      `- muse: unavailable (${REASON_VERSION_FAILED})\n` +
      `- claude: unavailable (${REASON_VERSION_FAILED})\n` +
      "\n",
  ));
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  assert.equal(first.notes.length, 1);
  assert.ok(!pi.sent[0].content.includes("probe exploded"), "the raw error never reaches the transcript");

  const second = makeCtx(false);
  await run(handler, "again", second.ctx);
  assert.equal(det.calls(), 1, "a rejected detection is cached, never re-probed in the session");
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].content, expected);
});

test("synchronous detector throw is mapped like a rejection (no throw from the handler)", async () => {
  const pi = makePi();
  const det = counting(() => {
    throw new Error("sync boom");
  });
  createRoute(pi.api, { detect: det.detect });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(det.calls(), 1);
  assert.equal(pi.sent[0].content, formatDetectionResult(allUnavailable()));
  assert.equal(notes.length, 1);
});

test("non-array detector result is mapped to all-unavailable", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: () => Promise.resolve(undefined as unknown as Provider[]) });
  const { ctx } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(pi.sent[0].content, formatDetectionResult(allUnavailable()));
});

test("allUnavailable returns both known ids with the '--version failed' reason", () => {
  assert.deepEqual(allUnavailable(), [
    { id: "muse", binary: "muse", version: null, available: false, reason: "--version failed" },
    { id: "claude", binary: "claude", version: null, available: false, reason: "--version failed" },
  ]);
});

// ---------------------------------------------------------------------------
// Session cache: in-flight dedupe and reuse

test("cache: two concurrent /route calls share one in-flight detection", async () => {
  const pi = makePi();
  let release: (value: Provider[]) => void = () => {};
  const pending = new Promise<Provider[]>((resolve) => {
    release = resolve;
  });
  const det = counting(() => pending);
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, { detect: det.detect, resolveKey: key.fake, requestDecision: jev.fake });
  const handler = routeHandler(pi);

  const a = makeCtx(false);
  const b = makeCtx(false);
  const runA = run(handler, "first", a.ctx);
  const runB = run(handler, "second", b.ctx);
  // Let both handlers reach the shared promise before detection settles.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(det.calls(), 1, "concurrent callers must not start a second probe");
  assert.equal(pi.sent.length, 0, "nothing is emitted before detection settles");

  release([MUSE_OK, CLAUDE_OK]);
  await Promise.all([runA, runB]);
  assert.equal(det.calls(), 1);
  const copy = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatMissingKey()}`;
  assert.deepEqual(
    pi.sent.map((m) => m.content),
    [copy, copy],
  );
  assert.equal(a.notes.length, 1);
  assert.equal(b.notes.length, 1);
  assert.equal(jev.calls(), 0);
});

test("cache: sequential calls reuse the session result (one detection total)", async () => {
  const pi = makePi();
  let n = 0;
  const det = counting(() => {
    n += 1;
    // A second probe would return a different answer; the cache must hide it.
    return Promise.resolve(n === 1 ? [MUSE_OK, CLAUDE_OK] : [MUSE_MISSING, CLAUDE_MISSING]);
  });
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, { detect: det.detect, resolveKey: key.fake, requestDecision: jev.fake });
  const handler = routeHandler(pi);
  for (const prompt of ["one", "two", "three"]) {
    const { ctx } = makeCtx(false);
    await run(handler, prompt, ctx);
  }
  assert.equal(det.calls(), 1);
  assert.equal(pi.sent.length, 3);
  const copy = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatMissingKey()}`;
  for (const m of pi.sent) assert.equal(m.content, copy);
  assert.equal(key.calls(), 3, "the key resolves fresh on every call (never cached)");
  assert.equal(jev.calls(), 0);
});

test("cache: usage/help between prompts never probe and never disturb the cache", async () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_MISSING]));
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, { detect: det.detect, resolveKey: key.fake, requestDecision: jev.fake });
  const handler = routeHandler(pi);
  await run(handler, "", makeCtx(false).ctx);
  await run(handler, "--help", makeCtx(false).ctx);
  assert.equal(det.calls(), 0);
  assert.equal(key.calls(), 0, "usage-level input never resolves a key");
  await run(handler, "hello", makeCtx(false).ctx);
  await run(handler, "-h", makeCtx(false).ctx);
  await run(handler, "hello again", makeCtx(false).ctx);
  assert.equal(det.calls(), 1);
  assert.equal(jev.calls(), 0);
});

test("cache: each factory call owns its own cache (no module-level state)", async () => {
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
  const key = nullKey();
  const jev = throwJev();
  const pi1 = makePi();
  const pi2 = makePi();
  createRoute(pi1.api, { detect: det.detect, resolveKey: key.fake, requestDecision: jev.fake });
  createRoute(pi2.api, { detect: det.detect, resolveKey: key.fake, requestDecision: jev.fake });
  await run(routeHandler(pi1), "hello", makeCtx(false).ctx);
  await run(routeHandler(pi2), "hello", makeCtx(false).ctx);
  assert.equal(det.calls(), 2);
  assert.equal(jev.calls(), 0);
});

// ---------------------------------------------------------------------------
// Jev/key handler paths (plan 02-04, task 3)

test("jev: missing key emits list + missing-key guidance, Jev never runs (json shape)", async () => {
  const pi = makePi();
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatMissingKey()}`;
  assert.deepEqual(notes, [{ text: toPlainText(expected), level: "info" }]);
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  assert.equal(key.calls(), 1);
  assert.equal(jev.calls(), 0);
});

for (const id of ["muse", "claude"] as const) {
  for (const effort of ["low", "standard", "high"] as const) {
    for (const confidence of [0.9, 0.63, 0.31] as const) {
      const tier = confidence >= 0.8 ? "auto" : confidence >= 0.5 ? "confirm" : "refuse";
      test(`04-01/T3(b): stubbed Jev choice ${id} at ${effort} effort, confidence ${confidence} renders the ${tier} composition`, async () => {
        const pi = makePi();
        const key = stubKey();
        const jev = okDecision(id, effort, confidence);
        const runner = runFake((opts) => settledRun(opts));
        const logDir = tempLogDir();
        createRoute(pi.api, {
          detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
          resolveKey: key.fake,
          requestDecision: jev.fake,
          logSink: nullSink,
          run: runner.fake,
          logDir,
        });
        const { ctx, notes, confirms } = makeCtx(false);
        await run(routeHandler(pi), "hello", ctx);
        const list = formatProviderList([MUSE_OK, CLAUDE_OK]);
        const other = id === "muse" ? "claude" : "muse";
        const line = formatDecisionLine(id, effort, confidence);
        // Headless ctx: confirm fails closed (no dialog, no spawn), auto
        // runs through the fake, refuse never spawns.
        let expected: string;
        if (tier === "auto") {
          assert.equal(runner.calls(), 1);
          const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
          expected =
            `${list}\n\n${line}\n\n` +
            `Why **${id}** (confidence 0.90).\n\n` +
            `**Run finished on ${id} (exit 0).**\n` +
            "Showing the last 2 of 2 stdout lines:\n" +
            "```text\n" +
            "OUT-1\n" +
            "OUT-2\n" +
            "```\n" +
            `Full log: ${logPath}`;
        } else if (tier === "confirm") {
          assert.equal(runner.calls(), 0);
          expected =
            `${list}\n\n${line}\n\n` +
            `Why **${id}** (confidence 0.63).\n\n` +
            "**Confirmation needed (interactive session required).**\n" +
            `Jev chose **${id}** at ${effort} effort (confidence 0.63), but that is below the auto-run threshold, and this session cannot ask for confirmation.\n` +
            "Re-run /route in an interactive Pi session to confirm and run it.";
        } else {
          assert.equal(runner.calls(), 0);
          expected = `${list}\n\n${formatRefuseBlock(id, [other], confidence)}`;
        }
        assert.equal(pi.sent.length, 1);
        assert.equal(pi.sent[0].content, expected);
        assert.ok(pi.sent[0].content.includes(`**${id}**`));
        assert.equal(confirms.length, 0, "headless/auto paths never open a dialog");
        if (tier === "refuse") {
          assert.ok(pi.sent[0].content.includes("**Too uncertain to route.**"));
          assert.ok(!pi.sent[0].content.includes("Jev routed"), "refuse renders no routing claim");
          for (const n of notes) assert.ok(!n.text.includes("Jev routed"), "no routing claim in any notify");
        } else {
          assert.ok(pi.sent[0].content.includes(`at ${effort} effort (confidence`));
          if (tier === "confirm") {
            assert.ok(pi.sent[0].content.includes("**Confirmation needed (interactive session required).**"));
          }
        }
        // Regression tripwire: the retired Phase 1 notice must never render beside
        // the decision line (literal pasted once, on purpose).
        assert.ok(
          !pi.sent[0].content.includes(
            "Automatic routing isn't available yet — this list is the detection result only.",
          ),
        );
        assert.deepEqual(
          notes.map((n) => n.text),
          tier === "auto"
            ? [
                toPlainText(LOADING_LINE),
                `Running your prompt on ${id} at ${effort} effort…\nCancel: Ctrl+Alt+X`,
                toPlainText(expected),
              ]
            : [toPlainText(LOADING_LINE), toPlainText(expected)],
        );
        assert.equal(key.calls(), 1);
        assert.equal(jev.calls(), 1);
      });
    }
  }
}

test("04-01/T3(c): stubbed null confidence renders the unknown refuse variant with zero digits", async () => {
  const pi = makePi();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", null).fake,
    logSink: nullSink,
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatRefuseBlock("muse", ["claude"], null)}`;
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].content, expected);
  assert.ok(!pi.sent[0].content.includes("Jev routed"));
  const at = pi.sent[0].content.indexOf("confidence");
  assert.ok(at >= 0, "the unknown sentence names confidence");
  assert.ok(!/\d/.test(pi.sent[0].content.slice(at + "confidence".length)), "zero digits after confidence");
  assert.deepEqual(
    notes.map((n) => n.text),
    [toPlainText(LOADING_LINE), toPlainText(expected)],
  );
});

for (const confidence of [0.63, 0.31] as const) {
  const tier = confidence >= 0.5 ? "confirm" : "refuse";
  test(`04-01/T3(d): single-provider route at confidence ${confidence} renders the empty-alternatives ${tier} shape`, async () => {
    const pi = makePi();
    const runner = runFake((opts) => settledRun(opts));
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_MISSING]),
      resolveKey: stubKey().fake,
      requestDecision: okDecision("muse", "standard", confidence).fake,
      logSink: nullSink,
      run: runner.fake,
      logDir: tempLogDir(),
    });
    const { ctx } = makeCtx(false);
    await run(routeHandler(pi), "hello", ctx);
    assert.equal(pi.sent.length, 1);
    const content = pi.sent[0].content;
    assert.ok(!content.includes("Alternatives:"), "no alternatives sentence with one provider");
    if (tier === "confirm") {
      // Headless: the fail-closed block carries no alternatives sentence.
      assert.equal(runner.calls(), 0);
      assert.ok(content.includes("**Confirmation needed (interactive session required).**"));
      assert.equal(
        content,
        `${formatProviderList([MUSE_OK, CLAUDE_MISSING])}\n\n${formatDecisionLine("muse", "standard", confidence)}\n\n` +
          "Why **muse** (confidence 0.63).\n\n" +
          "**Confirmation needed (interactive session required).**\n" +
          "Jev chose **muse** at standard effort (confidence 0.63), but that is below the auto-run threshold, and this session cannot ask for confirmation.\n" +
          "Re-run /route in an interactive Pi session to confirm and run it.",
      );
    } else {
      assert.ok(content.includes("**Too uncertain to route.**"));
      assert.ok(!content.includes("Jev routed"));
      assert.equal(
        content,
        `${formatProviderList([MUSE_OK, CLAUDE_MISSING])}\n\n${formatRefuseBlock("muse", [], confidence)}`,
      );
    }
  });
}

for (const confidence of [0.63, 0.31] as const) {
  test(`04-01/T3(e): hostile probabilities naming unavailable ids never leak into alternatives (${confidence})`, async () => {
    const pi = makePi();
    const jev = decideFake(() =>
      Promise.resolve({
        ok: true,
        decision: {
          harness: "muse",
          confidence,
          probabilities: { cursor: 0.9 },
          difficulty: 1,
          scoreConfidence: 0.9,
          scoreProbabilities: { "1": 1 },
          effort: "standard",
        },
      }),
    );
    const runner = runFake((opts) => settledRun(opts));
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: jev.fake,
      logSink: nullSink,
      run: runner.fake,
      logDir: tempLogDir(),
    });
    // Confirm tier runs confirmed here: alternatives surface in the dialog,
    // so the available-ids proof moves onto the captured dialog message.
    const interactive = confidence === 0.63;
    const { ctx, notes, confirms } = makeCtx(interactive, {
      confirm: () => Promise.resolve(true),
    });
    await run(routeHandler(pi), "hello", ctx);
    // Interactive legs render notify-only (zero sendMessage); the final
    // notify carries the composition in plain text.
    const content = interactive ? notes[notes.length - 1].text : pi.sent[0].content;
    assert.equal(pi.sent.length, interactive ? 0 : 1);
    assert.ok(!content.includes("cursor"), "untrusted probabilities keys render nowhere");
    for (const n of notes) assert.ok(!n.text.includes("cursor"));
    if (interactive) {
      assert.equal(runner.calls(), 1);
      assert.equal(confirms.length, 1);
      assert.ok(!confirms[0].message.includes("cursor"), "untrusted keys reach no dialog either");
      assert.ok(
        confirms[0].message.includes("Alternatives: claude."),
        "dialog alternatives derive from the available ids",
      );
    } else {
      assert.equal(runner.calls(), 0);
      assert.ok(content.includes("Alternatives: claude."), "alternatives derive from the available ids");
    }
    assert.equal(jev.calls(), 1);
  });
}

for (const cls of FAILURE_CLASSES) {
  test(`04-02/T3: stubbed ${cls} renders its block, then the session routes normally on the next /route`, async () => {
    const pi = makePi();
    const key = stubKey();
    const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
    // Mutable decide impl behind one counting fake: failure first, success after.
    let current = failDecision(cls);
    const succeeding = okDecision("muse", "standard", 0.9);
    let jevCalls = 0;
    const runner = runFake((opts) => settledRun(opts));
    const logDir = tempLogDir();
    createRoute(pi.api, {
      detect: det.detect,
      resolveKey: key.fake,
      requestDecision: (prompt, available, k) => {
        jevCalls += 1;
        return current.fake(prompt, available, k);
      },
      logSink: nullSink,
      run: runner.fake,
      logDir,
    });
    const handler = routeHandler(pi);
    // FIRST: the failure renders exactly as before (the await is the no-throw proof).
    const first = makeCtx(false);
    await run(handler, "hello", first.ctx);
    const failed = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatJevError(cls)}`;
    assert.deepEqual(pi.sent, [{ customType: "logofat", content: failed, display: true }]);
    assert.deepEqual(
      first.notes.map((n) => n.text),
      [toPlainText(LOADING_LINE), toPlainText(failed)],
    );
    assert.equal(jevCalls, 1);
    // THEN: swap to success — the same session routes normally afterwards.
    current = succeeding;
    const second = makeCtx(false);
    await run(handler, "hello again", second.ctx);
    assert.equal(runner.calls(), 1, "the failure leg never spawned; the success leg runs once");
    const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
    const routed =
      `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatDecisionLine("muse", "standard", 0.9)}\n\n` +
      "Why **muse** (confidence 0.90).\n\n" +
      "**Run finished on muse (exit 0).**\n" +
      "Showing the last 2 of 2 stdout lines:\n" +
      "```text\n" +
      "OUT-1\n" +
      "OUT-2\n" +
      "```\n" +
      `Full log: ${logPath}`;
    assert.equal(pi.sent.length, 2);
    assert.equal(pi.sent[1].content, routed);
    assert.deepEqual(
      second.notes.map((n) => n.text),
      [
        toPlainText(LOADING_LINE),
        "Running your prompt on muse at standard effort…\nCancel: Ctrl+Alt+X",
        toPlainText(routed),
      ],
    );
    assert.equal(jevCalls, 2);
    assert.equal(key.calls(), 2, "the key resolves fresh on every call, failure or not");
    assert.equal(det.calls(), 1, "the session cache is unpoisoned by the failure");
  });
}

test("jev: hasUI true success emits loading pre-emit + final notify, zero sendMessage", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  const logDir = tempLogDir();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse").fake,
    logSink: nullSink,
    run: runner.fake,
    logDir,
  });
  const { ctx, notes, confirms } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 1);
  assert.equal(confirms.length, 0, "auto never opens a dialog");
  const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatDecisionLine("muse", "standard", 0.9)}\n\n` +
    "Why **muse** (confidence 0.90).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    `Full log: ${logPath}`;
  assert.deepEqual(
    notes,
    [
      { text: toPlainText(LOADING_LINE), level: "info" },
      { text: "Running your prompt on muse at standard effort…\nCancel: Ctrl+Alt+X", level: "info" },
      { text: toPlainText(expected), level: "info" },
    ],
  );
  assert.equal(pi.sent.length, 0);
});

test("04-01/T3(h): hasUI true confirm emits loading pre-emit + final notify, zero sendMessage", async () => {
  const pi = makePi();
  const runner = throwRun();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.63).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, confirms } = makeCtx(true, {
    confirm: () => Promise.resolve(false),
  });
  await run(routeHandler(pi), "hello", ctx);
  // Declined: the dialog was the ask — no spawn, no run tuple, no notice.
  assert.equal(runner.calls(), 0);
  assert.equal(confirms.length, 1);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatDecisionLine("muse", "standard", 0.63)}\n\n` +
    "Why **muse** (confidence 0.63).\n\n" +
    "**Run declined.**\n" +
    "/route did not run your prompt on **muse**.\n" +
    "Re-run /route for a fresh judgment.";
  assert.deepEqual(
    notes,
    [
      { text: toPlainText(LOADING_LINE), level: "info" },
      { text: toPlainText(expected), level: "info" },
    ],
  );
  assert.equal(pi.sent.length, 0);
});

test("04-01/T3(h): hasUI true refuse-figure emits loading pre-emit + final notify, zero sendMessage", async () => {
  const pi = makePi();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.31).fake,
    logSink: nullSink,
  });
  const { ctx, notes } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatRefuseBlock("muse", ["claude"], 0.31)}`;
  assert.deepEqual(
    notes,
    [
      { text: toPlainText(LOADING_LINE), level: "info" },
      { text: toPlainText(expected), level: "info" },
    ],
  );
  assert.equal(pi.sent.length, 0);
});

test("04-01/T3(h): hasUI true refuse-unknown emits loading pre-emit + final notify, zero sendMessage", async () => {
  const pi = makePi();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", null).fake,
    logSink: nullSink,
  });
  const { ctx, notes } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatRefuseBlock("muse", ["claude"], null)}`;
  assert.deepEqual(
    notes,
    [
      { text: toPlainText(LOADING_LINE), level: "info" },
      { text: toPlainText(expected), level: "info" },
    ],
  );
  assert.equal(pi.sent.length, 0);
});

test("jev: zero-harness path never resolves a key or calls Jev", async () => {
  const pi = makePi();
  const key = throwKey();
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_MISSING, CLAUDE_MISSING]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const expected = formatDetectionResult([MUSE_MISSING, CLAUDE_MISSING]);
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  assert.equal(notes.length, 1);
  assert.equal(key.calls(), 0);
  assert.equal(jev.calls(), 0);
});

for (const args of ["", "--help", "-h"]) {
  test(`jev: usage-level input ${JSON.stringify(args)} never resolves a key or calls Jev`, async () => {
    const pi = makePi();
    const key = throwKey();
    const jev = throwJev();
    createRoute(pi.api, { detect: throwIfCalled, resolveKey: key.fake, requestDecision: jev.fake });
    const { ctx, notes } = makeCtx(false);
    await run(routeHandler(pi), args, ctx);
    assert.equal(pi.sent.length, 1);
    assert.equal(notes.length, 1);
    assert.equal(key.calls(), 0);
    assert.equal(jev.calls(), 0);
  });
}

test("jev: hostile requestDecision rejection maps to the network block, handler resolves", async () => {
  const pi = makePi();
  const key = stubKey();
  const hostile = decideFake(() => Promise.reject(new Error("hostile fake boom")));
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: key.fake,
    requestDecision: hostile.fake,
    logSink: nullSink,
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatJevError("network")}`;
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  assert.ok(!pi.sent[0].content.includes("hostile fake boom"), "the raw error never reaches the transcript");
  assert.equal(notes.length, 2, "pre-emit fired before the hostile rejection");
  assert.equal(hostile.calls(), 1);
});

test(
  "04-02/T2(e): the /route handler over a hanging Jev completes rendering the timeout block",
  { timeout: 5000 },
  async () => {
    const pi = makePi();
    const hanging = ((url: unknown, init: { signal?: AbortSignal | null }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: (prompt, available, key) =>
        requestDecision(prompt, available, key, {
          fetchImpl: hanging,
          timeoutMs: 50,
          maxAttempts: 3,
          backoffBaseMs: 10,
        }),
      logSink: nullSink,
    });
    const { ctx, notes } = makeCtx(false);
    await run(routeHandler(pi), "hello", ctx);
    const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatJevError("timeout")}`;
    assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
    assert.deepEqual(
      notes.map((n) => n.text),
      [toPlainText(LOADING_LINE), toPlainText(expected)],
    );
  },
);

test("jev: key resolution runs fresh on every Jev call (two calls, count is 2)", async () => {
  const pi = makePi();
  const key = nullKey();
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
  });
  const handler = routeHandler(pi);
  await run(handler, "one", makeCtx(false).ctx);
  await run(handler, "two", makeCtx(false).ctx);
  assert.equal(key.calls(), 2, "no caching: one resolution per Jev-path invocation");
  assert.equal(pi.sent.length, 2);
});

// Fixed canary shared with test/jev.test.ts T4: looks key-like but is NOT a
// real key — never provision this value anywhere.
const HANDLER_CANARY = "TSK-CANARY-7f3e2a9c1d4e";

test("04-02/T4(c): the prompt renders nowhere on any failure path (prompt canary)", async () => {
  const CANARY = "TSK-PROMPT-CANARY-4a1f";
  assert.equal(FAILURE_CLASSES.length, 8);
  for (const cls of FAILURE_CLASSES) {
    const pi = makePi();
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: failDecision(cls).fake,
      logSink: nullSink,
    });
    const { ctx, notes } = makeCtx(false);
    await run(routeHandler(pi), `fix the ${CANARY} bug`, ctx);
    for (const n of notes) assert.ok(!n.text.includes(CANARY), `${cls} notify echoes the prompt`);
    assert.equal(pi.sent.length, 1);
    assert.ok(!pi.sent[0].content.includes(CANARY), `${cls} sent echoes the prompt`);
  }
});

test("04-01/T3(g): handler surfaces never contain the resolved key (4 tier variants + 8 failure paths)", async () => {
  const paths: Array<{ label: string; decide: DecideFake }> = [
    { label: "success-auto", decide: okDecision("muse", "standard", 0.9) },
    { label: "success-confirm", decide: okDecision("muse", "standard", 0.63) },
    { label: "success-refuse-figure", decide: okDecision("muse", "standard", 0.31) },
    { label: "success-refuse-unknown", decide: okDecision("muse", "standard", null) },
    ...FAILURE_CLASSES.map((cls) => ({ label: cls, decide: failDecision(cls) })),
  ];
  assert.equal(paths.length, 12);
  for (const { label, decide } of paths) {
    const pi = makePi();
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey(HANDLER_CANARY).fake,
      requestDecision: decide.fake,
      logSink: nullSink,
    });
    const { ctx, notes } = makeCtx(false);
    await run(routeHandler(pi), "hello", ctx);
    for (const n of notes) assert.ok(!n.text.includes(HANDLER_CANARY), `${label} notify leaks the key`);
    assert.equal(pi.sent.length, 1);
    assert.ok(!pi.sent[0].content.includes(HANDLER_CANARY), `${label} sent leaks the key`);
  }
});

// ---------------------------------------------------------------------------
// Plan 04-03/T2: handler latency + tuple emission. Exactly one tuple per
// settled decide(); never on early returns or the key-throw path.

test("04-03/T2(a): success emits the Jev tuple first, then exactly one run tuple", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const runner = runFake((opts) => settledRun(opts));
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 1);
  assert.equal(lines.length, 2);
  const tuple = JSON.parse(lines[0]) as Record<string, unknown>;
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
  assert.equal(tuple["ok"], true);
  assert.equal(tuple["harness"], "muse");
  assert.equal(tuple["effort"], "standard");
  assert.equal(tuple["difficulty"], 1);
  assert.equal(tuple["confidence"], 0.9);
  assert.deepEqual(tuple["probabilities"], { muse: 1 });
  assert.equal(tuple["scoreConfidence"], 0.9);
  assert.equal(tuple["verdict"], "auto");
  assert.equal(typeof tuple["latencyMs"], "number");
  assert.ok((tuple["latencyMs"] as number) >= 0);
  // The run tuple follows the Jev tuple (interleave correlation).
  const runLine = JSON.parse(lines[1]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(runLine), [
    "type",
    "harness",
    "effort",
    "outcome",
    "exitCode",
    "timedOut",
    "runLatencyMs",
  ]);
  assert.equal(runLine["type"], "run");
  assert.equal(runLine["harness"], "muse");
  assert.equal(runLine["effort"], "standard");
  assert.equal(runLine["outcome"], "ok");
  assert.equal(runLine["exitCode"], 0);
  assert.equal(runLine["timedOut"], false);
  assert.equal(typeof runLine["runLatencyMs"], "number");
  assert.ok((runLine["runLatencyMs"] as number) >= 0);
});

test("04-03/T2(a): handler→sink canary leg — canary-keyed probabilities never reach the tuple", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const hostile = decideFake(() =>
    Promise.resolve({
      ok: true,
      decision: {
        harness: "muse",
        confidence: 0.9,
        probabilities: { "TSK-PROMPT-CANARY-4a1f": 1 },
        difficulty: 1,
        scoreConfidence: 0.9,
        scoreProbabilities: { "1": 1 },
        effort: "standard",
      },
    }),
  );
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: hostile.fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runFake((opts) => settledRun(opts)).fake,
    logDir: tempLogDir(),
  });
  await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(!line.includes("TSK-PROMPT-CANARY-4a1f"));
});

for (const [label, confidence, verdict] of [
  ["confirm", 0.63, "confirm"],
  ["refuse-figure", 0.31, "refuse"],
  ["refuse-unknown", null, "refuse"],
] as const) {
  test(`04-03/T2(b): ${label} fake yields a tuple recording verdict ${verdict}`, async () => {
    const pi = makePi();
    const lines: string[] = [];
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: okDecision("muse", "standard", confidence).fake,
      logSink: (line) => {
        lines.push(line);
      },
    });
    await run(routeHandler(pi), "hello", makeCtx(false).ctx);
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]) as { verdict: unknown }).verdict, verdict);
  });
}

for (const cls of FAILURE_CLASSES) {
  test(`04-03/T2(c): stubbed ${cls} emits the failure tuple with its class`, async () => {
    const pi = makePi();
    const lines: string[] = [];
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: failDecision(cls).fake,
      logSink: (line) => {
        lines.push(line);
      },
    });
    await run(routeHandler(pi), "hello", makeCtx(false).ctx);
    assert.equal(lines.length, 1);
    const tuple = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(tuple), ["ok", "class", "latencyMs"]);
    assert.equal(tuple["ok"], false);
    assert.equal(tuple["class"], cls);
    assert.equal(typeof tuple["latencyMs"], "number");
    assert.ok((tuple["latencyMs"] as number) >= 0);
  });
}

test("04-03/T2(c): a rejecting decide emits exactly one catch-mapped network tuple", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const hostile = decideFake(() => Promise.reject(new Error("hostile fake boom")));
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: hostile.fake,
    logSink: (line) => {
      lines.push(line);
    },
  });
  await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  assert.equal(lines.length, 1);
  const tuple = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(tuple["ok"], false);
  assert.equal(tuple["class"], "network");
});

test("04-03/T2(d): early returns emit nothing to the sink (usage, help, zero-harness, missing-key)", async () => {
  // Usage.
  {
    const lines: string[] = [];
    const pi = makePi();
    createRoute(pi.api, {
      detect: throwIfCalled,
      logSink: (line) => {
        lines.push(line);
      },
    });
    await run(routeHandler(pi), "", makeCtx(false).ctx);
    assert.equal(lines.length, 0);
  }
  // Help.
  {
    const lines: string[] = [];
    const pi = makePi();
    createRoute(pi.api, {
      detect: throwIfCalled,
      logSink: (line) => {
        lines.push(line);
      },
    });
    await run(routeHandler(pi), "--help", makeCtx(false).ctx);
    assert.equal(lines.length, 0);
  }
  // Zero harnesses.
  {
    const lines: string[] = [];
    const pi = makePi();
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_MISSING, CLAUDE_MISSING]),
      resolveKey: throwKey().fake,
      requestDecision: throwJev().fake,
      logSink: (line) => {
        lines.push(line);
      },
    });
    await run(routeHandler(pi), "hello", makeCtx(false).ctx);
    assert.equal(lines.length, 0);
  }
  // Missing key.
  {
    const lines: string[] = [];
    const pi = makePi();
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: nullKey().fake,
      requestDecision: throwJev().fake,
      logSink: (line) => {
        lines.push(line);
      },
    });
    await run(routeHandler(pi), "hello", makeCtx(false).ctx);
    assert.equal(lines.length, 0);
  }
});

test("04-03/T2(e): a throwing logSink still renders the full auto-tier composition", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  const logDir = tempLogDir();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: () => {
      throw new Error("sink boom");
    },
    run: runner.fake,
    logDir,
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 1);
  const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatDecisionLine("muse", "standard", 0.9)}\n\n` +
    "Why **muse** (confidence 0.90).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    `Full log: ${logPath}`;
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  assert.deepEqual(
    notes.map((n) => n.text),
    [
      toPlainText(LOADING_LINE),
      "Running your prompt on muse at standard effort…\nCancel: Ctrl+Alt+X",
      toPlainText(expected),
    ],
  );
});

test("04-03/T2(f): the default sink writes both tuples via console.error", async () => {
  const pi = makePi();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    run: runFake((opts) => settledRun(opts)).fake,
    logDir: tempLogDir(),
  });
  const seen: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    seen.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  } finally {
    console.error = real;
  }
  assert.equal(seen.length, 2);
  const tuple = JSON.parse(seen[0]) as Record<string, unknown>;
  assert.equal(tuple["ok"], true);
  assert.equal(tuple["verdict"], "auto");
  const runLine = JSON.parse(seen[1]) as Record<string, unknown>;
  assert.equal(runLine["type"], "run");
  assert.equal(runLine["outcome"], "ok");
});

test("04-03/T3(a): tuple lines never carry prompt, key, path, or auth material (success + 8 failures)", async () => {
  const PROMPT_CANARY = "TSK-PROMPT-CANARY-4a1f";
  const PATH_CANARY = "/bin/TSK-PATH-CANARY";
  // Pathy providers: the LIST legitimately names these binaries (D-06) —
  // the sweep below covers the tuple lines only, never the list.
  const pathy: Provider[] = [
    { id: "muse", binary: `${PATH_CANARY}/muse`, version: "Muse Code 1.3.0", available: true },
    { id: "claude", binary: `${PATH_CANARY}/claude`, version: null, available: true },
  ];
  const legs: Array<{ label: string; decide: DecideFake }> = [
    { label: "success", decide: okDecision("muse", "standard", 0.9) },
    ...FAILURE_CLASSES.map((cls) => ({ label: cls, decide: failDecision(cls) })),
  ];
  assert.equal(legs.length, 9);
  for (const { label, decide } of legs) {
    const pi = makePi();
    const lines: string[] = [];
    createRoute(pi.api, {
      detect: () => Promise.resolve(pathy),
      resolveKey: stubKey(HANDLER_CANARY).fake,
      requestDecision: decide.fake,
      logSink: (line) => {
        lines.push(line);
      },
      run: runFake((opts) => settledRun(opts)).fake,
      logDir: tempLogDir(),
    });
    await run(routeHandler(pi), `fix the ${PROMPT_CANARY} bug`, makeCtx(false).ctx);
    // The success leg sinks the Jev tuple plus the run tuple; failure
    // legs sink the failure tuple only. Every line is swept.
    assert.equal(lines.length, label === "success" ? 2 : 1, `${label}: tuple count`);
    for (const line of lines) {
      assert.ok(!line.includes(PROMPT_CANARY), `${label} tuple echoes the prompt`);
      assert.ok(!line.includes(HANDLER_CANARY), `${label} tuple leaks the key`);
      assert.ok(!line.includes(PATH_CANARY), `${label} tuple leaks a binary path`);
      assert.ok(!line.includes("Authorization"), `${label} tuple mentions Authorization`);
      assert.ok(!line.includes("Bearer"), `${label} tuple mentions Bearer`);
    }
  }
});

test("04-03/T2(i): a throwing resolveKey renders network with zero sink calls (no decide, no tuple)", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const key = keyFake(() => Promise.reject(new Error("key boom")));
  const jev = throwJev();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: key.fake,
    requestDecision: jev.fake,
    logSink: (line) => {
      lines.push(line);
    },
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatJevError("network")}`;
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  // No pre-emit: the throw precedes it.
  assert.deepEqual(
    notes.map((n) => n.text),
    [toPlainText(expected)],
  );
  assert.equal(lines.length, 0);
  assert.equal(key.calls(), 1);
  assert.equal(jev.calls(), 0);
});

// ---------------------------------------------------------------------------
// Import purity: dynamic proof in a child process with a fixture PATH

const FIXTURE_ROOT = mkdtempSync(path.join(os.tmpdir(), "logofat-index-"));
after(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const INDEX_URL = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href;

// Runs inside the child. Each phase waits long enough for any stray async
// side effect (timers, spawned probes) to land before the marker is checked.
const CHILD_SCRIPT = `
import { existsSync } from "node:fs";
const marker = process.env.LOGOFAT_MARKER;
const settle = () => new Promise((r) => setTimeout(r, 400));
const out = {};
const mod = await import(process.env.LOGOFAT_INDEX_URL);
await settle();
out.afterImport = existsSync(marker);
const regs = [];
const sent = [];
const subs = [];
const pi = {
  registerShortcut: () => {},
  registerCommand: (name, opts) => regs.push({ name, opts }),
  on: (event, handler) => subs.push([event, typeof handler]),
  sendMessage: (m) => sent.push(m),
};
mod.default(pi);
await settle();
out.afterFactory = existsSync(marker);
out.registrations = regs.map((r) => r.name);
out.subscriptions = subs;
const notes = [];
const ctx = { mode: "json", hasUI: false, ui: { notify: (t) => notes.push(t) } };
await regs.find((r) => r.name === "route").opts.handler("hello", ctx);
out.afterHandler = existsSync(marker);
out.sent = sent.map((m) => m.content);
out.notes = notes;
process.stdout.write(JSON.stringify(out));
`;

test("import purity: import and factory spawn nothing; the handler does (positive control)", () => {
  const binDir = path.join(FIXTURE_ROOT, "bin");
  const marker = path.join(FIXTURE_ROOT, "probed.marker");
  // Fake harnesses use shell builtins only, so the fixture PATH needs no
  // system directories. Each records that it was run, then prints a version.
  mkdirSync(binDir);
  for (const name of ["muse", "claude"]) {
    const file = path.join(binDir, name);
    writeFileSync(file, `#!/bin/sh\necho ${name} >> "$LOGOFAT_MARKER"\necho "${name} 9.9.9"\n`);
    chmodSync(file, 0o755);
  }
  assert.ok(!existsSync(marker));

  // Hermetic key boundary (02-04/T5): the Phase 2 handler path reaches key
  // resolution, so the child must not see ambient credentials — delete
  // TYPESAFE_API_KEY and point PI_CODING_AGENT_DIR at a fresh empty temp dir
  // (no settings.json), keeping the fixture PATH. No network is possible (no
  // key resolvable by construction); this doubles as the hermetic missing-key
  // regression test.
  const agentDir = mkdtempSync(path.join(FIXTURE_ROOT, "agent-"));
  const childEnv = { ...process.env };
  delete childEnv.TYPESAFE_API_KEY;
  childEnv["PI_CODING_AGENT_DIR"] = agentDir;
  childEnv["PATH"] = binDir;
  childEnv["LOGOFAT_MARKER"] = marker;
  childEnv["LOGOFAT_INDEX_URL"] = INDEX_URL;

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  const out = JSON.parse(child.stdout) as {
    afterImport: boolean;
    afterFactory: boolean;
    afterHandler: boolean;
    registrations: string[];
    subscriptions: [string, string][];
    sent: string[];
    notes: string[];
  };

  assert.equal(out.afterImport, false, "importing src/index.ts must not probe any harness");
  assert.equal(out.afterFactory, false, "calling the factory must not probe any harness");
  assert.deepEqual(out.registrations, ["route", "route-providers"]);
  // One subscription only: the session_shutdown drain. No session_start
  // probe, no spawn, no fetch, no timers at factory time.
  assert.deepEqual(out.subscriptions, [["session_shutdown", "function"]]);
  // Positive control: a broken fixture (bad shebang, missing chmod, wrong
  // PATH) would leave no marker here and fail instead of passing vacuously.
  assert.equal(out.afterHandler, true, "the handler must probe the fixture harnesses");
  assert.equal(out.sent.length, 1);
  assert.ok(out.sent[0].startsWith("**Detected providers (2/2):**\n"), out.sent[0]);
  assert.ok(out.sent[0].includes(`- muse: available (${path.join(binDir, "muse")}, muse 9.9.9)`), out.sent[0]);
  // Missing-key path with the pinned env: the guidance block (parent-computed
  // from src/messages.ts), exactly 1 sent + 1 notify (no pre-emit here).
  assert.ok(out.sent[0].includes(formatMissingKey()), out.sent[0]);
  assert.equal(out.notes.length, 1);
});

// ---------------------------------------------------------------------------
// Plan 05-03/T3: run-path composition — the outcome matrix through the `run`
// fake (with the real writeRunLog on an injected temp logDir), the confirm
// handshake, the shutdown drain, and the never-throw proofs.
// ---------------------------------------------------------------------------

const LIST_2_OF_2 =
  "**Detected providers (2/2):**\n" +
  "- muse: available (/fx/muse, Muse Code 1.3.0)\n" +
  "- claude: available (/fx/claude, 2.1.281 (Claude Code))";

type OutcomeLeg = {
  name: string;
  harness: ProviderId;
  effort: EffortLevel;
  binary: string;
  argv: string[];
  settled: Partial<RunSettled>;
  report: (logPath: string) => string;
  /** Expected log-file bytes, or null when the outcome writes no file. */
  logFile: ((runId: string) => string) | null;
};

const OUTCOME_LEGS: readonly OutcomeLeg[] = [
  {
    name: "ok",
    harness: "muse",
    effort: "low",
    binary: "/fx/muse",
    argv: ["exec", "--reasoning-effort", "low", "--", "hello"],
    settled: { outcome: "ok", exitCode: 0, signal: null, stdout: "OUT-1\nOUT-2\n", stderr: "" },
    report: (logPath) =>
      "**Run finished on muse (exit 0).**\n" +
      "Showing the last 2 of 2 stdout lines:\n" +
      "```text\n" +
      "OUT-1\n" +
      "OUT-2\n" +
      "```\n" +
      `Full log: ${logPath}`,
    logFile: (runId) =>
      "# logofat run log\n" +
      `run-id: ${runId}\n` +
      "harness: muse\n" +
      "effort: low\n" +
      "outcome: ok\n" +
      "exit-code: 0\n" +
      "timed-out: false\n" +
      "started-at: 2026-09-25T00:00:00.000Z\n" +
      "settled-at: 2026-09-25T00:00:01.000Z\n" +
      "--- stdout ---\n" +
      "OUT-1\n" +
      "OUT-2\n" +
      "--- stderr ---\n",
  },
  {
    name: "nonzero+code",
    harness: "claude",
    effort: "standard",
    binary: "/fx/claude",
    argv: ["-p", "--effort", "medium", "--", "hello"],
    settled: { outcome: "nonzero", exitCode: 3, signal: null, stdout: "OUT-1\n", stderr: "ERR-1\n" },
    report: (logPath) =>
      "**Run on claude exited with code 3.**\n" +
      "Showing the last 1 of 1 stdout lines:\n" +
      "```text\n" +
      "OUT-1\n" +
      "```\n" +
      "Last 1 of 1 stderr lines:\n" +
      "```text\n" +
      "ERR-1\n" +
      "```\n" +
      `Full log: ${logPath}\n` +
      "Check the full log for details, then re-run /route for another attempt.",
    logFile: (runId) =>
      "# logofat run log\n" +
      `run-id: ${runId}\n` +
      "harness: claude\n" +
      "effort: standard\n" +
      "outcome: nonzero\n" +
      "exit-code: 3\n" +
      "timed-out: false\n" +
      "started-at: 2026-09-25T00:00:00.000Z\n" +
      "settled-at: 2026-09-25T00:00:01.000Z\n" +
      "--- stdout ---\n" +
      "OUT-1\n" +
      "--- stderr ---\n" +
      "ERR-1\n",
  },
  {
    name: "nonzero+signal",
    harness: "muse",
    effort: "high",
    binary: "/fx/muse",
    argv: ["exec", "--reasoning-effort", "high", "--", "hello"],
    settled: {
      outcome: "nonzero",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "ERR-9\n",
    },
    report: (logPath) =>
      "**Run on muse was killed (SIGTERM).**\n" +
      "Showing the last 0 of 0 stdout lines:\n" +
      "(no stdout output)\n" +
      "Last 1 of 1 stderr lines:\n" +
      "```text\n" +
      "ERR-9\n" +
      "```\n" +
      `Full log: ${logPath}\n` +
      "Check the full log for details, then re-run /route for another attempt.",
    logFile: (runId) =>
      "# logofat run log\n" +
      `run-id: ${runId}\n` +
      "harness: muse\n" +
      "effort: high\n" +
      "outcome: nonzero\n" +
      "signal: SIGTERM\n" +
      "timed-out: false\n" +
      "started-at: 2026-09-25T00:00:00.000Z\n" +
      "settled-at: 2026-09-25T00:00:01.000Z\n" +
      "--- stdout ---\n" +
      "--- stderr ---\n" +
      "ERR-9\n",
  },
  {
    name: "timeout",
    harness: "claude",
    effort: "low",
    binary: "/fx/claude",
    argv: ["-p", "--effort", "low", "--", "hello"],
    settled: {
      outcome: "timeout",
      exitCode: null,
      signal: "SIGKILL",
      timedOut: true,
      stdout: "PARTIAL\n",
      stderr: "ERR-T\n",
    },
    report: (logPath) =>
      "**Run on claude timed out after 10 minutes.**\n" +
      "The run was stopped after the 10-minute limit; partial output is below.\n" +
      "Showing the last 1 of 1 stdout lines:\n" +
      "```text\n" +
      "PARTIAL\n" +
      "```\n" +
      "Last 1 of 1 stderr lines:\n" +
      "```text\n" +
      "ERR-T\n" +
      "```\n" +
      `Full log: ${logPath}\n` +
      "Re-run /route to try again with a fresh run.",
    logFile: (runId) =>
      "# logofat run log\n" +
      `run-id: ${runId}\n` +
      "harness: claude\n" +
      "effort: low\n" +
      "outcome: timeout\n" +
      "signal: SIGKILL\n" +
      "timed-out: true\n" +
      "started-at: 2026-09-25T00:00:00.000Z\n" +
      "settled-at: 2026-09-25T00:00:01.000Z\n" +
      "--- stdout ---\n" +
      "PARTIAL\n" +
      "--- stderr ---\n" +
      "ERR-T\n",
  },
  {
    name: "aborted",
    harness: "muse",
    effort: "standard",
    binary: "/fx/muse",
    argv: ["exec", "--reasoning-effort", "medium", "--", "hello"],
    settled: {
      outcome: "aborted",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "PARTIAL\n",
      stderr: "ERR-IGNORED\n",
    },
    report: (logPath) =>
      "**Run on muse was cancelled.**\n" +
      "The run was stopped before it finished; partial output is below.\n" +
      "Showing the last 1 of 1 stdout lines:\n" +
      "```text\n" +
      "PARTIAL\n" +
      "```\n" +
      `Full log: ${logPath}\n` +
      "Re-run /route when you are ready.",
    logFile: (runId) =>
      "# logofat run log\n" +
      `run-id: ${runId}\n` +
      "harness: muse\n" +
      "effort: standard\n" +
      "outcome: aborted\n" +
      "signal: SIGTERM\n" +
      "timed-out: false\n" +
      "started-at: 2026-09-25T00:00:00.000Z\n" +
      "settled-at: 2026-09-25T00:00:01.000Z\n" +
      "--- stdout ---\n" +
      "PARTIAL\n" +
      "--- stderr ---\n" +
      "ERR-IGNORED\n",
  },
  {
    name: "spawn-error",
    harness: "claude",
    effort: "high",
    binary: "/fx/claude",
    argv: ["-p", "--effort", "high", "--", "hello"],
    settled: { outcome: "spawn-error", exitCode: null, signal: null, stdout: "", stderr: "" },
    report: () =>
      "**Could not start claude.**\n" +
      "The claude binary could not be started (it may have been moved or removed since detection).\n" +
      "Run /route-providers and re-run /route to re-detect harnesses.",
    logFile: null,
  },
];

for (const leg of OUTCOME_LEGS) {
  test(`05-03/T3(b): auto ${leg.name} — exact composition, exact argv, log bytes, pointer line`, async () => {
    const pi = makePi();
    const runner = runFake((opts) => settledRun(opts, leg.settled));
    const logDir = tempLogDir();
    const lines: string[] = [];
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: okDecision(leg.harness, leg.effort, 0.9).fake,
      logSink: (line) => {
        lines.push(line);
      },
      run: runner.fake,
      logDir,
    });
    const controller = new AbortController();
    const { ctx, notes, confirms } = makeCtx(false, { signal: controller.signal });
    await run(routeHandler(pi), "hello", ctx);
    // EXEC-01: the exact argv reached the spawn call.
    assert.equal(runner.calls(), 1);
    const captured = runner.captured()[0];
    assert.equal(captured.binary, leg.binary);
    assert.deepEqual(captured.argv, leg.argv);
    assert.equal(captured.harness, leg.harness);
    assert.equal(captured.effort, leg.effort);
    assert.ok(captured.runId.startsWith("run-"));
    assert.ok(captured.signal instanceof AbortSignal);
    controller.abort();
    assert.equal(captured.signal.aborted, true, "host abort reaches the composed signal");
    assert.equal(captured.onProgress, undefined);
    assert.equal(confirms.length, 0);
    // EXEC-04: the exact composition, hardcoded end to end.
    const logPath = path.join(logDir, `logofat-${captured.runId}.log`);
    const decision = `Jev routed this prompt to **${leg.harness}** at ${leg.effort} effort (confidence 0.90).`;
    const explain = `Why **${leg.harness}** (confidence 0.90).`;
    const expected = `${LIST_2_OF_2}\n\n${decision}\n\n${explain}\n\n${leg.report(logPath)}`;
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].content, expected);
    assert.deepEqual(
      notes.map((n) => n.text),
      [
        toPlainText(LOADING_LINE),
        `Running your prompt on ${leg.harness} at ${leg.effort} effort…\nCancel: Ctrl+Alt+X`,
        toPlainText(expected),
      ],
    );
    // The file on disk holds the full stdout + stderr sections.
    if (leg.logFile === null) {
      assert.deepEqual(readdirSync(logDir), [], "spawn-error writes no log file");
    } else {
      assert.deepEqual(readdirSync(logDir), [`logofat-${captured.runId}.log`]);
      assert.equal(readFileSync(logPath, "utf8"), leg.logFile(captured.runId));
      assert.ok(pi.sent[0].content.includes(`Full log: ${logPath}`), "the pointer line names the file");
    }
    if (leg.name === "aborted") {
      assert.ok(!pi.sent[0].content.includes("ERR-IGNORED"), "a cancellation shows no stderr section");
      assert.ok(
        readFileSync(logPath, "utf8").includes("ERR-IGNORED"),
        "but the disk log keeps the full stderr",
      );
    }
    // One Jev tuple plus one run tuple, in order.
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[1]) as { outcome: unknown }).outcome, leg.settled.outcome);
  });
}

test("05-03/T3(c): headless confirm fails closed — headless block, no spawn, no run tuple", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const runner = throwRun();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.63).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, confirms } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 0);
  assert.equal(confirms.length, 0, "headless never opens a dialog");
  const expected =
    `${LIST_2_OF_2}\n\n` +
    "Jev routed this prompt to **muse** at standard effort (confidence 0.63).\n\n" +
    "Why **muse** (confidence 0.63).\n\n" +
    "**Confirmation needed (interactive session required).**\n" +
    "Jev chose **muse** at standard effort (confidence 0.63), but that is below the auto-run threshold, and this session cannot ask for confirmation.\n" +
    "Re-run /route in an interactive Pi session to confirm and run it.";
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].content, expected);
  assert.deepEqual(
    notes.map((n) => n.text),
    [toPlainText(LOADING_LINE), toPlainText(expected)],
  );
  assert.equal(lines.length, 1, "the Jev tuple only — no run tuple without a run");
});

test("05-03/T3(c): confirmed dialog runs once, reports, and passes the dialog timeout", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const runner = runFake((opts) => settledRun(opts));
  const logDir = tempLogDir();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.63).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir,
  });
  const { ctx, notes, confirms } = makeCtx(true, {
    confirm: () => Promise.resolve(true),
  });
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 1);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].timeout, CONFIRM_DIALOG_TIMEOUT_MS, "the bound is passed, not just defined");
  assert.equal(confirms[0].title, "Run on muse?");
  assert.equal(
    confirms[0].message,
    "Jev chose muse at standard effort (confidence 0.63), but that is below the auto-run threshold. Alternatives: claude.\n\nRun it on muse?",
  );
  // Confirmed: list + decision + run report — the dialog was the ask, so
  // no notice in the transcript. Interactive → notify-only.
  const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
  const expected =
    `${LIST_2_OF_2}\n\n` +
    "Jev routed this prompt to **muse** at standard effort (confidence 0.63).\n\n" +
    "Why **muse** (confidence 0.63).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    `Full log: ${logPath}`;
  assert.equal(pi.sent.length, 0);
  assert.deepEqual(
    notes.map((n) => n.text),
    [
      toPlainText(LOADING_LINE),
      "Running your prompt on muse at standard effort…\nCancel: Ctrl+Alt+X",
      toPlainText(expected),
    ],
  );
  assert.equal(lines.length, 2);
});

test("05-03/T3(c): declined dialog renders the declined block — no spawn, no run tuple", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const runner = throwRun();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.63).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, confirms } = makeCtx(true, {
    confirm: () => Promise.resolve(false),
  });
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 0);
  assert.equal(confirms.length, 1);
  const expected =
    `${LIST_2_OF_2}\n\n` +
    "Jev routed this prompt to **muse** at standard effort (confidence 0.63).\n\n" +
    "Why **muse** (confidence 0.63).\n\n" +
    "**Run declined.**\n" +
    "/route did not run your prompt on **muse**.\n" +
    "Re-run /route for a fresh judgment.";
  assert.equal(pi.sent.length, 0);
  assert.deepEqual(
    notes.map((n) => n.text),
    [toPlainText(LOADING_LINE), toPlainText(expected)],
  );
  assert.equal(lines.length, 1, "the Jev tuple only — no run tuple without a run");
});

test("05-03/T3(c): throwing dialog fails closed like a decline", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const runner = throwRun();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.63).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, confirms } = makeCtx(true, {
    confirm: () => Promise.reject(new Error("dialog boom")),
  });
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 0);
  assert.equal(confirms.length, 1);
  assert.equal(pi.sent.length, 0);
  assert.equal(notes.length, 2);
  assert.ok(notes[1].text.includes("Run declined."));
  assert.equal(lines.length, 1);
});

test("05-03/T3(c): confirm resolving inside the teardown window spawns nothing and emits nothing", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const runner = throwRun();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.63).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir: tempLogDir(),
  });
  let resolveGate!: (value: boolean) => void;
  let confirmSeen = false;
  const { ctx, notes } = makeCtx(true, {
    confirm: () => {
      confirmSeen = true;
      return new Promise<boolean>((resolve) => {
        resolveGate = resolve;
      });
    },
  });
  // Dispatch WITHOUT awaiting: the dialog stays open until the test
  // resolves it from the teardown side.
  const pending = routeHandler(pi)("hello", ctx);
  // Bounded poll (not a fixed microtask count) until the dialog opens.
  for (let i = 0; i < 1000 && !confirmSeen; i++) await new Promise((r) => setImmediate(r));
  assert.ok(confirmSeen, "the dialog never opened");
  // Teardown lands while the dialog is open.
  const sub = pi.onCalls.find((call) => call[0] === "session_shutdown");
  assert.ok(sub !== undefined);
  await (sub[1] as () => Promise<void>)();
  resolveGate(true);
  await pending;
  // SILENT: only the Jev pre-emit was captured — no spawn, no report, no
  // run tuple. The session is gone; there is no transcript to write to.
  assert.equal(runner.calls(), 0);
  assert.deepEqual(
    notes.map((n) => n.text),
    [toPlainText(LOADING_LINE)],
  );
  assert.equal(pi.sent.length, 0);
  assert.equal(lines.length, 1, "the Jev tuple only — the guarded run sinks nothing");
});

test("05-03/T3(c): auto never opens a dialog (throw-if-called ui)", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("claude", "high", 0.95).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  // Default ctx confirm throws if called — passing proves auto never asks.
  const { ctx, confirms } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 1);
  assert.equal(confirms.length, 0);
});

test("05-03/T3(d): createRoute subscribes once to session_shutdown", () => {
  const pi = makePi();
  createRoute(pi.api);
  assert.equal(pi.onCalls.length, 1);
  assert.equal(pi.onCalls[0][0], "session_shutdown");
  assert.equal(typeof pi.onCalls[0][1], "function");
});

test("05-03/T3(d): the shutdown handler drains a real running route — aborted, registry empty", async () => {
  const pi = makePi();
  createRoute(pi.api);
  const sub = pi.onCalls.find((call) => call[0] === "session_shutdown");
  assert.ok(sub !== undefined);
  const shutdown = sub[1] as () => Promise<void>;
  // A REAL runHarness sleeper (a stub, not a harness — D-22 holds),
  // started WITHOUT awaiting, like a live /route in flight.
  const settled = runHarness({
    runId: nextRunId(),
    harness: "muse",
    binary: process.execPath,
    argv: ["-e", "setTimeout(()=>{},5000);"],
    effort: "standard",
    timeoutMs: 30_000,
    killGraceMs: 200,
  });
  for (let i = 0; i < 1000 && __runCount() === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(__runCount(), 1);
  await shutdown();
  const result = await settled;
  // The sleeper answers SIGTERM, so the escalation resolves in
  // milliseconds (the grace is a cap, not a wait).
  assert.equal(result.outcome, "aborted");
  assert.equal(__runCount(), 0);
});

test("05-03/T3(e): a rejecting run fake renders spawn-error + tuple, and the session routes on", async () => {
  const pi = makePi();
  const lines: string[] = [];
  const logDir = tempLogDir();
  let mode: "reject" | "ok" = "reject";
  const runner = runFake((opts) => {
    if (mode === "reject") throw new Error("hostile run boom");
    return settledRun(opts);
  });
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runner.fake,
    logDir,
  });
  const handler = routeHandler(pi);
  const decision = "Jev routed this prompt to **muse** at standard effort (confidence 0.90).";
  // FIRST: the hostile reject maps to the spawn-error composition — and the
  // await itself is the no-throw proof.
  await run(handler, "hello", makeCtx(false).ctx);
  const failed =
    `${LIST_2_OF_2}\n\n${decision}\n\n` +
    "Why **muse** (confidence 0.90).\n\n" +
    "**Could not start muse.**\n" +
    "The muse binary could not be started (it may have been moved or removed since detection).\n" +
    "Run /route-providers and re-run /route to re-detect harnesses.";
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: failed, display: true }]);
  assert.deepEqual(readdirSync(logDir), [], "spawn-error writes no log file");
  assert.equal(lines.length, 2);
  const failedRun = JSON.parse(lines[1]) as Record<string, unknown>;
  assert.equal(failedRun["type"], "run");
  assert.equal(failedRun["outcome"], "spawn-error");
  assert.ok(!("exitCode" in failedRun));
  assert.ok(!("signal" in failedRun));
  // THEN: the session is usable — a second /route reports normally.
  mode = "ok";
  await run(handler, "hello again", makeCtx(false).ctx);
  assert.equal(runner.calls(), 2);
  const logPath = path.join(logDir, `logofat-${runner.captured()[1].runId}.log`);
  const recovered =
    `${LIST_2_OF_2}\n\n${decision}\n\n` +
    "Why **muse** (confidence 0.90).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    `Full log: ${logPath}`;
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].content, recovered);
  assert.equal(lines.length, 4);
  assert.equal((JSON.parse(lines[3]) as { outcome: unknown }).outcome, "ok");
});

test("05-03/T3(e): an unwritable log dir degrades to the no-log line, same block otherwise", async () => {
  const dir = tempLogDir();
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "x\n");
  const pi = makePi();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runFake((opts) => settledRun(opts)).fake,
    logDir: blocker,
  });
  await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  const expected =
    `${LIST_2_OF_2}\n\n` +
    "Jev routed this prompt to **muse** at standard effort (confidence 0.90).\n\n" +
    "Why **muse** (confidence 0.90).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    "The full log could not be written, so only this excerpt is available.";
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].content, expected);
  assert.ok(!pi.sent[0].content.includes("Full log:"), "no path is ever named for a missing log");
});

test("05-03/T3(e): one run sinks exactly one run tuple (counting sink)", async () => {
  const pi = makePi();
  const lines: string[] = [];
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("claude", "high", 0.9).fake,
    logSink: (line) => {
      lines.push(line);
    },
    run: runFake((opts) =>
      settledRun(opts, { outcome: "nonzero", exitCode: 3, stdout: "OUT-1\n", stderr: "ERR-1\n" }),
    ).fake,
    logDir: tempLogDir(),
  });
  await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  assert.equal(lines.length, 2);
  const runLines = lines.filter(
    (line) => (JSON.parse(line) as { type?: unknown }).type === "run",
  );
  assert.equal(runLines.length, 1);
  const tuple = JSON.parse(runLines[0]) as Record<string, unknown>;
  assert.equal(tuple["harness"], "claude");
  assert.equal(tuple["effort"], "high");
  assert.equal(tuple["outcome"], "nonzero");
  assert.equal(tuple["exitCode"], 3);
  assert.ok(!("signal" in tuple));
  assert.equal(tuple["timedOut"], false);
  assert.equal(typeof tuple["runLatencyMs"], "number");
});

test("05-03/T4: README documents running on a harness", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("## Run logs"));
  assert.ok(readme.includes("## Running on a harness"));
  assert.ok(readme.includes("auto-run threshold"));
  assert.ok(readme.includes("interactive session"));
  assert.ok(readme.includes("10 minutes"));
});

test("06-04/T2: README documents install, providers refresh, and live status", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("## Install"));
  assert.ok(readme.includes("pi install /path/to/logofat"));
  assert.ok(readme.includes("pi update --extensions"));
  assert.ok(readme.includes("review the source before installing"));
  assert.ok(readme.includes("## Providers refresh"));
  assert.ok(readme.includes("/route-providers"));
  assert.ok(readme.includes("live status line"));
  assert.ok(readme.includes("runner-up"));
  assert.ok(!readme.includes(".planning/"), "no planning leakage in shipped docs");
  assert.ok(!/Phase \d/i.test(readme), "no Phase N language in shipped docs");
});

for (const stage of ["detect", "key", "jev"] as const) {
  for (const confidence of [0.9, 0.63]) {
    test(`CR-01: shutdown while ${stage} is pending suppresses ${confidence} continuation`, async () => {
      const pi = makePi();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const pause = async () => { entered.resolve(); await gate.promise; };
      const runner = throwRun();
      createRoute(pi.api, {
        detect: async () => { if (stage === "detect") await pause(); return [MUSE_OK]; },
        resolveKey: async () => { if (stage === "key") await pause(); return "fake"; },
        requestDecision: async (...args) => {
          if (stage === "jev") await pause();
          return okDecision("muse", "low", confidence).fake(...args);
        },
        run: runner.fake,
        logSink: nullSink,
      });
      const { ctx, notes, confirms } = makeCtx(true);
      const pending = routeHandler(pi)("hello", ctx);
      await entered.promise;
      const before = notes.length;
      await (pi.onCalls[0][1] as () => Promise<void>)();
      // Shutdown releases the pending command even if an injected provider
      // never settles; resolving it later cannot restart work or open UI.
      await pending;
      gate.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(notes.length, before);
      assert.equal(confirms.length, 0);
      assert.equal(runner.calls(), 0);
    });
  }
}

test("CR-02: registered shortcut cancels an idle route without a host operation signal", async () => {
  const pi = makePi();
  const started = Promise.withResolvers<RunOptions>();
  createRoute(pi.api, {
    detect: async () => [MUSE_OK],
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "low").fake,
    logSink: nullSink,
    logDir: tempLogDir(),
    run: async (opts) => {
      started.resolve(opts);
      await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return settledRun(opts, { outcome: "aborted" });
    },
  });
  const { ctx, notes } = makeCtx(true); // Faithful idle Pi: ctx.signal absent.
  const pending = routeHandler(pi)("hello", ctx);
  const opts = await started.promise;
  assert.equal(ctx.signal, undefined);
  assert.equal(opts.signal!.aborted, false);
  assert.ok(notes.some((note) => note.text.includes("Ctrl+Alt+X")));
  const shortcut = pi.shortcuts.find((item) => item.key === CANCEL_ROUTE_SHORTCUT);
  assert.ok(shortcut);
  shortcut.handler(); // Host input dispatcher does not await command completion.
  assert.equal(opts.signal!.aborted, true);
  await pending;
  assert.match(notes.at(-1)!.text, /cancelled/i);
});

test("CR-02: shortcut dismisses pending confirmation and never spawns", async () => {
  const pi = makePi();
  const shown = Promise.withResolvers<AbortSignal>();
  let calls = 0;
  createRoute(pi.api, {
    detect: async () => [MUSE_OK], resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "low", 0.63).fake,
    logSink: nullSink,
    run: async (opts) => { calls++; return settledRun(opts); },
  });
  const { ctx } = makeCtx(true);
  ctx.ui.confirm = async (_title, _message, opts) => {
    shown.resolve(opts!.signal!);
    return new Promise(() => {});
  };
  const pending = routeHandler(pi)("hello", ctx);
  const signal = await shown.promise;
  pi.shortcuts[0].handler();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 0);
});

test("CR-08: final notify and headless message preserve literal code and hostile markdown", async () => {
  const pi = makePi();
  const output = "if True:\n    result = 2 ** 3\n\tpass\n```\n[unsafe](javascript:alert(1))\n  trailing  ";
  createRoute(pi.api, {
    detect: async () => [MUSE_OK], resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "low").fake,
    logSink: nullSink, logDir: tempLogDir(),
    run: async (opts) => settledRun(opts, { stdout: output }),
  });
  const { ctx, notes } = makeCtx(false);
  await routeHandler(pi)("hello", ctx);
  assert.ok(notes.at(-1)!.text.includes(output));
  assert.ok(pi.sent[0].content.includes("````text\n" + output + "\n````"));
});

test("CR-03: cleanup warnings appear in the final report and saved log", async () => {
  const pi = makePi();
  const logDir = tempLogDir();
  const warning = "Process tree cleanup is unavailable on this platform.";
  createRoute(pi.api, {
    detect: async () => [MUSE_OK], resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "low").fake,
    logSink: nullSink, logDir,
    run: async (opts) => settledRun(opts, { cleanupWarning: warning }),
  });
  const { ctx, notes } = makeCtx(false);
  await routeHandler(pi)("hello", ctx);
  assert.ok(notes.at(-1)!.text.includes(warning));
  assert.ok(pi.sent[0].content.includes(warning));
  assert.ok(readFileSync(path.join(logDir, readdirSync(logDir)[0]), "utf8").includes(warning));
});

// ---------------------------------------------------------------------------
// Plan 06-01/T2: onProgress wiring + status lifecycle through the `run` fake.
// ---------------------------------------------------------------------------

const STATUS_CYAN = "\u001b[36m";
const STATUS_RESET = "\u001b[0m";

for (const leg of [
  { outcome: "ok", settled: { outcome: "ok", exitCode: 0 } },
  {
    outcome: "nonzero",
    settled: { outcome: "nonzero", exitCode: 3, stdout: "OUT-1\n", stderr: "ERR-1\n" },
  },
  { outcome: "timeout", settled: { outcome: "timeout", timedOut: true } },
  { outcome: "aborted", settled: { outcome: "aborted" } },
] as const) {
  test(`06-01/T2: TUI ${leg.outcome} — leading tick on started, key cleared once on settle`, async () => {
    const pi = makePi();
    const runner = runFake((opts) => {
      opts.onProgress?.({ type: "started", runId: opts.runId, harness: opts.harness, pid: 4242 });
      return settledRun(opts, { ...leg.settled });
    });
    createRoute(pi.api, {
      detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
      resolveKey: stubKey().fake,
      requestDecision: okDecision("muse", "standard", 0.9).fake,
      logSink: nullSink,
      run: runner.fake,
      logDir: tempLogDir(),
    });
    const { ctx, statuses } = makeCtx(true, { setStatus: true });
    await run(routeHandler(pi), "hello", ctx);
    assert.equal(typeof runner.captured()[0].onProgress, "function");
    const key = `logofat:${runner.captured()[0].runId}`;
    // Leading tick: exact layout (excerpt absent), per-harness color, per-run key.
    assert.deepEqual(statuses[0], {
      key,
      text: `${STATUS_CYAN}muse${STATUS_RESET} · 0s · 0 lines`,
    });
    const clears = statuses.filter((s) => s.text === undefined);
    assert.equal(clears.length, 1, "the key is cleared exactly once on settle");
    assert.deepEqual(statuses.at(-1), { key, text: undefined });
    assert.equal(statuses.length, 2, "leading tick + clear only — no interval tick fires before settle");
  });
}

test("06-01/T2: spawn-error exit-only trace — zero ticks, one harmless clear", async () => {
  const pi = makePi();
  const runner = runFake((opts) => {
    // The real spawnErrorFallback emits exit only, never started (F11).
    opts.onProgress?.({ type: "exit", runId: opts.runId, outcome: "spawn-error", exitCode: null, signal: null });
    return settledRun(opts, { outcome: "spawn-error", exitCode: null, stdout: "", stderr: "" });
  });
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, statuses } = makeCtx(true, { setStatus: true });
  await run(routeHandler(pi), "hello", ctx);
  assert.deepEqual(statuses, [{ key: `logofat:${runner.captured()[0].runId}`, text: undefined }]);
});

test("06-01/T2: hostile run reject — zero ticks, one clear via finally", async () => {
  const pi = makePi();
  const runner = runFake(() => {
    throw new Error("hostile run boom");
  });
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, statuses } = makeCtx(true, { setStatus: true });
  await run(routeHandler(pi), "hello", ctx);
  assert.deepEqual(statuses, [{ key: `logofat:${runner.captured()[0].runId}`, text: undefined }]);
});

test("06-01/T2: headless passes onProgress undefined even when setStatus exists (F3)", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, statuses } = makeCtx(false, { setStatus: true });
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.captured()[0].onProgress, undefined);
  assert.deepEqual(statuses, []);
});

test("06-01/T2: setStatus-absent TUI falls back to undefined and still runs", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, statuses } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.captured()[0].onProgress, undefined);
  assert.deepEqual(statuses, []);
  assert.equal(pi.sent.length, 0);
  assert.ok(notes.at(-1)!.text.includes("Run finished on muse (exit 0)."));
});

test("06-01/T2: synth path (unresolvable binary) never attaches", async () => {
  const pi = makePi();
  const runner = throwRun();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_MISSING, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, statuses } = makeCtx(true, { setStatus: true });
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(runner.calls(), 0);
  assert.deepEqual(statuses, [], "nothing was spawned, so no footer entry was ever attached");
  assert.ok(notes.at(-1)!.text.includes("Could not start muse."));
});

test("06-01/T2: shutdown sweeps the in-flight entry; owner-clear after is harmless", async () => {
  const pi = makePi();
  const gate = Promise.withResolvers<void>();
  let sawStarted = false;
  const runner = runFake((opts) => {
    opts.onProgress?.({ type: "started", runId: opts.runId, harness: opts.harness, pid: 4242 });
    sawStarted = true;
    return gate.promise.then(() => settledRun(opts, { outcome: "aborted" }));
  });
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes, statuses } = makeCtx(true, { setStatus: true });
  const pending = routeHandler(pi)("hello", ctx);
  for (let i = 0; i < 1000 && !sawStarted; i++) await new Promise((r) => setImmediate(r));
  assert.ok(sawStarted, "the run never started");
  assert.equal(statuses.length, 1, "leading tick recorded before shutdown");
  const sub = pi.onCalls.find((call) => call[0] === "session_shutdown");
  assert.ok(sub !== undefined);
  await (sub[1] as () => Promise<void>)();
  const key = `logofat:${runner.captured()[0].runId}`;
  assert.deepEqual(statuses.at(-1), { key, text: undefined });
  assert.equal(statuses.filter((s) => s.text === undefined).length, 1);
  gate.resolve();
  await pending;
  assert.equal(
    statuses.filter((s) => s.text === undefined).length,
    2,
    "the owner finally re-clears harmlessly after the sweep",
  );
  assert.deepEqual(
    notes.map((n) => n.text),
    [toPlainText(LOADING_LINE), "Running your prompt on muse at standard effort…\nCancel: Ctrl+Alt+X"],
  );
});

// ---------------------------------------------------------------------------
// Plan 06-02/T2: the explain line in handler compositions.
// ---------------------------------------------------------------------------

test("06-02/T2: auto composition carries the full margin line in-slot", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  const logDir = tempLogDir();
  const jev = decideFake(() =>
    Promise.resolve({
      ok: true,
      decision: {
        harness: "muse",
        confidence: 0.9,
        probabilities: { muse: 0.819, claude: 0.121 },
        difficulty: 1,
        scoreConfidence: 0.9,
        scoreProbabilities: { "1": 1 },
        effort: "standard",
      },
    }),
  );
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: jev.fake,
    logSink: nullSink,
    run: runner.fake,
    logDir,
  });
  await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
  const expected =
    `${LIST_2_OF_2}\n\n` +
    "Jev routed this prompt to **muse** at standard effort (confidence 0.90).\n\n" +
    "Why **muse**, 0.81 vs **claude** 0.12 (confidence 0.90).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    `Full log: ${logPath}`;
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].content, expected);
});

test("06-02/T2: single-harness success shows the degraded shape (no runner-up)", async () => {
  const pi = makePi();
  const runner = runFake((opts) => settledRun(opts));
  const logDir = tempLogDir();
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_MISSING]),
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir,
  });
  await run(routeHandler(pi), "hello", makeCtx(false).ctx);
  const logPath = path.join(logDir, `logofat-${runner.captured()[0].runId}.log`);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_MISSING])}\n\n` +
    `${formatDecisionLine("muse", "standard", 0.9)}\n\n` +
    "Why **muse** (confidence 0.90).\n\n" +
    "**Run finished on muse (exit 0).**\n" +
    "Showing the last 2 of 2 stdout lines:\n" +
    "```text\n" +
    "OUT-1\n" +
    "OUT-2\n" +
    "```\n" +
    `Full log: ${logPath}`;
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].content, expected);
});

test("06-02/T2: hostile probabilities on the auto path degrade without leaking keys", async () => {
  const pi = makePi();
  const jev = decideFake(() =>
    Promise.resolve({
      ok: true,
      decision: {
        harness: "muse",
        confidence: 0.9,
        probabilities: { cursor: 0.95 },
        difficulty: 1,
        scoreConfidence: 0.9,
        scoreProbabilities: { "1": 1 },
        effort: "standard",
      },
    }),
  );
  createRoute(pi.api, {
    detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]),
    resolveKey: stubKey().fake,
    requestDecision: jev.fake,
    logSink: nullSink,
    run: runFake((opts) => settledRun(opts)).fake,
    logDir: tempLogDir(),
  });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  assert.equal(pi.sent.length, 1);
  assert.ok(pi.sent[0].content.includes("Why **muse** (confidence 0.90)."));
  assert.ok(!pi.sent[0].content.includes("cursor"), "untrusted probabilities keys render nowhere");
  for (const n of notes) assert.ok(!n.text.includes("cursor"));
});

// ---------------------------------------------------------------------------
// Plan 06-03/T3: route-providers refresh paths through the `detect` fake.
// ---------------------------------------------------------------------------

test("06-03/T3: first refresh shows list + first-detection note (no baseline)", async () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_MISSING]));
  createRoute(pi.api, { detect: det.detect });
  const { ctx, notes } = makeCtx(false);
  await run(refreshHandler(pi), "", ctx);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_MISSING])}\n\n${formatFirstDetectionNote()}`;
  assert.equal(det.calls(), 1);
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: expected, display: true }]);
  assert.deepEqual(notes, [{ text: toPlainText(expected), level: "info" }]);
});

test("06-03/T3: second refresh shows list + diff after a mid-session change", async () => {
  const pi = makePi();
  let current: Provider[] = [MUSE_OK, CLAUDE_MISSING];
  const det = counting(() => Promise.resolve(current));
  createRoute(pi.api, { detect: det.detect });
  const handler = refreshHandler(pi);
  await run(handler, "", makeCtx(false).ctx);
  current = [MUSE_OK, CLAUDE_OK];
  await run(handler, "  ", makeCtx(false).ctx);
  assert.equal(det.calls(), 2);
  const expected =
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n` +
    "- claude: now available (/fx/claude, 2.1.281 (Claude Code))";
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].content, expected);
});

test("06-03/T3: identical re-probe renders the no-changes line", async () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
  createRoute(pi.api, { detect: det.detect });
  const handler = refreshHandler(pi);
  await run(handler, "", makeCtx(false).ctx);
  await run(handler, "", makeCtx(false).ctx);
  assert.equal(det.calls(), 2);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\nNo changes since the last detection.`;
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1].content, expected);
});

test("06-03/T3: zero-available refresh appends the shared no-harness block", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: () => Promise.resolve([MUSE_MISSING, CLAUDE_MISSING]) });
  const handler = refreshHandler(pi);
  await run(handler, "", makeCtx(false).ctx);
  await run(handler, "", makeCtx(false).ctx);
  const list = formatProviderList([MUSE_MISSING, CLAUDE_MISSING]);
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[0].content, `${list}\n\n${formatFirstDetectionNote()}\n\n${formatNoHarness()}`);
  assert.equal(pi.sent[1].content, `${list}\n\nNo changes since the last detection.\n\n${formatNoHarness()}`);
});

for (const args of ["--help", "-h", "  --help  "]) {
  test(`06-03/T3: refresh args ${JSON.stringify(args)} show help without probing`, async () => {
    const pi = makePi();
    const det = counting(throwIfCalled);
    createRoute(pi.api, { detect: det.detect });
    const { ctx, notes } = makeCtx(false);
    await run(refreshHandler(pi), args, ctx);
    assert.equal(det.calls(), 0);
    assert.deepEqual(notes, [{ text: toPlainText(formatRefreshHelp()), level: "info" }]);
    assert.deepEqual(pi.sent, [{ customType: "logofat", content: formatRefreshHelp(), display: true }]);
  });
}

for (const args of ["--bogus", "hello", "--help me", "-"]) {
  test(`06-03/T3: refresh args ${JSON.stringify(args)} show usage without probing`, async () => {
    const pi = makePi();
    const det = counting(throwIfCalled);
    createRoute(pi.api, { detect: det.detect });
    const { ctx, notes } = makeCtx(false);
    await run(refreshHandler(pi), args, ctx);
    assert.equal(det.calls(), 0);
    assert.deepEqual(notes, [{ text: toPlainText(formatRefreshUsage()), level: "info" }]);
    assert.deepEqual(pi.sent, [{ customType: "logofat", content: formatRefreshUsage(), display: true }]);
  });
}

test("06-03/T3: concurrent refreshes share one probe with identical baseline + result", async () => {
  const pi = makePi();
  const gate = Promise.withResolvers<Provider[]>();
  const det = counting(() => gate.promise);
  createRoute(pi.api, { detect: det.detect });
  const handler = refreshHandler(pi);
  const a = makeCtx(false);
  const b = makeCtx(false);
  const c = makeCtx(false);
  const pending = [handler("", a.ctx), handler("  ", b.ctx), handler("", c.ctx)];
  // getProviders() defers detect() to a microtask: one macrotask flushes all three callers into the wave.
  await new Promise((r) => setImmediate(r));
  assert.equal(det.calls(), 1, "the shared wave probes once");
  gate.resolve([MUSE_OK, CLAUDE_OK]);
  await Promise.all(pending);
  assert.equal(det.calls(), 1, "one wave runs one probe");
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatFirstDetectionNote()}`;
  assert.equal(pi.sent.length, 3);
  for (const sent of pi.sent) {
    assert.deepEqual(sent, { customType: "logofat", content: expected, display: true });
  }
});

test("06-03/T3: a route awaiting the old probe keeps its snapshot across a refresh", async () => {
  const pi = makePi();
  const gate = Promise.withResolvers<Provider[]>();
  let calls = 0;
  const detect = (): Promise<Provider[]> => {
    calls += 1;
    return calls === 1 ? gate.promise : Promise.resolve([MUSE_OK, CLAUDE_OK]);
  };
  createRoute(pi.api, {
    detect,
    resolveKey: nullKey().fake,
    requestDecision: throwJev().fake,
  });
  const pendingRoute = routeHandler(pi)("hello", makeCtx(false).ctx);
  const pendingRefresh = refreshHandler(pi)("", makeCtx(false).ctx);
  gate.resolve([MUSE_OK, CLAUDE_MISSING]);
  await pendingRoute;
  await pendingRefresh;
  assert.equal(calls, 2);
  assert.equal(pi.sent.length, 2);
  // The route settled on the pre-refresh snapshot; the refresh shows the fresh list + diff.
  assert.equal(
    pi.sent[0].content,
    `${formatProviderList([MUSE_OK, CLAUDE_MISSING])}\n\n${formatMissingKey()}`,
  );
  assert.equal(
    pi.sent[1].content,
    `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n- claude: now available (/fx/claude, 2.1.281 (Claude Code))`,
  );
});

test("06-03/T3: refresh during a running run never affects it", async () => {
  const pi = makePi();
  const gate = Promise.withResolvers<void>();
  let current: Provider[] = [MUSE_OK, CLAUDE_OK];
  const det = counting(() => Promise.resolve(current));
  const runner = runFake((opts) => gate.promise.then(() => settledRun(opts)));
  createRoute(pi.api, {
    detect: det.detect,
    resolveKey: stubKey().fake,
    requestDecision: okDecision("muse", "standard", 0.9).fake,
    logSink: nullSink,
    run: runner.fake,
    logDir: tempLogDir(),
  });
  const pendingRoute = routeHandler(pi)("hello", makeCtx(false).ctx);
  for (let i = 0; i < 1000 && runner.calls() === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(runner.calls(), 1, "the run never started");
  current = [MUSE_MISSING, CLAUDE_MISSING];
  await run(refreshHandler(pi), "", makeCtx(false).ctx);
  gate.resolve();
  await pendingRoute;
  // The run kept its own binary + argv; the route report kept its settled list.
  const captured = runner.captured()[0];
  assert.equal(captured.binary, "/fx/muse");
  assert.deepEqual(captured.argv, ["exec", "--reasoning-effort", "medium", "--", "hello"]);
  assert.equal(pi.sent.length, 2);
  assert.ok(pi.sent[0].content.includes("**Detected providers (0/2):**"));
  assert.ok(pi.sent[1].content.startsWith(LIST_2_OF_2), "the route report kept its pre-refresh list");
});

test("06-03/T3: refresh under shutdown returns silently without probing", async () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
  createRoute(pi.api, { detect: det.detect });
  const sub = pi.onCalls.find((call) => call[0] === "session_shutdown");
  assert.ok(sub !== undefined);
  await (sub[1] as () => Promise<void>)();
  const { ctx, notes } = makeCtx(false);
  await run(refreshHandler(pi), "", ctx);
  assert.equal(det.calls(), 0);
  assert.deepEqual(notes, []);
  assert.deepEqual(pi.sent, []);
});

test("06-03/T3: shutdown while refresh awaits the old probe starts no fresh probe and emits nothing", async () => {
  const pi = makePi();
  const gate = Promise.withResolvers<Provider[]>();
  const det = counting(() => gate.promise);
  createRoute(pi.api, {
    detect: det.detect,
    resolveKey: nullKey().fake,
    requestDecision: throwJev().fake,
  });
  const pendingRoute = routeHandler(pi)("hello", makeCtx(false).ctx);
  const { ctx, notes } = makeCtx(false);
  const pendingRefresh = refreshHandler(pi)("", ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(det.calls(), 1);
  const sub = pi.onCalls.find((call) => call[0] === "session_shutdown");
  assert.ok(sub !== undefined);
  await (sub[1] as () => Promise<void>)();
  gate.resolve([MUSE_OK, CLAUDE_OK]);
  await pendingRoute;
  await pendingRefresh;
  assert.equal(det.calls(), 1, "no fresh probe starts during teardown");
  assert.deepEqual(notes, []);
  assert.deepEqual(pi.sent, []);
});

test("06-03/T3: shutdown while the fresh probe is pending emits nothing", async () => {
  const pi = makePi();
  const gate = Promise.withResolvers<Provider[]>();
  const det = counting(() => gate.promise);
  createRoute(pi.api, { detect: det.detect });
  const { ctx, notes } = makeCtx(false);
  const pending = refreshHandler(pi)("", ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(det.calls(), 1);
  const sub = pi.onCalls.find((call) => call[0] === "session_shutdown");
  assert.ok(sub !== undefined);
  await (sub[1] as () => Promise<void>)();
  gate.resolve([MUSE_OK, CLAUDE_OK]);
  await pending;
  assert.equal(det.calls(), 1);
  assert.deepEqual(notes, []);
  assert.deepEqual(pi.sent, []);
});

test("06-03/T3: refresh emits notify-only under TUI, notify + message headless", async () => {
  const tui = makePi();
  createRoute(tui.api, { detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]) });
  const t = makeCtx(true);
  await run(refreshHandler(tui), "", t.ctx);
  assert.equal(t.notes.length, 1);
  assert.equal(tui.sent.length, 0);

  const headless = makePi();
  createRoute(headless.api, { detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]) });
  const h = makeCtx(false);
  await run(refreshHandler(headless), "", h.ctx);
  const expected = `${formatProviderList([MUSE_OK, CLAUDE_OK])}\n\n${formatFirstDetectionNote()}`;
  assert.deepEqual(h.notes, [{ text: toPlainText(expected), level: "info" }]);
  assert.deepEqual(headless.sent, [{ customType: "logofat", content: expected, display: true }]);
});
