// Tests for src/runner/spawn.ts (Phase 5: Remote Execution + Result Handoff).
//
// Plan 05-01: the spawn runner. Stubs are `node -e` one-liners via
// process.execPath — never real harnesses, never shell. The ONLY faked
// spawn is the post-spawn-`error` arm (a mid-run child `error` has no
// deterministic outside trigger); every other test uses the real function.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { spawn } from "node:child_process";
import {
  OUTPUT_CAP_BYTES,
  RUN_TIMEOUT_MS,
  __runCount,
  buildChildEnv,
  killAllRuns,
  killRun,
  nextRunId,
  runHarness,
} from "../src/runner/spawn.ts";
import type { ProgressEvent, RunOptions, RunSettled } from "../src/runner/spawn.ts";

afterEach(async () => {
  await killAllRuns("shutdown", 50);
  assert.equal(__runCount(), 0);
});

const NODE = process.execPath;

function runOpts(overrides: Partial<RunOptions> & { binary: string; argv: string[] }): RunOptions {
  return {
    runId: nextRunId(),
    harness: "muse",
    effort: "standard",
    timeoutMs: 5_000,
    killGraceMs: 200,
    ...overrides,
  };
}

function nodeEval(js: string): { binary: string; argv: string[] } {
  return { binary: NODE, argv: ["-e", js] };
}

test("05-01/T1: RUN_TIMEOUT_MS is the locked 600_000 (pins the §2 '10 minutes' copy)", () => {
  // No value import into messages.ts: this assertion is the link between the
  // runner constant and the timeout block's "10 minutes" literal.
  assert.equal(RUN_TIMEOUT_MS, 600_000);
});

test("05-01/T1: exit-0 stub settles ok with the full RunSettled shape", async () => {
  const events: ProgressEvent[] = [];
  const settled = await runHarness(
    runOpts({
      ...nodeEval("process.stdout.write('OUT-1\\nOUT-2\\n');process.stderr.write('ERR-1\\n');"),
      onProgress: (event) => {
        events.push(event);
      },
    }),
  );
  assert.equal(settled.outcome, "ok");
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.signal, null);
  assert.equal(settled.timedOut, false);
  assert.equal(settled.stdout, "OUT-1\nOUT-2\n");
  assert.equal(settled.stderr, "ERR-1\n");
  assert.equal(settled.stdoutDroppedBytes, 0);
  assert.equal(settled.stderrDroppedBytes, 0);
  assert.equal(settled.harness, "muse");
  assert.equal(settled.effort, "standard");
  assert.ok(settled.runId.startsWith("run-"));
  assert.ok(Number.isFinite(Date.parse(settled.startedAt)));
  assert.ok(Number.isFinite(Date.parse(settled.settledAt)));
  assert.ok(Date.parse(settled.startedAt) <= Date.parse(settled.settledAt));
  assert.equal(
    events.filter((event) => event.type === "exit").length,
    1,
  );
});

test("05-01/T1: stub exiting 3 settles nonzero with the code", async () => {
  const settled = await runHarness(runOpts({ ...nodeEval("process.exit(3);") }));
  assert.equal(settled.outcome, "nonzero");
  assert.equal(settled.exitCode, 3);
  assert.equal(settled.signal, null);
  assert.equal(settled.timedOut, false);
});

test("05-01/T1: outsider-signal death settles nonzero with exitCode null + the signal name", async () => {
  const settled = await runHarness(
    runOpts({ ...nodeEval("process.kill(process.pid, 'SIGTERM');") }),
  );
  assert.equal(settled.outcome, "nonzero");
  assert.equal(settled.exitCode, null);
  assert.equal(settled.signal, "SIGTERM");
  assert.equal(settled.timedOut, false);
});

test("05-01/T1: nonexistent binary settles spawn-error with exactly one exit event", async () => {
  const events: ProgressEvent[] = [];
  const settled = await runHarness(
    runOpts({
      binary: "/nonexistent/logofat-probe-binary-07f3",
      argv: [],
      onProgress: (event) => {
        events.push(event);
      },
    }),
  );
  assert.equal(settled.outcome, "spawn-error");
  assert.equal(settled.exitCode, null);
  assert.equal(settled.signal, null);
  assert.equal(settled.timedOut, false);
  assert.equal(settled.stdout, "");
  assert.equal(settled.stderr, "");
  // No `started` (nothing spawned); exactly one `exit` (the trailing `close`
  // Node emits after a failed spawn no-ops via the settle-once guard).
  assert.equal(
    events.filter((event) => event.type === "started").length,
    0,
  );
  const exits = events.filter((event) => event.type === "exit");
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.outcome, "spawn-error");
});

test("05-01/T1: post-spawn child error is ignored — output stands, close settles", async () => {
  // The ONLY faked spawn in this file: a mid-run child `error` has no
  // deterministic outside trigger, so ONLY this test injects spawnImpl.
  const events: ProgressEvent[] = [];
  const fakeChild = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.kill = () => true;
  const fakeSpawn = (() => {
    // Async emission mirrors reality: the real spawn never emits synchronously.
    queueMicrotask(() => {
      fakeChild.emit("spawn");
      fakeChild.stdout.emit("data", Buffer.from("C1-MARKER"));
      fakeChild.emit("error", new Error("C1-PROBE"));
      fakeChild.emit("exit", 0, null);
      fakeChild.emit("close", 0, null);
    });
    return fakeChild;
  }) as unknown as typeof spawn;
  const settled = await runHarness(
    runOpts({
      binary: "fake",
      argv: [],
      spawnImpl: fakeSpawn,
      onProgress: (event) => {
        events.push(event);
      },
    }),
  );
  assert.equal(settled.outcome, "ok");
  assert.equal(settled.exitCode, 0);
  assert.equal(settled.stdout, "C1-MARKER");
  assert.equal(events[0]?.type, "started");
  assert.equal(
    events.filter((event) => event.type === "exit").length,
    1,
  );
});

test("05-01/T1: events order started → chunk* → exit, exit carrying the settled outcome", async () => {
  const events: ProgressEvent[] = [];
  const settled = await runHarness(
    runOpts({
      ...nodeEval("process.stdout.write('C\\n');process.stderr.write('D\\n');"),
      onProgress: (event) => {
        events.push(event);
      },
    }),
  );
  assert.ok(events.length >= 3);
  assert.equal(events[0]?.type, "started");
  assert.equal(events[events.length - 1]?.type, "exit");
  const middle = events.slice(1, -1);
  assert.ok(middle.length >= 1);
  for (const event of middle) assert.equal(event.type, "chunk");
  for (const event of events) assert.equal(event.runId, settled.runId);
  const started = events[0];
  assert.ok(started?.type === "started" && typeof started.pid === "number");
  const exit = events[events.length - 1];
  assert.ok(
    exit?.type === "exit" &&
      exit.outcome === settled.outcome &&
      exit.exitCode === settled.exitCode &&
      exit.signal === settled.signal,
  );
});

test("05-01/T1: hostile onProgress (throws) still settles ok", async () => {
  const settled = await runHarness(
    runOpts({
      ...nodeEval("process.stdout.write('HI');"),
      onProgress: () => {
        throw new Error("HOSTILE-CALLBACK");
      },
    }),
  );
  assert.equal(settled.outcome, "ok");
  assert.equal(settled.stdout, "HI");
});

test("05-01/T1: bytes past the capture cap are dropped but counted; chunks stay uncapped", async () => {
  const events: ProgressEvent[] = [];
  const settled = await runHarness(
    runOpts({
      ...nodeEval("process.stdout.write('A'.repeat(100));"),
      outputCapBytes: 10,
      onProgress: (event) => {
        events.push(event);
      },
    }),
  );
  assert.equal(settled.outcome, "ok");
  assert.equal(settled.stdout, "A".repeat(10));
  assert.equal(settled.stdoutDroppedBytes, 90);
  assert.equal(settled.stderrDroppedBytes, 0);
  // Chunk events carry text as received, uncapped — subscribers decide.
  const chunkBytes = events
    .filter((event) => event.type === "chunk")
    .map((event) => (event.type === "chunk" ? Buffer.byteLength(event.text) : 0))
    .reduce((a, b) => a + b, 0);
  assert.equal(chunkBytes, 100);
  assert.ok(OUTPUT_CAP_BYTES > 0);
});

test("05-01/T1: cap cut never splits a surrogate pair (deterministic fake chunking)", async () => {
  const fakeChild = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (signal: NodeJS.Signals) => boolean;
  };
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.pid = 4243;
  fakeChild.kill = () => true;
  const fakeSpawn = (() => {
    queueMicrotask(() => {
      fakeChild.emit("spawn");
      // "😀" is 4 UTF-8 bytes / one surrogate pair: a 3-byte cap cannot keep
      // a half-emoji, so the whole char is dropped and counted.
      fakeChild.stdout.emit("data", Buffer.from("😀", "utf8"));
      fakeChild.emit("exit", 0, null);
      fakeChild.emit("close", 0, null);
    });
    return fakeChild;
  }) as unknown as typeof spawn;
  const settled = await runHarness(
    runOpts({ binary: "fake", argv: [], spawnImpl: fakeSpawn, outputCapBytes: 3 }),
  );
  assert.equal(settled.outcome, "ok");
  assert.equal(settled.stdout, "");
  assert.equal(settled.stdoutDroppedBytes, 4);
});

test("05-01/T2: sleeper past an injected 50 ms timeout settles timeout + timedOut", async () => {
  const settled = await runHarness(
    runOpts({
      ...nodeEval("setTimeout(()=>{},5000);"),
      timeoutMs: 50,
      killGraceMs: 50,
    }),
  );
  assert.equal(settled.outcome, "timeout");
  assert.equal(settled.timedOut, true);
});

test("05-01/T2: abort mid-run settles aborted with partial output captured", async () => {
  // Chunk-triggered (not a fixed sleep): the abort provably lands after boot,
  // so the partial-output assertion is deterministic.
  const controller = new AbortController();
  const settled = await runHarness(
    runOpts({
      ...nodeEval("process.stdout.write('READY');setTimeout(()=>{},5000);"),
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 50,
      onProgress: (event) => {
        if (event.type === "chunk") controller.abort();
      },
    }),
  );
  assert.equal(settled.outcome, "aborted");
  assert.equal(settled.timedOut, false);
  assert.equal(settled.stdout, "READY");
});

test("05-01/T2: pre-aborted signal settles aborted without the stub producing output", async () => {
  const controller = new AbortController();
  controller.abort();
  const settled = await runHarness(
    runOpts({
      ...nodeEval("setTimeout(()=>process.stdout.write('LATE'),200);setTimeout(()=>{},1000);"),
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 50,
    }),
  );
  assert.equal(settled.outcome, "aborted");
  assert.equal(settled.stdout, "");
});

test("05-01/T2: killRun is twice-safe and unknown-id-safe; the run settles aborted", async () => {
  const runId = nextRunId();
  const runPromise = runHarness(
    runOpts({
      runId,
      ...nodeEval("setTimeout(()=>{},5000);"),
      timeoutMs: 5_000,
      killGraceMs: 50,
    }),
  );
  // Registration is synchronous (the Promise executor runs inline), so the
  // entry exists before runHarness returns — no polling needed.
  assert.equal(__runCount(), 1);
  killRun(runId, "abort");
  killRun(runId, "abort");
  killRun("run-no-such-run", "abort");
  const settled = await runPromise;
  assert.equal(settled.outcome, "aborted");
  assert.equal(__runCount(), 0);
});

test("05-01/T2: SIGTERM-ignoring stub is SIGKILLed after the grace, timeout kept", async () => {
  const settled = await runHarness(
    runOpts({
      ...nodeEval("process.on('SIGTERM',()=>{});setTimeout(()=>{},5000);"),
      timeoutMs: 500,
      killGraceMs: 50,
    }),
  );
  assert.equal(settled.outcome, "timeout");
  assert.equal(settled.timedOut, true);
  assert.equal(settled.exitCode, null);
  assert.equal(settled.signal, "SIGKILL");
});

test("05-01/T2: abort on a SIGTERM-ignoring stub escalates to SIGKILL, settles aborted", async () => {
  const controller = new AbortController();
  const settled = await runHarness(
    runOpts({
      ...nodeEval(
        "process.on('SIGTERM',()=>{});process.stdout.write('READY');setTimeout(()=>{},5000);",
      ),
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 50,
      onProgress: (event) => {
        if (event.type === "chunk") controller.abort();
      },
    }),
  );
  assert.equal(settled.outcome, "aborted");
  assert.equal(settled.signal, "SIGKILL");
});

test("05-01/T2: killAllRuns kills two concurrent sleepers; both dead (ESRCH)", async () => {
  const pids: number[] = [];
  const sleeper = (): Promise<RunSettled> =>
    runHarness(
      runOpts({
        ...nodeEval("setTimeout(()=>{},5000);"),
        timeoutMs: 10_000,
        killGraceMs: 50,
        onProgress: (event) => {
          if (event.type === "started" && typeof event.pid === "number") pids.push(event.pid);
        },
      }),
    );
  const a = sleeper();
  const b = sleeper();
  assert.equal(__runCount(), 2);
  await killAllRuns("shutdown", 50);
  const [settledA, settledB] = await Promise.all([a, b]);
  assert.equal(settledA.outcome, "aborted");
  assert.equal(settledB.outcome, "aborted");
  assert.equal(__runCount(), 0);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("05-01/T2: TYPESAFE_API_KEY never reaches the child env (canary)", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "CANARY-05-01-T2";
  try {
    const settled = await runHarness(
      runOpts({
        ...nodeEval("process.stdout.write(process.env.TYPESAFE_API_KEY ?? 'ABSENT');"),
      }),
    );
    assert.equal(settled.stdout, "ABSENT");
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("05-01/T2: buildChildEnv scrubs the key and keeps the rest", () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "CANARY-BUILDENV";
  try {
    const env = buildChildEnv();
    assert.ok(!("TYPESAFE_API_KEY" in env));
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

function liveIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? null : fields[19]!;
  } catch { return null; }
}

// Readiness comes from the grandchild after installing its TERM handler. Its
// pipes are inherited from the leader, so killing just the leader cannot close
// them. Fixture cleanup checks identity before signalling, even on assertions.
function treeFixture(): string {
  const grandchild = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);";
  return `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{
      detached:false,shell:false,stdio:['ignore','inherit','inherit','ipc']
    });
    child.on('message',()=>process.stdout.write('READY '+child.pid+'\\n'));
    process.on('SIGTERM',()=>process.exit(0));
  `;
}

for (const trigger of ["abort", "timeout", "shutdown"] as const) {
  test(`CR-03: ${trigger} drains TERM-resistant descendant after leader exits`, { skip: process.platform !== "linux" }, async () => {
    const controller = new AbortController();
    const identities = new Map<number, string>();
    let grandchild = 0;
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    let seen = "";
    let completed = false;
    const result = runHarness(runOpts({
      ...nodeEval(treeFixture()),
      timeoutMs: trigger === "timeout" ? 1_200 : 5_000,
      killGraceMs: 150,
      signal: controller.signal,
      onProgress(event) {
        if (event.type === "started" && event.pid) {
          const identity = liveIdentity(event.pid);
          if (identity) identities.set(event.pid, identity);
        }
        if (event.type === "chunk" && event.stream === "stdout") {
          seen += event.text;
          const match = /READY (\d+)\n/.exec(seen);
          if (match && !grandchild) {
            grandchild = Number(match[1]);
            const identity = liveIdentity(grandchild);
            if (identity) identities.set(grandchild, identity);
            readyResolve();
          }
        }
      },
    })).then((value) => { completed = true; return value; });
    try {
      await Promise.race([ready, result.then(() => assert.fail("exited before readiness"))]);
      assert.ok(liveIdentity(grandchild));
      let shutdown: Promise<void> | undefined;
      if (trigger === "abort") controller.abort();
      if (trigger === "shutdown") shutdown = killAllRuns("shutdown", 150);
      if (trigger !== "timeout") {
        await delay(40);
        assert.equal(completed, false);
        assert.equal(__runCount(), 1);
        assert.ok(liveIdentity(grandchild));
      }
      const settled = await result;
      await shutdown;
      assert.equal(settled.outcome, trigger === "timeout" ? "timeout" : "aborted");
      assert.equal(settled.cleanupWarning, undefined);
      assert.equal(liveIdentity(grandchild), null);
      assert.equal(__runCount(), 0);
    } finally {
      controller.abort();
      for (const [pid, identity] of identities) {
        if (liveIdentity(pid) === identity) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
      await result;
    }
  });
}

for (const first of ["timeout", "killRun"] as const) {
  test(`CR-04: ${first} then abort and shutdown share the death barrier`, async () => {
    const controller = new AbortController();
    const runId = nextRunId();
    let pid = 0;
    let readyResolve!: () => void;
    let termResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const term = new Promise<void>((resolve) => { termResolve = resolve; });
    let completed = false;
    let exits = 0;
    const result = runHarness(runOpts({
      runId,
      ...nodeEval("process.on('SIGTERM',()=>process.stdout.write('TERM\\n'));process.stdout.write('READY\\n');setInterval(()=>{},1000);"),
      timeoutMs: first === "timeout" ? 1_000 : 5_000,
      killGraceMs: 200,
      signal: controller.signal,
      onProgress(event) {
        if (event.type === "started" && event.pid) pid = event.pid;
        if (event.type === "exit") exits++;
        if (event.type === "chunk" && event.text.includes("READY")) readyResolve();
        if (event.type === "chunk" && event.text.includes("TERM")) termResolve();
      },
    })).then((value) => { completed = true; return value; });
    try {
      await Promise.race([ready, result.then(() => assert.fail("exited before readiness"))]);
      const firstKill = first === "killRun" ? killRun(runId, "abort") : undefined;
      await Promise.race([term, result.then(() => assert.fail("exited before TERM"))]);
      controller.abort();
      let shutdownDone = false;
      const shutdown = killAllRuns("shutdown", 5).then(() => { shutdownDone = true; });
      await delay(50);
      assert.equal(completed, false);
      assert.equal(shutdownDone, false);
      assert.equal(__runCount(), 1);
      process.kill(pid, 0);
      const settled = await result;
      await Promise.all([shutdown, firstKill]);
      assert.equal(settled.outcome, first === "timeout" ? "timeout" : "aborted");
      assert.equal(settled.signal, "SIGKILL");
      assert.equal(exits, 1);
      assert.equal(__runCount(), 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      controller.abort();
      await killRun(runId, "abort");
      await result;
    }
  });
}

function chunksSpawn(chunks: Array<["stdout" | "stderr", Buffer]>): typeof spawn {
  return (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4243, kill: () => true,
    });
    queueMicrotask(() => {
      child.emit("spawn");
      for (const [stream, chunk] of chunks) child[stream].emit("data", chunk);
      child.stdout.emit("end");
      child.stderr.emit("end");
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof spawn;
}

test("CR-06: real child split UTF-8 decodes independently on both pipes", async () => {
  const events: ProgressEvent[] = [];
  const settled = await runHarness(runOpts({
    ...nodeEval(`
      const bytes=Buffer.from('é€😀');
      (async()=>{ for(const byte of bytes) {
        process.stdout.write(Buffer.from([byte]));
        process.stderr.write(Buffer.from([byte]));
        await new Promise(resolve=>setTimeout(resolve,15));
      } })();
    `),
    onProgress: (event) => { events.push(event); },
  }));
  for (const stream of ["stdout", "stderr"] as const) {
    assert.equal(settled[stream], "é€😀");
    assert.equal(events.filter((e) => e.type === "chunk" && e.stream === stream).map((e) => e.type === "chunk" ? e.text : "").join(""), "é€😀");
  }
  assert.equal(settled.stdoutDroppedBytes + settled.stderrDroppedBytes, 0);
});

for (const stream of ["stdout", "stderr"] as const) {
  for (const char of ["é", "€", "😀"]) {
    test(`CR-06: split ${char} at ${stream} capture boundary counts raw bytes`, async () => {
      const bytes = Buffer.from("A" + char + "Z");
      const chunks = [...bytes].map((byte) => [stream, Buffer.from([byte])] as [typeof stream, Buffer]);
      const result = await runHarness(runOpts({ binary: "fake", argv: [], spawnImpl: chunksSpawn(chunks), outputCapBytes: Buffer.byteLength(char) }));
      assert.equal(result[stream], "A");
      assert.equal(result[`${stream}DroppedBytes`], bytes.length - 1);
    });
  }
}

test("CR-06: stream end flushes pending suffix once; dropped counts use input bytes", async () => {
  const events: ProgressEvent[] = [];
  const result = await runHarness(runOpts({ binary: "fake", argv: [], outputCapBytes: 3,
    spawnImpl: chunksSpawn([["stdout", Buffer.from([0xf0, 0x9f])], ["stderr", Buffer.from([0xff, 0x41])]]),
    onProgress: (event) => { events.push(event); },
  }));
  assert.equal(result.stdout, "�");
  assert.equal(result.stderr, "�");
  assert.equal(result.stdoutDroppedBytes, 0);
  assert.equal(result.stderrDroppedBytes, 1);
  assert.equal(events.filter((e) => e.type === "chunk" && e.stream === "stdout").map((e) => e.type === "chunk" ? e.text : "").join(""), "�");
});

test("CR-03: unconfirmed cleanup is bounded, warns, and closes owned pipes", async () => {
  const signals: NodeJS.Signals[] = [];
  let destroys = 0;
  const fakeSpawn = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { destroy: () => { destroys++; } }),
      stderr: Object.assign(new EventEmitter(), { destroy: () => { destroys++; } }),
      pid: 4243,
      kill: (signal: NodeJS.Signals) => { signals.push(signal); return false; },
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof spawn;
  const began = Date.now();
  const result = await runHarness(runOpts({ binary: "fake", argv: [], spawnImpl: fakeSpawn, timeoutMs: 10, killGraceMs: 10 }));
  assert.equal(result.outcome, "timeout");
  assert.match(result.cleanupWarning ?? "", /could not be confirmed.*subprocesses may remain/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(destroys, 2);
  assert.ok(Date.now() - began < 3_000);
  assert.equal(__runCount(), 0);
});
