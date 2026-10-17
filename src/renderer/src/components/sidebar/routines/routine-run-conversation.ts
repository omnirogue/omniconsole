import type { AutomationRun } from '../../../../../shared/automations-types'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'

/** The newest observable run wins; an older live run still prevents a duplicate launch. */
export function routineRunConversation(
  runs: readonly AutomationRun[],
  sessions: readonly SidebarSession[]
): SidebarSession | undefined {
  for (const run of [...runs].sort((a, b) => b.createdAt - a.createdAt)) {
    const session = sessions.find((row) => {
      const pane = row.paneKey ? parsePaneKey(row.paneKey) : null
      const observedPty =
        pane &&
        useAppStore.getState().terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
      if (run.terminalPtyId && observedPty && run.terminalPtyId !== observedPty) {
        return false
      }
      if (run.workspaceId && row.worktreeId !== run.workspaceId) {
        return false
      }
      return Boolean(
        (run.terminalPaneKey && row.paneKey === run.terminalPaneKey) ||
        (run.terminalSessionId && row.tabId === run.terminalSessionId) ||
        (run.chatSessionId &&
          row.sessionKey === JSON.stringify([row.hostId, 'structured', run.chatSessionId]))
      )
    })
    if (session) {
      return session
    }
  }
  return undefined
}
