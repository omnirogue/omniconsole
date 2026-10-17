import { useEffect, useMemo } from 'react'
import { conversationViewKey } from '@/lib/conversation-view'
import { isSidebarSessionOnScreen, type OnScreenSession } from '@/lib/sidebar-session-on-screen'
import {
  parseWorkspaceOnScreenSignature,
  portalOnScreenTargets,
  selectWorkspaceOnScreenSignature,
  type OnScreenSessionTarget
} from '@/lib/sidebar-sessions-on-screen'
import {
  useActivityTerminalPortals,
  viewHostsTerminalPortals
} from '@/components/activity/activity-terminal-portal'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionSelection } from '@/store/session-selection'

/**
 * The checkmark follows the conversation on the main screen. Returns the on-screen row's key.
 *
 * Why only on a change of screen, and never over an explicit selection: a deliberate
 * multi-select (or the Add next batch) belongs to the person, and a plain click already picks
 * the row it opens — so this lands on the same key and writes nothing, never fighting it.
 */
export function useSelectionFollowsScreen(
  sessions: readonly SidebarSession[],
  screen: OnScreenSession
): string | null {
  const { worktreeId, tabId, leafId = null } = screen
  const currentKey = useMemo(() => {
    if (!tabId) {
      return null
    }
    const current = sessions.find((session) =>
      isSidebarSessionOnScreen(session, { worktreeId, tabId, leafId })
    )
    return current ? conversationViewKey(current) : null
  }, [sessions, worktreeId, tabId, leafId])

  useSelectionFollowsRow(currentKey)

  return currentKey
}

/**
 * The checkmark follows the row on the main screen (a conversation's or a routine's key).
 * Why only on a change of screen, and never over an explicit selection: see above.
 * `listed` re-applies it when the row shows again: a folded group prunes its rows from the
 * selection, so a row that moved into a folded group lost its checkmark for good.
 */
export function useSelectionFollowsRow(currentKey: string | null, listed = true): void {
  useEffect(() => {
    if (!currentKey || !listed) {
      return
    }
    const selection = useSessionSelection.getState()
    if (selection.explicit) {
      return
    }
    if (selection.keys.length === 1 && selection.keys[0] === currentKey) {
      return
    }
    selection.setGesture(
      { selected: new Set([currentKey]), anchor: currentKey, focus: currentKey },
      false
    )
  }, [currentKey, listed])
}

const NO_TARGETS: readonly OnScreenSessionTarget[] = []

/**
 * Every conversation on the main screen, the focused one marked: each split group's front tab
 * in the workspace view, or the terminals a full-page view (Grid, Attention…) borrows.
 */
export function useOnScreenSidebarSessions(): readonly OnScreenSessionTarget[] {
  const activeView = useAppStore((state) => state.activeView)
  // Why a string selector: a fresh array from a store selector re-renders forever.
  const signature = useAppStore(selectWorkspaceOnScreenSignature)
  const commandCenter = useAppStore((state) => state.settings?.commandCenter === true)
  const portals = useActivityTerminalPortals(viewHostsTerminalPortals(activeView), commandCenter)
  return useMemo(() => {
    if (activeView === 'terminal') {
      return parseWorkspaceOnScreenSignature(signature)
    }
    return portals.length > 0 ? portalOnScreenTargets(portals) : NO_TARGETS
  }, [activeView, portals, signature])
}
