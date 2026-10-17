/**
 * Pure helpers for the keystroke latency sampler (terminal-input-latency.ts): the
 * per-minute summary shape and math, and where a keystroke's measure starts.
 */
import { summarizeLatencySamples } from '../typing-latency/diagnostic-summary'

export type TerminalInputLatencySummary = {
  windowMs: number
  keys: number
  echoCount: number
  echoP50Ms?: number
  echoP95Ms?: number
  echoMaxMs?: number
  paintCount: number
  paintP50Ms?: number
  paintP95Ms?: number
  paintMaxMs?: number
  /** Sampled keystrokes with no PTY output for their pane within the echo window. */
  unechoed: number
  /** Echoed keystrokes whose paint did not land within the paint window. */
  unpainted: number
}

/** Chromium's event.timeStamp shares performance.now()'s clock and marks when the OS
 *  delivered the key. A timestamp older than this is clamped to it: the key really did
 *  wait at least this long, and the cap stops a broken timebase reporting hours. */
export const MAX_EVENT_TIMESTAMP_AGE_MS = 60_000
/** Coarsened clocks can put event.timeStamp a hair after the handler's now(). */
const MAX_EVENT_TIMESTAMP_SKEW_MS = 5

/**
 * Where a keystroke's measure starts. A missing or other-clock timestamp (only
 * synthetic events lack a usable one) falls back to the handler time; a stale one is
 * clamped to MAX_EVENT_TIMESTAMP_AGE_MS, a lower bound, never re-based to the handler.
 */
export function resolveKeydownStart(eventTimeStamp: number | undefined, handledAt: number): number {
  if (
    typeof eventTimeStamp !== 'number' ||
    !Number.isFinite(eventTimeStamp) ||
    eventTimeStamp <= 0 ||
    eventTimeStamp > handledAt + MAX_EVENT_TIMESTAMP_SKEW_MS
  ) {
    return handledAt
  }
  return Math.min(handledAt, Math.max(eventTimeStamp, handledAt - MAX_EVENT_TIMESTAMP_AGE_MS))
}

/** Build the per-minute summary. Pure; exported for tests. */
export function summarizeTerminalInputLatency(input: {
  windowMs: number
  keys: number
  echoMs: readonly number[]
  paintMs: readonly number[]
  unechoed: number
  unpainted: number
}): TerminalInputLatencySummary {
  const echo = summarizeLatencySamples(input.echoMs)
  const paint = summarizeLatencySamples(input.paintMs)
  return {
    windowMs: Math.max(0, Math.round(input.windowMs)),
    keys: input.keys,
    echoCount: echo.count,
    ...(echo.p50 !== null ? { echoP50Ms: echo.p50 } : {}),
    ...(echo.p95 !== null ? { echoP95Ms: echo.p95 } : {}),
    ...(echo.max !== null ? { echoMaxMs: echo.max } : {}),
    paintCount: paint.count,
    ...(paint.p50 !== null ? { paintP50Ms: paint.p50 } : {}),
    ...(paint.p95 !== null ? { paintP95Ms: paint.p95 } : {}),
    ...(paint.max !== null ? { paintMaxMs: paint.max } : {}),
    unechoed: input.unechoed,
    unpainted: input.unpainted
  }
}
