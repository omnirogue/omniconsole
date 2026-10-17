import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/runtime-environments'
import type { SidebarSession } from '@/lib/sidebar-sessions'

export function sessionHostLabel(
  session: Pick<SidebarSession, 'hostId'>,
  sshTargetLabels: ReadonlyMap<string, string>,
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[] = []
): string | null {
  const parsed = parseExecutionHostId(session.hostId)
  if (!parsed) {
    return null
  }
  if (parsed.kind === 'local') {
    return translate('auto.components.SessionSidebar.technicalSessionThisDevice', 'This device')
  }
  if (parsed.kind === 'ssh') {
    return sshTargetLabels.get(parsed.targetId) ?? parsed.targetId
  }
  if (parsed.kind === 'runtime') {
    return (
      runtimeEnvironments.find((environment) => environment.id === parsed.environmentId)?.name ??
      null
    )
  }
  return null
}

export function sessionTechnicalDetail(
  session: SidebarSession,
  labels: ReadonlyMap<string, string>,
  runtimeEnvironments?: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
): string {
  return [
    session.agent,
    sessionHostLabel(session, labels, runtimeEnvironments),
    session.workspaceLabel
  ]
    .filter(Boolean)
    .join(' · ')
}
