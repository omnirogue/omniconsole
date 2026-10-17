import { parseWorkspaceKey } from './workspace-scope'

/** The task binding used by ordinary workspace launches on both sides of IPC. */
export function workspaceLaunchTaskId(
  worktreeId: string,
  linkedTaskId: string | null | undefined,
  folders: readonly { id: string; linkedTask?: { hubTaskId?: string | null } | null }[]
): string | undefined {
  const scope = parseWorkspaceKey(worktreeId)
  const folderId = scope?.type === 'folder' ? scope.folderWorkspaceId : worktreeId
  return (
    linkedTaskId ??
    folders.find((folder) => folder.id === folderId)?.linkedTask?.hubTaskId ??
    undefined
  )
}
