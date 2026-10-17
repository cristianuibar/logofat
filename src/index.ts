// Logofăt: Pi extension entry point.
//
// Importing this module has no side effects. The default export is a factory
// that Pi calls with its ExtensionAPI. It registers /route, its cancellation
// shortcut, and shutdown cleanup. No detection, spawning, fetching, or timers
// run at factory time.
//
// Detection is LAZY-ONLY (CONTEXT D-05, amended by plan 01-03). There is no
// startup probe. The first /route with
// a real prompt probes once; concurrent first callers share the in-flight
// promise; the settled result is cached in the factory closure for the rest
// of the session. Empty args and --help never probe.
//
// Output contract (test/output-contract.md):
// - Always call ctx.ui.notify(text, "info") once, with plain text only
//   (toPlainText from src/messages.ts), because notify renders `**` literally.
// - Also call the factory-captured pi.sendMessage with customType
//   CUSTOM_TYPE and the markdown copy, but only when !ctx.hasUI (json/print
//   modes). Under TUI or
//   RPC the custom message would display twice and enter model context.
// - The command context has no sendMessage method, and custom UI components
//   are prohibited. The host discards the handler's return value, so every
//   path must emit.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectProviders, diffProviders, PROVIDER_IDS, REASON_VERSION_FAILED } from "./providers.ts";
import type { Provider, ProviderId } from "./providers.ts";
import { requestDecision, resolveApiKey } from "./jev.ts";
import type { JevDecision, JevResult } from "./jev.ts";
import { evaluateGate, failureTuple, runTuple, successTuple, writeTuple } from "./gating.ts";
import type { LogSink } from "./gating.ts";
import { applyStickiness, nextIncumbent, STICKY_MARGIN } from "./sticky.ts";
import type { EffortLevel } from "./capabilities.ts";
import { buildRunArgv } from "./runner/harnesses/index.ts";
import {
  STDERR_TAIL_LINES,
  STDERR_TAIL_MAX_BYTES,
  TAIL_LINES,
  TAIL_MAX_BYTES,
  tailLines,
  writeRunLog,
} from "./runner/handoff.ts";
import { killAllRuns, nextRunId, runHarness } from "./runner/spawn.ts";
import type { OnProgress, RunOptions, RunSettled } from "./runner/spawn.ts";
import { attachRunStatus } from "./status.ts";
import {
  LOADING_LINE,
  countAvailable,
  formatConfirmDialog,
  formatConfirmDialogTitle,
  formatConfirmHeadless,
  formatDecisionLine,
  formatDetectionResult,
  formatExplainLine,
  formatFirstDetectionNote,
  formatHelp,
  formatJevError,
  formatLowConfidenceStayLine,
  formatMissingKey,
  formatNoHarness,
  formatProviderList,
  formatRefuseBlock,
  formatRefreshDiff,
  formatRefreshHelp,
  formatRefreshUsage,
  formatRunAborted,
  formatRunDeclined,
  formatRunNonzero,
  formatRunOk,
  formatRunStarted,
  formatRunTimeout,
  formatSpawnError,
  formatStayLine,
  formatSwitchLine,
  formatUsage,
  toPlainText,
} from "./messages.ts";

/** customType literal named in test/output-contract.md. */
export const CUSTOM_TYPE = "logofat";

/** Short description shown in Pi's command list. */
export const ROUTE_DESCRIPTION =
  "Logofăt: route a prompt to the best installed harness and run it there";

/** Short description for the refresh command in Pi's command list. */
export const REFRESH_DESCRIPTION = "Logofăt: re-detect installed harnesses and show what changed";

/**
 * Confirm-dialog bound: 5 minutes. Generous for a human reading the dialog
 * (which shows a live countdown), while bounding a non-responsive RPC
 * client. Expiry resolves decline-on-expiry in both modes (Cycle-2 C-3
 * probe), so the route has no unbounded waits at all.
 */
export const CONFIRM_DIALOG_TIMEOUT_MS = 300_000;
export const CANCEL_ROUTE_SHORTCUT = "ctrl+alt+x";

/** Stop waiting on uncancellable detection/key providers when the route ends. */
function duringRoute<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Route cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Injectable seams for createRoute. Tests pass fakes here; production uses the real modules. */
export type RouteDeps = {
  detect?: typeof detectProviders;
  resolveKey?: typeof resolveApiKey;
  requestDecision?: typeof requestDecision;
  logSink?: LogSink;
  run?: (opts: RunOptions) => Promise<RunSettled>;
  logDir?: string;
};

/**
 * The result used when detection rejects or returns something unusable:
 * every known harness as an unavailable row with the `--version failed`
 * reason. Detection failures never propagate to the handler.
 */
export function allUnavailable(): Provider[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    binary: id,
    version: null,
    available: false,
    reason: REASON_VERSION_FAILED,
  }));
}

/**
 * Picks the response text for usage-level input, or null when `args` is a
 * real prompt. This is a pure function. Everything after `/route` is one
 * opaque prompt string. It is trimmed only to classify help and blank input,
 * and never split.
 */
export function renderUsage(args: string): string | null {
  const trimmed = args.trim();
  if (trimmed === "") return formatUsage();
  if (trimmed === "--help" || trimmed === "-h") return formatHelp();
  return null;
}

/**
 * Emits one response. `copy` is markdown. notify gets the plain-text form
 * because it renders `**` literally; the custom message keeps the markdown.
 */
function emit(pi: ExtensionAPI, ctx: ExtensionCommandContext, copy: string): void {
  ctx.ui.notify(toPlainText(copy), "info");
  if (!ctx.hasUI) {
    pi.sendMessage({ customType: CUSTOM_TYPE, content: copy, display: true });
  }
}

/**
 * Registers /route on `pi`. Internal seam: the default export calls this
 * with the real detector, and tests call it with fakes.
 *
 * The session cache lives in THIS closure, never at module scope, so two
 * factory calls (separate sessions, /reload, or tests) never share state.
 */
export function createRoute(pi: ExtensionAPI, deps: RouteDeps = {}): void {
  const detect = deps.detect ?? detectProviders;
  const resolveKey = deps.resolveKey ?? resolveApiKey;
  const decide = deps.requestDecision ?? requestDecision;
  const run = deps.run ?? runHarness;
  const logDir = deps.logDir;
  // Lazy default: resolves console.error at call time, surviving runtime
  // patching (and keeping sink-injection tests order-independent).
  const logSink = deps.logSink ?? ((line: string) => console.error(line));
  const activeRoutes = new Set<AbortController>();
  const cancelRoutes = () => {
    for (const controller of activeRoutes) controller.abort();
  };
  // Live footer entries (Phase 6, EXEC-02): one clear-closure per wired run,
  // swept by the idempotent shutdown handler. Owner-clear in the settle
  // `finally` runs first on the settle path; both are try/caught at the call
  // site and twice-safe, so overlap is harmless.
  const liveStatusKeys = new Set<() => void>();
  // Pi dispatches extension shortcuts independently of command promises,
  // including while the model is idle and ctx.signal is undefined.
  pi.registerShortcut(CANCEL_ROUTE_SHORTCUT, {
    description: "Cancel Logofăt routes (including pending routing)",
    handler: cancelRoutes,
  });
  const state: {
    cached: Provider[] | null;
    inflight: Promise<Provider[]> | null;
    shuttingDown: boolean;
    incumbent: ProviderId | null;
  } = {
    cached: null,
    inflight: null,
    shuttingDown: false,
    incumbent: null,
  };

  // Shutdown drain (D-51): one idempotent session_shutdown subscription per
  // session, draining the module-level child registry with an awaited
  // TERM→KILL escalation, so quit/reload/replace kill running routes
  // before teardown completes (Pi awaits this handler). The flag trips
  // first so a confirm dialog resolving inside the teardown window spawns
  // no unwatched child (Cycle-2 C-2). The returned unsub is intentionally
  // unused — extension lifetime = session.
  pi.on("session_shutdown", () => {
    state.shuttingDown = true;
    cancelRoutes();
    for (const clear of liveStatusKeys) {
      liveStatusKeys.delete(clear);
      try {
        clear();
      } catch {
        // Clearing a dead footer entry is silent by contract.
      }
    }
    return killAllRuns("shutdown");
  });

  // Lazy session cache: the first real prompt probes once; concurrent
  // first callers share the in-flight promise. `refreshProviders()` (below)
  // wraps this to re-probe mid-session without touching its logic.
  function getProviders(): Promise<Provider[]> {
    if (state.cached !== null) return Promise.resolve(state.cached);
    if (state.inflight === null) {
      state.inflight = Promise.resolve()
        .then(() => detect())
        .then(
          (result) => (Array.isArray(result) ? result : allUnavailable()),
          () => allUnavailable(),
        )
        .then((result) => {
          state.cached = result;
          state.inflight = null;
          return result;
        });
    }
    return state.inflight;
  }

  /** One refresh wave: the pre-refresh baseline plus the fresh probe (null when none ran). */
  type RefreshResult = { baseline: Provider[] | null; fresh: Provider[] | null };

  // Shared refresh wave (Phase 6, ROUTE-03): concurrent refreshers share one
  // worker promise, published synchronously before the first await, so one
  // wave runs exactly one fresh probe with identical baseline+result for all
  // waiters. Cleared on settle; later refreshes start a new wave.
  let refreshInflight: Promise<RefreshResult> | null = null;

  /**
   * Re-probe mid-session: await any in-flight detection to settle (routes
   * already awaiting it keep their snapshot via promise identity), capture
   * the baseline, then clear and delegate to the untouched `getProviders()`
   * — so mid-refresh routes share the fresh probe. No fresh probe starts
   * during teardown. Never rejects (`getProviders()` is total).
   * D-85/E-1: never write the incumbent; unavailable means ignored, retained.
   */
  function refreshProviders(): Promise<RefreshResult> {
    if (refreshInflight !== null) return refreshInflight;
    refreshInflight = (async () => {
      try {
        if (state.inflight !== null) {
          try {
            await state.inflight;
          } catch {
            // getProviders() never rejects; armor only.
          }
        }
        const baseline = state.cached;
        if (state.shuttingDown) return { baseline, fresh: null };
        state.cached = null;
        state.inflight = null;
        return { baseline, fresh: await getProviders() };
      } finally {
        refreshInflight = null;
      }
    })();
    return refreshInflight;
  }

  /**
   * Synthesized `spawn-error` settled value for the paths that never
   * spawned (unresolvable binary, rejected argv, rejecting `run` fake). A
   * run that never settled is honestly a run that never started.
   */
  function synthSpawnError(runId: string, harness: ProviderId, effort: EffortLevel): RunSettled {
    const now = new Date(Date.now()).toISOString();
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
      startedAt: now,
      settledAt: now,
    };
  }

  /**
   * The run path: resolve binary + argv, spawn with a started-notify,
   * report (tails + log pointer), and sink exactly one run tuple. Every
   * settled run — including `spawn-error` and the hostile-reject
   * synthesis — emits its tuple; only the handshake no-spawn paths
   * (which never enter here) emit none.
   */
  async function runAndReport(
    args: string,
    ctx: ExtensionCommandContext,
    list: string,
    decision: JevDecision,
    confidence: number,
    availableProviders: Provider[],
    signal: AbortSignal,
    stickyLine: string | null,
  ): Promise<void> {
    if (state.shuttingDown || signal.aborted) return;
    const harness = decision.harness;
    const effort = decision.effort;
    let settled: RunSettled;
    let runLatencyMs = 0;
    // Set-before-await, mirroring the Jev `invoked` pattern: exactly one
    // run tuple is sunk per run-path entry, and the handshake no-spawn
    // paths (which never enter here) sink none.
    let runInvoked = false;
    const record = availableProviders.find((p) => p.id === harness);
    // `undefined` is impossible post-validation, but a hostile `run` fake
    // cannot affect this lookup — and `undefined` maps to `spawn-error`
    // without spawning, never a throw.
    const argv = record === undefined ? null : buildRunArgv(harness, effort, args);
    if (record === undefined || argv === null) {
      runInvoked = true;
      settled = synthSpawnError(nextRunId(), harness, effort);
    } else {
      // Notify-only pre-emit: replaced by the final emit in TUI/RPC and
      // invisible in --print --mode json (never sendMessage).
      ctx.ui.notify(`${toPlainText(formatRunStarted(harness, effort))}\nCancel: Ctrl+Alt+X`, "info");
      const runId = nextRunId();
      const start = Date.now();
      runInvoked = true;
      // Live footer entry (Phase 6, EXEC-02): wired only when a UI surface
      // exists AND setStatus is present. setStatus exists even headless, so
      // hasUI is part of the gate; headless keeps onProgress undefined
      // (zero new events, byte-stable output). The structural read keeps
      // `strict` clean whether or not the installed pi-coding-agent types
      // declare setStatus.
      const setStatusCandidate: unknown = (ctx.ui as unknown as { setStatus?: unknown }).setStatus;
      let onProgress: OnProgress | undefined = undefined;
      let clearStatus: (() => void) | null = null;
      if (ctx.hasUI === true && typeof setStatusCandidate === "function") {
        try {
          const setStatus = (
            setStatusCandidate as (key: string, text: string | undefined) => void
          ).bind(ctx.ui);
          const status = attachRunStatus({
            setStatus,
            key: `logofat:${runId}`,
            harness,
            ansi: true,
          });
          onProgress = (event) => {
            try {
              status.onEvent(event);
            } catch {
              // Renderer faults (incl. shutdown-race dead-ctx throws) never
              // stall the run; the runner's own callback armor is second layer.
            }
          };
          clearStatus = status.stop;
          liveStatusKeys.add(clearStatus);
        } catch {
          onProgress = undefined;
          clearStatus = null;
        }
      }
      try {
        settled = await run({
          runId,
          harness,
          binary: record.binary,
          argv,
          effort,
          signal,
          onProgress,
        });
      } catch {
        // A rejecting `run` fake is hostile (the real runner never
        // rejects): synthesize `spawn-error`, never throw.
        settled = synthSpawnError(runId, harness, effort);
      } finally {
        if (clearStatus !== null) {
          liveStatusKeys.delete(clearStatus);
          clearStatus();
        }
        runLatencyMs = Math.max(0, Date.now() - start);
      }
    }
    if (runInvoked) {
      state.incumbent = nextIncumbent(state.incumbent, settled.outcome, settled.harness);
      writeTuple(
        logSink,
        runTuple({
          harness: settled.harness,
          effort: settled.effort,
          outcome: settled.outcome,
          exitCode: settled.exitCode,
          signal: settled.signal,
          timedOut: settled.timedOut,
          runLatencyMs,
        }),
      );
    }
    const stdoutTail = tailLines(settled.stdout, TAIL_LINES, TAIL_MAX_BYTES);
    const stderrTail =
      settled.stderr === ""
        ? null
        : tailLines(settled.stderr, STDERR_TAIL_LINES, STDERR_TAIL_MAX_BYTES);
    let report: string;
    if (settled.outcome === "spawn-error") {
      // No log call: nothing ran, no file is written.
      report = formatSpawnError(harness);
    } else {
      const logPath = writeRunLog({
        dir: logDir,
        runId: settled.runId,
        harness: settled.harness,
        effort: settled.effort,
        outcome: settled.outcome,
        exitCode: settled.exitCode,
        signal: settled.signal,
        timedOut: settled.timedOut,
        startedAt: settled.startedAt,
        settledAt: settled.settledAt,
        stdout: settled.stdout,
        stderr: settled.stderr,
        stdoutDroppedBytes: settled.stdoutDroppedBytes,
        stderrDroppedBytes: settled.stderrDroppedBytes,
        cleanupWarning: settled.cleanupWarning,
      });
      if (settled.outcome === "ok") {
        report = formatRunOk(harness, stdoutTail, settled.stdoutDroppedBytes, logPath);
      } else if (settled.outcome === "nonzero") {
        report = formatRunNonzero(
          harness,
          settled.exitCode,
          settled.signal,
          stdoutTail,
          settled.stdoutDroppedBytes,
          stderrTail,
          logPath,
        );
      } else if (settled.outcome === "timeout") {
        report = formatRunTimeout(
          harness,
          stdoutTail,
          settled.stdoutDroppedBytes,
          stderrTail,
          logPath,
        );
      } else {
        // "aborted" — the only remaining outcome. (A hostile `run` fake
        // resolving an unknown outcome string lands here too: the tails
        // render, so the most truth available still shows.)
        report = formatRunAborted(harness, stdoutTail, settled.stdoutDroppedBytes, logPath);
      }
    }
    if (settled.cleanupWarning) {
      // Runner-owned fixed copy; never includes child-controlled text.
      report += `\nCleanup warning: ${settled.cleanupWarning}`;
    }
    if (state.shuttingDown) return;
    const availableIds = availableProviders.map((p) => p.id);
    const explain = formatExplainLine(decision, availableIds, confidence);
    try {
      emit(
        pi,
        ctx,
        [list, formatDecisionLine(harness, effort, confidence), explain, stickyLine, report]
          .filter((block) => block !== null).join("\n\n"),
      );
    } catch {
      // The shutdown race: the session may tear down between settle and
      // emit. This final emit is swallowed so a dead context never throws
      // out of the handler — the ONLY swallowed emit; pre-existing emits
      // are untouched.
    }
  }

  pi.registerCommand("route", {
    description: ROUTE_DESCRIPTION,
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (state.shuttingDown) return;
      const usage = renderUsage(args);
      if (usage !== null) {
        emit(pi, ctx, usage);
        return;
      }
      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([controller.signal, ctx.signal])
        : controller.signal;
      activeRoutes.add(controller);
      try {
        if (signal.aborted) return;
        const providers = await duringRoute(getProviders(), signal);
        if (state.shuttingDown || signal.aborted) return;
        const list = formatDetectionResult(providers);
        const availableProviders = providers.filter(
          (p) => p !== null && typeof p === "object" && p.available === true,
        );
        // Zero available: Phase 1 guidance, with no key resolution and no Jev
        // call (an empty Choice set is never sent).
        if (availableProviders.length === 0) {
          emit(pi, ctx, list);
          return;
        }
        // The Jev path. Handler never throws: an unexpected rejection (only
        // possible from a hostile injected fake — the real modules never throw)
        // maps to the network block rather than the stderr error signature.
        // Exactly one tuple is written per decide() invocation (G-6): the
        // invoked-flag gates emission, so early returns and the key-throw path
        // emit nothing.
        let result: JevResult;
        let latencyMs = 0;
        let invoked = false;
        try {
          const key = await duringRoute(resolveKey(), signal);
          if (state.shuttingDown || signal.aborted) return;
          if (key === null) {
            emit(pi, ctx, `${list}\n\n${formatMissingKey()}`);
            return;
          }
          // Notify-only pre-emit: replaced by the final emit in TUI/RPC and
          // invisible in --print --mode json (never sendMessage).
          ctx.ui.notify(toPlainText(LOADING_LINE), "info");
          const start = Date.now();
          // Set-before-await: a rejecting decide still emits its catch-mapped
          // network tuple. The measurement covers retries + backoff = the
          // user-felt wait; key resolution and detection stay outside it.
          invoked = true;
          try {
            result = await duringRoute(decide(args, availableProviders, key, { signal }), signal);
          } finally {
            latencyMs = Math.max(0, Date.now() - start);
          }
        } catch {
          result = { ok: false, failure: { class: "network" } };
        }
        if (state.shuttingDown || signal.aborted) return;
        if (result.ok) {
          // Verdict branch (Phase 4): every Jev decision gates through the
          // three tiers. The gate runs ONCE: the tuple records exactly the
          // verdict that drove the display. Alternatives derive from the
          // already-settled provider list (ids only, never probabilities
          // keys — no re-probe).
          const gate = evaluateGate(result.decision);
          const availableIds = availableProviders.map((p) => p.id);
          const decision = result.decision;
          const jevHarness = decision.harness;
          const incumbent = state.incumbent;
          const engaged = incumbent !== null && availableIds.includes(incumbent);
          let routed = decision;
          let stickyOutcome: "stay" | "switch" | "none" = "none";
          let stickyLine: string | null = null;
          // Unusable confidence made no selection: preserve the original refusal.
          if (gate.confidence !== null) {
            if (gate.verdict === "refuse" && engaged) {
              // Numeric-refuse always retains the working harness, even for a
              // large probability gap. Permission is the disclosed FR-6 exception.
              routed = decision.harness === incumbent ? decision : { ...decision, harness: incumbent };
              stickyOutcome = "stay";
              stickyLine = formatLowConfidenceStayLine(incumbent, gate.confidence);
            } else {
              const selected = applyStickiness({
                winner: decision.harness, probabilities: decision.probabilities,
                incumbent: engaged ? incumbent : null, availableIds,
              });
              routed = selected.harness === decision.harness ? decision : { ...decision, harness: selected.harness };
              if (engaged) {
                stickyOutcome = selected.stayed ? "stay" : "switch";
                stickyLine = selected.stayed ? formatStayLine(incumbent)
                  : formatSwitchLine(incumbent, routed.harness, STICKY_MARGIN);
              }
            }
          }
          if (invoked) {
            writeTuple(
              logSink,
              successTuple({ decision: routed, verdict: gate.verdict, latencyMs, availableIds,
                incumbent, sticky: stickyOutcome, jevHarness }),
            );
          }
          const alternatives = availableIds.filter((id) => id !== routed.harness);
          if (gate.verdict === "refuse" || gate.confidence === null) {
            if (gate.confidence !== null && engaged) {
              await runAndReport(args, ctx, list, routed, gate.confidence, availableProviders, signal, stickyLine);
            } else {
              emit(pi, ctx, `${list}\n\n${formatRefuseBlock(routed.harness, alternatives, gate.confidence)}`);
            }
            return;
          }
          // Past the refuse check, the figure is usable (the gate runs ONCE;
          // this is the confidence that drove both the tuple and the display).
          const confidence: number = gate.confidence;
          if (gate.verdict === "confirm") {
            // Confirm handshake (JEV-05): the dialog IS the ask. Headless
            // sessions cannot ask — fail closed with the headless block, no
            // confirm call, no spawn.
            if (!ctx.hasUI) {
              emit(
                pi,
                ctx,
                [list, formatDecisionLine(routed.harness, routed.effort, confidence),
                  formatExplainLine(routed, availableIds, confidence), stickyLine,
                  formatConfirmHeadless(routed.harness, routed.effort, confidence)]
                  .filter((block) => block !== null).join("\n\n"),
              );
              return;
            }
            let confirmed = false;
            try {
              confirmed = await duringRoute(ctx.ui.confirm(
                formatConfirmDialogTitle(routed.harness),
                formatConfirmDialog(
                  routed.harness,
                  alternatives,
                  routed.effort,
                  confidence,
                ),
                { timeout: CONFIRM_DIALOG_TIMEOUT_MS, signal },
              ), signal);
            } catch {
              confirmed = false;
            }
            // Decline, dismiss, expiry, abort, or throw all resolve `false`
            // in both modes (Cycle-2 C-3 probe) — and anything but exactly
            // `true` fails closed. No spawn, no run tuple.
            if (state.shuttingDown || signal.aborted) return;
            if (confirmed !== true) {
              emit(
                pi,
                ctx,
                [list, formatDecisionLine(routed.harness, routed.effort, confidence),
                  formatExplainLine(routed, availableIds, confidence), stickyLine,
                  formatRunDeclined(routed.harness)]
                  .filter((block) => block !== null).join("\n\n"),
              );
              return;
            }
            // Shutdown guard (Cycle-2 C-2): a confirm landing inside the
            // teardown window spawns no unwatched child and throws nothing —
            // SILENT return (no spawn, no emit, no run tuple), because the
            // session is tearing down and there is no transcript to write
            // a declined block to.
            if (state.shuttingDown === true) return;
            await runAndReport(args, ctx, list, routed, confidence, availableProviders, signal, stickyLine);
            return;
          }
          await runAndReport(args, ctx, list, routed, confidence, availableProviders, signal, stickyLine);
        } else {
          if (invoked) {
            writeTuple(logSink, failureTuple({ class: result.failure.class, latencyMs }));
          }
          emit(pi, ctx, `${list}\n\n${formatJevError(result.failure.class)}`);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        activeRoutes.delete(controller);
      }
    },
  });

  // Registration order is locked: `route` first, `route-providers` second.
  pi.registerCommand("route-providers", {
    description: REFRESH_DESCRIPTION,
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (state.shuttingDown) return;
      const trimmed = args.trim();
      if (trimmed === "--help" || trimmed === "-h") {
        emit(pi, ctx, formatRefreshHelp());
        return;
      }
      if (trimmed !== "") {
        emit(pi, ctx, formatRefreshUsage());
        return;
      }
      const { baseline, fresh } = await refreshProviders();
      // Post-await recheck (R1): doubles as the before-emit recheck — the
      // composition below is synchronous. No key, no Jev, no log, no runs.
      if (state.shuttingDown || fresh === null) return;
      const list = formatProviderList(fresh);
      const second =
        baseline === null
          ? formatFirstDetectionNote()
          : formatRefreshDiff(diffProviders(baseline, fresh), fresh);
      emit(
        pi,
        ctx,
        countAvailable(fresh) === 0 ? `${list}\n\n${second}\n\n${formatNoHarness()}` : `${list}\n\n${second}`,
      );
    },
  });
}

export default function logofat(pi: ExtensionAPI): void {
  createRoute(pi);
}
