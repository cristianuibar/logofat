// Logofăt: run-output handoff — truncation + full-log-on-disk (Phase 5, plan 05-04).
//
// Keeps messages.ts transcript-only: this module owns fs + truncation.
// `tailLines` is pure (golden-tested). `writeRunLog` returns the absolute
// path or `null` on ANY failure — never throws. `pruneRunLogs` never
// throws and never returns a value. Log headers carry run metadata only:
// NEVER prompt text, key material, or binary paths (there are no such
// fields in the input type, so the absence is structural).

import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { EffortLevel } from "../capabilities.ts";
import type { ProviderId } from "../providers.ts";
import type { RunOutcome } from "./spawn.ts";

/** Transcript stdout tail: last 50 lines with a 20 KiB excerpt guard. */
export const TAIL_LINES = 50;
export const TAIL_MAX_BYTES = 20_000;

/** Transcript stderr failure tail (nonzero + timeout only): last 10 lines, 4 KiB guard. */
export const STDERR_TAIL_LINES = 10;
export const STDERR_TAIL_MAX_BYTES = 4_000;

/** Prune keep-count: the newest 20 `logofat-*.log` files survive. */
const PRUNE_KEEP_DEFAULT = 20;

/** Log files are owner-only (umask can only remove bits, so this is deterministic). */
const LOG_FILE_MODE = 0o600;

export type TailResult = {
  shown: string[];
  totalLines: number;
  totalBytes: number;
  hitLineCap: boolean;
  hitByteCap: boolean;
};

function clampNonNegativeInt(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Splits on `\n` (`\r\n`-tolerant via trailing-`\r` strip per line). A
 * single trailing newline is the terminator, not an extra empty line, and
 * the empty string holds zero lines.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const raw = text.split("\n");
  if (text.endsWith("\n")) raw.pop();
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Keeps a suffix of `line` within the UTF-8 budget (never splits a surrogate). */
function cutAtCharBoundary(line: string, maxBytes: number): string {
  let bytes = 0;
  let start = line.length;
  for (const char of Array.from(line).reverse()) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    start -= char.length;
  }
  return line.slice(start);
}

/**
 * Keeps complete final lines within the byte budget. If the last line
 * alone exceeds the budget, keeps its UTF-8-safe suffix instead.
 */
function applyByteGuard(lines: string[], maxBytes: number): { shown: string[]; hitByteCap: boolean } {
  if (Buffer.byteLength(lines.join("\n")) <= maxBytes) return { shown: lines, hitByteCap: false };
  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    const add = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (used + add > maxBytes) break;
    kept.push(line);
    used += add;
  }
  if (kept.length > 0) return { shown: kept.reverse(), hitByteCap: true };
  return { shown: [cutAtCharBoundary(lines.at(-1) ?? "", maxBytes)], hitByteCap: true };
}

/**
 * Pure truncation: the last `maxLines`, then the byte guard. Totals cover
 * the whole input. Non-string input yields the empty tail — never throws.
 */
export function tailLines(text: string, maxLines: number, maxBytes: number): TailResult {
  if (typeof text !== "string") {
    return { shown: [], totalLines: 0, totalBytes: 0, hitLineCap: false, hitByteCap: false };
  }
  const totalBytes = Buffer.byteLength(text);
  const allLines = splitLines(text);
  const lineCapped =
    clampNonNegativeInt(maxLines) === 0 ? [] : allLines.slice(-clampNonNegativeInt(maxLines));
  const { shown, hitByteCap } = applyByteGuard(lineCapped, clampNonNegativeInt(maxBytes));
  return {
    shown,
    totalLines: allLines.length,
    totalBytes,
    hitLineCap: lineCapped.length < allLines.length,
    hitByteCap,
  };
}

/** Single-line header field: no newlines survive (log-injection-safe), empty/non-string → "unknown". */
function headerField(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const single = value.replace(/[\r\n]+/g, " ").trim();
  return single === "" ? "unknown" : single;
}

/**
 * One verbatim stream section: title + body + (when bytes were dropped past
 * the capture cap) the dropped-bytes marker line. The body is verbatim BY
 * DESIGN — only the section END is normalized to exactly one newline.
 */
function logSection(title: string, body: unknown, droppedBytes: unknown): string {
  const text = typeof body === "string" ? body : "";
  let out = `${title}\n${text}`;
  if (!out.endsWith("\n")) out += "\n";
  if (typeof droppedBytes === "number" && Number.isInteger(droppedBytes) && droppedBytes > 0) {
    out += `[output past the 1 MiB capture cap was dropped: ${droppedBytes} bytes]\n`;
  }
  return out;
}

export type WriteRunLogInput = {
  dir?: string | undefined;
  runId: string;
  harness: ProviderId;
  effort: EffortLevel;
  outcome: RunOutcome;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: string;
  settledAt: string;
  stdout: string;
  stderr: string;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  cleanupWarning?: string | undefined;
};

/** Per-user private storage prevents other users' files consuming retention slots. */
function defaultLogDir(): string {
  const user = userInfo();
  const owner = user.uid >= 0 ? String(user.uid) : encodeURIComponent(user.username);
  return join(tmpdir(), `logofat-${owner}`);
}

function ownedByCurrentUser(stat: ReturnType<typeof lstatSync>): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

/**
 * Writes one settled run's full stdout + stderr to
 * `logofat-<run-id>.log` under `dir` (default: a private per-user temp directory), then
 * prunes (write-then-prune — the current log is never a prune victim).
 * Returns the absolute path, or `null` on ANY failure — never throws, and
 * a failure never fails the run.
 */
export function writeRunLog(input: WriteRunLogInput): string | null {
  try {
    return writeRunLogInner(input);
  } catch {
    return null;
  }
}

function writeRunLogInner(input: WriteRunLogInput): string | null {
  const dir = typeof input.dir === "string" && input.dir !== "" ? input.dir : defaultLogDir();
  // Defense in depth: the charset keeps hostile ids inside `dir`
  // (`nextRunId` output already matches). The `logofat-` prefix + `.log`
  // suffix mean even a degenerate infix cannot become `.` or `..`.
  const rawId = typeof input.runId === "string" ? input.runId : "unknown";
  const safeId = rawId.replace(/[^A-Za-z0-9._-]/g, "-");
  const head = [
    "# logofat run log",
    `run-id: ${headerField(input.runId)}`,
    `harness: ${headerField(input.harness)}`,
    `effort: ${headerField(input.effort)}`,
    `outcome: ${headerField(input.outcome)}`,
    // exit-code/signal only when known (0 is known — never a truthiness check).
    ...(Number.isInteger(input.exitCode) ? [`exit-code: ${String(input.exitCode)}`] : []),
    ...(typeof input.signal === "string" && input.signal !== ""
      ? [`signal: ${headerField(input.signal)}`]
      : []),
    `timed-out: ${input.timedOut === true ? "true" : "false"}`,
    `started-at: ${headerField(input.startedAt)}`,
    `settled-at: ${headerField(input.settledAt)}`,
    ...(input.cleanupWarning ? [`cleanup-warning: ${headerField(input.cleanupWarning)}`] : []),
  ].join("\n");
  const content =
    `${head}\n` +
    logSection("--- stdout ---", input.stdout, input.stdoutDroppedBytes) +
    logSection("--- stderr ---", input.stderr, input.stderrDroppedBytes);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || !ownedByCurrentUser(directory)) return null;
  if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) return null;
  const file = resolve(dir, `logofat-${safeId}.log`);
  // Exclusive creation refuses pre-existing paths, including symlinks.
  writeFileSync(file, content, { encoding: "utf8", mode: LOG_FILE_MODE, flag: "wx" });
  pruneRunLogs({ dir, protectedPath: file });
  return file;
}

/**
 * Keeps the newest `keep` (default 20) `logofat-*.log` files by mtime,
 * deletes older ones. Unlink failures are swallowed PER ENTRY (one
 * vanishing entry — e.g. a concurrent /route pruning simultaneously —
 * must not skip the remaining deletes); the whole body sits in a backstop
 * try/catch. Never throws, never returns a value.
 */
export function pruneRunLogs(opts?: {
  dir?: string | undefined;
  keep?: number | undefined;
  protectedPath?: string | undefined;
}): void {
  try {
    const dir = typeof opts?.dir === "string" && opts.dir !== "" ? opts.dir : defaultLogDir();
    const directory = lstatSync(dir);
    if (!directory.isDirectory() || !ownedByCurrentUser(directory)) return;
    const keep =
      typeof opts?.keep === "number" && Number.isFinite(opts.keep) && opts.keep >= 0
        ? Math.floor(opts.keep)
        : PRUNE_KEEP_DEFAULT;
    const candidates: Array<{ name: string; mtimeMs: number }> = [];
    let protectedCount = 0;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("logofat-") || !name.endsWith(".log")) continue;
      try {
        const file = resolve(dir, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || !ownedByCurrentUser(stat)) continue;
        if (file === opts?.protectedPath) {
          protectedCount++;
          continue;
        }
        candidates.push({ name, mtimeMs: stat.mtimeMs });
      } catch {
        continue; // Stat failures skip the entry.
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    for (const victim of candidates.slice(Math.max(0, keep - protectedCount))) {
      try {
        unlinkSync(join(dir, victim.name));
      } catch {
        // Per-entry swallow — the loop continues past failures.
      }
    }
  } catch {
    // Backstop: pruning never throws and never fails the run.
  }
}
