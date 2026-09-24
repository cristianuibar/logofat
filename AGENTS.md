# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Project state

Phase 1 (extension foundation and harness detection) is built: `src/` holds `index.ts` (factory and `/route` handler), `providers.ts` (detection), and `messages.ts` (user-facing copy), and `test/` holds the unit suites and the in-Pi smoke script. `/route` currently reports detected providers only; Jev routing and execution land in later phases. The design lives in `.planning/`, which GSD manages (`/gsd-*` skills). `.planning/` is gitignored and `commit_docs: false`, so never commit it. Read `.planning/STATE.md` first to see the current phase, then `ROADMAP.md` and the active phase directory under `.planning/phases/`.

**Naming:** the project was renamed from **nabu** to **Logofăt** (package/domain spelled `logofat`). The rename has been applied in code: `package.json` is named `logofat`, and user-facing strings say Logofăt. The planning docs, the directory name, and Phase 1 plans still say `nabu`.

## What it is

A Pi coding-agent **extension package** (not a fork of Pi) that adds `/route <prompt>`:

1. It detects which external harnesses are installed. v0.1 supports `muse` and `claude`; cursor, codex, and grok are out of scope.
2. It sends the prompt, the provider list, and a static capability map to **Jev** (TypeSafe System One, `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`). A Choice question picks the harness and a Score question gives difficulty/effort.
3. It runs the prompt on the chosen harness and streams a short status line with a per-harness color back into the Pi session.

## Planned architecture (from `.planning/research/`)

- **Directory Pi package, no build step.** Pi loads TypeScript in place through jiti. `package.json` has a `pi.extensions` manifest pointing at `./src/index.ts`, the `pi-package` keyword, **zero runtime dependencies**, and `@earendil-works/pi-coding-agent` as a `*` peerDependency, imported with `import type` only and never bundled. Use Node built-ins (`node:child_process`, `node:fs`) and global `fetch`.
- **The factory has no side effects.** The default export `(pi: ExtensionAPI) => void` only registers commands and hooks. No spawn, fetch, or timers run at import or factory time. Work starts in the command handler or in `session_start`, and cleanup goes in an idempotent `session_shutdown`.
- **Flow:** `/route` handler (the only component that knows the whole sequence) → `detectProviders()` (PATH plus `--version` probe, shared with `providers refresh`) → Jev client → runner → status renderer.
- **Jev client:** pure `buildRequest` and `parseDecision` functions, testable without a network, plus a thin `fetch` wrapper with an `AbortController` timeout that retries only on 429 and 5xx. When Jev is unreachable the command **fails loudly** with a distinct message per failure class. It never silently falls back to a default harness and never hangs.
- **Confidence gating:** high confidence runs automatically, medium asks for confirmation, low asks or refuses. Jev confidence measures distribution spread, not accuracy.
- **Execution:** direct `spawn` with `shell: false`, piped stdio, and `detached: false`. **tmux was rejected.** Keep a module-level child registry. On abort or shutdown, send SIGTERM and escalate to SIGKILL, so no orphaned processes remain. Per-harness adapters live at `runner/harnesses/{muse,claude}.ts`.
- **Capability map:** a versioned `HARNESS_CAPABILITIES` constant built from open-licensed benchmarks and changed only by commits.
- **Output:** always use `ctx.ui.notify`. When `!ctx.hasUI`, also call `pi.sendMessage` with the factory-captured `pi`; `ctx.sendMessage` does not exist. Do not use `ctx.ui.custom`. Guard status rendering for print and JSON modes. The host discards handler return values.
- **API key hygiene:** read `TYPESAFE_API_KEY`, or a Pi settings value, at call time. Never put the key on a command line or in the transcript, logs, or errors. Strip `Authorization` on error paths.

## Commands

- `npm test` runs the unit suites (`node --test 'test/*.test.ts'`). Don't run bare `node --test`: it also picks up `test/lib/pi-json.mjs`, which is a helper, not a test.
- `npm run test:smoke` runs `test/smoke-pi.sh`, the 5-check isolated in-Pi smoke test (it needs `pi` on PATH).
- Tests use `node --test` built-ins, with Node >= 24 for native `.ts` type stripping. There are no devDependencies, so `tsc` is not enforced. `tsconfig.json` is `strict`, `nodenext`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`. Use relative `.ts` imports and only erasable TS syntax: no enums, no namespaces, no parameter properties.
- Load the extension in Pi in isolation without installing it:
  ```sh
  export PI_CODING_AGENT_DIR=$(mktemp -d); SESS=$(mktemp -d)
  timeout 60 pi --no-session --session-dir "$SESS" --no-extensions --no-skills \
    --no-context-files --no-themes --extension ./src/index.ts \
    --print --mode json "/route hello" > out.json 2> err.txt </dev/null
  ```
  Pi exits 0 even when a handler throws and writes extension errors to stderr. Keep stdout and stderr in separate files and check both. Never trust the exit code.
- Install target: `pi install <this repo>`; update with `pi update`. Pi >= 0.87.1.
