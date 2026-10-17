import { z } from 'zod'
import type {
  ConsoleJobEvidencePage,
  ConsoleJobEvidenceRequest,
  ConsoleJobLogRequest,
  ConsoleJobLog
} from '../../shared/console-job-evidence'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { jobId } from '../../shared/console-workflow-schemas'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'
import { jobEvents } from './console-workflow-records'

const attempt = z.number().int().nonnegative()
const logRequest = z.object({ jobId, attempt: attempt.optional() }).strict()
const evidenceRequest = logRequest.extend({
  attempt: attempt.positive().optional(),
  leaseGeneration: attempt.positive().optional(),
  after: attempt.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  kind: z.enum(['input', 'provider_event', 'output', 'status']).optional()
})

const logResponse: z.ZodType<ConsoleJobLog> = z.object({
  job_id: jobId,
  attempt,
  host: z.string().nullable(),
  log: z.string().max(262_144),
  at: z.string()
})

const evidenceResponse: z.ZodType<ConsoleJobEvidencePage> = z.object({
  job_id: jobId,
  attempt,
  lease_generation: attempt,
  host: z.string().nullable(),
  session_id: z.string().nullable(),
  provider: z.string().nullable(),
  entries: z
    .array(
      z.object({
        id: z.number().int().positive(),
        kind: z.enum(['input', 'provider_event', 'output', 'status']),
        text: z.string(),
        at: z.string(),
        record_id: attempt.optional(),
        part: attempt.optional(),
        final: z.boolean().optional()
      })
    )
    .max(200),
  next_after: attempt,
  has_more: z.boolean(),
  complete: z.boolean()
})

export function readConsoleJobLog(
  args: ConsoleJobLogRequest
): Promise<ConsoleWorkflowResult<ConsoleJobLog>> {
  return validated(args, logRequest, (input) =>
    request(
      `/api/gtd/jobs/${input.jobId}/log${input.attempt === undefined ? '' : `?attempt=${input.attempt}`}`,
      'GET',
      logResponse.refine(
        (page) =>
          page.job_id === input.jobId &&
          (input.attempt === undefined || page.attempt === input.attempt)
      )
    )
  )
}

export function readConsoleFleetJobEventPage(job: string, after: number, limit = 200) {
  return request(
    `/api/gtd/jobs/${job}/events?after=${after}&limit=${limit}`,
    'GET',
    jobEvents
      .extend({ next_after: attempt, has_more: z.boolean() })
      .refine(
        (page) =>
          page.job_id === job &&
          page.events.every(
            (event, index) =>
              event.job_id === job && event.id > (page.events[index - 1]?.id ?? after)
          ) &&
          page.next_after === (page.events.at(-1)?.id ?? after) &&
          (!page.has_more || page.next_after > after)
      )
  )
}

export function readConsoleJobEvidence(
  args: ConsoleJobEvidenceRequest
): Promise<ConsoleWorkflowResult<ConsoleJobEvidencePage>> {
  return validated(args, evidenceRequest, (input) => {
    const after = input.after ?? 0
    const query = new URLSearchParams()
    if (input.attempt !== undefined) {
      query.set('attempt', String(input.attempt))
    }
    if (input.leaseGeneration !== undefined) {
      query.set('lease_generation', String(input.leaseGeneration))
    }
    query.set('after', String(after))
    query.set('limit', String(input.limit ?? 100))
    if (input.kind !== undefined) {
      query.set('kind', input.kind)
    }
    return request(
      `/api/gtd/jobs/${input.jobId}/evidence?${query}`,
      'GET',
      evidenceResponse.refine(
        (page) =>
          page.job_id === input.jobId &&
          (input.attempt === undefined || page.attempt === input.attempt) &&
          (input.leaseGeneration === undefined ||
            page.lease_generation === input.leaseGeneration) &&
          page.entries.every(
            (entry, index) =>
              entry.id > (page.entries[index - 1]?.id ?? after) &&
              (input.kind === undefined || entry.kind === input.kind)
          ) &&
          (input.kind !== undefined && !page.has_more
            ? page.next_after >= (page.entries.at(-1)?.id ?? after)
            : page.next_after === (page.entries.at(-1)?.id ?? after)) &&
          (!page.has_more || page.next_after > after)
      )
    )
  })
}
