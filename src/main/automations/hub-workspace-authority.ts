import type { Store } from '../persistence'
import { getAutomationHubRefusal } from '../../shared/automation-hub-authority'
import type { ExecutionHostId } from '../../shared/execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'

export function getAutomationWorkspaceHubRefusal(
  store: Pick<Store, 'getWorktreeMeta' | 'getFolderWorkspaces'> &
    Partial<Pick<Store, 'getWorktreeMetaForHost'>>,
  workspaceId: string | null | undefined,
  executionHostId?: ExecutionHostId
): string | null {
  if (!workspaceId) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceId)
  const folderId = scope?.type === 'folder' ? scope.folderWorkspaceId : workspaceId
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const meta =
    executionHostId && store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, executionHostId)
      : store.getWorktreeMeta(worktreeId)
  return getAutomationHubRefusal(
    meta?.linkedWorkItem?.hubTaskId ??
      store.getFolderWorkspaces().find((workspace) => workspace.id === folderId)?.linkedTask
        ?.hubTaskId
  )
}
