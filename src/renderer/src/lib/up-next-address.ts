import { parseExecutionHostId } from '../../../shared/execution-host'
import type { ConversationSource } from '../../../shared/conversation-source'
import type { SessionOutcomeRuntimeTarget } from '../../../shared/session-outcome-routing'
import type { SidebarSession } from './sidebar-sessions'
import { conversationSourceForSession } from './conversation-source-for-session'

export type UpNextAddress = {
  source: ConversationSource
  owner: SessionOutcomeRuntimeTarget
}

export function upNextAddressForSession(session: SidebarSession): UpNextAddress | null {
  const host = parseExecutionHostId(session.hostId ?? 'local')
  if (host?.kind !== 'local' && host?.kind !== 'runtime') {
    return null
  }
  const source = conversationSourceForSession(session, session.hostId ?? 'local')
  return source
    ? {
        source,
        owner:
          host.kind === 'runtime'
            ? { kind: 'environment', environmentId: host.environmentId }
            : { kind: 'local' }
      }
    : null
}
