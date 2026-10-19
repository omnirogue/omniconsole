import { useSessionFolders } from '@/store/session-folders'
import { conversationViewKey } from './conversation-view'
import type { SidebarSession } from './sidebar-sessions'

/**
 * Why (Sal, 2026-10-19): "agent sessions [are] separate from human sessions and human started
 * sessions stay open until we close them." A launch an agent made is noted on the computer that
 * runs it; its window lists it in Agent sessions, and only such sessions are cleaned up unasked.
 */
export function markAgentSession(session: SidebarSession): boolean {
  const folders = useSessionFolders.getState()
  if (!folders.loaded) {
    folders.load()
  }
  const marked = useSessionFolders.getState().markAgentSession(conversationViewKey(session))
  if (!marked) {
    throw new Error(useSessionFolders.getState().error ?? 'Could not note the agent session.')
  }
  return true
}
