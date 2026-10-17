/**
 * App wiring for the always-on keystroke latency sampler (terminal-input-latency.ts):
 * the `latencyTelemetry` setting (default on) is the kill switch, and summaries go to
 * the renderer breadcrumb channel, which main writes to main.trace.ndjson.
 *
 * The note* functions are called from the pane's existing keydown, xterm-input and
 * live-output paths. They take a pane key and timing only — never key contents.
 */
import { useAppStore } from '@/store'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import type { CrashReportBreadcrumbData } from '../../../../shared/crash-reporting'
import { TERMINAL_INPUT_LATENCY_BREADCRUMB } from '../../../../shared/latency-telemetry-breadcrumbs'
import {
  createTerminalInputLatencySampler,
  type LatencyTerminal,
  type TerminalInputLatencySampler,
  type TerminalInputLatencySummary
} from './terminal-input-latency'

/** Numbers only: the summary is counts and durations, so nothing else may ride along. */
export function toTerminalInputLatencyBreadcrumbData(
  summary: TerminalInputLatencySummary
): CrashReportBreadcrumbData {
  const data: CrashReportBreadcrumbData = {}
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      data[key] = value
    }
  }
  return data
}

function isLatencyTelemetryEnabled(): boolean {
  try {
    return useAppStore.getState().settings?.latencyTelemetry !== false
  } catch {
    return true
  }
}

let sampler: TerminalInputLatencySampler | null = null

function getSampler(): TerminalInputLatencySampler {
  sampler ??= createTerminalInputLatencySampler({
    now: () => performance.now(),
    isEnabled: isLatencyTelemetryEnabled,
    record: (summary) =>
      recordRendererCrashBreadcrumb(
        TERMINAL_INPUT_LATENCY_BREADCRUMB,
        toTerminalInputLatencyBreadcrumbData(summary)
      ),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(typeof requestAnimationFrame === 'function'
      ? { requestFrame: (callback: () => void) => void requestAnimationFrame(() => callback()) }
      : {})
  })
  return sampler
}

/** Keydown on the focused pane's terminal element. Reads only the event's timestamp. */
export function noteTerminalKeydownForLatency(
  paneKey: string,
  event: Pick<KeyboardEvent, 'timeStamp'>
): void {
  getSampler().noteKeydown(paneKey, event.timeStamp)
}

/** xterm produced input for this pane's PTY (after a keydown when it is a keystroke). */
export function noteTerminalInputForLatency(paneKey: string, terminal: LatencyTerminal): void {
  getSampler().noteTerminalInput(paneKey, terminal)
}

/** Live PTY output arrived for this pane. */
export function noteTerminalOutputForLatency(paneKey: string): void {
  sampler?.noteOutput(paneKey)
}
