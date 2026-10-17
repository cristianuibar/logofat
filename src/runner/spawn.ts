// Logofăt: harness process runner (Phase 5, plan 05-01).
//
// NEVER-REJECT boundary module (providers.ts precedent): every run settles
// into exactly one RunOutcome value, never a throw. Orchestration over
// node:child_process plus Linux /proc tracking — no Pi imports or fetch.
// Active-run tracking timers are cleared at settlement. Escalation waits stay
// referenced so process exit cannot skip the promised SIGKILL/drain barrier.
//
// Settle discipline: a shared TERM→KILL/drain barrier owns settlement, except
// pre-spawn errors. Leader exit alone does not release owned descendants.
// A deadline failure is reported explicitly in cleanupWarning. Polling cannot
// discover descendants that fork and reparent entirely between snapshots;
// platforms without Linux /proc report that cleanup could not be confirmed.
// The `exit` ProgressEvent fires exactly once per run, at settle;
// `spawn-error` runs never emit `started` (nothing spawned).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { ProviderId } from "../providers.ts";
import type { EffortLevel } from "../capabilities.ts";

/**
 * Wall-clock bound per run: 10 minutes. A generous backstop, not a budget —
 * remote coding runs legitimately take minutes. Injectable via
 * RunOptions.timeoutMs (tests use milliseconds).
 */
export const RUN_TIMEOUT_MS = 600_000;

/**
 * Grace between SIGTERM and SIGKILL on the abort, timeout, and shutdown
 * paths. Harness children need seconds to flush. Injectable via
 * RunOptions.killGraceMs.
 */
export const KILL_GRACE_MS = 5_000;

/**
 * Post-SIGKILL settle wait. A KILLed process that never closes is in
 * uninterruptible sleep; the extension waits this long, then moves on, so
 * shutdown is never delayed unboundedly. Worst-case shutdown delay is one
 * grace plus this settle (~6s). Module-private: tests pin it only through
 * stub-child timing behavior, never by name.
 */
const KILL_SETTLE_MS = 1_000;

/**
 * Collected-output cap: 1 MiB total across both streams. Bytes past the cap
 * are dropped but COUNTED (stdoutDroppedBytes / stderrDroppedBytes), so the
 * shown/total line stays honest. Injectable via RunOptions.outputCapBytes.
 */
export const OUTPUT_CAP_BYTES = 1_048_576;

/** The five settled run outcomes (D-55). Every run ends as exactly one. */
export type RunOutcome = "ok" | "nonzero" | "timeout" | "aborted" | "spawn-error";

/** Why a tracked child is being killed. Recorded before the first kill. */
export type KillCause = "abort" | "timeout" | "shutdown";

/**
 * Progress events for one run (D-53). Phase 5 subscribes only to collect;
 * no transcript rendering reads events. Kept minimal and frozen-friendly:
 * the Phase 6 renderer consumes this exact union.
 */
export type ProgressEvent =
  | { type: "started"; runId: string; harness: ProviderId; pid: number | null }
  | { type: "chunk"; runId: string; stream: "stdout" | "stderr"; text: string }
  | {
      type: "exit";
      runId: string;
      outcome: RunOutcome;
      exitCode: number | null;
      signal: string | null;
    };

export type OnProgress = (event: ProgressEvent) => void;

export type RunOptions = {
  runId: string;
  harness: ProviderId;
  binary: string;
  argv: string[];
  effort: EffortLevel;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  killGraceMs?: number;
  outputCapBytes?: number;
  onProgress?: OnProgress | undefined;
  spawnImpl?: typeof spawn;
};

export type RunSettled = {
  runId: string;
  harness: ProviderId;
  effort: EffortLevel;
  outcome: RunOutcome;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  startedAt: string;
  settledAt: string;
  /** Present when process-tree cleanup could not be confirmed. */
  cleanupWarning?: string;
};

type RegistryEntry = {
  child: ChildProcess | null;
  cause: KillCause | null;
  pid: number | null;
  dead: boolean;
  closed: boolean;
  tree: Map<number, string>;
  signalled: Set<string>;
  trackingFailed: boolean;
  trackTree: boolean;
  escalation: Promise<void> | null;
  terminate: (cause: KillCause, graceMs?: number) => Promise<void>;
  cleanupWarning?: string;
};

/**
 * Module-level child registry (D-51): the sanctioned exception to the
 * factory-closure-state precedent, because the session_shutdown handler must
 * reach children the closure cannot see. Keyed by run-id; a settled run is
 * unregistered and never a kill target. Concurrent /route invocations each
 * get a run-id; a new route never cancels a prior run.
 */
const running = new Map<string, RegistryEntry>();

let runCounter = 0;

/**
 * Fresh run-id: pid + a module counter + 4 random bytes. The counter
 * guarantees uniqueness per handler invocation even if random repeats; the
 * pid disambiguates tmpdir filenames across Pi restarts. The id is the
 * registry key, the log-filename infix, and the run-tuple correlator.
 */
export function nextRunId(): string {
  return `run-${process.pid.toString(36)}-${(runCounter++).toString(36)}-` + randomBytes(4).toString("hex");
}

/**
 * Child environment: the parent env minus TYPESAFE_API_KEY, deleted
 * unconditionally (even when absent — no branch). The harness has no use
 * for our Jev key, and a child must never inherit it (D-52).
 */
export function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return env;
}

/** Test-only: tracked-child count. `afterEach` asserts it returns to 0. */
export function __runCount(): number {
  return running.size;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Length excluding a valid but incomplete UTF-8 suffix at a capture cut. */
function completePrefixLength(bytes: Buffer): number {
  let start = bytes.length - 1;
  while (start >= 0 && bytes[start]! >= 0x80 && bytes[start]! <= 0xbf && bytes.length - start <= 3) start--;
  if (start < 0) return bytes.length;
  const lead = bytes[start]!;
  const size = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  if (bytes.length - start >= size) return bytes.length;
  const second = bytes[start + 1];
  for (let i = start + 1; i < bytes.length; i++) {
    if (bytes[i]! < 0x80 || bytes[i]! > 0xbf) return bytes.length;
  }
  if (second !== undefined && ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second > 0x9f) || (lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second > 0x8f))) return bytes.length;
  return start;
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Death/close and the deadline, not signal delivery, establish cleanup.
  }
}

// /proc's start-time field survives reparenting and distinguishes PID reuse.
// Node has no pidfd API: rechecking immediately before kill narrows, but cannot
// eliminate, the kernel check/kill race. No shared process group is signalled.
function processIdentity(pid: number): { start: string; state: string; parent: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { start: fields[19]!, state: fields[0]!, parent: Number(fields[1]) };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

function refreshTree(entry: RegistryEntry): void {
  if (!entry.trackTree) return;
  try {
    // Map iteration visits newly discovered entries too, walking the full tree.
    for (const [pid, start] of entry.tree) {
      const current = processIdentity(pid);
      if (current?.start !== start || current.state === "Z" || current.state === "X") {
        entry.tree.delete(pid);
        continue;
      }
      try {
        for (const task of readdirSync(`/proc/${pid}/task`)) {
          const children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
          // Revalidate the owning process after enumeration as well.
          if (processIdentity(pid)?.start !== start) break;
          for (const value of children.split(/\s+/)) {
            if (!value) continue;
            const descendant = Number(value);
            const identity = processIdentity(descendant);
            // A PID from the children list might have exited and been reused
            // since enumeration: only adopt a process still parented here.
            if (identity?.parent === pid && !entry.tree.has(descendant)) entry.tree.set(descendant, identity.start);
          }
        }
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  } catch {
    entry.trackingFailed = true;
  }
}

function signalTree(entry: RegistryEntry, signal: NodeJS.Signals): void {
  refreshTree(entry);
  // Descendants first; retain identities after the leader exits/reparents them.
  for (const [pid, start] of [...entry.tree].reverse()) {
    if (pid === entry.pid) continue;
    const key = `${pid}:${start}:${signal}`;
    if (entry.signalled.has(key)) continue;
    try {
      const current = processIdentity(pid);
      if (current?.start === start && current.state !== "Z" && current.state !== "X") {
        process.kill(pid, signal);
        entry.signalled.add(key);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") entry.trackingFailed = true;
    }
  }
  if (!entry.dead && entry.child && !entry.signalled.has(`leader:${signal}`)) {
    entry.signalled.add(`leader:${signal}`);
    safeKill(entry.child, signal);
  }
}

function drained(entry: RegistryEntry): boolean {
  refreshTree(entry);
  return entry.dead && entry.closed && entry.tree.size === 0;
}

async function waitForDrain(entry: RegistryEntry, ms: number, signal: NodeJS.Signals): Promise<void> {
  const deadline = performance.now() + ms;
  while (!drained(entry) && performance.now() < deadline) {
    // Keep this timer referenced: shutdown must not exit before escalation.
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - performance.now()))));
    signalTree(entry, signal);
  }
}

function escalateEntry(entry: RegistryEntry, graceMs: number): Promise<void> {
  if (entry.escalation) return entry.escalation;
  // Publish the Promise before signalling (a fake child may emit synchronously).
  entry.escalation = Promise.resolve().then(async () => {
    signalTree(entry, "SIGTERM");
    await waitForDrain(entry, graceMs, "SIGTERM");
    if (!drained(entry)) {
      signalTree(entry, "SIGKILL");
      await waitForDrain(entry, KILL_SETTLE_MS, "SIGKILL");
    }
    if (!drained(entry) || entry.trackingFailed) {
      entry.cleanupWarning = "Process-tree cleanup could not be confirmed within the cleanup deadline; subprocesses may remain.";
    }
  }).catch(() => {
    entry.cleanupWarning = "Process-tree cleanup failed; subprocesses may remain.";
  });
  return entry.escalation;
}

/**
 * Kills one tracked run. Safe to call twice and a no-op on unknown ids —
 * never throws.
 */
export async function killRun(runId: string, cause: KillCause): Promise<void> {
  try {
    const entry = running.get(runId);
    if (entry === undefined) return;
    await entry.terminate(cause);
  } catch {
    // Unknown ids and dead children are no-ops, never throws.
  }
}

/**
 * TERMs every tracked child, awaits all exits or one grace, KILLs
 * stragglers, awaits up to the settle cap, then resolves. Bounded, never
 * throws — even on an empty registry or hostile state.
 */
export async function killAllRuns(cause: KillCause, graceMs?: number): Promise<void> {
  try {
    const grace = positiveOr(graceMs, KILL_GRACE_MS);
    await Promise.all([...running.values()].map((entry) => entry.terminate(cause, grace)));
  } catch {
    // Bounded, never throws — even on hostile registry state.
  }
}

/**
 * Degenerate settled value for the impossible: `runHarness` itself threw
 * before the run machinery could settle (hostile options). A run that never
 * settled is honestly a run that never started. Never throws.
 */
function spawnErrorFallback(opts: RunOptions, startedAt: string): RunSettled {
  let runId = "run-unknown";
  let harness = "" as ProviderId;
  let effort: EffortLevel = "low";
  let onProgress: OnProgress | undefined;
  try {
    if (opts !== null && typeof opts === "object") {
      if (typeof opts.runId === "string") runId = opts.runId;
      if (typeof opts.harness === "string") harness = opts.harness as ProviderId;
      if (opts.effort === "low" || opts.effort === "standard" || opts.effort === "high") {
        effort = opts.effort;
      }
      if (typeof opts.onProgress === "function") onProgress = opts.onProgress;
    }
  } catch {
    // Hostile getters: keep the degenerate fields.
  }
  if (onProgress !== undefined) {
    try {
      onProgress({ type: "exit", runId, outcome: "spawn-error", exitCode: null, signal: null });
    } catch {
      // A hostile progress callback never breaks even the fallback.
    }
  }
  return {
    runId,
    harness,
    effort,
    outcome: "spawn-error",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    startedAt,
    settledAt: new Date(Date.now()).toISOString(),
  };
}

/**
 * Runs one harness binary to settlement. NEVER rejects: every run settles
 * into exactly one outcome (D-55). `timedOut` is true only for `timeout`.
 */
export function runHarness(opts: RunOptions): Promise<RunSettled> {
  return new Promise<RunSettled>((resolve) => {
    const startedAt = new Date(Date.now()).toISOString();
    try {
      startRun(opts, startedAt, resolve);
    } catch {
      resolve(spawnErrorFallback(opts, startedAt));
    }
  });
}

function startRun(opts: RunOptions, startedAt: string, resolve: (settled: RunSettled) => void): void {
  const { runId, harness, effort } = opts;
  const timeoutMs = positiveOr(opts.timeoutMs, RUN_TIMEOUT_MS);
  const killGraceMs = positiveOr(opts.killGraceMs, KILL_GRACE_MS);
  const outputCapBytes = positiveOr(opts.outputCapBytes, OUTPUT_CAP_BYTES);
  const onProgress = opts.onProgress;

  const entry: RegistryEntry = {
    child: null,
    cause: null,
    pid: null,
    dead: false,
    closed: false,
    tree: new Map(),
    signalled: new Set(),
    trackingFailed: process.platform !== "linux" && opts.spawnImpl === undefined,
    trackTree: process.platform === "linux" && opts.spawnImpl === undefined,
    escalation: null,
    terminate: async () => {},
  };
  running.set(runId, entry);

  let stdout = "";
  let stderr = "";
  let collectedBytes = 0;
  let stdoutDroppedBytes = 0;
  let stderrDroppedBytes = 0;
  let spawned = false;
  let settled = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let treeTimer: ReturnType<typeof setInterval> | null = null;
  const streams = {
    stdout: { decoder: new StringDecoder("utf8"), ended: false, bytes: 0, kept: [] as Buffer[] },
    stderr: { decoder: new StringDecoder("utf8"), ended: false, bytes: 0, kept: [] as Buffer[] },
  };

  const notify = (event: ProgressEvent): void => {
    if (onProgress === undefined) return;
    try {
      onProgress(event);
    } catch {
      // A hostile progress callback never breaks the run.
    }
  };

  const cleanup = (): void => {
    running.delete(runId);
    if (treeTimer !== null) clearInterval(treeTimer);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const signal = opts.signal;
    if (onAbort !== null && signal !== undefined && signal !== null) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // Listener removal is best-effort.
      }
      onAbort = null;
    }
  };

  const settle = (outcome: RunOutcome, timedOut: boolean): void => {
    if (settled) return;
    for (const stream of ["stdout", "stderr"] as const) {
      endStream(stream);
      const state = streams[stream];
      let bytes = Buffer.concat(state.kept);
      // If capture ended mid-character, omit the incomplete suffix instead of
      // manufacturing replacement bytes. At real EOF, decode/flush it normally.
      if (state.bytes > bytes.length) bytes = bytes.subarray(0, completePrefixLength(bytes));
      const text = bytes.toString("utf8");
      if (stream === "stdout") {
        stdout = text;
        stdoutDroppedBytes = state.bytes - bytes.length;
      } else {
        stderr = text;
        stderrDroppedBytes = state.bytes - bytes.length;
      }
    }
    settled = true;
    cleanup();
    notify({ type: "exit", runId, outcome, exitCode, signal: exitSignal });
    resolve({
      runId,
      harness,
      effort,
      outcome,
      exitCode,
      signal: exitSignal,
      timedOut,
      stdout,
      stderr,
      stdoutDroppedBytes,
      stderrDroppedBytes,
      startedAt,
      settledAt: new Date(Date.now()).toISOString(),
      ...(entry.cleanupWarning ? { cleanupWarning: entry.cleanupWarning } : {}),
    });
  };

  const endStream = (stream: "stdout" | "stderr"): void => {
    const state = streams[stream];
    if (state.ended) return;
    state.ended = true;
    const text = state.decoder.end();
    if (text) notify({ type: "chunk", runId, stream, text });
  };

  const appendChunk = (stream: "stdout" | "stderr", chunk: unknown): void => {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.alloc(0);
    const state = streams[stream];
    state.bytes += bytes.length;
    const keep = Math.min(bytes.length, Math.max(0, outputCapBytes - collectedBytes));
    if (keep > 0) state.kept.push(Buffer.from(bytes.subarray(0, keep)));
    collectedBytes += keep;
    const text = state.decoder.write(bytes);
    refreshTree(entry);
    if (text) notify({ type: "chunk", runId, stream, text });
  };

  const finish = (): void => {
    if (!entry.closed && entry.cleanupWarning) {
      entry.child?.stdout?.destroy?.();
      entry.child?.stderr?.destroy?.();
    }
    if (entry.cause === "timeout") settle("timeout", true);
    else if (entry.cause !== null) settle("aborted", false);
    else settle(exitCode === 0 ? "ok" : "nonzero", false);
  };

  const killWithCause = async (cause: KillCause, graceMs = killGraceMs): Promise<void> => {
    if (settled) return;
    if (entry.cause === null) entry.cause = cause;
    await escalateEntry(entry, graceMs);
    // Every trigger, including registry APIs, waits for the same barrier.
    finish();
  };
  entry.terminate = killWithCause;

  const spawnFn = opts.spawnImpl ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(opts.binary, opts.argv, {
      cwd: process.cwd(),
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(),
    });
  } catch {
    // A synchronous spawn throw means the run never started.
    settle("spawn-error", false);
    return;
  }
  entry.child = child;
  entry.pid = typeof child.pid === "number" ? child.pid : null;
  if (entry.trackTree && entry.pid !== null) {
    try {
      const identity = processIdentity(entry.pid);
      if (identity) entry.tree.set(entry.pid, identity.start);
    } catch {
      entry.trackingFailed = true;
    }
    treeTimer = setInterval(() => refreshTree(entry), 20);
    treeTimer.unref();
  }

  if (child.stdout !== null) {
    child.stdout.on("data", (chunk: unknown) => {
      try {
        appendChunk("stdout", chunk);
      } catch {
        // Collection faults never break the run.
      }
    });
    // An unhandled stream `error` would throw out of the emitter and escape
    // the settle machinery — stream faults are swallowed, the run settles
    // on `close` regardless.
    child.stdout.on("error", () => {});
    child.stdout.on("end", () => endStream("stdout"));
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk: unknown) => {
      try {
        appendChunk("stderr", chunk);
      } catch {
        // Collection faults never break the run.
      }
    });
    child.stderr.on("error", () => {});
    child.stderr.on("end", () => endStream("stderr"));
  }
  child.on("spawn", () => {
    spawned = true;
    entry.pid = typeof child.pid === "number" ? child.pid : null;
    notify({ type: "started", runId, harness, pid: child.pid ?? null });
  });
  child.on("error", () => {
    // Pre-spawn transport failure (e.g. ENOENT): the run never started, so
    // settle `spawn-error` immediately — the `close` Node emits after a
    // failed spawn then no-ops via the guard. A post-spawn `error` is a
    // rare mid-run transport fault: ignored, the run's real output stands
    // and `close` settles normally.
    if (!spawned) settle("spawn-error", false);
  });
  child.on("exit", (code, signal) => {
    refreshTree(entry);
    entry.dead = true;
    exitCode = code;
    exitSignal = signal;
    // Normal leader exit must also drain surviving owned tools and held pipes.
    // A close event may follow synchronously, so publish escalation first.
    if (!settled && entry.escalation === null) {
      void escalateEntry(entry, killGraceMs).then(finish);
    }
  });
  child.on("close", (code, signal) => {
    entry.dead = true;
    entry.closed = true;
    // `exit`-first values are preserved: close's values win when present,
    // stored exit values stand when close carries none.
    if (typeof code === "number") exitCode = code;
    if (typeof signal === "string") exitSignal = signal;
    if (settled) return;
    if (entry.escalation) void entry.escalation.then(finish);
    else void escalateEntry(entry, killGraceMs).then(finish);
  });

  timer = setTimeout(() => {
    timer = null;
    void killWithCause("timeout");
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const signal = opts.signal;
  if (signal !== undefined && signal !== null) {
    try {
      if (signal.aborted) {
        // Fired before the child spawned: still kills it.
        void killWithCause("abort");
      } else {
        onAbort = () => {
          void killWithCause("abort");
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    } catch {
      // A hostile signal object fails closed: abort the run, leak nothing.
      void killWithCause("abort");
    }
  }
}
