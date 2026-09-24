// Unit tests for src/index.ts: factory purity, argument handling, the emit
// gate, and the factory-closure detection cache (plan 01-04, task 1).
//
// Test doubles follow the real host contract (test/output-contract.md):
// - the stub `pi` records registerCommand / on / sendMessage calls;
// - the stub `ctx` carries ONLY genuine command-context members (ui.notify,
//   mode, hasUI). It has no sendMessage: that method does not exist on the
//   real command context, so a double offering it would hide a bug.
// - the handler contract is Promise<void>. The host discards return values,
//   so every assertion is on recorded notify / sendMessage calls.
//
// Detection is always injected through createRoute(pi, { detect }) so no test
// here spawns a real harness. The one exception is the import-purity proof at
// the end, which runs in a CHILD node process against a generated fixture PATH
// (the test process PATH is never mutated).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import logofat, { CUSTOM_TYPE, ROUTE_DESCRIPTION, allUnavailable, createRoute, renderUsage } from "../src/index.ts";
import {
  ROUTING_NOTICE,
  formatDetectionResult,
  formatHelp,
  formatNoHarness,
  formatProviderList,
  formatUsage,
  toPlainText,
} from "../src/messages.ts";
import { REASON_NOT_FOUND, REASON_VERSION_FAILED } from "../src/providers.ts";
import type { Provider } from "../src/providers.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type Registration = { name: string; description: string; handler: Handler };
type SentMessage = { customType: string; content: string; display: boolean };

type StubPi = {
  api: ExtensionAPI;
  registrations: Registration[];
  onCalls: unknown[][];
  sent: SentMessage[];
};

function makePi(): StubPi {
  const registrations: Registration[] = [];
  const onCalls: unknown[][] = [];
  const sent: SentMessage[] = [];
  const api = {
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
  return { api: api as unknown as ExtensionAPI, registrations, onCalls, sent };
}

type StubCtx = {
  ctx: ExtensionCommandContext;
  notes: { text: string; level: string }[];
};

/** hasUI true = TUI/RPC shape; hasUI false = --print --mode json shape. */
function makeCtx(hasUI: boolean): StubCtx {
  const notes: { text: string; level: string }[] = [];
  const raw = {
    mode: hasUI ? "tui" : "json",
    hasUI,
    ui: {
      notify(text: string, level: string) {
        notes.push({ text, level });
      },
    },
  };
  assert.ok(!("sendMessage" in raw), "the ctx double must not offer ctx.sendMessage");
  return { ctx: raw as unknown as ExtensionCommandContext, notes };
}

function routeHandler(pi: StubPi): Handler {
  assert.equal(pi.registrations.length, 1, "exactly one command registration expected");
  const [reg] = pi.registrations;
  assert.equal(reg.name, "route");
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

// ---------------------------------------------------------------------------
// Factory purity and registration

test("factory: nothing is registered until the factory runs, then exactly one /route", () => {
  const pi = makePi();
  // The module is already imported at the top of this file. Importing it gave
  // the module no `pi` to touch, and the stub records nothing until called.
  assert.equal(pi.registrations.length, 0);
  assert.equal(pi.onCalls.length, 0);
  assert.equal(pi.sent.length, 0);

  const ret = logofat(pi.api);
  assert.equal(ret, undefined);
  assert.equal(pi.registrations.length, 1);
  assert.equal(pi.registrations[0].name, "route");
  assert.equal(pi.registrations[0].description, ROUTE_DESCRIPTION);
  assert.equal(typeof pi.registrations[0].handler, "function");
  assert.equal(pi.onCalls.length, 0, "the factory subscribes to no events (lazy-only detection)");
  assert.equal(pi.sent.length, 0, "the factory emits nothing");
});

test("factory: registering does not call the detector", () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
  createRoute(pi.api, { detect: det.detect });
  assert.equal(det.calls(), 0);
  assert.equal(pi.registrations.length, 1);
});

test("CUSTOM_TYPE is the contract literal and the description names Logofăt", () => {
  assert.equal(CUSTOM_TYPE, "logofat");
  assert.ok(ROUTE_DESCRIPTION.startsWith("Logofăt: "));
  assert.ok(!/nabu/i.test(ROUTE_DESCRIPTION));
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

test("gate: hasUI true (TUI/RPC) -> one notify, zero pi.sendMessage (detection result)", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]) });
  const { ctx, notes } = makeCtx(true);
  await run(routeHandler(pi), "hello", ctx);
  assert.deepEqual(notes, [{ text: toPlainText(formatProviderList([MUSE_OK, CLAUDE_OK])), level: "info" }]);
  assert.ok(!notes[0].text.includes("**"), "notify text is plain (no bold markers)");
  assert.equal(pi.sent.length, 0);
});

test("gate: hasUI false (json) -> one notify plus one pi.sendMessage with the markdown copy", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: () => Promise.resolve([MUSE_OK, CLAUDE_MISSING]) });
  const { ctx, notes } = makeCtx(false);
  await run(routeHandler(pi), "hello", ctx);
  const copy = formatProviderList([MUSE_OK, CLAUDE_MISSING]);
  assert.deepEqual(notes, [{ text: toPlainText(copy), level: "info" }]);
  assert.deepEqual(pi.sent, [{ customType: "logofat", content: copy, display: true }]);
  assert.ok(copy.includes(ROUTING_NOTICE));
});

test("the prompt text is passed through unsplit and never echoed into the payload", async () => {
  const pi = makePi();
  createRoute(pi.api, { detect: () => Promise.resolve([MUSE_OK, CLAUDE_OK]) });
  const { ctx } = makeCtx(false);
  await run(routeHandler(pi), " secret  prompt   text ", ctx);
  assert.equal(pi.sent.length, 1);
  assert.ok(!pi.sent[0].content.includes("secret"));
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
  assert.ok(!pi.sent[0].content.includes(ROUTING_NOTICE));
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
  createRoute(pi.api, { detect: det.detect });
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
  const copy = formatProviderList([MUSE_OK, CLAUDE_OK]);
  assert.deepEqual(
    pi.sent.map((m) => m.content),
    [copy, copy],
  );
  assert.equal(a.notes.length, 1);
  assert.equal(b.notes.length, 1);
});

test("cache: sequential calls reuse the session result (one detection total)", async () => {
  const pi = makePi();
  let n = 0;
  const det = counting(() => {
    n += 1;
    // A second probe would return a different answer; the cache must hide it.
    return Promise.resolve(n === 1 ? [MUSE_OK, CLAUDE_OK] : [MUSE_MISSING, CLAUDE_MISSING]);
  });
  createRoute(pi.api, { detect: det.detect });
  const handler = routeHandler(pi);
  for (const prompt of ["one", "two", "three"]) {
    const { ctx } = makeCtx(false);
    await run(handler, prompt, ctx);
  }
  assert.equal(det.calls(), 1);
  assert.equal(pi.sent.length, 3);
  for (const m of pi.sent) assert.equal(m.content, formatProviderList([MUSE_OK, CLAUDE_OK]));
});

test("cache: usage/help between prompts never probe and never disturb the cache", async () => {
  const pi = makePi();
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_MISSING]));
  createRoute(pi.api, { detect: det.detect });
  const handler = routeHandler(pi);
  await run(handler, "", makeCtx(false).ctx);
  await run(handler, "--help", makeCtx(false).ctx);
  assert.equal(det.calls(), 0);
  await run(handler, "hello", makeCtx(false).ctx);
  await run(handler, "-h", makeCtx(false).ctx);
  await run(handler, "hello again", makeCtx(false).ctx);
  assert.equal(det.calls(), 1);
});

test("cache: each factory call owns its own cache (no module-level state)", async () => {
  const det = counting(() => Promise.resolve([MUSE_OK, CLAUDE_OK]));
  const pi1 = makePi();
  const pi2 = makePi();
  createRoute(pi1.api, { detect: det.detect });
  createRoute(pi2.api, { detect: det.detect });
  await run(routeHandler(pi1), "hello", makeCtx(false).ctx);
  await run(routeHandler(pi2), "hello", makeCtx(false).ctx);
  assert.equal(det.calls(), 2);
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
const pi = {
  registerCommand: (name, opts) => regs.push({ name, opts }),
  on: () => { throw new Error("factory must not subscribe to events"); },
  sendMessage: (m) => sent.push(m),
};
mod.default(pi);
await settle();
out.afterFactory = existsSync(marker);
out.registrations = regs.map((r) => r.name);
const notes = [];
const ctx = { mode: "json", hasUI: false, ui: { notify: (t) => notes.push(t) } };
await regs[0].opts.handler("hello", ctx);
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

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    env: { ...process.env, PATH: binDir, LOGOFAT_MARKER: marker, LOGOFAT_INDEX_URL: INDEX_URL },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  const out = JSON.parse(child.stdout) as {
    afterImport: boolean;
    afterFactory: boolean;
    afterHandler: boolean;
    registrations: string[];
    sent: string[];
    notes: string[];
  };

  assert.equal(out.afterImport, false, "importing src/index.ts must not probe any harness");
  assert.equal(out.afterFactory, false, "calling the factory must not probe any harness");
  assert.deepEqual(out.registrations, ["route"]);
  // Positive control: a broken fixture (bad shebang, missing chmod, wrong
  // PATH) would leave no marker here and fail instead of passing vacuously.
  assert.equal(out.afterHandler, true, "the handler must probe the fixture harnesses");
  assert.equal(out.sent.length, 1);
  assert.ok(out.sent[0].startsWith("**Detected providers (2/2):**\n"), out.sent[0]);
  assert.ok(out.sent[0].includes(`- muse: available (${path.join(binDir, "muse")}, muse 9.9.9)`), out.sent[0]);
  assert.equal(out.notes.length, 1);
});
