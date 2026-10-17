import type { SidebarSession } from '@/lib/sidebar-sessions'
import { structuredSessionFolderKey } from '@/lib/session-folder-identity'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'

export type StructuredSessionPaneTarget =
  | { kind: 'chat'; target: RuntimeClientTarget; sessionId: string; tabId: string }
  | { kind: 'missing-session' | 'owner-unverifiable' | 'open-on-owner' | 'identity-mismatch' }

export function resolveStructuredSessionPaneTarget(
  session: SidebarSession,
  tab: Tab | undefined,
  tabHostId: ExecutionHostId | null
): StructuredSessionPaneTarget {
  if (!session.structuredSessionId) {
    return { kind: 'missing-session' }
  }
  const host = parseExecutionHostId(session.hostId)
  if (!host) {
    return { kind: 'owner-unverifiable' }
  }
  if (host.kind === 'ssh' || !session.tabId || !tab) {
    return { kind: 'open-on-owner' }
  }
  if (
    session.kind !== 'structured' ||
    tab.contentType !== 'agent-session' ||
    tab.id !== session.tabId ||
    tab.worktreeId !== session.worktreeId ||
    tab.entityId !== session.structuredSessionId ||
    tabHostId !== host.id ||
    session.sessionKey !== structuredSessionFolderKey(host.id, session.structuredSessionId) ||
    (session.paneKey !== null &&
      session.paneKey !== structuredAgentSessionPaneKey(tab.id, tab.entityId))
  ) {
    return { kind: 'identity-mismatch' }
  }
  return {
    kind: 'chat',
    sessionId: tab.entityId,
    tabId: tab.id,
    target:
      host.kind === 'local'
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: host.environmentId }
  }
}
