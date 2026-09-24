// Unit tests for detectProviders().
//
// Hermetic by construction: every test builds fake `muse` / `claude`
// executables in a fresh temp dir and passes a PATH that holds ONLY fixture
// directories through the `opts.env` seam. The real process env is never
// mutated and real harnesses are never spawned.
//
// Fixtures are /bin/sh scripts that use shell builtins only, because the
// fixture PATH has no system directories on it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectProviders,
  firstVersionLine,
  REASON_NOT_FOUND,
  REASON_VERSION_FAILED,
  REASON_VERSION_TIMED_OUT,
} from '../src/providers.ts';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'logofat-providers-'));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let dirCounter = 0;
function freshDir(): string {
  dirCounter += 1;
  const dir = path.join(ROOT, `bin-${dirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeBin(dir: string, name: string, body: string, mode = 0o755): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

function makeRaw(dir: string, name: string, content: string, mode = 0o755): string {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

// About 74 KB of filler, well past the 8 KB maxBuffer.
const FILLER_LOOP =
  'i=0; while [ $i -lt 2000 ]; do echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done';

test('binary found and --version ok yields available with trimmed version and exact record shape', async () => {
  const dir = freshDir();
  const museBin = makeBin(dir, 'muse', 'printf "\\n   Muse Code 1.3.0  \\nsecond line\\n"');
  const claudeBin = makeBin(dir, 'claude', 'echo "2.1.281 (Claude Code)"');

  const result = await detectProviders({ env: { PATH: dir }, timeoutMs: 5000 });

  assert.deepEqual(result, [
    { id: 'muse', binary: museBin, version: 'Muse Code 1.3.0', available: true },
    { id: 'claude', binary: claudeBin, version: '2.1.281 (Claude Code)', available: true },
  ]);
  assert.deepEqual(Object.keys(result[0]), ['id', 'binary', 'version', 'available']);
  assert.equal('reason' in result[0], false);
});

test('binary missing from PATH yields not-found reason; missing or empty PATH never throws', async () => {
  const empty = freshDir();
  const expected = [
    { id: 'muse', binary: 'muse', version: null, available: false, reason: REASON_NOT_FOUND },
    { id: 'claude', binary: 'claude', version: null, available: false, reason: REASON_NOT_FOUND },
  ];
  assert.equal(REASON_NOT_FOUND, 'binary not found on PATH');

  assert.deepEqual(await detectProviders({ env: { PATH: empty } }), expected);
  assert.deepEqual(await detectProviders({ env: {} }), expected);
  assert.deepEqual(await detectProviders({ env: { PATH: '' } }), expected);
  // Nonexistent dirs and a regular file used as a PATH segment (ENOTDIR) are skipped.
  const notADir = makeRaw(freshDir(), 'plain-file', 'x', 0o644);
  const odd = [path.join(empty, 'does-not-exist'), notADir, empty].join(path.delimiter);
  assert.deepEqual(await detectProviders({ env: { PATH: odd } }), expected);
});

test('empty and relative PATH segments are skipped, so cwd-relative binaries never resolve', async () => {
  const dir = freshDir();
  makeBin(dir, 'muse', 'echo "cwd muse 6.6.6"');
  makeBin(dir, 'claude', 'echo "cwd claude 6.6.6"');
  // A relative segment that really points at the fixture dir from the cwd.
  const relative = path.relative(process.cwd(), dir);
  assert.equal(path.isAbsolute(relative), false);

  const PATH = ['', relative, '.', '', 'node_modules/.bin', ''].join(path.delimiter);
  const result = await detectProviders({ env: { PATH } });

  for (const p of result) {
    assert.equal(p.available, false);
    assert.equal(p.reason, REASON_NOT_FOUND);
    assert.equal(p.binary, p.id);
  }
});

test('non-executable files and directories named like a harness are not found; a later segment still resolves', async () => {
  const shadow = freshDir();
  makeBin(shadow, 'muse', 'echo "no exec bit"', 0o644);
  mkdirSync(path.join(shadow, 'claude'));

  const onlyShadow = await detectProviders({ env: { PATH: shadow } });
  assert.deepEqual(
    onlyShadow.map((p) => [p.id, p.available, p.reason]),
    [
      ['muse', false, REASON_NOT_FOUND],
      ['claude', false, REASON_NOT_FOUND],
    ],
  );

  const real = freshDir();
  const museBin = makeBin(real, 'muse', 'echo "muse 1.0"');
  const claudeBin = makeBin(real, 'claude', 'echo "claude 2.0"');
  const both = await detectProviders({ env: { PATH: [shadow, real].join(path.delimiter) } });
  assert.deepEqual(
    both.map((p) => [p.binary, p.available, p.version]),
    [
      [museBin, true, 'muse 1.0'],
      [claudeBin, true, 'claude 2.0'],
    ],
  );
});

test('--version non-zero exit and signal death yield --version failed', async () => {
  const dir = freshDir();
  const museBin = makeBin(dir, 'muse', 'echo "muse 1.0"; exit 3');
  const claudeBin = makeBin(dir, 'claude', 'echo "claude 2.0"; kill -9 $$');

  const result = await detectProviders({ env: { PATH: dir }, timeoutMs: 5000 });

  assert.equal(REASON_VERSION_FAILED, '--version failed');
  assert.deepEqual(result, [
    { id: 'muse', binary: museBin, version: null, available: false, reason: REASON_VERSION_FAILED },
    { id: 'claude', binary: claudeBin, version: null, available: false, reason: REASON_VERSION_FAILED },
  ]);
});

test('spawn error (bad shebang, ENOENT) yields --version failed and never throws', async () => {
  const dir = freshDir();
  const museBin = makeRaw(dir, 'muse', '#!/nonexistent/interpreter\necho hi\n');
  const claudeBin = makeRaw(dir, 'claude', '#!/nonexistent\n');

  const result = await detectProviders({ env: { PATH: dir }, timeoutMs: 5000 });

  assert.deepEqual(result, [
    { id: 'muse', binary: museBin, version: null, available: false, reason: REASON_VERSION_FAILED },
    { id: 'claude', binary: claudeBin, version: null, available: false, reason: REASON_VERSION_FAILED },
  ]);
});

test('hanging --version is killed at the timeout and yields --version timed out', async () => {
  const dir = freshDir();
  const museBin = makeBin(dir, 'muse', 'while :; do :; done');
  makeBin(dir, 'claude', 'echo "claude 2.0"');

  const started = Date.now();
  const result = await detectProviders({ env: { PATH: dir }, timeoutMs: 50 });
  const elapsed = Date.now() - started;

  assert.equal(REASON_VERSION_TIMED_OUT, '--version timed out');
  assert.deepEqual(result[0], {
    id: 'muse',
    binary: museBin,
    version: null,
    available: false,
    reason: REASON_VERSION_TIMED_OUT,
  });
  assert.equal(result[1].available, true);
  assert.equal(result[1].version, 'claude 2.0');
  assert.ok(elapsed < 3000, `detection took ${elapsed} ms; the timeout did not bound the probe`);
});

test('whitespace or control-only --version output yields version null but stays available', async () => {
  const dir = freshDir();
  makeBin(dir, 'muse', 'printf "   \\n\\t\\n\\001\\002\\033\\n"');
  makeBin(dir, 'claude', ':');

  const result = await detectProviders({ env: { PATH: dir } });

  assert.deepEqual(
    result.map((p) => [p.id, p.available, p.version, 'reason' in p]),
    [
      ['muse', true, null, false],
      ['claude', true, null, false],
    ],
  );
});

test('stderr-only version output is captured', async () => {
  const dir = freshDir();
  makeBin(dir, 'muse', 'echo "  muse 4.5.6 (stderr)  " >&2');
  makeBin(dir, 'claude', 'echo "" ; echo "claude 7.8.9" >&2');

  const result = await detectProviders({ env: { PATH: dir } });

  assert.deepEqual(
    result.map((p) => [p.available, p.version]),
    [
      [true, 'muse 4.5.6 (stderr)'],
      [true, 'claude 7.8.9'],
    ],
  );
});

test('oversized output (stdout overflow and stderr-only overflow) stays available with the first-line version', async () => {
  const dir = freshDir();
  makeBin(dir, 'muse', `echo "big-stdout 1.2.3"\n${FILLER_LOOP}`);
  makeBin(dir, 'claude', `{ echo "big-stderr 3.2.1"\n${FILLER_LOOP}\n} >&2`);

  const result = await detectProviders({ env: { PATH: dir }, timeoutMs: 5000 });

  assert.deepEqual(
    result.map((p) => [p.id, p.available, p.version, p.reason]),
    [
      ['muse', true, 'big-stdout 1.2.3', undefined],
      ['claude', true, 'big-stderr 3.2.1', undefined],
    ],
  );
});

test('results are always [muse, claude] even when claude finishes first', async () => {
  const dir = freshDir();
  const log = path.join(freshDir(), 'completion.log');
  // muse waits (builtins only) until claude has written the log, so claude
  // deterministically completes first. The probe timeout bounds the wait.
  makeBin(dir, 'muse', 'while [ ! -s "$LOG" ]; do :; done\necho muse >> "$LOG"\necho "muse 1.0"');
  makeBin(dir, 'claude', 'echo claude >> "$LOG"\necho "claude 2.0"');

  const result = await detectProviders({ env: { PATH: dir, LOG: log }, timeoutMs: 5000 });

  assert.equal(readFileSync(log, 'utf8'), 'claude\nmuse\n');
  assert.deepEqual(
    result.map((p) => [p.id, p.available, p.version]),
    [
      ['muse', true, 'muse 1.0'],
      ['claude', true, 'claude 2.0'],
    ],
  );
});

test('firstVersionLine: first non-empty cleaned line, null for blank or control-only input', () => {
  assert.equal(firstVersionLine('\r\n  v1.2.3 \r\nnext'), 'v1.2.3');
  assert.equal(firstVersionLine('\u0007\u001b\n\t \nreal 1'), 'real 1');
  assert.equal(firstVersionLine('   \n\t\u0001\n'), null);
  assert.equal(firstVersionLine(''), null);
  assert.equal(firstVersionLine(undefined), null);
  assert.equal(firstVersionLine('weird-format-no-digits'), 'weird-format-no-digits');
});
