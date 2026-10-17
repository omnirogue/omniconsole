import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { reviewedLaunchStart } from '@/components/sidebar/session-folders/new-conversation/reviewed-launch'
import type { LaunchPick } from '@/components/sidebar/session-folders/new-conversation/resolve-launch-plan'
import { selectedComputerWorkspace } from '@/components/sidebar/session-folders/new-conversation/selected-computer-workspace'
import { useConversationLaunch } from '@/components/sidebar/session-folders/new-conversation/use-conversation-launch'
import { useLauncherAccountRows } from '@/components/sidebar/session-folders/new-conversation/use-launcher-account-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import { translate } from '@/i18n/i18n'
import { launchProjectIn, projectWorkspaceIn, useLaunchProject } from '@/lib/project-launch'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'

export type ProjectFolderLaunch = {
  starting: boolean
  /** Where the launch runs: the project's workspace, the work root, or the selected computer's. */
  worktreeId: string | null
  local: boolean
  setReviewing: (reviewing: boolean) => void
  /** Starts a pick as the project's "+" would, through the launch review panel, filed by `onLaunched`. */
  start: (
    pick: LaunchPick | undefined,
    options: { templateId?: string; onLaunched: (tabId: string) => void }
  ) => void
}

/**
 * A launch from the project page that behaves as the project folder's "+": the project's home
 * workspace, inherited context, the review panel, and the new tab handed to `onLaunched`.
 */
export function useProjectFolderLaunch(
  folder: { id: string; name: string },
  viewModePreference?: 'chat' | 'terminal'
): ProjectFolderLaunch {
  const runtimeId = useAppStore((state) => state.settings?.activeRuntimeEnvironmentId)
  const computerWorkspace = useAppStore((state) =>
    selectedComputerWorkspace(state, state.settings?.activeRuntimeEnvironmentId)
  )
  const folderMetadata = useSessionFolders((state) => state.metadata)
  const projectWorkspace = useAppStore((state) =>
    projectWorkspaceIn(state, launchProjectIn(folderMetadata, folder.id))
  )
  // Why as the folder's "+": no project workspace means the work root, or the selected computer's.
  const defaultToWorkRoot = !runtimeId && !projectWorkspace
  const launchWorktreeId = projectWorkspace ?? (defaultToWorkRoot ? null : computerWorkspace)
  const [reviewing, setReviewing] = useState(false)
  const availability = useWorkAgentCapabilities(
    launchWorktreeId,
    undefined,
    'workspace-launch',
    true,
    reviewing
  )
  const target = useAgentDetectionTargetForWorktree(launchWorktreeId)
  const local = target?.kind === 'local' && !isWebRuntimeSessionActive(runtimeId)
  const accountEnvironmentId =
    target?.kind === 'runtime'
      ? target.environmentId
      : runtimeId && !launchWorktreeId
        ? runtimeId
        : null
  const { claude, codex } = useLauncherAccountRows(accountEnvironmentId)
  const missingComputerWorkspace = Boolean(runtimeId && !launchWorktreeId)
  const scope = useHandoffScope()
  const pending = useRef<((tabId: string) => void) | null>(null)
  const launch = useConversationLaunch({
    worktreeId: launchWorktreeId,
    defaultToWorkRoot,
    loading: availability.loading,
    refreshCapabilities: availability.refresh,
    scope,
    local,
    accountEnvironmentId,
    rows: { claude, codex },
    readCapabilities: missingComputerWorkspace ? () => [] : availability.readCurrent,
    setOpen: () => undefined,
    ...(viewModePreference ? { viewModePreference } : {}),
    onLaunched: (tabId) => pending.current?.(tabId)
  })
  return {
    starting: launch.starting || reviewing,
    worktreeId: launchWorktreeId,
    local,
    setReviewing,
    start: (pick, options) => {
      if (missingComputerWorkspace) {
        toast.error(
          translate(
            'computerPicker.needsWorkspace',
            'Add a workspace on this computer to start a session.'
          )
        )
        return
      }
      // Why on start: the launch inherits the project the way its "+" does (project-launch.ts).
      useLaunchProject.getState().open(folder.id)
      pending.current = options.onLaunched
      reviewedLaunchStart({
        launch,
        worktreeId: launchWorktreeId,
        local,
        folder,
        ...(options.templateId ? { templateId: options.templateId } : {}),
        onReviewChange: setReviewing
      })(pick)
    }
  }
}
