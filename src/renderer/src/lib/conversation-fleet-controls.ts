import { fleetExecutionControlsAvailable } from '../../../shared/fleet-execution-controls'
import { refreshWorkflowGraph } from '@/lib/workflow-graph-read-cache'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import { fleetJobPredecessors, retryableFleetJobs } from '@/lib/conversation-fleet-progress'
import {
  useConversationFleetStore,
  type ConversationFleetView
} from '@/store/conversation-fleet-store'
import type { ConsoleWorkflowCancellation } from '../../../shared/console-workflow-control-types'

/** Re-reads one run past the per-tick graph cache, so a control's effect shows before the next poll. */
async function rereadConversationFleetRun(scope: string, workflowId: string): Promise<void> {
  try {
    const result = await refreshWorkflowGraph(scope, workflowId)
    useConversationFleetStore.getState().recordJobs(scope, workflowId, result.jobs, null)
  } catch {
    /* The next poll reads it again. */
  }
}

export async function cancelConversationFleetRun(
  scope: string,
  workflowId: string
): Promise<ConsoleWorkflowCancellation> {
  if (!fleetExecutionControlsAvailable) {
    throw new Error('Fleet cancellation is unavailable.')
  }
  const result = workflowData(await consoleWorkflowApi().cancelWorkflow({ workflowId }))
  useConversationFleetStore.getState().recordJobs(scope, workflowId, result.jobs, null)
  await rereadConversationFleetRun(scope, workflowId)
  return result
}

export type ConversationFleetRetry = {
  retried: string[]
  failed: { jobId: string; message: string }[]
}

/** Retries stopped stages in dependency order; a stage behind a refused retry waits for the next one. */
export async function retryConversationFleetStages(
  scope: string,
  run: ConversationFleetView
): Promise<ConversationFleetRetry> {
  if (!fleetExecutionControlsAvailable) {
    throw new Error('Fleet retry is unavailable.')
  }
  const api = consoleWorkflowApi()
  const outcome: ConversationFleetRetry = { retried: [], failed: [] }
  const held = new Set<string>()
  for (const job of retryableFleetJobs(run.jobs)) {
    if (fleetJobPredecessors(job).some((id) => held.has(id))) {
      held.add(job.id)
      continue
    }
    const result = await api.retryJob({ jobId: job.id })
    if (result.ok) {
      outcome.retried.push(job.id)
    } else {
      held.add(job.id)
      outcome.failed.push({ jobId: job.id, message: result.error.message })
    }
  }
  await rereadConversationFleetRun(scope, run.workflowId)
  return outcome
}
