import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'

/** Keep a computer-scoped launch from inheriting an open tab owned by another computer. */
export function selectedComputerWorkspace(
  state: Omit<WorktreeRuntimeOwnerState, 'folderWorkspaces'> & {
    folderWorkspaces?: readonly FolderWorkspace[]
  },
  environmentId: string | null | undefined
): string | null {
  if (!environmentId) {
    return null
  }
  const hostId = `runtime:${encodeURIComponent(environmentId)}`
  if (
    state.activeWorktreeId &&
    getExecutionHostIdForWorktree(state, state.activeWorktreeId) === hostId
  ) {
    return state.activeWorktreeId
  }
  const folders = (state.folderWorkspaces ?? []).filter(
    (folder) => !folder.isArchived && folder.executionHostId === hostId
  )
  const work = folders.find((folder) => folder.name === 'Work') ?? folders[0]
  return work ? folderWorkspaceKey(work.id) : null
}
