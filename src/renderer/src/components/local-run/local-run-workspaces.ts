import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

/**
 * A workspace a graph can run on. Folders come first because a local Run needs nothing
 * but a folder of material; a git workspace is the same thing plus a repository, which
 * only matters for admitting work through the console.
 */
export type LocalRunWorkspaceOption = {
  /** Runtime selector, for the host probes that list a CLI's models. */
  value: string
  label: string
  /** Absolute folder path — what the graph itself stores and what a person reads. */
  path: string
  kind: 'folder' | 'git'
}

export function localRunWorkspaceOptions(
  worktrees: readonly Worktree[],
  folders: readonly FolderWorkspace[]
): LocalRunWorkspaceOption[] {
  return [
    ...folders.map(folderWorkspaceToWorktree).map((workspace) => option(workspace, 'folder')),
    ...worktrees.map((workspace) => option(workspace, 'git'))
  ].filter((entry) => entry.path)
}

function option(workspace: Worktree, kind: 'folder' | 'git'): LocalRunWorkspaceOption {
  return {
    value: toRuntimeWorktreeSelector(workspace.id),
    label: workspace.displayName || workspace.branch || workspace.path,
    path: workspace.path,
    kind
  }
}

export function findLocalRunWorkspace(
  options: readonly LocalRunWorkspaceOption[],
  selector: string
): LocalRunWorkspaceOption | null {
  return options.find((entry) => entry.value === selector) ?? null
}

/** The option whose folder path matches, for opening a draft from a workspace row. */
export function localRunWorkspaceByPath(
  options: readonly LocalRunWorkspaceOption[],
  path: string
): LocalRunWorkspaceOption | null {
  return options.find((entry) => entry.path === path) ?? null
}
