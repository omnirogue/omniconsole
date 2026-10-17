import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SidebarSession } from './sidebar-sessions'

/** Locate dispatched work for filtering and grouping without changing its controller or row key. */
export function projectWorkflowExecutionHosts(
  sessions: readonly SidebarSession[],
  hosts: readonly { id: ExecutionHostId; label: string; kind: string }[],
  sshTargetLabels?: ReadonlyMap<string, string>
): SidebarSession[] {
  return sessions.map((session) => {
    const alias = session.workflow?.sshHost
    if (!alias) {
      return session
    }
    const matches = hosts.filter((host) => {
      const parsed = parseExecutionHostId(host.id)
      return (
        parsed?.kind === 'ssh' &&
        (sshTargetLabels ? sshTargetLabels.get(parsed.targetId) : host.label) === alias
      )
    })
    // Display names are not authority: ambiguous or missing matches retain the controller scope.
    if (matches.length !== 1) {
      return session
    }
    return { ...session, displayHostId: matches[0]!.id }
  })
}
