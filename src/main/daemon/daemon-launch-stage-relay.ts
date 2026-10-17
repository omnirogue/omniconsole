// Relays a daemon-side launch-stage report to the session's attached client, so
// main can record it as a `launch.<stage>` span in the trace file.
//
// Diagnostics only: the payload holds a stage token, an outcome token and elapsed
// ms — never terminal bytes — and no control path reads it. An unattached session
// is simply not reported; the stage is still in daemon.log.

import type { DaemonEvent } from './daemon-stream-events'
import type { DaemonLaunchStageReport } from './session-launch-stage-report'

export type LaunchStageRelayDeps = {
  clientIdForSession(sessionId: string): string | undefined
  enqueueControlEvent(clientId: string, sessionId: string, control: DaemonEvent): void
}

export function relayLaunchStageEvent(
  deps: LaunchStageRelayDeps,
  sessionId: string,
  report: DaemonLaunchStageReport
): void {
  const clientId = deps.clientIdForSession(sessionId)
  if (!clientId) {
    return
  }
  deps.enqueueControlEvent(clientId, sessionId, {
    type: 'event',
    event: 'launchStage',
    sessionId,
    payload: report
  })
}
