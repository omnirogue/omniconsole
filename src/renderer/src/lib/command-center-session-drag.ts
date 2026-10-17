import { conversationViewKey } from './conversation-view'
import { sessionWorkspaceGroupKey } from './session-sidebar-tree'
import { beginSessionSidebarDrag, writeSessionSidebarDrag } from './session-sidebar-drag'
import type { SidebarSession } from './sidebar-sessions'

export function beginCommandCenterSessionDrag(data: DataTransfer, session: SidebarSession): void {
  const payload = { kind: 'row' as const, sessionKey: conversationViewKey(session) }
  data.effectAllowed = 'move'
  writeSessionSidebarDrag(data, payload)
  beginSessionSidebarDrag({ ...payload, workspaceGroupKey: sessionWorkspaceGroupKey(session) })
}
