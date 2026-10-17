// Tests for src/runner/handoff.ts (Phase 5: Remote Execution + Result Handoff).
//
// Plan 05-04: tailLines goldens (pure), writeRunLog round-trips + failure
// nulls, prune keep-count + never-throw degradation, and the
// prompt/key/path file-bytes sweep. All fs tests inject a temp dir (never
// the real tmpdir) and clean up in afterEach.

import { afterEach, mock, test } from "node:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STDERR_TAIL_LINES,
  STDERR_TAIL_MAX_BYTES,
  TAIL_LINES,
  TAIL_MAX_BYTES,
  pruneRunLogs,
  tailLines,
  writeRunLog,
} from "../src/runner/handoff.ts";
import type { WriteRunLogInput } from "../src/runner/handoff.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort: the 0o555 fixtures must be writable to remove.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "logofat-handoff-test-"));
  dirs.push(dir);
  return dir;
}

/** Unwritable-dir assertions fail as root (root writes through 0o555). */
const SKIP_AS_ROOT =
  typeof process.getuid === "function" && process.getuid() === 0
    ? "unwritable-dir assertions need a non-root user"
    : false;

function logInput(overrides: Partial<WriteRunLogInput> & { dir: string }): WriteRunLogInput {
  return {
    runId: "run-test1",
    harness: "muse",
    effort: "standard",
    outcome: "ok",
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt: "2026-09-25T00:00:00.000Z",
    settledAt: "2026-09-25T00:00:01.000Z",
    stdout: "",
    stderr: "",
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    ...overrides,
  };
}

test("05-04/T1: tail constants are the locked 50/20k + 10/4k", () => {
  assert.equal(TAIL_LINES, 50);
  assert.equal(TAIL_MAX_BYTES, 20_000);
  assert.equal(STDERR_TAIL_LINES, 10);
  assert.equal(STDERR_TAIL_MAX_BYTES, 4_000);
});

test("05-04/T1: short text passes through with exact counts", () => {
  assert.deepEqual(tailLines("a\nb\nc", 50, 20_000), {
    shown: ["a", "b", "c"],
    totalLines: 3,
    totalBytes: 5,
    hitLineCap: false,
    hitByteCap: false,
  });
});

test("05-04/T1: trailing newline is a terminator; empty string holds zero lines", () => {
  assert.deepEqual(tailLines("a\nb\n", 50, 20_000).shown, ["a", "b"]);
  assert.equal(tailLines("a\nb\n", 50, 20_000).totalLines, 2);
  assert.deepEqual(tailLines("", 50, 20_000), {
    shown: [],
    totalLines: 0,
    totalBytes: 0,
    hitLineCap: false,
    hitByteCap: false,
  });
});

test("05-04/T1: 100-line input yields the last 50 + the line-cap flag", () => {
  const text = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n");
  const tail = tailLines(text, 50, 20_000);
  assert.equal(tail.shown.length, 50);
  assert.equal(tail.shown[0], "L51");
  assert.equal(tail.shown[49], "L100");
  assert.equal(tail.totalLines, 100);
  assert.equal(tail.totalBytes, Buffer.byteLength(text));
  assert.equal(tail.hitLineCap, true);
  assert.equal(tail.hitByteCap, false);
});

test("05-04/T1: byte guard preserves complete final lines within the cap", () => {
  const tail = tailLines("aaa\nbbb\nccc", 10, 7);
  assert.deepEqual(tail.shown, ["bbb", "ccc"]);
  assert.equal(tail.totalLines, 3);
  assert.equal(tail.hitLineCap, false);
  assert.equal(tail.hitByteCap, true);
});

test("05-04/T1: byte guard cuts mid-line when no newline qualifies", () => {
  const tail = tailLines("abcdefghij", 10, 5);
  assert.deepEqual(tail.shown, ["fghij"]);
  assert.equal(tail.hitByteCap, true);
});

test("05-04/T1: CRLF input is tolerated via per-line CR strip", () => {
  const tail = tailLines("a\r\nb\r\n", 50, 20_000);
  assert.deepEqual(tail.shown, ["a", "b"]);
  assert.equal(tail.totalLines, 2);
  assert.equal(tail.totalBytes, 6);
  assert.equal(tail.hitLineCap, false);
  assert.equal(tail.hitByteCap, false);
});

test("05-04/T1: byte cut never splits a surrogate pair", () => {
  assert.deepEqual(tailLines("😀😀", 10, 5).shown, ["😀"]);
  assert.deepEqual(tailLines("a😀b", 10, 3).shown, ["b"]);
  assert.equal(tailLines("😀😀", 10, 5).hitByteCap, true);
});

test("CR-07: oversized earlier lines cannot hide the final answer or error", () => {
  for (const [maxLines, maxBytes, final] of [
    [TAIL_LINES, TAIL_MAX_BYTES, "FINAL ANSWER"],
    [STDERR_TAIL_LINES, STDERR_TAIL_MAX_BYTES, "FINAL ERROR"],
  ] as const) {
    const tail = tailLines(`${"A".repeat(maxBytes + 1)}\n${final}`, maxLines, maxBytes);
    assert.deepEqual(tail.shown, [final]);
    assert.equal(tail.hitByteCap, true);
  }
});

test("CR-07: an oversized final line retains a UTF-8-safe suffix", () => {
  assert.deepEqual(tailLines("discard\nlong prefix é😀END", 50, 9).shown, ["é😀END"]);
  assert.deepEqual(tailLines("discard\nlong prefix é😀END", 50, 8).shown, ["😀END"]);
  assert.deepEqual(tailLines("first\nlast", 50, 0).shown, [""]);
});

test("05-04/T1: hostile input yields the empty tail, never throws", () => {
  const hostile: unknown[] = [null, undefined, 42, {}, [], true];
  for (const input of hostile) {
    assert.deepEqual(tailLines(input as string, 50, 20_000), {
      shown: [],
      totalLines: 0,
      totalBytes: 0,
      hitLineCap: false,
      hitByteCap: false,
    });
  }
});

test("05-04/T1: writeRunLog round-trip — byte-exact header order + sections, 0600", () => {
  const dir = tempDir();
  const file = writeRunLog(
    logInput({ dir, runId: "run-abc123", stdout: "OUT-1\nOUT-2\n", stderr: "ERR-1" }),
  );
  assert.ok(file !== null);
  assert.ok(file.startsWith(`${dir}/`));
  assert.equal(file, join(dir, "logofat-run-abc123.log"));
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(file, "utf8"),
    [
      "# logofat run log",
      "run-id: run-abc123",
      "harness: muse",
      "effort: standard",
      "outcome: ok",
      "exit-code: 0",
      "timed-out: false",
      "started-at: 2026-09-25T00:00:00.000Z",
      "settled-at: 2026-09-25T00:00:01.000Z",
      "--- stdout ---",
      "OUT-1",
      "OUT-2",
      "--- stderr ---",
      "ERR-1",
      "",
    ].join("\n"),
  );
});

test("05-04/T1: outsider-signal shape — signal line, no exit-code line", () => {
  const dir = tempDir();
  const file = writeRunLog(
    logInput({ dir, outcome: "nonzero", exitCode: null, signal: "SIGTERM" }),
  );
  assert.ok(file !== null);
  const bytes = readFileSync(file, "utf8");
  assert.ok(bytes.includes("\nsignal: SIGTERM\n"));
  assert.ok(!bytes.includes("exit-code:"));
});

test("05-04/T1: neither-usable shape — neither exit-code nor signal lines", () => {
  const dir = tempDir();
  const file = writeRunLog(logInput({ dir, outcome: "aborted", exitCode: null, signal: null }));
  assert.ok(file !== null);
  const bytes = readFileSync(file, "utf8");
  assert.ok(!bytes.includes("exit-code:"));
  assert.ok(!bytes.includes("signal:"));
});

test("05-04/T1: dropped-bytes marker present when capped, absent when 0", () => {
  const dir = tempDir();
  const capped = writeRunLog(
    logInput({ dir, runId: "run-capped", stdout: "X", stdoutDroppedBytes: 123 }),
  );
  assert.ok(capped !== null);
  const cappedBytes = readFileSync(capped, "utf8");
  assert.ok(
    cappedBytes.includes("--- stdout ---\nX\n[output past the 1 MiB capture cap was dropped: 123 bytes]\n"),
  );
  assert.ok(!cappedBytes.includes("[output past the 1 MiB capture cap was dropped: 0 bytes]"));
  const uncapped = writeRunLog(logInput({ dir, runId: "run-uncapped", stdout: "X" }));
  assert.ok(uncapped !== null);
  assert.ok(!readFileSync(uncapped, "utf8").includes("output past the 1 MiB capture cap"));
});

test("05-04/T1: writeRunLog returns null when the dir path is a file", () => {
  const dir = tempDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x\n");
  assert.equal(writeRunLog(logInput({ dir: blocker })), null);
});

test("05-04/T1: writeRunLog returns null when the dir is unwritable", { skip: SKIP_AS_ROOT }, () => {
  const dir = tempDir();
  chmodSync(dir, 0o555);
  assert.equal(writeRunLog(logInput({ dir })), null);
});

test("05-04/T1: hostile runId is sanitized; the file lands IN dir", () => {
  const dir = tempDir();
  const file = writeRunLog(logInput({ dir, runId: "../../x" }));
  assert.ok(file !== null);
  assert.equal(file, join(dir, "logofat-..-..-x.log"));
  assert.ok(existsSync(file));
});

test("05-04/T1: prune keeps the newest 20, deletes the oldest 5, spares decoys", () => {
  const dir = tempDir();
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    const file = join(dir, `logofat-old-${i}.log`);
    writeFileSync(file, `old ${i}\n`);
    const mtime = new Date(now - (25 - i) * 1000);
    utimesSync(file, mtime, mtime);
  }
  writeFileSync(join(dir, "other.txt"), "decoy\n");
  writeFileSync(join(dir, "notalogofat-1.log"), "decoy\n");
  pruneRunLogs({ dir });
  const survivors = readdirSync(dir).sort();
  assert.equal(survivors.length, 22);
  for (let i = 0; i < 5; i++) assert.ok(!survivors.includes(`logofat-old-${i}.log`));
  for (let i = 5; i < 25; i++) assert.ok(survivors.includes(`logofat-old-${i}.log`));
  assert.ok(survivors.includes("other.txt"));
  assert.ok(survivors.includes("notalogofat-1.log"));
});

test("05-04/T1: prune honors an explicit keep", () => {
  const dir = tempDir();
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `logofat-k-${i}.log`), "x\n");
  pruneRunLogs({ dir, keep: 3 });
  assert.equal(readdirSync(dir).length, 3);
});

test("CR-09: future-dated files cannot evict the just-written log", () => {
  const dir = tempDir();
  const future = new Date("2099-01-01T00:00:00Z");
  for (let i = 0; i < 20; i++) {
    const file = join(dir, `logofat-future-${i}.log`);
    writeFileSync(file, "old\n");
    utimesSync(file, future, future);
  }
  const current = writeRunLog(logInput({ dir, runId: "current", stdout: "latest result" }));
  assert.ok(current);
  assert.ok(readFileSync(current, "utf8").includes("latest result"));
  assert.equal(readdirSync(dir).length, 20);
});

test("CR-09: equal timestamps preserve the protected log and residual keep budget", () => {
  const dir = tempDir();
  const stamp = new Date("2026-01-01T00:00:00Z");
  for (const name of ["a", "b", "z-current"]) {
    const file = join(dir, `logofat-${name}.log`);
    writeFileSync(file, name);
    utimesSync(file, stamp, stamp);
  }
  const current = join(dir, "logofat-z-current.log");
  pruneRunLogs({ dir, keep: 2, protectedPath: current });
  assert.equal(readFileSync(current, "utf8"), "z-current");
  assert.equal(readdirSync(dir).length, 2);
});

test("CR-09: symlinks neither consume retention slots nor get deleted", () => {
  const dir = tempDir();
  const outside = join(tempDir(), "outside.log");
  writeFileSync(outside, "untouched");
  for (let i = 0; i < 21; i++) symlinkSync(outside, join(dir, `logofat-link-${i}.log`));
  const current = writeRunLog(logInput({ dir }));
  assert.ok(current);
  pruneRunLogs({ dir, keep: 1 });
  assert.ok(existsSync(current));
  assert.equal(readdirSync(dir).length, 22);
  assert.equal(readFileSync(outside, "utf8"), "untouched");
});

test("CR-09: default logs use a private per-user directory", () => {
  const dir = tempDir();
  const input = logInput({ dir });
  delete input.dir;
  const moduleUrl = new URL("../src/runner/handoff.ts", import.meta.url).href;
  const code = `import { writeRunLog } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(writeRunLog(${JSON.stringify(input)})));`;
  const file = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
    env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir }, encoding: "utf8",
  }));
  assert.equal(typeof file, "string");
  assert.ok(file.startsWith(`${dir}/logofat-`));
  const parent = join(file, "..");
  assert.notEqual(parent, dir);
  if (process.platform !== "win32") assert.equal(statSync(parent).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("CR-09: foreign-owned regular files do not consume retention slots or get deleted", {
  skip: typeof process.getuid !== "function",
}, () => {
  const dir = tempDir();
  const foreign = join(dir, "logofat-foreign.log");
  const owned = join(dir, "logofat-owned.log");
  writeFileSync(foreign, "foreign");
  writeFileSync(owned, "owned");
  const future = new Date("2099-01-01T00:00:00Z");
  utimesSync(foreign, future, future);
  const original = fs.lstatSync;
  const replacement = mock.method(fs, "lstatSync", (path, ...args) => {
    const stat = original(path, ...args);
    if (String(path) === foreign) Object.defineProperty(stat, "uid", { value: process.getuid!() + 1 });
    return stat;
  });
  syncBuiltinESMExports();
  try {
    pruneRunLogs({ dir, keep: 1 });
    assert.equal(readFileSync(owned, "utf8"), "owned");
    pruneRunLogs({ dir, keep: 0 });
    assert.equal(readFileSync(foreign, "utf8"), "foreign");
    assert.ok(!existsSync(owned));
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
});

test("CR-09: writing rejects a symlink filename, directory, and non-private directory", () => {
  const dir = tempDir();
  const outside = join(tempDir(), "outside.log");
  writeFileSync(outside, "untouched");
  symlinkSync(outside, join(dir, "logofat-run-test1.log"));
  assert.equal(writeRunLog(logInput({ dir })), null);
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  const alias = join(tempDir(), "alias");
  symlinkSync(dir, alias);
  assert.equal(writeRunLog(logInput({ dir: alias, runId: "another" })), null);
  if (process.platform !== "win32") {
    const shared = tempDir();
    chmodSync(shared, 0o777);
    assert.equal(writeRunLog(logInput({ dir: shared })), null);
  }
});

test("cleanup warnings are included as a single metadata line", () => {
  const file = writeRunLog(logInput({ dir: tempDir(), cleanupWarning: "incomplete\ncleanup" }));
  assert.ok(file);
  assert.ok(readFileSync(file, "utf8").includes("\ncleanup-warning: incomplete cleanup\n"));
});

test("05-04/T1: prune on a missing or unwritable dir is a silent no-throw", () => {
  pruneRunLogs({ dir: join(tempDir(), "nope") });
  if (SKIP_AS_ROOT === false) {
    const dir = tempDir();
    chmodSync(dir, 0o555);
    pruneRunLogs({ dir });
  }
});

test("05-04/T1: prune under an unwritable dir no-throws and every file survives", {
  skip: SKIP_AS_ROOT,
}, () => {
  const dir = tempDir();
  for (let i = 0; i < 25; i++) writeFileSync(join(dir, `logofat-r1-${i}.log`), "x\n");
  chmodSync(dir, 0o555);
  // Default keep 20 → 5 victims, but every unlinkSync fails.
  pruneRunLogs({ dir });
  assert.equal(readdirSync(dir).length, 25);
});

test("05-04/T2: README documents the run logs", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes("## Decision log (stderr)"));
  assert.ok(readme.includes("## Run logs"));
  assert.ok(readme.includes("logofat-<run-id>.log"));
  assert.ok(readme.includes("1 MiB"));
  assert.ok(readme.includes("protects the current log"));
  assert.ok(readme.includes("19 other owned regular logs"));
});

test("05-04/T1: header carries no prompt/key/path bytes (sweep)", () => {
  const dir = tempDir();
  const promptCanary = "SWEEP-PROMPT-9f3c-alphabet-soup";
  const keyCanary = "SWEEP-KEY-9f3c-alphabet-soup";
  const pathCanary = "sweep/binary/path/9f3c-fake-harness";
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = keyCanary;
  try {
    const file = writeRunLog({
      ...logInput({
        dir,
        runId: "run-sweep1",
        outcome: "nonzero",
        exitCode: 3,
        stdout: "plain stdout",
      }),
      // Structural proof: even when the caller passes prompt/key/path
      // fields, the writer has nowhere to put them. The tail is verbatim
      // BY DESIGN and exempt (D-54) — no canary goes into the streams.
      prompt: promptCanary,
      binary: pathCanary,
      apiKey: keyCanary,
    } as unknown as WriteRunLogInput);
    assert.ok(file !== null);
    const bytes = readFileSync(file, "utf8");
    assert.ok(!bytes.includes(promptCanary));
    assert.ok(!bytes.includes(keyCanary));
    assert.ok(!bytes.includes(pathCanary));
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});
