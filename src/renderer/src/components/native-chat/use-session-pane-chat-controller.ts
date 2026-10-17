import { useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import {
  publishSessionPaneChatController,
  removeSessionPaneChatController,
  sessionPaneChatKey
} from '@/lib/session-pane-chat-controller'
import type { useStructuredAgentSession } from './use-structured-agent-session'

/** Shares the mounted viewer's capabilities with its island, without a second hold or reader. */
export function useSessionPaneChatController(
  props: { worktreeId: string; tabId: string; viewer?: boolean; isVisible: boolean },
  controller: ReturnType<typeof useStructuredAgentSession>
): void {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  const hostId = useAppStore((state) => {
    if (!enabled || !props.viewer) {
      return null
    }
    const tab = state.unifiedTabsByWorktree[props.worktreeId]?.find(
      (entry) => entry.id === props.tabId
    )
    return sidebarSessionWorkspace(state, props.worktreeId, tab?.executionHostId).hostId
  })
  const key = sessionPaneChatKey(hostId, props.worktreeId, props.tabId)
  const owner = useRef(Symbol('session-pane-chat'))
  const active = useRef(false)
  const latest = useRef({ key, controller, visible: props.isVisible })
  useLayoutEffect(() => {
    latest.current = { key, controller, visible: props.isVisible }
  })
  useLayoutEffect(() => {
    if (!enabled || !props.viewer) {
      return
    }
    publishSessionPaneChatController(key, owner.current, {
      writable:
        props.isVisible &&
        controller.writable &&
        (!(controller.isWorking || controller.outbox.length > 0) ||
          controller.supportsLiveInput === true),
      needsYou: controller.prompts.length,
      messages: controller.messages,
      send: (text) => {
        const current = latest.current
        const session = current.controller
        return (
          active.current &&
          current.key === key &&
          current.visible &&
          session.writable &&
          (!(session.isWorking || session.outbox.length > 0) ||
            session.supportsLiveInput === true) &&
          session.send(text, [])
        )
      }
    })
  }, [enabled, props.viewer, props.isVisible, key, controller])
  useLayoutEffect(() => {
    active.current = enabled && props.viewer === true
    const publisher = owner.current
    return () => {
      active.current = false
      removeSessionPaneChatController(key, publisher)
    }
  }, [key, enabled, props.viewer])
}
