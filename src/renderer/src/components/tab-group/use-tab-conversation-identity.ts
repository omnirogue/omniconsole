import { canRenderNativeChatForAgent } from '@/lib/native-chat-supported-agent'
import { useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { findTabSleepingAgentRecord } from '../native-chat/native-chat-tab-sleeping-record'

export function tabHasConversationIdentity(
  state: AppState,
  worktreeId: string,
  tab?: Tab | null
): boolean {
  if (tab?.contentType !== 'terminal') {
    return false
  }
  return Boolean(
    canRenderNativeChatForAgent(
      state.tabsByWorktree[worktreeId]?.find((terminal) => terminal.id === tab.entityId)
        ?.launchAgent
    ) ||
    Object.entries(state.agentStatusByPaneKey).some(
      ([paneKey, entry]) =>
        paneKey.startsWith(`${tab.entityId}:`) && canRenderNativeChatForAgent(entry.agentType)
    ) ||
    canRenderNativeChatForAgent(
      findTabSleepingAgentRecord(state.sleepingAgentSessionsByPaneKey ?? {}, tab.entityId)?.agent
    )
  )
}

type StickyRecord = { key: string; sticky: boolean }

export function useTabConversationIdentity(worktreeId: string, tab?: Tab | null): boolean {
  const hasAgent = useAppStore((state) => tabHasConversationIdentity(state, worktreeId, tab))
  const key = `${worktreeId}\u0000${tab?.id ?? ''}`
  const [record, setRecord] = useState<StickyRecord>({ key, sticky: hasAgent })
  // Why: adjust sticky state during render (not an effect) so a transient hook loss never
  // remounts the strip on a retained conversation; resets when the tab identity changes.
  if (record.key !== key) {
    setRecord({ key, sticky: hasAgent })
    return hasAgent
  }
  if (hasAgent && !record.sticky) {
    setRecord({ key, sticky: true })
    return true
  }
  return hasAgent || record.sticky
}
