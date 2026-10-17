import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { ConversationSource } from '../../../shared/conversation-source'
import type { SidebarSession } from './sidebar-sessions'
import { sidebarSessionSourceIdentity } from './sidebar-session-source-identity'

/**
 * The address of the conversation a sidebar row is showing.
 *
 * Local by default. A caller using a paired transport must name its execution host;
 * the returned address is local to that host and must travel on that same transport.
 */
export function conversationSourceForSession(
  session: SidebarSession,
  executionHostId: string = LOCAL_EXECUTION_HOST_ID
): ConversationSource | null {
  if ((session.hostId ?? LOCAL_EXECUTION_HOST_ID) !== executionHostId) {
    return null
  }
  if (session.kind === 'structured') {
    // Why the explicit null pane: the structured identity is minted from the
    // session id, and only the tab-id branch recovers that id.
    const identity = sidebarSessionSourceIdentity({
      paneKey: null,
      kind: 'structured',
      tabId: session.tabId
    })
    return identity
      ? {
          worktreeId: session.worktreeId,
          paneKey: identity.sourceKey,
          kind: 'structured',
          sessionId: identity.sessionRef
        }
      : null
  }
  return session.paneKey
    ? { worktreeId: session.worktreeId, paneKey: session.paneKey, kind: 'pty' }
    : null
}
