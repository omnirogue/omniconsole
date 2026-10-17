import type { SessionAgentTemplate } from '../../../../shared/session-agent-template'
import { getTerminalTabOwnerWorktreeId } from '../slices/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

/** Structured launches name their tab before the host mirror creates it. */
const pendingByTabId = new Map<string, SessionAgentTemplate>()

/** The template a launch recorded for a structured tab the mirror has not created yet. */
export function pendingTabAgentTemplate(tabId: string): SessionAgentTemplate | undefined {
  return pendingByTabId.get(tabId)
}

export function createTerminalTabAgentTemplateActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'setTabAgentTemplate'> {
  return {
    setTabAgentTemplate: (tabId, template) => {
      set((s) => {
        const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        if (ownerWorktreeId) {
          const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
          return {
            tabsByWorktree: {
              ...s.tabsByWorktree,
              [ownerWorktreeId]: tabs.map((tab) =>
                tab.id === tabId ? { ...tab, agentTemplate: template } : tab
              )
            }
          }
        }
        for (const [worktreeId, tabs] of Object.entries(s.unifiedTabsByWorktree)) {
          if (tabs.some((tab) => tab.id === tabId && tab.contentType === 'agent-session')) {
            return {
              unifiedTabsByWorktree: {
                ...s.unifiedTabsByWorktree,
                [worktreeId]: tabs.map((tab) =>
                  tab.id === tabId ? { ...tab, agentTemplate: template } : tab
                )
              }
            }
          }
        }
        pendingByTabId.set(tabId, template)
        return s
      })
    }
  }
}
