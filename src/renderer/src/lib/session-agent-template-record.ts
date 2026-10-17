import { liveTabAgentTemplate, singlePaneTabAgentTemplate } from './tab-agent-template-attribution'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { SessionAgentTemplate } from '../../../shared/session-agent-template'

/** Adds recording the launch's agent template to a launch's `onSessionCreated`. */
export function recordingAgentTemplate(
  onSessionCreated: ((tabId: string) => void) | undefined,
  template: SessionAgentTemplate | undefined
): ((tabId: string) => void) | undefined {
  if (!template) {
    return onSessionCreated
  }
  return (tabId) => {
    useAppStore.getState().setTabAgentTemplate(tabId, template)
    onSessionCreated?.(tabId)
  }
}

/**
 * The agent template a session recorded at launch: a terminal tab keeps it on the tab (read only
 * for its launched agent, see liveTabAgentTemplate), a structured chat on its agent-session tab.
 * No record means the launch never said.
 */
export function recordedSessionAgentTemplate(
  state: {
    tabsByWorktree: Record<string, readonly TerminalTab[]>
    unifiedTabsByWorktree: Record<string, readonly Tab[]>
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  },
  session: Pick<SidebarSession, 'kind' | 'tabId' | 'worktreeId'>
): SessionAgentTemplate | undefined {
  if (!session.tabId) {
    return undefined
  }
  if (session.kind === 'structured') {
    return state.unifiedTabsByWorktree[session.worktreeId]?.find(
      (tab) => tab.id === session.tabId && tab.contentType === 'agent-session'
    )?.agentTemplate
  }
  return liveTabAgentTemplate(
    state.tabsByWorktree[session.worktreeId]?.find((tab) => tab.id === session.tabId),
    state.terminalLayoutsByTabId[session.tabId]
  )
}

/** The terminal tab's record even after its launched agent exited, for carrying it into a resume. */
export function resumableSessionAgentTemplate(
  state: {
    tabsByWorktree: Record<string, readonly TerminalTab[]>
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  },
  session: Pick<SidebarSession, 'kind' | 'tabId' | 'worktreeId'>
): SessionAgentTemplate | undefined {
  if (!session.tabId || session.kind === 'structured') {
    return undefined
  }
  return singlePaneTabAgentTemplate(
    state.tabsByWorktree[session.worktreeId]?.find((tab) => tab.id === session.tabId),
    state.terminalLayoutsByTabId[session.tabId]
  )
}
