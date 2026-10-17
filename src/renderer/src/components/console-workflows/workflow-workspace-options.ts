import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

export type WorkflowWorkspaceOption = { value: string; label: string }

/** The same workspace choices the explicit local start offers, in the same order. */
export function workflowWorkspaceOptions(
  worktrees: readonly Worktree[],
  folders: readonly FolderWorkspace[]
): WorkflowWorkspaceOption[] {
  return [...worktrees, ...folders.map(folderWorkspaceToWorktree)].map((workspace) => ({
    value: toRuntimeWorktreeSelector(workspace.id),
    label: workspace.displayName || workspace.branch || workspace.path
  }))
}
