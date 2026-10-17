import type { AgentStatusEntry } from './agent-status-types'

export type DaemonVersionReport = {
  /** appVersion recorded in the daemon pid file; null when unknown (no record, pre-metadata daemon, web client). */
  daemonAppVersion: string | null
  /** The version of the app currently running. */
  appVersion: string
}

export type DaemonVersionDrift = {
  drifted: boolean
  daemonVersion: string
}

/**
 * Why: a daemon started by an older install survives an in-place app upgrade whenever it still
 * owns live sessions (daemon-replacement-preflight.ts defers `stale_bundle` replacement to protect
 * PTYs), so the running terminal code lags the app until someone restarts it on purpose.
 */
export function resolveDaemonVersionDrift(report: DaemonVersionReport | null): DaemonVersionDrift {
  if (!report || !report.daemonAppVersion || !report.appVersion) {
    return { drifted: false, daemonVersion: report?.daemonAppVersion ?? '' }
  }
  return {
    drifted: report.daemonAppVersion !== report.appVersion,
    daemonVersion: report.daemonAppVersion
  }
}

// Why: `blocked` is an agent mid-task waiting for a permission answer — restarting the daemon
// would kill that work just as surely as killing an actively `working` pane.
const BUSY_AGENT_STATES: ReadonlySet<AgentStatusEntry['state']> = new Set(['working', 'blocked'])

export function isAnyPtyBusy(
  agentStatusByPaneKey: Readonly<Record<string, Pick<AgentStatusEntry, 'state'> | undefined>>
): boolean {
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry && BUSY_AGENT_STATES.has(entry.state)) {
      return true
    }
  }
  return false
}
