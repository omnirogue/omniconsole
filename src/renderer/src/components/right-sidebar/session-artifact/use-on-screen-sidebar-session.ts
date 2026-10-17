import { useAppStore } from '@/store'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import {
  isSidebarSessionOnScreen,
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId
} from '@/lib/sidebar-session-on-screen'
import type { SidebarSession } from '@/lib/sidebar-sessions'

/** The sidebar row of the conversation on screen, whichever provider runs it; null for none. */
export function useOnScreenSidebarSession(): SidebarSession | null {
  const sessions = useSidebarSessions('pane')
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const tabId = useAppStore(selectOnScreenSessionTabId)
  const leafId = useAppStore(selectOnScreenSessionLeafId)
  return (
    sessions.find((row) => isSidebarSessionOnScreen(row, { worktreeId, tabId, leafId })) ?? null
  )
}
