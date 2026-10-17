import type { ConsoleConversationFleetAdmitRequest } from '../../shared/console-conversation-fleet-types'
import { requireFleetReconciliation } from './console-fleet-reconciliation'
import type { ConsoleWorkflowApi } from '../../shared/console-workflow-api'
import type {
  ConsoleWorkflowResult,
  ConsoleWorkflowStep
} from '../../shared/console-workflow-types'
import { assertConversationFleetOpenRouterRoutes } from '../../shared/conversation-fleet-openrouter'
import { failure } from './console-workflow-transport'

export async function validateFleetOmpRoutes(
  steps: ConsoleWorkflowStep[],
  readInventory: ConsoleWorkflowApi['fleetInventory']
): Promise<ConsoleWorkflowResult<null>> {
  if (
    !steps.some(
      (step) =>
        (step.actor_id ?? step.actor ?? '').split(':')[0] === 'omp' ||
        step.openrouter_candidates !== undefined
    )
  ) {
    return { ok: true, data: null }
  }
  const inventory = await readInventory()
  if (!inventory.ok) {
    return inventory
  }
  try {
    assertConversationFleetOpenRouterRoutes(steps, inventory.data)
    return { ok: true, data: null }
  } catch (error) {
    return failure(
      'capability_unavailable',
      error instanceof Error ? error.message : 'OMP routing unavailable.'
    )
  }
}

export async function validateFleetOmpAdmission(
  body: ConsoleConversationFleetAdmitRequest,
  readInventory: ConsoleWorkflowApi['fleetInventory'],
  preview: { principal: string; isCurrent: () => boolean },
  reconcile: boolean
) {
  if (reconcile) {
    return requireFleetReconciliation(body.taskId, preview.principal, preview.isCurrent)
  }
  return validateFleetOmpRoutes(
    body.graph.nodes.map((node) => ({
      title: node.title,
      actor_id: node.actor_id,
      machine: node.machine,
      effort: node.effort ?? undefined,
      openrouter_candidates: node.openrouter_candidates
    })),
    readInventory
  )
}
