import type { AgentSessionProcessIdentity } from '../../../shared/agent-session-record'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { WorkflowScriptSlots } from './workflow-script-slots'
import { reconcileWorkflowProgram } from './workflow-program-recovery'
import type {
  WorkflowExecutionOutcome,
  WorkflowNativeAttestationInput
} from './workflow-execution-service'

/** Claims an interrupted run from its replaced owner and reconciles it; nothing is launched. */
export async function recoverInterruptedWorkflow(input: {
  store: WorkflowCheckpointStore
  slots: WorkflowScriptSlots
  attestNativeResult?: (input: WorkflowNativeAttestationInput) => void
  executionId: string
  fence: number
  owner: AgentSessionProcessIdentity
}): Promise<WorkflowExecutionOutcome & { fence: number }> {
  const claimedFence = await input.store.claimOwner(input.executionId, input.fence, input.owner)
  const outcome = await reconcileWorkflowProgram({
    store: input.store,
    slots: input.slots,
    executionId: input.executionId,
    fence: claimedFence,
    attestNativeResult:
      input.attestNativeResult ??
      (() => {
        throw new Error('Workflow native attestation is unavailable during recovery')
      })
  })
  return { ...outcome, fence: claimedFence }
}
