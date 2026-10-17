import { useAppStore } from '@/store'
import { sessionWorkOwner } from '@/components/native-chat/session-work-owner'
import { buildPaneSessions, type SidebarSessionSource } from './sidebar-sessions'
import { conversationSourceForSession } from './conversation-source-for-session'
import type { ConversationSource } from '../../../shared/conversation-source'
import { upNextAddressForSession, type UpNextAddress } from './up-next-address'

/**
 * The conversation a pane is, read at the moment a command is typed.
 *
 * Why not the hook: `/next` is answered inside a keystroke handler, so this cannot
 * be a subscription. It reads the SAME projection the strip reads — the sidebar row
 * that owns this pane, then `conversationSourceForSession` — so the address a typed
 * command queues to and the address the strip shows are the same string, including
 * its refusal to address a conversation owned by another execution host.
 */
export function conversationSourceForPane(
  paneKey: string,
  tabId: string
): ConversationSource | null {
  const sessions = buildPaneSessions(useAppStore.getState() as unknown as SidebarSessionSource)
  const owner = sessionWorkOwner(sessions, paneKey, tabId)
  return owner ? conversationSourceForSession(owner) : null
}

/** A typed command captures its execution owner and address together at submission. */
export function upNextAddressForPane(paneKey: string, tabId: string): UpNextAddress | null {
  const sessions = buildPaneSessions(useAppStore.getState() as unknown as SidebarSessionSource)
  const candidates = sessions.filter(
    (session) =>
      session.paneKey === paneKey || (session.kind === 'structured' && session.tabId === tabId)
  )
  return candidates.length === 1 ? upNextAddressForSession(candidates[0]!) : null
}
