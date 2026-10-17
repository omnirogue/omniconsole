import type { SidebarSession } from '@/lib/sidebar-sessions'

/** A PTY leaf never borrows an adjacent agent's authority. ACP owns its tab without a PTY. */
export function sessionWorkOwner(
  sessions: readonly SidebarSession[],
  paneKey: string,
  tabId: string
) {
  return (
    sessions.find((session) => session.paneKey === paneKey) ??
    sessions.find((session) => session.kind === 'structured' && session.tabId === tabId)
  )
}
