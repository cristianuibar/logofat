// Logofăt: live per-harness run status for the Pi footer (Phase 6, EXEC-02).
//
// Pure renderer + a bounded tail buffer + a ProgressEvent-driven ticker. No
// I/O, no Pi imports, no state outside the returned closures. The runner is
// untouched: src/index.ts constructs the onProgress closure from
// attachRunStatus and clears it in the settle `finally`.
//
// Totality: every export degrades on hostile input and never throws, so a
// renderer fault can never stall or fail a run (the wiring site adds its own
// try/catch as a second layer).

import { sanitizeField } from "./messages.ts";
import type { ProviderId } from "./providers.ts";
import type { ProgressEvent } from "./runner/spawn.ts";

/** Tick cadence: at most one footer update per second (timer-only). */
export const STATUS_TICK_MS = 1000;

/** Tail-buffer bound: ~6 80-column lines, enough for split-line assembly. */
export const TAIL_BUFFER_CHARS = 512;

/** Excerpt cap: the last line renders at most this many characters. */
export const EXCERPT_CHARS = 80;

/** Total-line budget (G1 backstop): worst-case renders stay under this. */
export const STATUS_LINE_BUDGET_CHARS = 160;

// UI-SPEC per-harness tokens. Cyan/magenta are mutually distinct
// non-severity hues (red reads as failure); the id text always rides beside
// the color, so the harness survives even where ANSI does not render.
const HARNESS_ANSI: Readonly<Record<ProviderId, string>> = Object.freeze({
  muse: "\u001b[36m",
  claude: "\u001b[35m",
});
const ANSI_RESET = "\u001b[0m";

/** `Ns` under 60s, `MmSSs` at/over (zero-padded seconds). Hostile input renders `0s`. */
function formatElapsed(ms: unknown): string {
  const totalSeconds =
    typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : 0;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export type RenderStatusInput = {
  harness: ProviderId;
  elapsedMs: number;
  lineCount: number;
  excerpt: string;
  ansi: boolean;
};

/**
 * One footer line: `<id> · <elapsed> · <n> lines[ · <excerpt>]`. The excerpt
 * clause is omitted until the first chunk arrives (empty excerpt). The id is
 * wrapped in its per-harness ANSI token only when `ansi` is true AND the
 * sanitized id is a known harness — sanitize-then-wrap, so child-derived
 * text can never inject escapes. The 80-char excerpt cap is enforced here
 * (keep-last) as well as at the attach site, so the 160-char budget holds
 * even for direct callers. Never throws.
 */
export function renderStatus(input: RenderStatusInput): string {
  try {
    const src = input as unknown as Record<string, unknown> | null | undefined;
    const id = sanitizeField(src?.["harness"]) || "unknown";
    const elapsed = formatElapsed(src?.["elapsedMs"]);
    const rawCount = src?.["lineCount"];
    const count =
      typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount >= 0
        ? Math.floor(rawCount)
        : 0;
    const rawExcerpt = src?.["excerpt"];
    const excerpt =
      typeof rawExcerpt === "string" ? sanitizeField(rawExcerpt).slice(-EXCERPT_CHARS) : "";
    const ansi = src?.["ansi"] === true;
    const token =
      ansi && Object.hasOwn(HARNESS_ANSI, id)
        ? `${HARNESS_ANSI[id as ProviderId]}${id}${ANSI_RESET}`
        : id;
    const head = `${token} · ${elapsed} · ${count} lines`;
    return excerpt === "" ? head : `${head} · ${excerpt}`;
  } catch {
    return "unknown · 0s · 0 lines";
  }
}

export type TailBuffer = {
  push: (text: unknown) => void;
  lastLine: () => string;
  readonly lineCount: number;
};

/**
 * Bounded stream-agnostic tail over run chunks. Chunks are arbitrary
 * data-event slices, not lines, so the buffer assembles the tail itself:
 * `push` appends (non-strings ignored) and trims from the head to the
 * limit. `lineCount` is CUMULATIVE across pushes (completed lines produced
 * so far) — trimming the buffer never rewinds the displayed count.
 * `lastLine` is the text after the last `\n` (`""` when the buffer is empty
 * or ends on a newline). Never throws.
 */
export function createTailBuffer(limitChars: number = TAIL_BUFFER_CHARS): TailBuffer {
  const limit =
    typeof limitChars === "number" && Number.isFinite(limitChars) && limitChars > 0
      ? Math.max(1, Math.floor(limitChars))
      : TAIL_BUFFER_CHARS;
  let buffer = "";
  let count = 0;
  return {
    push(text: unknown): void {
      try {
        if (typeof text !== "string" || text === "") return;
        count += text.split("\n").length - 1;
        buffer = (buffer + text).slice(-limit);
      } catch {
        // A hostile chunk never breaks the renderer.
      }
    },
    lastLine(): string {
      try {
        const at = buffer.lastIndexOf("\n");
        return at === -1 ? buffer : buffer.slice(at + 1);
      } catch {
        return "";
      }
    },
    get lineCount(): number {
      return count;
    },
  };
}

/** Injectable clock/scheduler seam for the ticker. Tests pass a fake; production uses the defaults. */
export type StatusClock = {
  now: () => number;
  every: (tick: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type AttachRunStatusArgs = {
  setStatus: (key: string, text: string | undefined) => void;
  key: string;
  harness: ProviderId;
  ansi: boolean;
  intervalMs?: number;
  clock?: Partial<StatusClock>;
};

/**
 * Drives one footer entry from run progress events. `started` renders the
 * leading tick and starts the interval timer; `chunk` feeds only the tail
 * buffer; `exit` is ignored (no trailing tick — the final report follows
 * immediately and the owner clears). `stop()` clears the timer (if any)
 * and the key; it is twice-safe and never throws, and it is always safe
 * to call even when `started` never arrived. Every `setStatus` call is
 * try/caught. Never throws.
 */
export function attachRunStatus(args: AttachRunStatusArgs): {
  onEvent: (event: ProgressEvent) => void;
  stop: () => void;
} {
  const src = args as unknown as Record<string, unknown> | null | undefined;
  const rawSetStatus = src?.["setStatus"];
  const setStatus: (key: string, text: string | undefined) => void =
    typeof rawSetStatus === "function"
      ? (rawSetStatus as (key: string, text: string | undefined) => void)
      : () => {};
  const rawKey = src?.["key"];
  const key = typeof rawKey === "string" && rawKey !== "" ? rawKey : "logofat:unknown";
  const rawHarness = src?.["harness"];
  const harness = (typeof rawHarness === "string" ? rawHarness : "") as ProviderId;
  const ansi = src?.["ansi"] === true;
  const rawInterval = src?.["intervalMs"];
  const interval =
    typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : STATUS_TICK_MS;
  const clock = src?.["clock"] as Partial<StatusClock> | null | undefined;
  const rawNow = clock?.now;
  const rawEvery = clock?.every;
  const rawClear = clock?.clear;
  const readNow = (): number => {
    try {
      const value = typeof rawNow === "function" ? rawNow() : Date.now();
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const every: (tick: () => void, ms: number) => unknown =
    typeof rawEvery === "function"
      ? (fn: () => void, ms: number) => {
          try {
            return (rawEvery as (tick: () => void, ms: number) => unknown)(fn, ms);
          } catch {
            return null;
          }
        }
      : (fn, ms) => setInterval(fn, ms);
  const clear: (handle: unknown) => void =
    typeof rawClear === "function"
      ? (handle: unknown) => {
          (rawClear as (handle: unknown) => void)(handle);
        }
      : (handle: unknown) => {
          clearInterval(handle as ReturnType<typeof setInterval>);
        };

  const tail = createTailBuffer();
  let timer: unknown = null;
  let timerOn = false;
  let started = false;
  let startMs = 0;
  let stopped = false;

  const render = (): void => {
    try {
      // Sanitize first, then keep the last 80: sanitizing can lengthen via
      // the `] (` join, so cap-last guarantees the budget.
      const excerpt = sanitizeField(tail.lastLine()).slice(-EXCERPT_CHARS);
      setStatus(
        key,
        renderStatus({ harness, elapsedMs: readNow() - startMs, lineCount: tail.lineCount, excerpt, ansi }),
      );
    } catch {
      // A tick never breaks the run.
    }
  };

  const onEvent = (event: ProgressEvent): void => {
    try {
      if (stopped) return;
      const type = (event as { type?: unknown } | null | undefined)?.type;
      if (type === "started") {
        if (started) return;
        started = true;
        startMs = readNow();
        render();
        if (!timerOn) {
          const handle = every(() => {
            try {
              if (!stopped) render();
            } catch {
              // A tick never breaks the run.
            }
          }, interval);
          // unref (when the scheduler offers it) so a leaked ticker can
          // never hold the process open; firing is unaffected.
          try {
            const unref = (handle as { unref?: unknown } | null | undefined)?.unref;
            if (typeof unref === "function") (unref as () => void).call(handle);
          } catch {
            // Schedulers without unref (test fakes) carry on.
          }
          timer = handle;
          timerOn = true;
        }
      } else if (type === "chunk") {
        tail.push((event as { text?: unknown })?.text);
      }
      // `exit` and anything else: ignored — no trailing tick.
    } catch {
      // A hostile event never breaks the run.
    }
  };

  const stop = (): void => {
    stopped = true;
    if (timerOn) {
      timerOn = false;
      const handle = timer;
      timer = null;
      try {
        clear(handle);
      } catch {
        // A hostile scheduler never breaks teardown.
      }
    }
    try {
      setStatus(key, undefined);
    } catch {
      // Clearing never fails the run.
    }
  };

  return { onEvent, stop };
}
