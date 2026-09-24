// Harness detection for Logofăt.
//
// A harness counts as installed only when a PATH scan finds an executable
// file for it AND `<resolved path> --version` exits cleanly within the probe
// timeout (CONTEXT D-03). Detection never throws: every failure becomes an
// `available: false` record with one of the fixed UI-SPEC reason strings.
//
// The probe uses execFile with an argv array and no shell. execFile owns the
// timeout, the SIGKILL, and output bounding, so this module keeps no timers
// and does no process-group handling of its own.
//
// Windows PATHEXT resolution is out of scope (local-first, POSIX PATH only).

import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export type ProviderId = 'muse' | 'claude';

export type Provider = {
  id: ProviderId;
  binary: string;
  version: string | null;
  available: boolean;
  reason?: string;
};

export type DetectOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

/** Stable result order. Callers rely on it (D-04). */
export const PROVIDER_IDS: readonly ProviderId[] = ['muse', 'claude'];

export const DEFAULT_TIMEOUT_MS = 5000;
export const VERSION_MAX_BUFFER = 8192;

export const REASON_NOT_FOUND = 'binary not found on PATH';
export const REASON_VERSION_FAILED = '--version failed';
export const REASON_VERSION_TIMED_OUT = '--version timed out';

const MAXBUFFER_CODES = new Set([
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER',
]);

// C0 control characters plus DEL. A line made only of these and whitespace
// carries no version text.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * First non-empty line of the output, trimmed and stripped of control
 * characters. Returns null when the output is blank or holds only
 * whitespace/control characters. Any other line is the version as-is:
 * no format rule is imposed on unfamiliar version strings.
 */
export function firstVersionLine(output: string | undefined | null): string | null {
  if (typeof output !== 'string' || output.length === 0) return null;
  for (const line of output.split(/\r\n|\r|\n/)) {
    const cleaned = line.replace(CONTROL_CHARS, '').trim();
    if (cleaned.length > 0) return cleaned;
  }
  return null;
}

function pickVersion(stdout: unknown, stderr: unknown): string | null {
  const out = typeof stdout === 'string' ? stdout : undefined;
  const err = typeof stderr === 'string' ? stderr : undefined;
  return firstVersionLine(out) ?? firstVersionLine(err);
}

/**
 * Resolve `name` against the PATH in `env`. Empty and non-absolute PATH
 * segments are skipped so a relative entry can never resolve to a file in
 * the current working directory. A segment whose stat/access fails for any
 * reason is skipped, never thrown.
 */
export async function resolveOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const rawPath = env.PATH;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  for (const segment of rawPath.split(path.delimiter)) {
    if (segment.length === 0 || !path.isAbsolute(segment)) continue;
    const candidate = path.join(segment, name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

type ProbeResult = Pick<Provider, 'version' | 'available' | 'reason'>;

function probeVersion(binary: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        ['--version'],
        {
          shell: false,
          env,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: VERSION_MAX_BUFFER,
          encoding: 'utf8',
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          // (1) clean exit
          if (err === null) {
            resolve({ available: true, version: pickVersion(stdout, stderr) });
            return;
          }
          const code = (err as NodeJS.ErrnoException).code;
          // (2) oversized output never fails the probe; the callback args hold
          // the partial output up to maxBuffer.
          if (typeof code === 'string' && MAXBUFFER_CODES.has(code)) {
            resolve({ available: true, version: pickVersion(stdout, stderr) });
            return;
          }
          // (3) killed by execFile's own timeout
          if ((err as { killed?: boolean }).killed === true) {
            resolve({ available: false, version: null, reason: REASON_VERSION_TIMED_OUT });
            return;
          }
          // (4) non-zero exit, signal death, spawn errors: one fixed reason.
          // The raw errno is dropped on purpose (never displayed or logged).
          resolve({ available: false, version: null, reason: REASON_VERSION_FAILED });
        },
      );
    } catch {
      resolve({ available: false, version: null, reason: REASON_VERSION_FAILED });
    }
  });
}

async function detectOne(id: ProviderId, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Provider> {
  let resolved: string | null = null;
  try {
    resolved = await resolveOnPath(id, env);
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    return { id, binary: id, version: null, available: false, reason: REASON_NOT_FOUND };
  }
  const probe = await probeVersion(resolved, env, timeoutMs);
  const record: Provider = { id, binary: resolved, version: probe.version, available: probe.available };
  if (probe.reason !== undefined) record.reason = probe.reason;
  return record;
}

/**
 * Detect the supported harnesses. Probes run concurrently; the result is
 * always `[muse, claude]` in that order, whatever order the probes finish in.
 * Never throws.
 *
 * `opts.env` (default `process.env`) and `opts.timeoutMs` (default 5000 ms)
 * exist so tests can point PATH at fixture directories without touching
 * global state.
 */
export async function detectProviders(opts: DetectOptions = {}): Promise<Provider[]> {
  const env = opts.env ?? process.env;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  return Promise.all(PROVIDER_IDS.map((id) => detectOne(id, env, timeoutMs)));
}
