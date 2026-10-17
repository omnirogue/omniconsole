import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { splitWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

/**
 * Prep is controller-owned today. Prove its catalog and the selected workspace's route agree;
 * a paired mirror (including SSH through a paired HUB) cannot become a local request.
 */
export function sessionPrepDispatchSourceIn(
  state: WorktreeOperationRouteState,
  workspaceId: string
): string | null {
  const scope = parseWorkspaceKey(workspaceId)
  const id =
    scope?.type === 'folder'
      ? scope.folderWorkspaceId
      : scope?.type === 'worktree'
        ? scope.worktreeId
        : workspaceId
  const catalog =
    scope?.type === 'folder'
      ? state.folderWorkspaces?.filter((folder) => folder.id === id)
      : state.repos?.filter((repo) => repo.id === splitWorktreeId(id)?.repoId)
  if (catalog?.length !== 1) {
    return null
  }
  const owner = catalog[0]!
  const hostId = getRepoExecutionHostId(owner)
  if (hostId.startsWith('runtime:') || (hostId !== 'local' && !owner.connectionId)) {
    return null
  }
  const route = resolveWorktreeOperationRouteResult(state, workspaceId)
  if (
    route.kind !== 'resolved' ||
    route.route.runtimeEnvironmentId ||
    route.route.executionHostId !== hostId
  ) {
    return null
  }
  // The main-process folder catalog takes the bare id; navigation uses folder:<id>.
  return id
}
