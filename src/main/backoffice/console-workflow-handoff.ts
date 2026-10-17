import { openrouterCandidates } from '../../shared/openrouter-route'
import { z } from 'zod'
import type {
  ConsoleLocalJob,
  ConsoleLocalActivation
} from '../console-workflows/console-local-execution-contract'
import { consoleLocalJobSchema } from '../console-workflows/console-local-execution-schema'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { consoleWorkflowJson, jobId, taskId } from '../../shared/console-workflow-schemas'
import { consoleWorkflowAcceptanceCommands } from '../../shared/console-workflow-acceptance'
import { normalizeConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { failure, requestConsoleWorkflow } from './console-workflow-transport'

const text = z.string().min(1).max(64_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const workflowInputs = z.union([
  z.array(consoleWorkflowJson).max(100),
  z
    .object({ source_files: z.array(consoleWorkflowJson).max(32).optional() })
    .catchall(consoleWorkflowJson)
])
const handoffSchema = z.object({
  artifact_result: z
    .object({
      path: z.enum(['work-result.json', 'folder-snapshot.json', 'folder-review.json']),
      format: z.literal('json'),
      max_bytes: z.literal(65536)
    })
    .strict()
    .optional(),
  job_id: jobId,
  task_id: taskId,
  title: text,
  brief: text,
  agent_brief: z.string().max(64_000).nullish(),
  acceptance: text,
  acceptance_commands: consoleWorkflowAcceptanceCommands,
  repo: text.max(2048).nullable(),
  base_branch: text.max(1024).nullable(),
  workspace: z
    .object({ kind: z.literal('folder'), path: text.max(4096) })
    .strict()
    .optional(),
  base_sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullish(),
  provider: z.enum(['codex', 'claude', 'grok', 'omp']),
  model: text.max(512),
  openrouter_candidates: openrouterCandidates.optional(),
  effort: text.max(512).nullish(),
  owned_paths: z.array(text.max(2048)).nullish(),
  checkouts: z.array(consoleWorkflowJson).length(0),
  actor_type: z.literal('ai'),
  placement: z.enum(['local', 'fleet']),
  status: text.max(64),
  canonical_binding: z.object({
    task_id: taskId,
    contract_id: text.max(160),
    contract_digest: digest,
    contract_generation: z.number().int().positive()
  }),
  workflow: z.object({
    workflow_id: text.max(160),
    dispatch_id: text.max(160),
    digest,
    action: z.enum(['execute', 'review', 'repair'])
  })
})
const handoffReply = z.object({
  ok: z.literal(true),
  handoff: handoffSchema,
  workflow_inputs: workflowInputs,
  blockers: z.array(consoleWorkflowJson),
  ready: z.boolean()
})
const activationReply = z.object({
  ok: z.literal(true),
  handoff: handoffSchema,
  workflow_inputs: workflowInputs,
  claim: z.object({
    job_id: jobId,
    host: text.max(512),
    attempt: z.number().int().positive(),
    lease_generation: z.number().int().positive(),
    claimed_at: z.string().datetime({ offset: true }),
    runner_instance: text.max(128),
    claim_request_id: text.max(128),
    attempt_intent_id: text.max(512),
    dispatch_key: text.max(512)
  })
})

export function normalizeConsoleWorkflowHandoff(
  handoff: z.infer<typeof handoffSchema>,
  inputs: z.infer<typeof workflowInputs>,
  ready: boolean
): ConsoleLocalJob {
  if (handoff.task_id !== handoff.canonical_binding.task_id) {
    throw new Error('The handoff and canonical contract identify different cards.')
  }
  return consoleLocalJobSchema.parse({
    id: handoff.job_id,
    taskId: handoff.task_id,
    workflowId: handoff.workflow.workflow_id,
    digest: handoff.workflow.digest,
    state: ready ? 'ready' : handoff.status,
    placement: handoff.placement,
    provider: handoff.provider,
    model: handoff.model,
    ...(handoff.openrouter_candidates !== undefined
      ? { openrouterCandidates: handoff.openrouter_candidates }
      : {}),
    ...(handoff.effort ? { effort: handoff.effort } : {}),
    title: handoff.title,
    ...(handoff.artifact_result
      ? {
          artifactResult: {
            path: handoff.artifact_result.path,
            format: handoff.artifact_result.format,
            maxBytes: handoff.artifact_result.max_bytes
          }
        }
      : {}),
    repo: handoff.repo,
    baseBranch: handoff.base_branch,
    ...(handoff.workspace
      ? { workspace: handoff.workspace, baseSha: handoff.base_sha ?? null }
      : handoff.base_sha
        ? { baseSha: handoff.base_sha }
        : {}),
    prompt: handoff.agent_brief || handoff.brief,
    brief: handoff.brief,
    acceptance: handoff.acceptance,
    acceptanceCommands: handoff.acceptance_commands.map(({ program, args, timeout_ms }) => ({
      program,
      args,
      timeoutMs: timeout_ms
    })),
    inputs: Array.isArray(inputs) ? inputs : [inputs, ...(inputs.source_files ?? [])],
    ownedPaths: handoff.owned_paths ?? null,
    readOnly: handoff.workflow.action === 'review',
    action: handoff.workflow.action
  })
}

/** One read-only named contract; unsupported checkout or acceptance shapes never activate. */
export async function readConsoleWorkflowHandoff(
  id: string,
  principal: string
): Promise<ConsoleWorkflowResult<ConsoleLocalJob>> {
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${id}/handoff`,
    'GET',
    handoffReply.refine(
      (value) =>
        value.handoff.job_id === id &&
        (!value.ready || (value.handoff.status === 'queued' && !value.blockers.length))
    ),
    undefined,
    15_000,
    true,
    principal
  )
  if (!response.ok) {
    return response
  }
  try {
    return {
      ok: true,
      data: normalizeConsoleWorkflowHandoff(
        response.data.handoff,
        response.data.workflow_inputs,
        response.data.ready
      )
    }
  } catch {
    return failure(
      'invalid_response',
      'The handoff does not preserve its canonical card and executable contract.'
    )
  }
}

/** Explicit activation identifiers come from the caller's retained transport intent. */
export async function activateConsoleWorkflowJob(input: {
  job: ConsoleLocalJob
  principal: string
  runnerInstance: string
  claimRequestId: string
}): Promise<ConsoleWorkflowResult<ConsoleLocalActivation>> {
  if (
    ![input.runnerInstance, input.claimRequestId].every((value) =>
      /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ) ||
    input.job.placement !== 'local' ||
    input.job.state !== 'ready'
  ) {
    return failure(
      'invalid_request',
      'Activation requires one explicitly selected ready local job and retained claim identifiers.'
    )
  }
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${input.job.id}/activate`,
    'POST',
    activationReply,
    { runner_instance: input.runnerInstance, claim_request_id: input.claimRequestId },
    15_000,
    true,
    input.principal
  )
  if (!response.ok) {
    return response
  }
  try {
    const { handoff, claim, workflow_inputs: inputs } = response.data
    const job = normalizeConsoleWorkflowHandoff(handoff, inputs, false)
    if (
      job.state !== 'running' ||
      claim.job_id !== job.id ||
      claim.runner_instance !== input.runnerInstance ||
      claim.claim_request_id !== input.claimRequestId ||
      !claim.host.startsWith('local:') ||
      JSON.stringify({ ...job, state: input.job.state }) !== JSON.stringify(input.job)
    ) {
      throw new Error('claim_changed')
    }
    return {
      ok: true,
      data: {
        job,
        principal: input.principal,
        binding: normalizeConsoleJobBinding({
          taskId: job.taskId,
          workflowId: job.workflowId,
          jobId: job.id,
          attempt: claim.attempt,
          leaseGeneration: claim.lease_generation,
          contractId: handoff.canonical_binding.contract_id,
          contractDigest: handoff.canonical_binding.contract_digest,
          contractGeneration: handoff.canonical_binding.contract_generation,
          claim: {
            host: claim.host,
            claimedAt: claim.claimed_at,
            runnerInstance: claim.runner_instance,
            claimRequestId: claim.claim_request_id,
            attemptIntentId: claim.attempt_intent_id,
            dispatchKey: claim.dispatch_key
          }
        })
      }
    }
  } catch {
    return failure(
      'invalid_response',
      'The activation receipt changed the exact frozen job or claim.'
    )
  }
}
