import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/runtime-environments'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SidebarHostOption } from '../sidebar-host-options'
import { sessionHostLabel } from './session-technical-detail'

export type SessionHostOptions = {
  hosts: SidebarHostOption[]
  /** Saved SSH connections left out: no workspace points at them and no session names them. */
  sshWithoutWorkspace: number
}

/**
 * An SSH host a session can be dispatched to: a workspace points at it (the rule dispatch
 * enforces, session-prep-execution-host) or a session already runs there.
 */
function isDispatchableSshHost(
  host: SidebarHostOption,
  sshTargetIdsWithWorkspace: ReadonlySet<string>,
  sessionHostIds: ReadonlySet<ExecutionHostId>
): boolean {
  const parsed = parseExecutionHostId(host.id)
  return (
    sessionHostIds.has(host.id) ||
    (parsed?.kind === 'ssh' && sshTargetIdsWithWorkspace.has(parsed.targetId))
  )
}

/**
 * The hosts the Sessions switch offers: every host that is set up, plus any host a session still
 * belongs to that setup no longer lists (an SSH-backed VM, a removed server's kept workspace), so
 * no session is ever out of reach of the switch. SSH hosts are only those a session can be
 * dispatched to; the other saved connections are counted, not listed.
 */
export function sessionHostOptions(
  configured: readonly SidebarHostOption[],
  sessions: readonly Pick<SidebarSession, 'hostId' | 'displayHostId' | 'unavailable'>[],
  labels: {
    sshTargetLabels: ReadonlyMap<string, string>
    runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
  },
  sshTargetIdsWithWorkspace: ReadonlySet<string>
): SessionHostOptions {
  const known = new Set<ExecutionHostId>(configured.map((host) => host.id))
  const sessionHostIds = new Set<ExecutionHostId>()
  const extra = new Map<ExecutionHostId, SidebarHostOption>()
  for (const session of sessions) {
    const host = parseExecutionHostId(session.displayHostId ?? session.hostId)
    if (host) {
      sessionHostIds.add(host.id)
    }
    if (!host || known.has(host.id)) {
      continue
    }
    // Reachable when any of its sessions is; otherwise shown as disconnected.
    const reachable = extra.get(host.id)?.health === 'available' || !session.unavailable
    extra.set(host.id, {
      id: host.id,
      kind: host.kind,
      label:
        sessionHostLabel({ hostId: host.id }, labels.sshTargetLabels, labels.runtimeEnvironments) ??
        getExecutionHostLabel(host.id),
      detail: '',
      health: reachable ? 'available' : 'disconnected',
      presence: 'project'
    })
  }
  const listed = configured.filter(
    (host) =>
      host.kind !== 'ssh' || isDispatchableSshHost(host, sshTargetIdsWithWorkspace, sessionHostIds)
  )
  return {
    hosts: [...listed, ...extra.values()],
    sshWithoutWorkspace: configured.length - listed.length
  }
}
