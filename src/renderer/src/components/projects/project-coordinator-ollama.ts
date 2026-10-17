import { toast } from 'sonner'
import { reviewedLocalOllamaLaunch } from '@/components/sidebar/session-folders/new-conversation/local-ollama/reviewed-local-ollama-launch'
import { translate } from '@/i18n/i18n'
import { ollamaTagFromOpenCodeModelId } from '../../../../shared/local-ollama-launch'
import type { ProjectCoordinator } from '../../../../shared/project-settings'

/** The chat runs on Local Ollama: OpenCode with an `ollama/<tag>` model (the record's own form). */
export function coordinatorOllamaTag(launch: ProjectCoordinator['launch']): string | null {
  return launch.agent === 'opencode' ? ollamaTagFromOpenCodeModelId(launch.model) : null
}

/** Starts the chat on Local Ollama as the folder's Local Ollama row starts a thread. */
export function startOllamaCoordinator(args: {
  folder: { id: string; name: string }
  worktreeId: string | null
  local: boolean
  tag: string
  templateId: string
  onLaunched: (tabId: string) => void
  onReviewChange: (reviewing: boolean) => void
}): void {
  if (!args.local) {
    toast.error(
      translate(
        'projects.chat.ollamaLocalOnly',
        'Local Ollama runs on this computer only. Pick this computer, or another agent for the chat.'
      )
    )
    return
  }
  reviewedLocalOllamaLaunch(args)
}
