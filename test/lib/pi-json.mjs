#!/usr/bin/env node
// Strict Pi `--print --mode json` output assertion helper.
//
// Usage: node test/lib/pi-json.mjs <stdout-file> <stderr-file> <expected-marker>
//
// This is the ONLY assertion path for Pi checks in this repo. The constants
// below are embedded from test/output-contract.md (probed against Pi 0.87.1).
// Pi exits 0 even when a command handler throws, so the exit code of `pi`
// proves nothing. This helper's verdict is the proof.
//
// PASS requires ALL of:
//   1. a non-empty, non-whitespace marker argument
//   2. stdout is line-delimited JSON with at least one event
//   3. ONE message event whose message has role === EXPECTED_ROLE AND
//      customType === EXPECTED_CUSTOM_TYPE AND whose decoded `content`
//      contains the marker. All three must hold in the same message.
//      `details` and other metadata are never searched, and `display` is
//      deliberately ignored because it is not part of the contract.
//   4. stderr has no line outside BENIGN_STDERR_LINES. The Pi command-error
//      signature (`Extension error (command:<name>): ...`) is reported as its
//      own failure class.
//
// Exit codes: 0 pass | 2 usage/empty marker | 3 unreadable file |
//             4 non-JSON stdout line | 5 zero events | 6 no matching message |
//             7 stderr extension-error signature | 8 unexpected stderr line

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Contract constants (test/output-contract.md).
export const EXPECTED_ROLE = "custom";
export const EXPECTED_CUSTOM_TYPE = "logofat";
// Stderr error signature observed on this host. There is no JSON
// command-error event, so stderr is the only error channel.
export const STDERR_ERROR_SIGNATURE = /^Extension error \(command:[^)]*\): /;
// Benign stderr baseline for successful `--print --mode json` runs: empty.
// Pi 0.87.1 wrote 0 bytes to stderr on every successful probe.
export const BENIGN_STDERR_LINES = Object.freeze([]);

function fail(code, msg) {
  console.error(`pi-json: FAIL(${code}): ${msg}`);
  process.exit(code);
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(3, `cannot read ${label} file ${JSON.stringify(path)}: ${err.message}`);
  }
}

export function decodeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function main(argv) {
  if (argv.length !== 3) {
    fail(2, "usage: node test/lib/pi-json.mjs <stdout-file> <stderr-file> <expected-marker>");
  }
  const [stdoutPath, stderrPath, marker] = argv;
  if (typeof marker !== "string" || marker.trim() === "") {
    fail(2, "expected-marker is empty or whitespace-only; refusing to assert a vacuous marker");
  }

  // stdout: line-delimited JSON events.
  const stdout = readText(stdoutPath, "stdout");
  const events = [];
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      fail(4, `stdout line ${i + 1} is not JSON: ${JSON.stringify(line.slice(0, 200))}`);
    }
  }
  if (events.length === 0) fail(5, "stdout contains zero JSON events");

  const matched = events.some((ev) => {
    const msg = ev && typeof ev === "object" ? ev.message : undefined;
    if (!msg || typeof msg !== "object") return false;
    if (msg.role !== EXPECTED_ROLE) return false;
    if (msg.customType !== EXPECTED_CUSTOM_TYPE) return false;
    return decodeContent(msg.content).includes(marker);
  });

  // stderr: must stay within the benign baseline.
  const stderr = readText(stderrPath, "stderr");
  const errLines = stderr.split("\n").filter((l) => l !== "");
  const signatureHit = errLines.find((l) => STDERR_ERROR_SIGNATURE.test(l));
  if (signatureHit) fail(7, `stderr carries the Pi extension-error signature: ${JSON.stringify(signatureHit)}`);
  const unexpected = errLines.find((l) => !BENIGN_STDERR_LINES.includes(l));
  if (unexpected !== undefined) fail(8, `unexpected stderr line outside the benign baseline: ${JSON.stringify(unexpected)}`);

  if (!matched) {
    fail(
      6,
      `no message event has role=${EXPECTED_ROLE} + customType=${EXPECTED_CUSTOM_TYPE} + content containing the marker (${events.length} events parsed)`,
    );
  }

  console.log(`pi-json: PASS (${events.length} events; role=${EXPECTED_ROLE} customType=${EXPECTED_CUSTOM_TYPE} marker matched; stderr clean)`);
}

// Run only as a CLI; importing the module (e.g. to read the constants) has no side effects.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
