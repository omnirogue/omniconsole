// Composition point for main-process latency telemetry (PR 1.0): installs the
// `latencyTelemetry` kill-switch reader and starts the per-minute event-loop delay
// span. Launch-cause attributes read the same switch (launch-stage-trace.ts).

import { startEventLoopDelayMonitor } from './event-loop-delay-monitor'
import { setLatencyTelemetryEnabledReader } from './latency-probe-switch'

/** Returns a stop function for shutdown. Never throws. */
export function startMainLatencyTelemetry(isEnabled: () => boolean): () => void {
  try {
    setLatencyTelemetryEnabledReader(isEnabled)
    const monitor = startEventLoopDelayMonitor()
    return () => monitor.stop()
  } catch {
    // Why swallow: optional diagnostics must never block main startup.
    return () => {}
  }
}
