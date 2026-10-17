import type { RuntimeMobileSessionTabsRemovedResult } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import type { AppState } from '../store'
import { createMirroredTerminalOwnerResolver } from './web-session-mirror-owner'
import { registerRetiredEnvironmentMirrorRetraction } from './retired-environment-mirror-retraction'
import {
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsStorePatch,
  clearWebSessionTabsTrackingForEnvironment,
  listWebSessionTabsMappedWorktreeIds
} from './web-session-tabs-sync'
import { retractMirroredWorkflowEnvironment } from './web-session-workflow-records'
import { retractMirroredConversationEnvironment } from './web-session-conversation-ledger'

const RETIRED_ENVIRONMENT_EPOCH = 'environment-retired'

/** Workspaces where `environmentId` positively owns a mirrored row; others are left untouched. */
function collectMirroredWorktreeIds(state: AppState, environmentId: string): string[] {
  const worktreeIds = new Set(listWebSessionTabsMappedWorktreeIds(environmentId))
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const ownerOf = createMirroredTerminalOwnerResolver(state, worktreeId)
    if (
      tabs.some((tab) => {
        const owner = ownerOf(tab)
        return owner.kind === 'owned' && owner.environmentId === environmentId
      })
    ) {
      worktreeIds.add(worktreeId)
    }
  }
  for (const file of state.openFiles) {
    if (file.mirroredFromRuntimeSession === true && file.runtimeEnvironmentId === environmentId) {
      worktreeIds.add(file.worktreeId)
    }
  }
  const workspaceIdsWithPages = new Set(
    Object.values(state.browserPagesByWorkspace ?? {}).flatMap((pages) =>
      (pages ?? [])
        .filter(
          (page) => state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId === environmentId
        )
        .map((page) => page.workspaceId)
    )
  )
  for (const [worktreeId, workspaces] of Object.entries(state.browserTabsByWorktree)) {
    if ((workspaces ?? []).some((workspace) => workspaceIdsWithPages.has(workspace.id))) {
      worktreeIds.add(worktreeId)
    }
  }
  return [...worktreeIds]
}

/**
 * Retract every row mirrored from environments that just left the saved list (never a same-id
 * re-pair, whose subscription republishes the same rows). Each workspace gets
 * that environment's own removal frame, so owner buckets drop only its rows (terminals, structured
 * chats, editors, browser pages) and every other owner's rows stay. Mirror removal only retracts
 * visibility: no process is closed and no persisted conversation is deleted.
 */
export function retractMirroredSessionRowsForEnvironments(environmentIds: Iterable<string>): void {
  for (const environmentId of new Set(environmentIds)) {
    const worktreeIds = collectMirroredWorktreeIds(useAppStore.getState(), environmentId)
    if (worktreeIds.length > 0) {
      const frames = worktreeIds.map((worktree): RuntimeMobileSessionTabsRemovedResult => ({
        worktree,
        publicationEpoch: RETIRED_ENVIRONMENT_EPOCH,
        snapshotVersion: 0,
        removed: true,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }))
      const settle = applyWebSessionTabsStorePatch(
        (state) => applyWebSessionTabsSnapshots(state, frames, environmentId),
        // Why no frames: a retired environment's absence is not host evidence to settle on.
        { frames: [] }
      )
      settle()
    }
    clearWebSessionTabsTrackingForEnvironment(environmentId)
    retractMirroredWorkflowEnvironment(environmentId)
    retractMirroredConversationEnvironment(environmentId)
  }
}

registerRetiredEnvironmentMirrorRetraction(retractMirroredSessionRowsForEnvironments)
