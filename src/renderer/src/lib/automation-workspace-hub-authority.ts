import { useAppStore } from '@/store'
import { assertAutomationHubAuthority } from '../../../shared/automation-hub-authority'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

export function assertAutomationWorkspaceAuthority(
  workspaceId: string | null,
  paneKey?: string
): void {
  if (!workspaceId) {
    return
  }
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(workspaceId)
  const hubTaskId =
    scope?.type === 'folder'
      ? state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)?.linkedTask
          ?.hubTaskId
      : state.allWorktrees().find((entry) => entry.id === workspaceId)?.linkedWorkItem?.hubTaskId
  assertAutomationHubAuthority(hubTaskId)
  if (paneKey) {
    assertAutomationHubAuthority(
      state.agentLaunchConfigByPaneKey?.[paneKey]?.launchConfig.agentEnv?.OMNI_TASK_ID
    )
  }
}
