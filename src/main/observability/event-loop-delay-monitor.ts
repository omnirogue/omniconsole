// Main-process event-loop delay, one `main.event_loop_delay` span per minute in the
// local trace file (latency telemetry, PR 1.0).
//
// Why: a stalled main process delays every PTY byte and every keystroke echo, but
// OmniConsole had no always-on measure of it — the only lag number came from an
// ad-hoc inspector probe. Node's `monitorEventLoopDelay` samples the loop from a
// libuv timer at `resolution` ms, so the cost is one tiny timer callback per tick
// plus one span per minute.
//
// Values are the histogram's own (nanoseconds → ms). They include the sampling
// timer's interval, so `min_ms` sits near `resolution_ms` on an idle loop; readers
// subtract it instead of this module guessing a platform-specific baseline.
//
// Side-effect freedom: telemetry only; every failure is swallowed, the timer is
// unref'd (it never holds the app open), and a tick with no samples writes nothing.

import { monitorEventLoopDelay } from 'node:perf_hooks'
import { startSpan } from './tracer'
import { isLatencyTelemetryEnabled } from './latency-probe-switch'

export const EVENT_LOOP_DELAY_SPAN = 'main.event_loop_delay'
export const EVENT_LOOP_DELAY_INTERVAL_MS = 60_000
export const EVENT_LOOP_DELAY_RESOLUTION_MS = 20

/** The subset of Node's `IntervalHistogram` this monitor reads. */
export type EventLoopDelayHistogram = {
  enable(): boolean | void
  disable(): boolean | void
  reset(): void
  percentile(percentile: number): number
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly count?: number
}

export type EventLoopDelayMonitorDeps = {
  createHistogram?: (resolutionMs: number) => EventLoopDelayHistogram
  isEnabled?: () => boolean
  record?: (attributes: Record<string, number>) => void
  intervalMs?: number
  resolutionMs?: number
}

export type EventLoopDelayMonitor = {
  /** Emit the current window now (the interval calls this). */
  flush(): void
  stop(): void
}

const NS_PER_MS = 1_000_000

function toMs(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? Math.round((nanoseconds / NS_PER_MS) * 100) / 100 : 0
}

function recordEventLoopDelaySpan(attributes: Record<string, number>): void {
  const span = startSpan(EVENT_LOOP_DELAY_SPAN, { attributes: { kind: 'perf', ...attributes } })
  span.end()
}

export function startEventLoopDelayMonitor(
  deps: EventLoopDelayMonitorDeps = {}
): EventLoopDelayMonitor {
  const resolutionMs = deps.resolutionMs ?? EVENT_LOOP_DELAY_RESOLUTION_MS
  const intervalMs = deps.intervalMs ?? EVENT_LOOP_DELAY_INTERVAL_MS
  const isEnabled = deps.isEnabled ?? isLatencyTelemetryEnabled
  const record = deps.record ?? recordEventLoopDelaySpan
  const createHistogram =
    deps.createHistogram ??
    ((resolution: number) => monitorEventLoopDelay({ resolution }) as EventLoopDelayHistogram)

  let histogram: EventLoopDelayHistogram | null = null
  let windowStartedAt = Date.now()

  const ensureHistogram = (): EventLoopDelayHistogram | null => {
    if (histogram) {
      return histogram
    }
    try {
      histogram = createHistogram(resolutionMs)
      histogram.enable()
      windowStartedAt = Date.now()
    } catch {
      histogram = null
    }
    return histogram
  }

  const releaseHistogram = (): void => {
    try {
      histogram?.disable()
    } catch {
      // Diagnostics only.
    }
    histogram = null
  }

  const flush = (): void => {
    try {
      if (!isEnabled()) {
        // Why disable rather than keep sampling: the kill switch must stop the
        // sampling timer too, not just the writes.
        releaseHistogram()
        return
      }
      const current = histogram
      if (!current) {
        ensureHistogram()
        return
      }
      const samples = typeof current.count === 'number' ? current.count : undefined
      const now = Date.now()
      if (samples !== 0) {
        record({
          'event_loop.window_ms': Math.max(0, now - windowStartedAt),
          'event_loop.resolution_ms': resolutionMs,
          'event_loop.p50_ms': toMs(current.percentile(50)),
          'event_loop.p99_ms': toMs(current.percentile(99)),
          'event_loop.max_ms': toMs(current.max),
          'event_loop.min_ms': toMs(current.min),
          'event_loop.mean_ms': toMs(current.mean),
          ...(samples !== undefined ? { 'event_loop.samples': samples } : {})
        })
      }
      current.reset()
      windowStartedAt = now
    } catch {
      // Why swallow: an optional diagnostic must never throw from a timer in main.
    }
  }

  if (isEnabled()) {
    ensureHistogram()
  }
  const timer = setInterval(flush, intervalMs)
  // Why unref: telemetry must never keep a quitting app alive.
  ;(timer as { unref?: () => void }).unref?.()

  return {
    flush,
    stop: () => {
      clearInterval(timer)
      releaseHistogram()
    }
  }
}
