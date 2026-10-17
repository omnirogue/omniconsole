import { z } from 'zod'
import type { ConsoleJobBinding, ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { consoleWorkflowJson, jobId, taskId } from '../../shared/console-workflow-schemas'
import { requestConsoleWorkflow } from './console-workflow-transport'

const identifier = z.string().min(1).max(512)
export const consoleClaimRecord = z.object({
  id: jobId,
  task_id: taskId,
  status: identifier,
  attempt: z.number().int().positive(),
  lease_generation: z.number().int().positive(),
  claim_host: identifier,
  claimed_at: z.string().datetime({ offset: true }),
  runner_instance: identifier,
  claim_request_id: identifier,
  cancel_requested: z.boolean(),
  execution_binding: z.object({
    job_id: jobId,
    task_id: taskId,
    host: identifier,
    attempt: z.number().int().positive(),
    claimed_at: z.string().datetime({ offset: true }),
    runner_instance: identifier,
    claim_request_id: identifier,
    attempt_intent_id: identifier,
    dispatch_key: identifier,
    contract_id: identifier,
    contract_digest: z.string().regex(/^[a-f0-9]{64}$/),
    contract_generation: z.number().int().positive()
  }),
  process_identity: consoleWorkflowJson.nullish(),
  terminal_proof: consoleWorkflowJson.nullish()
})
export type ConsoleClaimRecord = z.infer<typeof consoleClaimRecord>

export function consoleClaimMatches(row: ConsoleClaimRecord, binding: ConsoleJobBinding): boolean {
  const claim = binding.claim
  if (!claim) {
    return false
  }
  const expected = {
    job_id: binding.jobId,
    task_id: binding.taskId,
    host: claim.host,
    attempt: binding.attempt,
    claimed_at: claim.claimedAt,
    runner_instance: claim.runnerInstance,
    claim_request_id: claim.claimRequestId,
    attempt_intent_id: claim.attemptIntentId,
    dispatch_key: claim.dispatchKey,
    contract_id: binding.contractId,
    contract_digest: binding.contractDigest,
    contract_generation: binding.contractGeneration
  }
  return (
    row.id === binding.jobId &&
    row.task_id === binding.taskId &&
    row.attempt === binding.attempt &&
    row.lease_generation === binding.leaseGeneration &&
    row.claim_host === claim.host &&
    row.claimed_at === claim.claimedAt &&
    row.runner_instance === claim.runnerInstance &&
    row.claim_request_id === claim.claimRequestId &&
    Object.entries(expected).every(
      ([key, value]) => row.execution_binding[key as keyof typeof expected] === value
    )
  )
}

export function readConsoleWorkflowClaim(
  job: string,
  principal: string,
  binding?: ConsoleJobBinding
): Promise<ConsoleWorkflowResult<ConsoleClaimRecord>> {
  return requestConsoleWorkflow(
    `/api/gtd/jobs/${job}`,
    'GET',
    consoleClaimRecord.refine(
      (row) => row.id === job && (!binding || consoleClaimMatches(row, binding))
    ),
    undefined,
    15_000,
    false,
    principal
  )
}
