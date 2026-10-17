import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AGENT_DETECTION_LOCAL_TARGET_KEY,
  getAgentDetectionTargetKeyForWorktree
} from '@/hooks/useAgentDetectionTarget'
import { translate } from '@/i18n/i18n'
import {
  createLocalWorkflowConversation,
  updateLocalWorkflowConversation
} from '@/lib/local-workflow-conversation'
import { useAppStore } from '@/store'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { improveThisPrompt, improveThisSeed } from './next-steps-improve-this'
import { stopKeepGoingForPersonAction } from './NextStepsKeepGoing'

/** Opens Improve on the latest reply, to review and Start; it never starts by itself. */
function openImproveThis(worktreeId: string, messages: readonly NativeChatMessage[]): void {
  const seed = improveThisSeed(messages)
  if (!seed) {
    return
  }
  const prompt = improveThisPrompt(seed)
  const tabId = createLocalWorkflowConversation(worktreeId, 'improve')
  // The new tab's empty Improve graph is drawn from this host's models when it opens.
  const draft = useAppStore.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
    ?.localWorkflow?.draft
  updateLocalWorkflowConversation(worktreeId, tabId, {
    prompt,
    ...(draft ? { draft: { ...draft, prompt } } : {})
  })
}

/**
 * "Improve this…" under the latest agent reply. Improve runs on this computer's workspaces only
 * (local and folder); elsewhere the action is shown disabled with why. Without a transcript (the
 * Terminal view) there is no reply to seed it with, so nothing is shown.
 */
export function NextStepsImproveThis({
  conversation,
  messages,
  className
}: {
  conversation: ConversationSource
  messages: readonly NativeChatMessage[] | undefined
  className?: string
}) {
  const { worktreeId } = conversation
  const local = useAppStore(
    (state) =>
      getAgentDetectionTargetKeyForWorktree(state, worktreeId) === AGENT_DETECTION_LOCAL_TARGET_KEY
  )
  if (!messages || !improveThisSeed(messages)) {
    return null
  }
  return (
    <div className={className}>
      <Button
        size="xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={!local}
        title={
          local
            ? translate(
                'nextSteps.improveThis.title',
                'Open the latest reply in Improve, to review and start'
              )
            : translate(
                'nextSteps.improveThis.unavailable',
                'Improve runs on this computer’s workspaces only'
              )
        }
        data-next-steps-improve-this
        onClick={() => {
          // A person action: Keep going stops on the host first, or Improve does not open.
          stopKeepGoingForPersonAction(conversation)
            .then(() => openImproveThis(worktreeId, messages))
            .catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error))
            )
        }}
      >
        {translate('nextSteps.improveThis.action', 'Improve this…')}
      </Button>
    </div>
  )
}
