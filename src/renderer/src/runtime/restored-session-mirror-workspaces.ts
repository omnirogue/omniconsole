import type { AppState } from '@/store/types'
import { isWebOnlyMirroredTerminalTab } from '../../../shared/terminal-surface-id'
import { getCatalogRuntimeOwnerEnvironmentId } from '@/lib/session-inventory-workspace-provenance'
import { createMirroredTerminalOwnerResolver } from './web-session-mirror-owner'
import { createCatalogOwnedClientRowClaim } from './web-session-catalog-owned-rows'
import {
  isMirrorPaneSleepingRecord,
  mirrorRecordOwnerEnvironmentId,
  sleepingRecordTabId
} from './web-session-mirror-sleeping-records'

/**
 * A restored web-only mirror row that is provably `environmentId`'s: its own evidence (remote
 * PTYs, the saved unified-tab stamp) names it, or it carries none and the saved catalog credits
 * the workspace to it. Never decided by which host a window has open.
 */
function isRestoredMirrorRowOf(
  state: AppState,
  tab: AppState['tabsByWorktree'][string][number],
  owner: ReturnType<ReturnType<typeof createMirroredTerminalOwnerResolver>>,
  catalogOwner: string | null,
  environmentId: string
): boolean {
  return (
    isWebOnlyMirroredTerminalTab(tab, state.terminalLayoutsByTabId[tab.id]) &&
    (owner.kind === 'owned'
      ? owner.environmentId === environmentId
      : owner.kind === 'unknown' && catalogOwner === environmentId) &&
    !tab.conversationLaunchPending &&
    !state.pendingStartupByTabId[tab.id]
  )
}

/**
 * Workspaces holding restored mirror rows of `environmentId`, with just those rows.
 *
 * Why only that environment's rows: removal frames are owner-scoped (an environment's removal
 * drops only rows that are its own), so a workspace that also holds another owner's rows no
 * longer has to be skipped; the environment's own omission from its inventory is the evidence.
 * Restored conversation copies under client-minted ids count too when the catalog credits the
 * workspace to it (web-session-catalog-owned-rows), so a restart cannot keep them past the
 * first complete inventory.
 */
export function captureRestoredSessionMirrorWorkspaces(state: AppState, environmentId: string) {
  const withRows = captureRestoredMirrorRowWorkspaces(state, environmentId)
  const covered = new Set(withRows.map(({ worktree }) => worktree))
  return [
    ...withRows,
    // Why: a workspace whose only trace here is this environment's mirror-pane records (its tabs
    // gone, the records restored from the saved session) is retired by the same inventory evidence;
    // its removal frame drops those records (web-session-mirror-sleeping-records).
    ...[...workspacesWithOwnedMirrorRecords(state, environmentId)]
      .filter((worktree) => !covered.has(worktree))
      .map((worktree) => ({
        worktree,
        tabs: state.tabsByWorktree[worktree],
        rows: [] as AppState['tabsByWorktree'][string],
        layouts: [] as (AppState['terminalLayoutsByTabId'][string] | undefined)[],
        unifiedTabs: state.unifiedTabsByWorktree[worktree],
        browserTabs: state.browserTabsByWorktree[worktree]
      }))
  ]
}

function workspacesWithOwnedMirrorRecords(state: AppState, environmentId: string): Set<string> {
  const worktrees = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey ?? {})) {
    const tabId = sleepingRecordTabId(record)
    if (
      tabId !== null &&
      isMirrorPaneSleepingRecord(record) &&
      mirrorRecordOwnerEnvironmentId(
        tabId,
        getCatalogRuntimeOwnerEnvironmentId(state, record.worktreeId)
      ) === environmentId
    ) {
      worktrees.add(record.worktreeId)
    }
  }
  return worktrees
}

function captureRestoredMirrorRowWorkspaces(state: AppState, environmentId: string) {
  return Object.entries(state.tabsByWorktree).flatMap(([worktree, tabs]) => {
    const ownerOf = createMirroredTerminalOwnerResolver(state, worktree)
    const catalogOwner = getCatalogRuntimeOwnerEnvironmentId(state, worktree)
    const claimsClientRow = createCatalogOwnedClientRowClaim(
      state,
      worktree,
      environmentId,
      catalogOwner
    )
    const rows = tabs.filter(
      (tab) =>
        isRestoredMirrorRowOf(state, tab, ownerOf(tab), catalogOwner, environmentId) ||
        claimsClientRow(tab)
    )
    if (rows.length === 0) {
      return []
    }
    return [
      {
        worktree,
        tabs,
        rows,
        layouts: rows.map((tab) => state.terminalLayoutsByTabId[tab.id]),
        unifiedTabs: state.unifiedTabsByWorktree[worktree],
        browserTabs: state.browserTabsByWorktree[worktree]
      }
    ]
  })
}

export function restoredSessionMirrorWorkspaceIsUnchanged(
  state: AppState,
  _environmentId: string,
  baseline: ReturnType<typeof captureRestoredSessionMirrorWorkspaces>[number]
): boolean {
  return (
    state.tabsByWorktree[baseline.worktree] === baseline.tabs &&
    state.unifiedTabsByWorktree[baseline.worktree] === baseline.unifiedTabs &&
    state.browserTabsByWorktree[baseline.worktree] === baseline.browserTabs &&
    baseline.rows.every(
      (tab, index) =>
        state.terminalLayoutsByTabId[tab.id] === baseline.layouts[index] &&
        !state.pendingStartupByTabId[tab.id]
    )
  )
}
