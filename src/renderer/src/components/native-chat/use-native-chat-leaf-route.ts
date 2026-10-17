import { useCallback } from 'react'
import { useNativeChatLeaf } from './native-chat-leaf-state'
import type { NativeChatLeafRoute } from './native-chat-leaf-routing'
import { switchNativeChatView } from './switch-native-chat-view'

export function useNativeChatLeafRoute(
  worktreeId: string,
  unifiedTabId: string | null | undefined,
  tabId: string
) {
  const [chatLeafId, setChatLeafId] = useNativeChatLeaf(tabId)
  return useCallback(
    (route: NativeChatLeafRoute) => {
      if (route.chatLeafId !== chatLeafId) {
        setChatLeafId(route.chatLeafId)
      }
      if (route.exitChat && unifiedTabId) {
        // Lifecycle exit (owning pane closed/rebound), not a user toggle: skip telemetry.
        switchNativeChatView(worktreeId, unifiedTabId, 'terminal', {
          focus: false,
          emitTelemetry: false
        })
      }
    },
    [chatLeafId, setChatLeafId, worktreeId, unifiedTabId]
  )
}
