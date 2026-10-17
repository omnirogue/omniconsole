import { translate } from '@/i18n/i18n'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { inSessionHostFilter, type SessionHostFilter } from './session-host-scope'
import { UNKNOWN_COMPUTER_BUCKET_ID } from './session-sidebar-lens'
import type { SidebarSession } from './sidebar-sessions'

type RowHostSession = Pick<SidebarSession, 'hostId' | 'displayHostId'>

/**
 * The computer a row names. Why not `displayHostId` alone: an own workflow lists under Home but
 * runs on its workspace's computer, which is the one the person needs to know. An SSH alias row
 * names the host the alias reached.
 */
export function sessionRowHostId(session: RowHostSession): ExecutionHostId | null {
  return session.displayHostId && session.displayHostId !== LOCAL_EXECUTION_HOST_ID
    ? session.displayHostId
    : (session.hostId ?? session.displayHostId ?? null)
}

/**
 * Rows name their computer only when the host switch shows more than one, so a list of one
 * computer's sessions stays as it was. Never under Home: that list is this computer's by name.
 */
export function showsSessionRowHosts(
  sessions: readonly RowHostSession[],
  filter: SessionHostFilter
): boolean {
  if (!filter.kinds.some((kind) => kind !== 'local')) {
    return false
  }
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!inSessionHostFilter(session.displayHostId ?? session.hostId, filter)) {
      continue
    }
    seen.add(sessionRowHostId(session) ?? UNKNOWN_COMPUTER_BUCKET_ID)
    if (seen.size > 1) {
      return true
    }
  }
  return false
}

/**
 * The readable name a row shows for its computer. Why never the id: a paired runtime's id is a
 * uuid, so one whose name has not arrived yet reads as a paired computer.
 */
export function sessionRowHostName(
  hostId: ExecutionHostId | null,
  sshTargetLabels: ReadonlyMap<string, string> | undefined,
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[] | undefined
): string {
  const host = parseExecutionHostId(hostId)
  if (host?.kind === 'local') {
    return translate('conversations.groupBy.thisComputer', 'This computer')
  }
  if (host?.kind === 'ssh') {
    return sshTargetLabels?.get(host.targetId) ?? host.targetId
  }
  if (host?.kind === 'runtime') {
    const name = runtimeEnvironments?.find(
      (environment) => environment.id === host.environmentId
    )?.name
    return name?.trim() || translate('sessionHosts.rowPairedComputer', 'Paired computer')
  }
  return translate('conversations.groupBy.unknownComputer', 'Unknown computer')
}
