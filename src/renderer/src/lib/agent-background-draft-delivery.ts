import { toast } from 'sonner'
import type { TuiAgent } from '../../../shared/tui-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'

export function scheduleAgentBackgroundDraft(
  tabId: string,
  content: string,
  agent: TuiAgent,
  beforeWrite?: () => void
): Promise<boolean> {
  return pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit: true,
    beforeWrite,
    onTimeout: () => {
      beforeWrite?.()
      showAutomationPromptNotSentToast(agent)
    }
  })
    .then((sent) => {
      if (!sent) {
        beforeWrite?.()
      }
      return sent
    })
    .catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    })
}
