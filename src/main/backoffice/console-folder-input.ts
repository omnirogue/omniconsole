import { z } from 'zod'
import type { ConsoleLocalExecutionPort } from '../console-workflows/console-local-execution-contract'
import {
  consoleFolderCandidate,
  consoleFolderCandidateSchema,
  hydrateConsoleFolderCandidate
} from '../console-workflows/console-folder-round-snapshot'
import { normalizeConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { requestConsoleWorkflow } from './console-workflow-transport'

const reply = z
  .object({
    ok: z.literal(true),
    candidate: consoleFolderCandidateSchema,
    content_b64: z.string().min(1).max(90_000)
  })
  .strict()

export const hydrateConsoleWorkflowFolderCandidate: NonNullable<
  ConsoleLocalExecutionPort['hydrateFolderCandidate']
> = async (activation, workspacePath) => {
  const expected = consoleFolderCandidate(activation.job)
  if (!expected) {
    return
  }
  const binding = normalizeConsoleJobBinding(activation.binding)
  const claim = binding.claim
  if (!claim || !claim.host.startsWith('local:')) {
    throw new Error('The folder candidate requires its complete local claim.')
  }
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${binding.jobId}/folder-input`,
    'POST',
    reply,
    {
      host: claim.host,
      attempt: binding.attempt,
      claimed_at: claim.claimedAt,
      runner_instance: claim.runnerInstance,
      lease_generation: binding.leaseGeneration,
      claim_request_id: claim.claimRequestId,
      attempt_intent_id: claim.attemptIntentId,
      dispatch_key: claim.dispatchKey
    },
    60_000,
    true,
    activation.principal
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  await hydrateConsoleFolderCandidate({
    activation,
    workspacePath,
    candidate: response.data.candidate,
    contentBase64: response.data.content_b64
  })
}
