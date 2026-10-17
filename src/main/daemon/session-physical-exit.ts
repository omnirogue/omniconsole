import {
  resolveUnreportedExitCause,
  type TerminalExitCause
} from '../../shared/terminal-exit-cause'
import type { SessionOptions } from './session-options'
import type { SessionOutputPlane } from './session-output-plane'

export type SessionExitCallbacks = {
  onExit: SessionOptions['onExit']
  onPhysicalExit: SessionOptions['onPhysicalExit']
}

export function recordSessionPhysicalExit(
  session: { sessionId: string; incarnationId: string; pid: number },
  callbacks: SessionExitCallbacks,
  code: number,
  cause: TerminalExitCause | undefined,
  output: Pick<SessionOutputPlane, 'finishTerminalStream'>
): void {
  const observedCause = cause ?? resolveUnreportedExitCause(code)
  const terminalStream = output.finishTerminalStream()
  // The caller has drained every output barrier and committed the final partial line.
  // Persist before listener delivery and reaping, including exits before publication.
  callbacks.onPhysicalExit?.({
    version: 1,
    sessionId: session.sessionId,
    incarnationId: session.incarnationId,
    pid: session.pid,
    observedAt: new Date().toISOString(),
    exitCause: observedCause,
    exitCode: observedCause.kind === 'exited' ? observedCause.exitCode : null,
    terminalStream
  })
}
