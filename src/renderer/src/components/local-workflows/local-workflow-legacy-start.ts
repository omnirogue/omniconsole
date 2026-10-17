import { useEffect } from 'react'
import { updateLocalWorkflowConversation } from '@/lib/local-workflow-conversation'
import type { LocalWorkflowSetupResult } from '../../../../shared/local-workflow-rpc'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** The host refuses an earlier build's graphless pending Start, which would otherwise spin forever. */
export function useClearLegacyLocalWorkflowStart(
  tab: TerminalTab,
  setup: LocalWorkflowSetupResult | undefined,
  ready: boolean
): void {
  const workflow = tab.localWorkflow
  // Setup's executionId is the conversation's latest run, so no admitted Start is dropped.
  const clear =
    ready &&
    !!setup &&
    !setup.executionId &&
    !workflow?.executionId &&
    !!workflow?.startRequest &&
    !workflow.startRequest.draft.graph &&
    !workflow.startRequest.draft.audit
  useEffect(() => {
    if (clear) {
      updateLocalWorkflowConversation(tab.worktreeId, tab.id, { startRequest: undefined })
    }
  }, [clear, tab.worktreeId, tab.id])
}
