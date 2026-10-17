import { z } from 'zod'
import { workflowAdmission } from './console-workflow-responses'
import type { ConsoleConversationFleetAdmitRequest } from '../../shared/console-conversation-fleet-types'
import { failure, requestConsoleWorkflow } from './console-workflow-transport'

const contract = 'conversation-admission-reconciliation.v1'

export async function requireFleetReconciliation(
  taskId: string,
  principal: string,
  isCurrent: () => boolean
) {
  const result = await requestConsoleWorkflow(
    `/api/gtd/workflow-tasks/${taskId}/reconciliation-capabilities`,
    'GET',
    z.object({
      ok: z.literal(true),
      contract: z.literal(contract),
      task_id: z.literal(taskId),
      canonical_command_replay: z.literal(true)
    }),
    undefined,
    30_000,
    true,
    principal,
    isCurrent
  )
  return result.ok
    ? result
    : failure(
        'reconciliation_unavailable',
        'The server cannot reconcile this saved admission. Keep its original workflow; do not dispatch again.'
      )
}

export function fleetReconciliationProof(body: ConsoleConversationFleetAdmitRequest) {
  return z
    .object({
      contract: z.literal(contract),
      task_id: z.literal(body.taskId),
      workflow_id: z.literal(body.graph.dispatch_id),
      digest: z.literal(body.digest),
      expected_revision: z.literal(body.expectedRevision),
      context_digest: z.literal(body.contextDigest),
      command_id: z.string().min(1),
      graph_key: z.string().min(1)
    })
    .refine((value) => value.command_id === value.graph_key)
}

export function fleetReconciliationAdmission(body: ConsoleConversationFleetAdmitRequest) {
  return workflowAdmission.and(z.object({ reconciliation: fleetReconciliationProof(body) }))
}
