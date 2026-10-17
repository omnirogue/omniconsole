import type { SubprocessHandle } from './session-subprocess-handle'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'
import type { TerminalHistoryExactExit } from './terminal-history-exact-exit'
import type { LaunchStageReporter } from './session-launch-stage-report'

export type SessionOptions = {
  sessionId: string
  cols: number
  rows: number
  terminalHandle?: string
  launchAgent?: TuiAgent
  subprocess: SubprocessHandle
  shellReadySupported: boolean
  shellReadyTimeoutMs?: number
  /** Cap the shell-ready wait may adaptively grow to while nothing yet proves
   *  the shell is alive. Absent ⇒ the fixed bound above. */
  shellReadyAdaptiveCapMs?: number
  /** Reports launch-stage timings (daemon log + relay to the attached client). */
  reportLaunchStage?: LaunchStageReporter
  /** Reports a readiness outcome worth diagnosing to the daemon's file log.
   *  Why not console: the detached daemon runs with stdio 'ignore'. */
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
  historySeedChunks?: readonly string[]
  scrollback?: number
  wslDistro?: string
  // Fired once the session reaches a terminal state so the owner (TerminalHost) can reap it; without
  // a reaper, dead sessions and their scrollback emulators accumulate for the daemon's lifetime.
  onExit?: (code: number) => void
  onPhysicalExit?: (observation: TerminalHistoryExactExit) => void
  startupIngress?: PtyStartupIngressIntent
  ownerBackend?: PtyOwnerBackend
}
