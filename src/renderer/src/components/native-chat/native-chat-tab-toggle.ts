import type { AgentType } from '../../../../shared/agent-status-types'
import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import type { AppState } from '@/store/types'
import { canToggleNativeChat } from './native-chat-availability'
import { findTabSleepingAgentRecord } from './native-chat-tab-sleeping-record'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from './native-chat-leaf-routing'

export function resolveNativeChatToggleShortcutDetectedAgent({
  terminalTabId,
  terminalLayout,
  agentStatusByPaneKey
}: {
  terminalTabId: string
  terminalLayout?: TerminalLayoutSnapshot | null
  agentStatusByPaneKey: Record<string, { agentType?: AgentType }>
}): AgentType | null {
  const activeLeafId = resolveNativeChatActiveLayoutLeafId(terminalLayout)
  if (activeLeafId) {
    return agentStatusByPaneKey[`${terminalTabId}:${activeLeafId}`]?.agentType ?? null
  }
  if (!isNativeChatTabWideFallbackSafe(terminalLayout)) {
    return null
  }
  return (
    Object.entries(agentStatusByPaneKey).find(([paneKey]) =>
      paneKey.startsWith(`${terminalTabId}:`)
    )?.[1].agentType ?? null
  )
}

export type NativeChatTabToggle = {
  /** The unified tab id setTabViewMode/toggleTabViewMode take. */
  unifiedTabId: string
  isChat: boolean
  /** The tab may show the chat view (agent parseable, Chat UI on, transcript readable). */
  eligible: boolean
  /** Any agent is known for the tab; a plain shell has nothing to show as chat. */
  hasAgent: boolean
}

/**
 * One chat-eligibility answer for a terminal tab, shared by the keyboard chord and
 * every visible Chat / Terminal switch so they can never disagree. Switching only
 * changes the tab's view; the same PTY and agent session keep running.
 */
export function resolveNativeChatTabToggle(
  state: AppState,
  worktreeId: string,
  unifiedTabId: string,
  leafId?: string
): NativeChatTabToggle | null {
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === unifiedTabId
  )
  if (!tab || tab.contentType !== 'terminal') {
    return null
  }
  const terminalTab = (state.tabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.entityId
  )
  // Why: pane keys are `${entityId}:${leafId}` — the backing terminal tab id, not the unified tab id.
  const layout = state.terminalLayoutsByTabId[tab.entityId]
  const terminalLayout = layout && leafId ? { ...layout, activeLeafId: leafId } : layout
  const tabWideFallbackSafe = isNativeChatTabWideFallbackSafe(terminalLayout)
  const detectedAgent = resolveNativeChatToggleShortcutDetectedAgent({
    terminalTabId: tab.entityId,
    terminalLayout,
    agentStatusByPaneKey: state.agentStatusByPaneKey
  })
  const titleFallbackAgent = tabWideFallbackSafe
    ? (resolveCommittedTitleAgentType(tab.label ?? '') ??
      (terminalTab ? resolveCommittedTitleAgentType(terminalTab.title) : null))
    : null
  const isChat = tab.viewMode === 'chat'
  // Why: an exited agent drops its live row, title and (on pane close) launch hint
  // together; the resume checkpoint is what still says a conversation lives here.
  const checkpointAgent = findTabSleepingAgentRecord(
    state.sleepingAgentSessionsByPaneKey ?? {},
    tab.entityId
  )?.agent
  return {
    unifiedTabId: tab.id,
    isChat,
    hasAgent: Boolean(
      detectedAgent || terminalTab?.launchAgent || titleFallbackAgent || checkpointAgent
    ),
    eligible: canToggleNativeChat({
      experimentalNativeChatEnabled: nativeChatEnabledByPreference(state.settings),
      contentType: 'terminal',
      launchAgent:
        detectedAgent || !tabWideFallbackSafe
          ? null
          : (terminalTab?.launchAgent ?? checkpointAgent ?? null),
      detectedAgent,
      resolvedAgent: detectedAgent ? null : titleFallbackAgent,
      nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
        getConnectionIdFromState(state, worktreeId)
      ),
      isChatViewMode: isChat && !leafId
    })
  }
}

/** The unified tab hosting a terminal tab, for surfaces that only know the terminal tab id. */
export function findUnifiedTabIdForTerminalTab(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  worktreeId: string,
  terminalTabId: string
): string | null {
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === terminalTabId
    )?.id ?? null
  )
}
