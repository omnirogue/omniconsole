import type { SidebarSession } from './sidebar-sessions'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'

/** The key a row's live agent status is published under: its pane, or a structured chat's own. */
export function sidebarSessionStatusKey(
  session: Pick<SidebarSession, 'paneKey'> & Partial<Pick<SidebarSession, 'kind' | 'tabId'>>
): string | null {
  return sidebarSessionSourceIdentity(session)?.sourceKey ?? null
}

export function sidebarSessionSourceIdentity(
  session: Pick<SidebarSession, 'paneKey'> & Partial<Pick<SidebarSession, 'kind' | 'tabId'>>
): { sourceKey: string; sessionRef: string } | null {
  if (session.paneKey) {
    return { sourceKey: session.paneKey, sessionRef: session.paneKey }
  }
  const prefix = 'structured-agent-session-'
  if (session.kind !== 'structured' || !session.tabId?.startsWith(prefix)) {
    return null
  }
  const sessionId = session.tabId.slice(prefix.length)
  if (!sessionId || structuredAgentSessionTabId(sessionId) !== session.tabId) {
    return null
  }
  return {
    sourceKey: structuredAgentSessionPaneKey(session.tabId, sessionId),
    sessionRef: sessionId
  }
}
