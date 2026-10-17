import { z } from 'zod'
import type { ConsoleJobResults, ConsoleJobResultsRequest } from '../../shared/console-job-results'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { jobId, taskId } from '../../shared/console-workflow-schemas'
import {
  readFetchResponseBytesWithinLimit,
  readFetchResponseJsonWithinLimit
} from '../../shared/fetch-response-body'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  captureConsoleWorkflowPerson,
  redactConsoleWorkflowMemory
} from './console-workflow-person'
import { failure, refusal, requestConsoleWorkflow, validated } from './console-workflow-transport'
import { jobRecord } from './console-workflow-records'
import { decodeConsoleFolderResult } from './console-folder-result'

export function readConsoleJobResults(
  args: ConsoleJobResultsRequest
): Promise<ConsoleWorkflowResult<ConsoleJobResults>> {
  return validated(
    args,
    z.object({ jobId, attempt: z.number().int().positive() }).strict(),
    async (input) => {
      const person = await captureConsoleWorkflowPerson()
      if (!person.ok) {
        return person
      }
      const readJob = () =>
        requestConsoleWorkflow(
          `/api/gtd/jobs/${input.jobId}`,
          'GET',
          jobRecord.refine((job) => job.id === input.jobId && job.attempt === input.attempt),
          undefined,
          15_000,
          true,
          person.data.principal,
          person.data.isCurrent
        )
      const current = await readJob()
      if (!current.ok) {
        return current
      }
      const receipt = current.data.execution_artifacts?.[0]
      if (
        !receipt ||
        receipt.job_id !== input.jobId ||
        receipt.attempt !== input.attempt ||
        !taskId.safeParse(current.data.task_id).success
      ) {
        return failure(
          'result_unavailable',
          'No verified result files are available for this attempt.'
        )
      }
      let response: Response | undefined
      try {
        if (!person.data.isCurrent()) {
          return failure(
            'connection_changed',
            'Your account changed. Refresh before opening these results.'
          )
        }
        const path = `/api/gtd/hub/api/board/${current.data.task_id}/files/download?path=${encodeURIComponent(receipt.rel)}`
        response = await fetch(`${person.data.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${person.data.bearer}`, 'Accept-Encoding': 'identity' },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(60_000)
        })
        if (!response.ok) {
          const raw = await readFetchResponseJsonWithinLimit<unknown>(response, 65_536).catch(
            () => ({})
          )
          return person.data.isCurrent()
            ? refusal(redactConsoleWorkflowMemory(raw), response.status)
            : failure(
                'connection_changed',
                'Your account changed. Refresh before opening these results.'
              )
        }
        if ((response.headers.get('content-encoding') ?? 'identity') !== 'identity') {
          return failure('result_changed', 'The result download changed its byte encoding.')
        }
        const bytes = Buffer.from(
          await readFetchResponseBytesWithinLimit(response, receipt.size_bytes)
        )
        const result = decodeConsoleFolderResult(bytes, receipt)
        const latest = await readJob()
        if (!latest.ok) {
          return latest
        }
        const actual = latest.data.execution_artifacts?.[0]
        if (
          !actual ||
          latest.data.task_id !== current.data.task_id ||
          JSON.stringify(actual) !== JSON.stringify(receipt)
        ) {
          return failure(
            'result_changed',
            'This job attempt changed while its results were downloaded. Refresh to continue.'
          )
        }
        if (!person.data.isCurrent()) {
          return failure(
            'connection_changed',
            'Your account changed. Refresh before opening these results.'
          )
        }
        return { ok: true as const, data: result }
      } catch {
        return failure(
          'result_unavailable',
          'The result could not be downloaded and verified. Refresh to try again.'
        )
      } finally {
        if (response) {
          await cancelUnreadResponseBody(response)
        }
      }
    }
  )
}
