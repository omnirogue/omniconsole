import { isDeepStrictEqual } from 'node:util'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import { currentSessionOutcomeStageBinding } from './session-outcome-workflow-completion'

/** A cancelled review loop may retain its currently verified producer, never a synthetic closure. */
export function sessionOutcomeVerifiedProducer(
  chain: SessionChain,
  workflow: SessionOutcomeWorkflow,
  stage: SessionOutcomeWorkflow['stages'][number],
  selectedStepIds: Set<string>
) {
  if (workflow.error || !workflow.canonicalSeal || selectedStepIds.size !== 1) {
    return
  }
  const current = currentSessionOutcomeStageBinding(chain, workflow)
  if (
    stage.outcomeIds.some((outcomeId) =>
      stage.actionIds.some((id) => current(stage, outcomeId, 'action', id))
    )
  ) {
    return
  }
  const producer = chain.steps.find((step) => selectedStepIds.has(step.id))
  const node = workflow.preview.graph.nodes.find(
    (entry) =>
      entry.key === stage.key &&
      entry.action === 'execute' &&
      entry.loop_stage?.role === 'producer' &&
      entry.loop_stage.round === 0
  )
  if (
    !node ||
    !producer ||
    producer.kind === 'handoff' ||
    producer.review ||
    producer.reviewRepair ||
    producer.agent !== node.provider ||
    producer.model !== node.model ||
    !stage.outcomeIds.some((outcomeId) => current(stage, outcomeId, 'step', producer.id))
  ) {
    return
  }
  return workflow.verifiedProducerReceipts?.find(
    (proof) =>
      proof.key === node.key &&
      proof.provider === node.provider &&
      proof.model === node.model &&
      proof.taskId !== workflow.preview.admission.filing_root_task_id &&
      workflow.receipts?.some((receipt) => isDeepStrictEqual(receipt, proof)) &&
      workflow.activations.some(
        (activation) =>
          activation.jobId === proof.jobId &&
          activation.state === 'started' &&
          activation.dispatchId === proof.dispatchId &&
          activation.runId === proof.runId
      )
  )
}
