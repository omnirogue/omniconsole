import { isSidebarSessionOnScreen, type OnScreenSession } from './sidebar-session-on-screen'
import type { SidebarSession } from './sidebar-sessions'

/** Pane hints are usable only with resolved execution ownership. */
export function selectGridDefaultSession(
  sessions: readonly SidebarSession[],
  attention: readonly {
    paneKey: string
    stateChangedAt: number
    hostId: SidebarSession['hostId']
  }[],
  current: OnScreenSession & { hostId: SidebarSession['hostId'] }
): SidebarSession | null {
  const available = sessions.filter((session) => !session.unavailable)
  for (const pane of [...attention].sort(
    (left, right) => right.stateChangedAt - left.stateChangedAt
  )) {
    const session = available.find(
      (row) => pane.hostId !== null && row.hostId === pane.hostId && row.paneKey === pane.paneKey
    )
    if (session) {
      return session
    }
  }
  return (
    available.find(
      (row) =>
        current.hostId !== null &&
        row.hostId === current.hostId &&
        row.worktreeId === current.worktreeId &&
        isSidebarSessionOnScreen(row, current)
    ) ?? null
  )
}
