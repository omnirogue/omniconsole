import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type {
  ConsoleExecutionAck,
  ConsoleExecutionObservation,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import { normalizeConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { failure, requestConsoleWorkflow, unavailable } from './console-workflow-transport'
import { jobEvents } from './console-workflow-records'

const progressAck = z.object({
  ok: z.literal(true),
  event_id: z.number().int().positive(),
  duplicate: z.boolean(),
  cancel_requested: z.boolean()
})

/** Verify the committed event before acknowledging the local transport cursor. */
export async function publishConsoleExecutionObservation(
  observation: ConsoleExecutionObservation,
  expectedPrincipal: string
): Promise<ConsoleWorkflowResult<ConsoleExecutionAck>> {
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return person
  }
  if (person.data.principal !== expectedPrincipal || !person.data.isCurrent()) {
    return failure(
      'principal_mismatch',
      'Sign in as the person who activated this job to resume publication.'
    )
  }
  if (!observation?.binding?.claim) {
    return unavailable('the complete server-issued local claim needed to publish this observation')
  }
  let binding
  try {
    binding = normalizeConsoleJobBinding(observation.binding)
  } catch {
    return failure('invalid_request', 'The observation has no valid local claim binding.')
  }
  if (
    !/^[a-f0-9]{64}$/.test(observation.idempotencyKey) ||
    !/^sha256:[a-f0-9]{64}$/.test(observation.journalCursor) ||
    !['run_started', 'checkpoint_written', 'stop_confirmed', 'worker_exit'].includes(
      observation.event
    ) ||
    (observation.detail !== undefined &&
      (typeof observation.detail !== 'string' || observation.detail.length > 1000))
  ) {
    return failure(
      'invalid_request',
      'The observation must name its committed cursor and bounded event.'
    )
  }
  const submitted = {
    id: observation.idempotencyKey,
    kind: observation.event === 'run_started' ? 'progress' : observation.event,
    cursor: observation.journalCursor,
    ...(observation.detail === undefined ? {} : { note: observation.detail })
  }
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${binding.jobId}/progress`,
    'POST',
    progressAck,
    {
      attempt: binding.attempt,
      lease_generation: binding.leaseGeneration,
      claimed_at: binding.claim!.claimedAt,
      runner_instance: binding.claim!.runnerInstance,
      observation: submitted
    },
    15_000,
    false,
    expectedPrincipal
  )
  if (!response.ok) {
    return response
  }
  const recorded = await requestConsoleWorkflow(
    `/api/gtd/jobs/${binding.jobId}/events?event_id=${response.data.event_id}`,
    'GET',
    jobEvents,
    undefined,
    15_000,
    false,
    expectedPrincipal
  )
  if (!recorded.ok) {
    return recorded
  }
  const event = recorded.data.events.find((entry) => entry.id === response.data.event_id)
  if (
    !event ||
    recorded.data.job_id !== binding.jobId ||
    event.job_id !== binding.jobId ||
    event.kind !== 'local_observation' ||
    event.detail.attempt !== binding.attempt ||
    event.detail.lease_generation !== binding.leaseGeneration ||
    !isDeepStrictEqual(event.detail.observation, submitted)
  ) {
    return failure(
      'invalid_response',
      'The console event does not acknowledge this exact observation.'
    )
  }
  return {
    ok: true,
    data: {
      eventId: String(event.id),
      journalCursor: observation.journalCursor,
      idempotencyKey: observation.idempotencyKey
    }
  }
}
