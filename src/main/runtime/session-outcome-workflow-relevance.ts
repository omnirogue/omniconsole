import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import { currentSessionOutcomeStageBinding } from './session-outcome-workflow-completion'
/** Audit-only generations cannot project failures onto replacement obligations. */
export function currentSessionOutcomeWorkflowOutcomeIds(
  chain: SessionChain,
  workflow: SessionOutcomeWorkflow
): Set<string> {
  const current = currentSessionOutcomeStageBinding(chain, workflow)
  return new Set(
    workflow.stages.flatMap((stage) =>
      stage.outcomeIds.filter(
        (outcomeId) =>
          stage.stepIds.some((id) => current(stage, outcomeId, 'step', id)) ||
          stage.actionIds.some((id) => current(stage, outcomeId, 'action', id))
      )
    )
  )
}
