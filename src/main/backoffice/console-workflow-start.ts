import { z } from 'zod'
import type { ConsoleJobBinding, ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { isPtyLaunchGateReceipt, type PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { normalizeConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { failure, requestConsoleWorkflow } from './console-workflow-transport'

const identifier = z.string().min(1).max(512)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const claimBinding = z.object({
  job_id: identifier,
  task_id: identifier,
  host: identifier,
  attempt: z.number().int().positive(),
  claimed_at: z.string().datetime({ offset: true }),
  runner_instance: identifier,
  claim_request_id: identifier,
  attempt_intent_id: identifier,
  dispatch_key: identifier,
  contract_id: identifier,
  contract_digest: digest,
  contract_generation: z.number().int().positive()
})
const startedJob = z.object({
  id: identifier,
  task_id: identifier,
  status: z.literal('running'),
  attempt: z.number().int().positive(),
  lease_generation: z.number().int().positive(),
  claim_host: identifier,
  claimed_at: z.string().datetime({ offset: true }),
  runner_instance: identifier,
  claim_request_id: identifier,
  project_dir: z.string(),
  base_sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  input_digest: digest,
  cancel_requested: z.literal(false),
  process_identity: z.object({
    pid: z.number().int().positive(),
    started_at: z.string(),
    runner_instance: identifier
  }),
  execution_binding: claimBinding,
  execution_start_receipt: z.object({
    binding: claimBinding,
    started: z.literal(true),
    session_id: z.string().regex(/^ses_[A-Za-z0-9_-]{1,128}$/),
    attempt_id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
  })
})

export type ConsoleWorkflowProcessStart = {
  binding: ConsoleJobBinding
  principal: string
  gate: PtyLaunchGateReceipt
  projectDir: string
  baseSha: string | null
  workspace?: { kind: 'folder'; path: string }
  inputDigest: string
}

/** The caller commits this exact receipt to Orca's journal before releasing the host gate. */
export async function startConsoleWorkflowProcess(
  input: ConsoleWorkflowProcessStart
): Promise<ConsoleWorkflowResult<ConsoleJobBinding>> {
  let binding: ConsoleJobBinding
  try {
    binding = normalizeConsoleJobBinding(input.binding)
    if (
      !binding.claim ||
      !binding.claim.host.startsWith('local:') ||
      !binding.contractId ||
      !binding.contractDigest ||
      !binding.contractGeneration ||
      !isPtyLaunchGateReceipt(input.gate) ||
      !input.gate.reportsChildExitStatus ||
      input.gate.startupCommandMode !== 'exec' ||
      !Number.isFinite(new Date(input.gate.processStartTimeMs).getTime()) ||
      (input.workspace
        ? input.workspace.kind !== 'folder' ||
          input.workspace.path !== input.projectDir ||
          input.baseSha !== null
        : typeof input.baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.baseSha)) ||
      !/^[a-f0-9]{64}$/.test(input.inputDigest) ||
      !input.projectDir.startsWith('/') ||
      input.projectDir.split('/').includes('..')
    ) {
      throw new Error('invalid_start')
    }
  } catch {
    return failure(
      'invalid_request',
      'Start requires the exact local claim, closed process gate and frozen input digest.'
    )
  }
  const claim = binding.claim!
  const processIdentity = {
    pid: input.gate.pid,
    started_at: new Date(input.gate.processStartTimeMs).toISOString(),
    runner_instance: claim.runnerInstance
  }
  const expectedBinding = {
    job_id: binding.jobId,
    task_id: binding.taskId,
    host: claim.host,
    attempt: binding.attempt,
    claimed_at: claim.claimedAt,
    runner_instance: claim.runnerInstance,
    claim_request_id: claim.claimRequestId,
    attempt_intent_id: claim.attemptIntentId,
    dispatch_key: claim.dispatchKey,
    contract_id: binding.contractId!,
    contract_digest: binding.contractDigest!,
    contract_generation: binding.contractGeneration!
  }
  const matches = (actual: z.infer<typeof claimBinding>) =>
    Object.entries(expectedBinding).every(
      ([key, value]) => actual[key as keyof typeof actual] === value
    )
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${binding.jobId}/started`,
    'POST',
    z
      .object({ ok: z.literal(true), job: startedJob })
      .refine(
        ({ job }) =>
          job.id === binding.jobId &&
          job.task_id === binding.taskId &&
          job.attempt === binding.attempt &&
          job.lease_generation === binding.leaseGeneration &&
          job.claim_host === claim.host &&
          job.claimed_at === claim.claimedAt &&
          job.runner_instance === claim.runnerInstance &&
          job.claim_request_id === claim.claimRequestId &&
          job.project_dir === input.projectDir &&
          job.base_sha === input.baseSha &&
          job.input_digest === input.inputDigest &&
          job.process_identity.pid === processIdentity.pid &&
          job.process_identity.started_at === processIdentity.started_at &&
          job.process_identity.runner_instance === processIdentity.runner_instance &&
          matches(job.execution_binding) &&
          matches(job.execution_start_receipt.binding)
      ),
    {
      attempt: binding.attempt,
      lease_generation: binding.leaseGeneration,
      claimed_at: claim.claimedAt,
      runner_instance: claim.runnerInstance,
      process_identity: processIdentity,
      project_dir: input.projectDir,
      base_sha: input.baseSha,
      input_digest: input.inputDigest
    },
    15_000,
    false,
    input.principal
  )
  if (!response.ok) {
    return response
  }
  return {
    ok: true,
    data: {
      ...binding,
      sessionId: response.data.job.execution_start_receipt.session_id,
      attemptId: response.data.job.execution_start_receipt.attempt_id,
      inputDigest: response.data.job.input_digest
    }
  }
}
