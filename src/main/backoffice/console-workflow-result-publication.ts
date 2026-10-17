import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  ConsoleExecutionAck,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import type { ConsoleJobResultPublication } from '../runtime/orchestration/console-job-result'
import { normalizeConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { consoleLocalResultSchema } from '../console-workflows/console-local-execution-schema'
import { consoleJobOutputDigest } from '../console-workflows/console-job-digests'
import { consoleClaimRecord } from './console-workflow-claim-record'
import { readConsoleWorkflowEventPage } from './console-workflow-event-page'
import { failure, requestConsoleWorkflow } from './console-workflow-transport'

function pythonJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${pythonJson(key)}:${pythonJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** Matches the server's durable result receipt fingerprint, including fields added by finish(). */
export function consoleResultReceiptFingerprint(
  body: Record<string, unknown>,
  host: string
): string {
  return createHash('sha256')
    .update(pythonJson({ ...body, host, seat_rotated: false, error: null, revision_plan: null }))
    .digest('hex')
}

export async function publishConsoleWorkflowResult(
  publication: ConsoleJobResultPublication,
  principal: string
): Promise<ConsoleWorkflowResult<ConsoleExecutionAck>> {
  let binding
  let result
  try {
    binding = normalizeConsoleJobBinding(publication.binding)
    result = consoleLocalResultSchema.parse(publication.result)
    if (
      !binding.claim?.host.startsWith('local:') ||
      (!binding.inputDigest && result.terminal_proof.kind !== 'not_started') ||
      !/^sha256:[a-f0-9]{64}$/.test(publication.journalCursor) ||
      !/^[a-f0-9]{64}$/.test(publication.idempotencyKey) ||
      !('process_identity' in result.terminal_proof) ||
      result.terminal_proof.process_identity.runner_instance !== binding.claim.runnerInstance ||
      result.output_digest !== consoleJobOutputDigest(result) ||
      (result.status === 'done' &&
        result.branch === null &&
        (!result.file_id || !result.artifact_sha256)) ||
      (!['failed', 'cancelled'].includes(result.status) && result.result_exit_code !== 0)
    ) {
      throw new Error('unproven_result')
    }
  } catch {
    return failure(
      'invalid_request',
      'The result requires its frozen cursor, claim and actual process termination receipt.'
    )
  }
  const claim = binding.claim!
  const body = {
    ...result,
    attempt: binding.attempt,
    lease_generation: binding.leaseGeneration,
    claimed_at: claim.claimedAt,
    runner_instance: claim.runnerInstance,
    ...(binding.inputDigest ? { input_digest: binding.inputDigest } : {}),
    journal_cursor: publication.journalCursor,
    idempotency_key: publication.idempotencyKey
  }
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${binding.jobId}/result`,
    'POST',
    z
      .object({ ok: z.literal(true), job: consoleClaimRecord, duplicate: z.boolean() })
      .refine(({ job }) => job.id === binding.jobId && job.task_id === binding.taskId),
    body,
    15_000,
    false,
    principal
  )
  if (!response.ok) {
    return response
  }
  const fingerprint = consoleResultReceiptFingerprint(body, claim.host)
  let after = 0
  for (;;) {
    const recorded = await readConsoleWorkflowEventPage(binding.jobId, after, 200, principal)
    if (!recorded.ok) {
      return recorded
    }
    const receipt = recorded.data.events.find(
      (event) =>
        event.kind === 'runner_result_receipt' &&
        event.detail.claim_id === claim.claimedAt &&
        event.detail.attempt === binding.attempt &&
        event.detail.host === claim.host &&
        event.detail.fingerprint === fingerprint
    )
    if (receipt) {
      return {
        ok: true,
        data: {
          eventId: String(receipt.id),
          journalCursor: publication.journalCursor,
          idempotencyKey: publication.idempotencyKey
        }
      }
    }
    if (!recorded.data.events.length) {
      return failure(
        'invalid_response',
        'The console has not acknowledged this exact retained result.'
      )
    }
    after = recorded.data.next_after
  }
}
