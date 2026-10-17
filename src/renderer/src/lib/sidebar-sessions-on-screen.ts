import type { AppState } from '@/store'
import {
  isActivityTerminalPortalVisible,
  type ActivityTerminalPortalTarget
} from '@/components/activity/activity-terminal-portal'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  isSidebarSessionOnScreen,
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId,
  type OnScreenSession,
  type OnScreenSessionSource
} from './sidebar-session-on-screen'
import type { SidebarSession } from './sidebar-sessions'

/** A conversation on the main screen; `focused` marks the one the person is working in. */
export type OnScreenSessionTarget = OnScreenSession & { focused: boolean }

type WorkspaceOnScreenSource = OnScreenSessionSource & Partial<Pick<AppState, 'layoutByWorktree'>>

function collectLayoutGroupIds(node: TabGroupLayoutNode | undefined, out: string[]): string[] {
  if (!node) {
    return out
  }
  if (node.type === 'leaf') {
    out.push(node.groupId)
    return out
  }
  collectLayoutGroupIds(node.first, out)
  return collectLayoutGroupIds(node.second, out)
}

type EncodedTarget = [focused: boolean, tabId: string, leafId: string | null]

/**
 * Every conversation the workspace view shows — the front tab of each split group — as one
 * string. Why a string: a store selector must return a stable value, and a fresh array
 * re-renders forever.
 */
export function selectWorkspaceOnScreenSignature(state: WorkspaceOnScreenSource): string {
  const worktreeId = state.activeWorktreeId
  if (state.activeView !== 'terminal' || !worktreeId) {
    return ''
  }
  const targets: EncodedTarget[] = []
  const focusedTabId = selectOnScreenSessionTabId(state)
  if (focusedTabId) {
    targets.push([true, focusedTabId, selectOnScreenSessionLeafId(state)])
    // Why: the other panes split inside the focused tab are on screen as well.
    targets.push([false, focusedTabId, null])
  }
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const tabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  for (const groupId of collectLayoutGroupIds(state.layoutByWorktree?.[worktreeId], [])) {
    const group = groups.find((candidate) => candidate.id === groupId)
    const tab = group?.activeTabId
      ? tabs.find(
          (candidate) => candidate.id === group.activeTabId && candidate.groupId === groupId
        )
      : undefined
    const tabId =
      tab?.contentType === 'terminal'
        ? tab.entityId
        : tab?.contentType === 'agent-session'
          ? tab.id
          : null
    if (tabId && tabId !== focusedTabId) {
      targets.push([false, tabId, null])
    }
  }
  return targets.length > 0 ? JSON.stringify([worktreeId, targets]) : ''
}

export function parseWorkspaceOnScreenSignature(signature: string): OnScreenSessionTarget[] {
  if (!signature) {
    return []
  }
  const [worktreeId, targets] = JSON.parse(signature) as [string, EncodedTarget[]]
  return targets.map(([focused, tabId, leafId]) => ({ worktreeId, tabId, leafId, focused }))
}

/** What a full-page view (Grid, Attention, Activity…) shows: the terminals it borrows. */
export function portalOnScreenTargets(
  portals: readonly ActivityTerminalPortalTarget[]
): OnScreenSessionTarget[] {
  return portals.filter(isActivityTerminalPortalVisible).map((portal) => ({
    worktreeId: portal.worktreeId,
    tabId: portal.tabId,
    leafId: portal.paneKey ? (parsePaneKey(portal.paneKey)?.leafId ?? null) : null,
    focused: portal.active
  }))
}

/** 'focused' for the conversation being worked in, 'visible' for the others on screen. */
export function sidebarSessionScreenPresence(
  session: Pick<SidebarSession, 'tabId' | 'paneKey' | 'worktreeId'>,
  targets: readonly OnScreenSessionTarget[]
): 'focused' | 'visible' | null {
  let visible = false
  for (const target of targets) {
    if (!isSidebarSessionOnScreen(session, target)) {
      continue
    }
    if (target.focused) {
      return 'focused'
    }
    visible = true
  }
  return visible ? 'visible' : null
}
