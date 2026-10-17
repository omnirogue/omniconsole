import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { setNativeChatLeaf } from './native-chat-leaf-state'
import { commitNativeChatViewMode } from './commit-native-chat-view-mode'
import { useAppStore } from '@/store'
import { useCallback } from 'react'
import { focusNativeChatView } from './native-chat-view-focus'
import { resolveNativeChatTabToggle } from './native-chat-tab-toggle'

/** All entry points preserve the retained leaf, transcript and composer draft. */
export function switchNativeChatView(
  worktreeId: string,
  unifiedTabId: string,
  mode: 'chat' | 'terminal',
  options: { focus?: boolean; emitTelemetry?: boolean; paneKey?: string } = {}
): void {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === unifiedTabId)
  if (!tab || tab.contentType !== 'terminal') {
    return
  }
  const requestedPane = options.paneKey ? parsePaneKey(options.paneKey) : null
  if (options.paneKey && requestedPane?.tabId !== tab.entityId) {
    return
  }
  const leafId = requestedPane?.leafId ?? state.terminalLayoutsByTabId[tab.entityId]?.activeLeafId
  if (
    mode === 'chat' &&
    !resolveNativeChatTabToggle(state, worktreeId, unifiedTabId, requestedPane?.leafId)?.eligible
  ) {
    return
  }
  if (mode === 'chat' && leafId) {
    setNativeChatLeaf(tab.entityId, leafId)
  }
  commitNativeChatViewMode(state, worktreeId, tab, mode, options.emitTelemetry ?? true)
  if (options.focus === false) {
    return
  }
  focusNativeChatView(worktreeId, unifiedTabId, tab.entityId, leafId, mode)
}

export function useSwitchToTerminal(worktreeId: string, unifiedTabId: string | null | undefined) {
  return useCallback(() => {
    if (unifiedTabId) {
      switchNativeChatView(worktreeId, unifiedTabId, 'terminal')
    }
  }, [worktreeId, unifiedTabId])
}
