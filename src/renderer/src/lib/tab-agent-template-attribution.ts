import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { SessionAgentTemplate } from '../../../shared/session-agent-template'

/** The tab's record, but only while the tab is one pane: a split pane never borrows it. */
export function singlePaneTabAgentTemplate(
  tab: TerminalTab | undefined,
  layout: TerminalLayoutSnapshot | undefined
): SessionAgentTemplate | undefined {
  if (!tab?.agentTemplate) {
    return undefined
  }
  return collectLeafIdsInOrder(layout?.root).filter(isTerminalLeafId).length > 1
    ? undefined
    : tab.agentTemplate
}

/**
 * Which template the tab's live session runs as. Like `launchAgent`, the record speaks only for the
 * launched agent: once that agent exits, a later agent in the same terminal reads Not recorded.
 */
export function liveTabAgentTemplate(
  tab: TerminalTab | undefined,
  layout: TerminalLayoutSnapshot | undefined
): SessionAgentTemplate | undefined {
  return tab?.launchAgent ? singlePaneTabAgentTemplate(tab, layout) : undefined
}

/** A synced snapshot carries no launch records, so each tab keeps the one this desktop made. */
export function keepLocalTabAgentTemplates(
  tabsByWorktree: Record<string, TerminalTab[]>,
  localTabsByWorktree: Record<string, readonly TerminalTab[]>
): Record<string, TerminalTab[]> {
  const local = new Map(
    Object.values(localTabsByWorktree)
      .flat()
      .filter((tab) => tab.agentTemplate)
      .map((tab) => [tab.id, tab.agentTemplate!])
  )
  if (local.size === 0) {
    return tabsByWorktree
  }
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const agentTemplate = local.get(tab.id)
        return agentTemplate && !tab.agentTemplate ? { ...tab, agentTemplate } : tab
      })
    ])
  )
}
