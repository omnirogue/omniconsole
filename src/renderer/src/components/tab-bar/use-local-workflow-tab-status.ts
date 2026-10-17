import { useAppStore } from '@/store'
import {
  localWorkflowTabStatus,
  type LocalWorkflowTabStatus
} from '@/lib/local-workflow-tab-status'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/** A workflow tab's run state as a primitive, so unrelated store writes never repaint the tab. */
export function useLocalWorkflowTabStatus(tab: TerminalTab): LocalWorkflowTabStatus | null {
  const workflow = tab.localWorkflow
  return useAppStore((state) =>
    workflow
      ? localWorkflowTabStatus(
          workflow,
          state.localWorkflowStatusByTabId[tab.id],
          state.buildReview.pipelinesById,
          state.buildReview.pipelinesListed,
          state.localWorkflowHydrationByTabId[tab.id]
        )
      : null
  )
}
