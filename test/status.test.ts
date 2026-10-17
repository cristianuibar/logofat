// Unit tests for src/status.ts (Phase 6, EXEC-02): the pure footer
// renderer, the tail buffer, and the ProgressEvent-driven ticker.
//
// Renderer + tail tests are pure string checks. Ticker tests drive a fake
// clock/scheduler — never real sleeps, never real timers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXCERPT_CHARS,
  STATUS_LINE_BUDGET_CHARS,
  STATUS_TICK_MS,
  TAIL_BUFFER_CHARS,
  attachRunStatus,
  createTailBuffer,
  renderStatus,
} from "../src/status.ts";
import type { StatusClock } from "../src/status.ts";
import type { ProviderId } from "../src/providers.ts";
import type { ProgressEvent } from "../src/runner/spawn.ts";

const CYAN = "\u001b[36m";
const MAGENTA = "\u001b[35m";
const RESET = "\u001b[0m";

const STARTED_MUSE: ProgressEvent = { type: "started", runId: "run-1", harness: "muse", pid: 4242 };
const EXIT_OK: ProgressEvent = { type: "exit", runId: "run-1", outcome: "ok", exitCode: 0, signal: null };

function chunk(text: string): ProgressEvent {
  return { type: "chunk", runId: "run-1", stream: "stdout", text };
}

type StatusCall = { key: string; text: string | undefined };

function makeSetStatus(impl?: (key: string, text: string | undefined) => void): {
  calls: StatusCall[];
  fn: (key: string, text: string | undefined) => void;
} {
  const calls: StatusCall[] = [];
  return {
    calls,
    fn: (key, text) => {
      calls.push({ key, text });
      impl?.(key, text);
    },
  };
}

type FakeClock = {
  clock: StatusClock;
  scheduled: { id: number; ms: number }[];
  cleared: unknown[];
  liveCount: () => number;
  setNow: (ms: number) => void;
  fireAll: () => void;
};

/** Manual scheduler: ticks fire only when the test calls fireAll(). */
function makeFakeClock(): FakeClock {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const scheduled: { id: number; ms: number }[] = [];
  const cleared: unknown[] = [];
  return {
    clock: {
      now: () => nowMs,
      every: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, fn);
        scheduled.push({ id, ms });
        return id;
      },
      clear: (handle: unknown) => {
        cleared.push(handle);
        timers.delete(handle as number);
      },
    },
    scheduled,
    cleared,
    liveCount: () => timers.size,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    fireAll: () => {
      for (const fn of [...timers.values()]) fn();
    },
  };
}

// ---------------------------------------------------------------------------
// renderStatus goldens
// ---------------------------------------------------------------------------

test("06-01/T1: leading layout is id + elapsed + zero count, no excerpt clause", () => {
  assert.equal(
    renderStatus({ harness: "muse", elapsedMs: 0, lineCount: 0, excerpt: "", ansi: false }),
    "muse · 0s · 0 lines",
  );
  assert.equal(
    renderStatus({ harness: "claude", elapsedMs: 0, lineCount: 0, excerpt: "", ansi: false }),
    "claude · 0s · 0 lines",
  );
});

test("06-01/T1: ticking layout shows elapsed, count, and the excerpt clause", () => {
  assert.equal(
    renderStatus({ harness: "muse", elapsedMs: 1000, lineCount: 0, excerpt: "", ansi: false }),
    "muse · 1s · 0 lines",
  );
  assert.equal(
    renderStatus({ harness: "muse", elapsedMs: 12_345, lineCount: 7, excerpt: "writing main.ts", ansi: false }),
    "muse · 12s · 7 lines · writing main.ts",
  );
  assert.equal(
    renderStatus({ harness: "claude", elapsedMs: 59_999, lineCount: 120, excerpt: "done", ansi: false }),
    "claude · 59s · 120 lines · done",
  );
});

test("06-01/T1: elapsed renders MmSSs at/over 60s with zero-padded seconds", () => {
  assert.equal(
    renderStatus({ harness: "muse", elapsedMs: 60_000, lineCount: 0, excerpt: "", ansi: false }),
    "muse · 1m00s · 0 lines",
  );
  assert.equal(
    renderStatus({ harness: "muse", elapsedMs: 65_000, lineCount: 3, excerpt: "x", ansi: false }),
    "muse · 1m05s · 3 lines · x",
  );
  assert.equal(
    renderStatus({ harness: "claude", elapsedMs: 599_999, lineCount: 0, excerpt: "", ansi: false }),
    "claude · 9m59s · 0 lines",
  );
  assert.equal(
    renderStatus({ harness: "claude", elapsedMs: 3_599_999, lineCount: 0, excerpt: "", ansi: false }),
    "claude · 59m59s · 0 lines",
  );
});

test("06-01/T1: ANSI wrap covers the sanitized id only, char-for-char", () => {
  assert.equal(
    renderStatus({ harness: "muse", elapsedMs: 0, lineCount: 0, excerpt: "", ansi: true }),
    `${CYAN}muse${RESET} · 0s · 0 lines`,
  );
  assert.equal(
    renderStatus({ harness: "claude", elapsedMs: 2000, lineCount: 4, excerpt: "ok", ansi: true }),
    `${MAGENTA}claude${RESET} · 2s · 4 lines · ok`,
  );
  // Exact escape structure: one opener, one reset, nothing else.
  const line = renderStatus({ harness: "muse", elapsedMs: 0, lineCount: 0, excerpt: "", ansi: true });
  assert.deepEqual([...line.matchAll(/\u001b/g)].length, 2);
  assert.ok(line.startsWith(`${CYAN}muse${RESET} `));
});

test("06-01/T1: ansi:false is the plain-text fallback, no substitute glyphs", () => {
  const line = renderStatus({ harness: "muse", elapsedMs: 1000, lineCount: 1, excerpt: "x", ansi: false });
  assert.equal(line, "muse · 1s · 1 lines · x");
  assert.ok(!line.includes("\u001b"));
});

test("06-01/T1: hostile input degrades, never throws", () => {
  const hostile = (input: unknown): string => {
    let out: string | undefined;
    try {
      out = renderStatus(input as Parameters<typeof renderStatus>[0]);
    } catch (err) {
      assert.fail(`renderStatus threw: ${String(err)}`);
    }
    return out;
  };
  assert.equal(hostile(null), "unknown · 0s · 0 lines");
  assert.equal(hostile(undefined), "unknown · 0s · 0 lines");
  assert.equal(hostile({}), "unknown · 0s · 0 lines");
  assert.equal(
    hostile({ harness: "", elapsedMs: 0, lineCount: 0, excerpt: "", ansi: false }),
    "unknown · 0s · 0 lines",
  );
  assert.equal(
    hostile({ harness: "muse", elapsedMs: Number.NaN, lineCount: 0, excerpt: "", ansi: false }),
    "muse · 0s · 0 lines",
  );
  assert.equal(
    hostile({ harness: "muse", elapsedMs: -5000, lineCount: 0, excerpt: "", ansi: false }),
    "muse · 0s · 0 lines",
  );
  assert.equal(
    hostile({ harness: "muse", elapsedMs: 0, lineCount: Number.POSITIVE_INFINITY, excerpt: "", ansi: false }),
    "muse · 0s · 0 lines",
  );
  assert.equal(
    hostile({ harness: "muse", elapsedMs: 0, lineCount: -3, excerpt: "", ansi: false }),
    "muse · 0s · 0 lines",
  );
  assert.equal(
    hostile({ harness: "muse", elapsedMs: 1500, lineCount: 2.9, excerpt: "", ansi: false }),
    "muse · 1s · 2 lines",
  );
  // Non-string excerpts omit the clause; unknown ids render uncolored.
  assert.equal(
    hostile({ harness: "muse", elapsedMs: 0, lineCount: 0, excerpt: 42, ansi: false }),
    "muse · 0s · 0 lines",
  );
  assert.equal(
    hostile({ harness: "cursor", elapsedMs: 0, lineCount: 0, excerpt: "", ansi: true }),
    "cursor · 0s · 0 lines",
  );
  // Throwing getters never escape.
  const evil = {};
  Object.defineProperty(evil, "harness", {
    get() {
      throw new Error("getter boom");
    },
  });
  assert.equal(hostile(evil), "unknown · 0s · 0 lines");
});

test("06-01/T1: sanitize-then-wrap — injected escapes never reach the line", () => {
  // An id carrying ANSI sanitizes to the bare token before any wrap.
  assert.equal(
    renderStatus({ harness: "\u001b[31mmuse" as ProviderId, elapsedMs: 0, lineCount: 0, excerpt: "", ansi: true }),
    `${CYAN}muse${RESET} · 0s · 0 lines`,
  );
  assert.equal(
    renderStatus({ harness: "mu\u0000se" as ProviderId, elapsedMs: 0, lineCount: 0, excerpt: "", ansi: false }),
    "muse · 0s · 0 lines",
  );
  // Excerpt canaries: CSI, OSC, controls, bidi, and link syntax all neutralized.
  const line = renderStatus({
    harness: "muse",
    elapsedMs: 0,
    lineCount: 0,
    excerpt: "\u001b[31mred](http://evil.example)\u001b]0;title\u0007 \u202esneaky\u202c\u0002",
    ansi: true,
  });
  assert.ok(!line.includes("\u001b[31m"), line);
  assert.ok(!line.includes("]("), line);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(line.replace(/\u001b\[[0-9]+m/g, "")), line);
  assert.ok(line.startsWith(`${CYAN}muse${RESET} · 0s · 0 lines · `));
});

test("06-01/T1: the 160-char budget holds with a worst-case excerpt", () => {
  assert.equal(STATUS_TICK_MS, 1000);
  assert.equal(TAIL_BUFFER_CHARS, 512);
  assert.equal(EXCERPT_CHARS, 80);
  assert.equal(STATUS_LINE_BUDGET_CHARS, 160);
  const worst = renderStatus({
    harness: "muse",
    elapsedMs: 3_599_999,
    lineCount: 123456,
    excerpt: "x".repeat(200),
    ansi: true,
  });
  assert.ok(worst.endsWith(` · ${"x".repeat(80)}`), worst);
  assert.ok(worst.length <= STATUS_LINE_BUDGET_CHARS, `${worst.length}: ${worst}`);
  const unknownWorst = renderStatus({
    harness: "cursor",
    elapsedMs: 3_599_999,
    lineCount: 123456,
    excerpt: "y".repeat(80),
    ansi: true,
  });
  assert.ok(unknownWorst.length <= STATUS_LINE_BUDGET_CHARS, unknownWorst);
});

// ---------------------------------------------------------------------------
// Tail buffer
// ---------------------------------------------------------------------------

test("06-01/T1: tail buffer assembles split lines and counts completed lines", () => {
  const tail = createTailBuffer();
  assert.equal(tail.lastLine(), "");
  assert.equal(tail.lineCount, 0);
  tail.push("foo");
  assert.equal(tail.lastLine(), "foo");
  assert.equal(tail.lineCount, 0);
  tail.push("bar\n");
  assert.equal(tail.lastLine(), "");
  assert.equal(tail.lineCount, 1);
  tail.push("baz\nqux\npartial");
  assert.equal(tail.lastLine(), "partial");
  assert.equal(tail.lineCount, 3);
});

test("06-01/T1: tail buffer trims from the head but the count stays cumulative", () => {
  const tail = createTailBuffer(10);
  tail.push("0123456789ABC");
  assert.equal(tail.lastLine(), "3456789ABC");
  tail.push("d\ne\nf\n");
  assert.equal(tail.lineCount, 3);
  assert.equal(tail.lastLine(), "");
  // The default bound keeps ~6 80-column lines.
  const big = createTailBuffer();
  big.push("z".repeat(600));
  assert.equal(big.lastLine().length, 512);
  big.push(`${"a\n".repeat(300)}tail`);
  assert.equal(big.lineCount, 300);
  assert.equal(big.lastLine(), "tail");
});

test("06-01/T1: tail buffer ignores non-strings and hostile limits, never throws", () => {
  const tail = createTailBuffer();
  for (const bad of [null, undefined, 42, {}, []] as const) {
    let threw = false;
    try {
      tail.push(bad);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  }
  assert.equal(tail.lastLine(), "");
  assert.equal(tail.lineCount, 0);
  for (const limit of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY, "512"] as const) {
    const t = createTailBuffer(limit as unknown as number);
    t.push("hello");
    assert.equal(t.lastLine(), "hello");
  }
  const tiny = createTailBuffer(0.5);
  tiny.push("hello");
  assert.equal(tiny.lastLine(), "o");
});

// ---------------------------------------------------------------------------
// Ticker with a fake clock
// ---------------------------------------------------------------------------

test("06-01/T1: started renders the leading tick and starts the 1s timer", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent } = attachRunStatus({
    setStatus: status.fn,
    key: "logofat:run-1",
    harness: "muse",
    ansi: true,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  assert.deepEqual(status.calls, [
    { key: "logofat:run-1", text: `${CYAN}muse${RESET} · 0s · 0 lines` },
  ]);
  assert.deepEqual(fake.scheduled, [{ id: 1, ms: 1000 }]);
});

test("06-01/T1: timer ticks advance elapsed; silent runs still tick", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent } = attachRunStatus({
    setStatus: status.fn,
    key: "logofat:run-1",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  fake.setNow(1000);
  fake.fireAll();
  fake.setNow(65_000);
  fake.fireAll();
  assert.deepEqual(
    status.calls.map((c) => c.text),
    ["muse · 0s · 0 lines", "muse · 1s · 0 lines", "muse · 1m05s · 0 lines"],
  );
});

test("06-01/T1: the excerpt appears on the first chunk-carrying tick", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent } = attachRunStatus({
    setStatus: status.fn,
    key: "logofat:run-1",
    harness: "claude",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  fake.setNow(1000);
  fake.fireAll();
  assert.equal(status.calls[1].text, "claude · 1s · 0 lines");
  onEvent(chunk("writing "));
  onEvent(chunk("main.ts\nnext"));
  fake.setNow(2000);
  fake.fireAll();
  assert.equal(status.calls[2].text, "claude · 2s · 1 lines · next");
});

test("06-01/T1: excerpt is sanitized then capped at 80 chars, cap-last", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  // Sanitizing lengthens via the `] (` join: cap-last keeps the budget exact.
  onEvent(chunk(`${"A".repeat(70)}](x)`));
  fake.setNow(1000);
  fake.fireAll();
  const text = status.calls[1].text ?? "";
  assert.ok(text.endsWith(` · ${"A".repeat(70)}] (x)`), text);
  onEvent(chunk(`\n${"B".repeat(200)}`));
  fake.setNow(2000);
  fake.fireAll();
  const capped = status.calls[2].text ?? "";
  assert.ok(capped.endsWith(` · ${"B".repeat(80)}`), capped);
  assert.ok(capped.length <= STATUS_LINE_BUDGET_CHARS, capped);
});

test("06-01/T1: exit is ignored — no trailing tick, timer untouched", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  const before = status.calls.length;
  onEvent(EXIT_OK);
  assert.equal(status.calls.length, before, "exit renders no trailing tick");
  fake.setNow(1000);
  fake.fireAll();
  assert.equal(status.calls.length, before + 1, "the timer survives exit until stop()");
});

test("06-01/T1: exit-only trace schedules nothing; stop is safe (C4)", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent, stop } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(EXIT_OK);
  assert.deepEqual(fake.scheduled, []);
  assert.deepEqual(status.calls, [], "no tick without started");
  let threw = false;
  try {
    stop();
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.deepEqual(status.calls, [{ key: "k", text: undefined }]);
});

test("06-01/T1: stop cancels the scheduler and clears the key, twice-safe", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent, stop } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  stop();
  assert.deepEqual(fake.cleared, [1]);
  assert.equal(fake.liveCount(), 0);
  assert.deepEqual(status.calls.at(-1), { key: "k", text: undefined });
  fake.setNow(5000);
  fake.fireAll();
  const afterFirstStop = status.calls.length;
  let threw = false;
  try {
    stop();
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.deepEqual(fake.cleared, [1], "the scheduler is cleared once");
  assert.equal(status.calls.length, afterFirstStop + 1, "the second clear is a harmless repeat");
  assert.deepEqual(status.calls.at(-1), { key: "k", text: undefined });
});

test("06-01/T1: a throwing setStatus is swallowed on tick and on stop", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus(() => {
    throw new Error("dead ctx");
  });
  const { onEvent, stop } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  let threw = false;
  try {
    onEvent(STARTED_MUSE);
    onEvent(chunk("x"));
    fake.setNow(1000);
    fake.fireAll();
    onEvent(EXIT_OK);
    stop();
    stop();
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});

test("06-01/T1: repeated started and post-stop events are ignored", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent, stop } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  onEvent(STARTED_MUSE);
  onEvent(STARTED_MUSE);
  assert.deepEqual(fake.scheduled, [{ id: 1, ms: 1000 }]);
  assert.equal(status.calls.length, 1);
  stop();
  const afterStop = status.calls.length;
  onEvent(STARTED_MUSE);
  onEvent(chunk("late"));
  assert.equal(status.calls.length, afterStop, "post-stop events render nothing");
  assert.deepEqual(fake.scheduled, [{ id: 1, ms: 1000 }]);
});

test("06-01/T1: chunks before started feed no tick; hostile events never throw", () => {
  const fake = makeFakeClock();
  const status = makeSetStatus();
  const { onEvent } = attachRunStatus({
    setStatus: status.fn,
    key: "k",
    harness: "muse",
    ansi: false,
    clock: fake.clock,
  });
  let threw = false;
  try {
    onEvent(chunk("early"));
    onEvent(null as unknown as ProgressEvent);
    onEvent(undefined as unknown as ProgressEvent);
    onEvent({} as ProgressEvent);
    onEvent("started" as unknown as ProgressEvent);
    onEvent({ type: "chunk" } as ProgressEvent);
    onEvent({ type: "nope" } as unknown as ProgressEvent);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.deepEqual(status.calls, []);
  assert.deepEqual(fake.scheduled, []);
  // A minimal started still ticks: the harness comes from the attach args.
  onEvent({ type: "started" } as ProgressEvent);
  assert.equal(status.calls.length, 1);
});

test("06-01/T1: hostile attach args and clock degrade, never throw", () => {
  let threw = false;
  try {
    const a = attachRunStatus(null as unknown as Parameters<typeof attachRunStatus>[0]);
    a.onEvent(STARTED_MUSE);
    a.stop();
    const b = attachRunStatus({
      setStatus: "nope" as unknown as (key: string, text: string | undefined) => void,
      key: "",
      harness: "" as ProviderId,
      ansi: "yes" as unknown as boolean,
      intervalMs: -1,
      clock: { now: () => Number.NaN, every: () => ({}) },
    });
    b.onEvent(STARTED_MUSE);
    b.stop();
    const c = attachRunStatus({
      setStatus: () => {},
      key: "k",
      harness: "muse",
      ansi: false,
      intervalMs: 250,
      clock: {
        now: () => {
          throw new Error("clock boom");
        },
        every: () => {
          throw new Error("scheduler boom");
        },
        clear: () => {
          throw new Error("clear boom");
        },
      },
    });
    c.onEvent(STARTED_MUSE);
    c.stop();
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});
