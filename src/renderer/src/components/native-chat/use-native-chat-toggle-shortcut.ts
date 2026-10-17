import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveNativeChatActiveLayoutLeafId,
  resolveNativeChatOwnerLeafId
} from './native-chat-leaf-routing'
import { useNativeChatLeafState } from './native-chat-leaf-state'
import { switchNativeChatView } from './switch-native-chat-view'
import { useEffect } from 'react'
import { useAppStore } from '../../store'
import { isMacPlatform, matchesNativeChatToggleShortcut } from './native-chat-shortcut'
import { resolveNativeChatTabToggle } from './native-chat-tab-toggle'

export { resolveNativeChatToggleShortcutDetectedAgent } from './native-chat-tab-toggle'

/** Toggles the active worktree's focused agent-terminal tab between the terminal
 *  and native chat views via the keyboard. Gated to the active worktree so only
 *  one listener acts at a time, and to agent terminals so the chord is inert on
 *  plain shells / non-terminal surfaces. */
export function useNativeChatToggleShortcut(worktreeId: string, isWorktreeActive: boolean): void {
  useEffect(() => {
    if (!isWorktreeActive) {
      return
    }
    const isMac = isMacPlatform()
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || !matchesNativeChatToggleShortcut(e, isMac)) {
        return
      }
      const state = useAppStore.getState()
      const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
      const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === activeGroupId)
      if (!group?.activeTabId) {
        return
      }
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.id === group.activeTabId
      )
      if (tab?.contentType !== 'terminal') {
        return
      }
      const layout = state.terminalLayoutsByTabId[tab.entityId]
      const leafId = resolveNativeChatActiveLayoutLeafId(layout)
      if (!leafId) {
        return
      }
      const toggle = resolveNativeChatTabToggle(state, worktreeId, tab.id, leafId)
      const owner = resolveNativeChatOwnerLeafId(
        useNativeChatLeafState.getState().nativeChatLeafByTabId[tab.entityId],
        layout
      )
      const leafIsChat = toggle?.isChat && owner === leafId
      if (!toggle || (!leafIsChat && !toggle.eligible)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      switchNativeChatView(worktreeId, toggle.unifiedTabId, leafIsChat ? 'terminal' : 'chat', {
        paneKey: makePaneKey(tab.entityId, leafId)
      })
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [worktreeId, isWorktreeActive])
}
