// Shape of the launch-stage report the daemon emits for the stages only it can
// see (shell-ready, and the moment the queued startup command actually reached
// the shell). The daemon writes it to daemon.log and relays it to the attached
// client, where main turns it into a `launch.<stage>` span in the trace file.
//
// Diagnostics only: nothing in the terminal data path, the hook-status signals
// or `tui-idle` readiness reads these reports.

/** Daemon-log event name for a launch-stage report. */
export const LAUNCH_STAGE_LOG_EVENT = 'launch-stage'

/** Stages the daemon owns. `process_spawn` and `agent_hook_status` are main's. */
export type DaemonLaunchStageName = 'shell_ready' | 'startup_command'

export type DaemonLaunchStageReport = {
  readonly stage: DaemonLaunchStageName
  /** Milliseconds from the barrier arming to this stage boundary. */
  readonly elapsedMs: number
  /** Short enum token, e.g. `ready_marker` / `timeout_expired`. */
  readonly outcome: string
  /** Pre-ready stdin writes flushed at this boundary, when the stage is a flush. */
  readonly queuedWrites?: number
}

/** Sink a session reports launch stages to. Separate from the shell-readiness
 *  event sink so the readiness diagnosis stream keeps its exact contract. */
export type LaunchStageReporter = (sessionId: string, report: DaemonLaunchStageReport) => void

const STAGE_NAMES: readonly DaemonLaunchStageName[] = ['shell_ready', 'startup_command']
const OUTCOME_TOKEN = /^[a-z][a-z0-9_]{0,31}$/

/** Validate an untrusted (cross-process) report before it becomes a span. */
export function parseDaemonLaunchStageReport(value: unknown): DaemonLaunchStageReport | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const candidate = value as Partial<DaemonLaunchStageReport>
  if (!STAGE_NAMES.includes(candidate.stage as DaemonLaunchStageName)) {
    return null
  }
  if (typeof candidate.outcome !== 'string' || !OUTCOME_TOKEN.test(candidate.outcome)) {
    return null
  }
  if (typeof candidate.elapsedMs !== 'number' || !Number.isFinite(candidate.elapsedMs)) {
    return null
  }
  const queuedWrites =
    typeof candidate.queuedWrites === 'number' && Number.isFinite(candidate.queuedWrites)
      ? { queuedWrites: Math.max(0, Math.round(candidate.queuedWrites)) }
      : {}
  return {
    stage: candidate.stage as DaemonLaunchStageName,
    elapsedMs: Math.max(0, Math.round(candidate.elapsedMs)),
    outcome: candidate.outcome,
    ...queuedWrites
  }
}
