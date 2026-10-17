import type { AutomationCreateInput } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { assertAutomationHubAuthority } from '../../../shared/automation-hub-authority'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getAllWorktreeMetaForHost } from '../loading-store/worktree-identity-metadata'

export function assertWorkspaceAutomationAuthority(
  state: PersistedState,
  automation: Pick<AutomationCreateInput, 'projectId' | 'workspaceMode' | 'workspaceId'>
): void {
  if (automation.workspaceMode !== 'existing' || !automation.workspaceId) {
    return
  }
  const repo = state.repos.find((entry) => entry.id === automation.projectId)
  const worktreeMeta = getAllWorktreeMetaForHost({ state }, getRepoExecutionHostId(repo ?? {}))
  const scope = parseWorkspaceKey(automation.workspaceId)
  const folderId = scope?.type === 'folder' ? scope.folderWorkspaceId : automation.workspaceId
  const hubTaskId =
    worktreeMeta[automation.workspaceId]?.linkedWorkItem?.hubTaskId ||
    state.folderWorkspaces.find((entry) => entry.id === folderId)?.linkedTask?.hubTaskId
  assertAutomationHubAuthority(hubTaskId)
}
