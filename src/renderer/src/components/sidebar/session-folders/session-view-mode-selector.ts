import { resolveNativeChatOwnerLeafId } from '@/components/native-chat/native-chat-leaf-routing'
import { useNativeChatLeafState } from '@/components/native-chat/native-chat-leaf-state'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { nativeChatEnabledByPreference } from '../../../../../shared/native-chat-preference'
import { getCachedUnifiedTerminalTabForWorktree } from '@/components/terminal-pane/terminal-unified-tab-lookup'

type SessionIdentity = Pick<SidebarSession, 'kind' | 'worktreeId' | 'tabId'> & {
  paneKey?: string | null
}

export function createSessionViewModeSelector(
  { kind, worktreeId, tabId, paneKey }: SessionIdentity,
  chatLeafId?: string | null
) {
  return (
    state: Pick<AppState, 'settings' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'>
  ): 'chat' | 'terminal' => {
    if (kind === 'structured') {
      return 'chat'
    }
    const tab = tabId
      ? getCachedUnifiedTerminalTabForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId)
      : null
    const owner = resolveNativeChatOwnerLeafId(
      chatLeafId,
      tabId ? state.terminalLayoutsByTabId[tabId] : null
    )
    return nativeChatEnabledByPreference(state.settings) &&
      tab?.viewMode === 'chat' &&
      (!paneKey || (tabId && owner && paneKey === `${tabId}:${owner}`))
      ? 'chat'
      : 'terminal'
  }
}

export function useSessionViewMode({ kind, worktreeId, tabId, paneKey }: SessionIdentity) {
  const chatLeafId = useNativeChatLeafState((state) =>
    tabId ? state.nativeChatLeafByTabId[tabId] : null
  )
  const selector = useMemo(
    () => createSessionViewModeSelector({ kind, worktreeId, tabId, paneKey }, chatLeafId),
    [kind, worktreeId, tabId, paneKey, chatLeafId]
  )
  return useAppStore(selector)
}
