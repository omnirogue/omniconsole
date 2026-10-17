import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionManageEntry } from '../../shared/session-manage-types'

/**
 * Why an action that touches execution (continue, ask, stop, restart, delete) refuses a session
 * this computer does not execute, or null when it does. The caller's local socket says who may
 * ask; this says what may be acted on: an SSH or paired host's process is that host's.
 */
export function remoteExecutionRefusal(
  entry: Pick<SessionManageEntry, 'title' | 'hostId'>,
  verb: string
): string | null {
  const host = parseExecutionHostId(entry.hostId)
  if (host?.kind === 'local') {
    return null
  }
  if (host?.kind === 'ssh' && verb === 'stop') {
    return `“${entry.title}” runs on the SSH host ${host.targetId}, which has not supplied a verified guarded-stop ticket. Nothing changed.`
  }
  const where =
    host?.kind === 'ssh'
      ? `the SSH host ${host.targetId}`
      : host?.kind === 'runtime'
        ? 'another OmniConsole'
        : 'a host this computer cannot name'
  return `“${entry.title}” runs on ${where}, not on this computer, so session ${verb} does not act on it: these commands only touch sessions this computer executes. Nothing changed.`
}
