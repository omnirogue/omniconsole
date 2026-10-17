import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { bindCoordinatorLaunch } from '@/lib/pending-folder-launches'
import { useLaunchProject } from '@/lib/project-launch'
import { useAppStore } from '@/store'
import type { ProjectSettings } from '../../../../shared/project-settings'
import { coordinatorLaunchPick, coordinatorViewMode } from './project-coordinator-launch'
import { coordinatorOllamaTag, startOllamaCoordinator } from './project-coordinator-ollama'
import {
  COORDINATOR_TEMPLATE_ID,
  LOCAL_OLLAMA_AGENT,
  defaultCoordinatorDraft,
  projectCoordinatorFromDraft
} from './project-settings-draft'
import { useProjectFolderLaunch } from './use-project-folder-launch'

/**
 * Starts the project's chat the way its "+" starts a thread: the recorded pick, in the project's
 * home workspace, through the launch review panel, filed in the project; the new row is then
 * bound as `ProjectSettings.coordinator` (plan: Project chat). The Chat view is on where native
 * chat is, and the Coordinator template opens the session wherever it runs.
 */
export function useProjectCoordinatorLaunch(
  folder: { id: string; name: string },
  settings: ProjectSettings | null
): { start: () => void; starting: boolean } {
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const viewMode = useAppStore((state) => coordinatorViewMode(state.settings))
  const launch = useProjectFolderLaunch(folder, viewMode)
  const recorded =
    settings?.coordinator ??
    (settings
      ? projectCoordinatorFromDraft(defaultCoordinatorDraft(defaultAgent), undefined)
      : null)
  return {
    starting: launch.starting,
    start: () => {
      if (!recorded) {
        return
      }
      const templateId = recorded.launch.templateId ?? COORDINATOR_TEMPLATE_ID
      const onLaunched = (tabId: string): void =>
        bindCoordinatorLaunch(tabId, folder.id, recorded.launch)
      const tag = coordinatorOllamaTag(recorded.launch)
      if (tag) {
        useLaunchProject.getState().open(folder.id)
        startOllamaCoordinator({
          folder,
          worktreeId: launch.worktreeId,
          local: launch.local,
          tag,
          templateId,
          onLaunched,
          onReviewChange: launch.setReviewing
        })
        return
      }
      if (recorded.launch.agent === LOCAL_OLLAMA_AGENT) {
        toast.error(
          translate(
            'projects.chat.ollamaModelMissing',
            'Pick an Ollama model for the project chat in Project settings.'
          )
        )
        return
      }
      const pick = coordinatorLaunchPick(recorded.launch)
      if (!pick) {
        toast.error(
          translate(
            'projects.chat.agentNotLaunchable',
            '{{agent}} cannot start from here yet. Pick another agent in Project settings.',
            { agent: getAgentLabel(recorded.launch.agent) }
          )
        )
        return
      }
      launch.start(pick, { templateId, onLaunched })
    }
  }
}
