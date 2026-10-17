import { automaticCleanupProtectionForRow } from '../automatic-session-cleanup-protection'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'
import { getConnectionIdFromState } from '../connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '../worktree-runtime-owner'
import { buildSessionManageSidebarRows } from '../session-manage-sidebar-rows'

/** Sessions the idle timers never touch because a person kept them: saved or pinned rows. */
export type IdleKeptSessions = { paneKeys: Set<string>; tabIds: Set<string> }

/** A pinned tab, or any tab of a pinned workspace. Store reads only, so it is always available. */
export function isPinnedTabOrWorkspace(
  state: AppState,
  worktreeId: string,
  tabId: string
): boolean {
  return (
    isUnifiedTabPinned(state, worktreeId, tabId) ||
    state.getKnownWorktreeById?.(worktreeId)?.isPinned === true
  )
}

/**
 * Saved (Saved Sessions) and pinned rows as the sidebar lists them. `null` when the sidebar could
 * not be read: every caller then keeps everything, because unknown means keep. The projection is
 * heavy, so callers read it only once a rule has a candidate.
 */
export async function readKeptSessions(state: AppState): Promise<IdleKeptSessions | null> {
  try {
    const kept: IdleKeptSessions = { paneKeys: new Set(), tabIds: new Set() }
    for (const row of buildSessionManageSidebarRows(state)) {
      if (!automaticCleanupProtectionForRow(state, row, Date.now())) {
        continue
      }
      if (row.paneKey) {
        kept.paneKeys.add(row.paneKey)
      }
      // Why: a pin covers the whole tab; a saved conversation without a pane is its tab.
      if (row.tabId && (row.pinned || !row.paneKey)) {
        kept.tabIds.add(row.tabId)
      }
    }
    return kept
  } catch (error) {
    console.warn('[idle-auto-close] could not read saved and pinned sessions:', error)
    return null
  }
}

/**
 * Workspaces whose terminals run on another computer (a runtime environment or SSH), whose owner
 * the window cannot name, or the floating terminal. The idle timers act on local ones only.
 */
export function getNonLocalWorktreeIds(state: AppState, worktreeIds: Iterable<string>): string[] {
  const nonLocal: string[] = []
  for (const worktreeId of worktreeIds) {
    if (
      worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
      getRuntimeEnvironmentIdForWorktree(state, worktreeId) !== null ||
      getConnectionIdFromState(state, worktreeId) !== null
    ) {
      nonLocal.push(worktreeId)
    }
  }
  return nonLocal
}

/**
 * Anything agent-related in a workspace: a live agent row, a retained (finished) agent card, a
 * sleeping record, an agent launch config or a foreground agent, by worktree id or by one of its
 * tabs' pane keys. R2's workspace stop (the store's Sleep) drops all of these, so R2 only sleeps a
 * workspace that holds none of them; a workspace with agents is R1's.
 */
export function workspaceHoldsAgentState(state: AppState, worktreeId: string): boolean {
  const prefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const ownsPane = (paneKey: string): boolean =>
    prefixes.some((prefix) => paneKey.startsWith(prefix))
  const ownsRow = ([paneKey, row]: [string, { worktreeId?: string } | undefined]): boolean =>
    row?.worktreeId === worktreeId || ownsPane(paneKey)
  return (
    Object.entries(state.agentStatusByPaneKey ?? {}).some(ownsRow) ||
    Object.entries(state.retainedAgentsByPaneKey ?? {}).some(ownsRow) ||
    Object.entries(state.sleepingAgentSessionsByPaneKey ?? {}).some(ownsRow) ||
    Object.keys(state.agentLaunchConfigByPaneKey ?? {}).some(ownsPane) ||
    Object.keys(state.paneForegroundAgentByPaneKey ?? {}).some(ownsPane)
  )
}
