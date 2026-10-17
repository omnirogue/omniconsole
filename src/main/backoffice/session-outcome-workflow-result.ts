import { readSessionOutcomeFolderArtifact } from './session-outcome-folder-result'
import { hasSessionOutcomeCanonicalProjection } from '../runtime/session-outcome-workflow-seal'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import type {
  SessionOutcomeWorkflow,
  SessionOutcomeCanonicalSeal
} from '../../shared/session-outcome-workflow'
import { consoleResultReceiptFingerprint } from './console-workflow-result-publication'
import { readConsoleWorkflowEventPage } from './console-workflow-event-page'
import { getConsoleJobBindingForDispatch } from '../runtime/orchestration/console-job-binding'
import type { ConsoleJobResultPublication } from '../runtime/orchestration/console-job-result'
import { sessionOutcomeStageReceipt } from '../../shared/session-outcome-workflow'
import { consoleLocalResultSchema } from '../console-workflows/console-local-execution-schema'

/** A terminal failure is retained as failure, never given a passing verification report. */
export async function readSessionOutcomeWorkflowFailure(
  runtime: OrcaRuntimeService,
  job: ConsoleWorkflowJob,
  activation: SessionOutcomeWorkflow['activations'][number],
  principal: string
) {
  const read = await readBoundNativeResult(runtime, job, activation, principal)
  return read?.result.status === 'failed'
    ? { eventId: read.eventId, fingerprint: read.fingerprint }
    : null
}
/** Cross-check the immutable native result against its actual server acknowledgement and verified stage. */
export async function readSessionOutcomeWorkflowResult(
  runtime: OrcaRuntimeService,
  job: ConsoleWorkflowJob,
  activation: SessionOutcomeWorkflow['activations'][number],
  principal: string,
  seal: SessionOutcomeCanonicalSeal
) {
  const projection = job.policy.workflow.hub_projection
  if (
    projection?.satisfied !== true ||
    typeof projection.verification_report_id !== 'string' ||
    !hasSessionOutcomeCanonicalProjection(projection, seal)
  ) {
    return null
  }
  const read = await readBoundNativeResult(runtime, job, activation, principal)
  if (
    !read ||
    !['done', 'pr_open'].includes(read.result.status) ||
    read.result.result_exit_code !== 0
  ) {
    return null
  }
  return sessionOutcomeStageReceipt.parse({
    ...read.fields,
    verificationReportId: projection.verification_report_id
  })
}
async function readBoundNativeResult(
  runtime: OrcaRuntimeService,
  job: ConsoleWorkflowJob,
  activation: SessionOutcomeWorkflow['activations'][number],
  principal: string
) {
  if (!activation.dispatchId || !activation.runId) {
    return null
  }
  const db = runtime.getOrchestrationDb()
  const binding = getConsoleJobBindingForDispatch(db, activation.dispatchId)
  const run = db.getRun(activation.runId)
  if (
    !binding?.claim ||
    binding.jobId !== job.id ||
    binding.taskId !== job.task_id ||
    run?.console_job_principal !== principal ||
    binding.attempt !== job.attempt ||
    binding.leaseGeneration !== job.lease_generation
  ) {
    return null
  }
  const rows = db.db
    .prepare(`SELECT p.payload FROM console_job_publications p
    JOIN messages m ON m.id=p.observation_id WHERE m.run_id=? AND p.principal=?
    AND p.acknowledged_at IS NOT NULL AND m.id LIKE 'omnios_result_%'`)
    .all(activation.runId, principal) as { payload: string }[]
  const publication = rows
    .map((row) => JSON.parse(row.payload) as ConsoleJobResultPublication)
    .find(
      (row) =>
        'result' in row &&
        row.binding.jobId === job.id &&
        JSON.stringify(row.binding) === JSON.stringify(binding)
    )
  if (!publication) {
    return null
  }
  const result = consoleLocalResultSchema.parse(publication.result)
  const claim = binding.claim
  const fingerprint = consoleResultReceiptFingerprint(
    {
      ...result,
      attempt: binding.attempt,
      lease_generation: binding.leaseGeneration,
      claimed_at: claim.claimedAt,
      runner_instance: claim.runnerInstance,
      ...(binding.inputDigest ? { input_digest: binding.inputDigest } : {}),
      journal_cursor: publication.journalCursor,
      idempotency_key: publication.idempotencyKey
    },
    claim.host
  )
  const events: Parameters<typeof readSessionOutcomeFolderArtifact>[0] = []
  let after = 0
  for (let page = 0; page < 20; page++) {
    const response = await readConsoleWorkflowEventPage(job.id, after, 200, principal)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    events.push(...response.data.events)
    const receipt = response.data.events.find(
      (event) =>
        event.kind === 'runner_result_receipt' &&
        event.detail.claim_id === claim.claimedAt &&
        event.detail.attempt === binding.attempt &&
        event.detail.host === claim.host &&
        event.detail.fingerprint === fingerprint
    )
    if (receipt) {
      return {
        eventId: receipt.id,
        fingerprint,
        result,
        fields: {
          jobId: job.id,
          taskId: job.task_id,
          key: job.policy.workflow.key,
          provider: job.provider,
          model: job.model,
          eventId: receipt.id,
          fingerprint,
          attempt: binding.attempt,
          leaseGeneration: binding.leaseGeneration,
          dispatchId: activation.dispatchId,
          runId: activation.runId,
          journalCursor: publication.journalCursor,
          idempotencyKey: publication.idempotencyKey,
          ...(binding.inputDigest ? { inputDigest: binding.inputDigest } : {}),
          folderArtifact: readSessionOutcomeFolderArtifact(events, receipt.id, result, {
            attempt: binding.attempt,
            leaseGeneration: binding.leaseGeneration,
            claimedAt: claim.claimedAt
          }),
          candidateSha: result.candidate_sha,
          branch: result.branch,
          prUrl: result.pr_url,
          ...(result.workflow_loop_verdict ? { verdict: result.workflow_loop_verdict } : {})
        }
      }
    }
    if (!response.data.events.length) {
      return null
    }
    after = response.data.next_after
  }
  throw new Error('The stage result receipt exceeds the bounded event history.')
}
