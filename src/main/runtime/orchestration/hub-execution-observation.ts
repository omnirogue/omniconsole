import { createHash } from 'node:crypto'
import type {
  OrchestrationExecutionObservation,
  OrchestrationObservationInput
} from '../../../shared/orchestration-execution-observation'
import type { OrchestrationDb } from './db/orchestration-db'
import { OrchestrationError } from './orchestration-error'
import type { MessageRow } from './types'

function observationId(input: OrchestrationObservationInput): string {
  const identity = JSON.stringify([
    input.runId,
    input.event,
    input.workerDispatchId ?? null,
    input.checkpointCursor ?? null
  ])
  return `omnios_observation_${createHash('sha256').update(identity).digest('hex')}`
}

export function restoreHubExecutionObservation(
  db: OrchestrationDb,
  row: MessageRow
): OrchestrationExecutionObservation | null {
  if (row.delivery_contract !== 'audit_only' || row.from_handle !== 'runtime' || !row.payload) {
    return null
  }
  const run = db.getRun(row.run_id)
  const payload = JSON.parse(row.payload) as {
    hubTaskId?: string
    event?: OrchestrationExecutionObservation['event']
    workerDispatchId?: string | null
    checkpointCursor?: string | null
  }
  if (
    !run?.hub_task_id ||
    payload.hubTaskId !== run.hub_task_id ||
    !payload.event ||
    !['run_started', 'checkpoint_written', 'stop_confirmed', 'worker_exit'].includes(
      payload.event
    ) ||
    row.id !==
      observationId({
        runId: run.id,
        event: payload.event,
        workerDispatchId: payload.workerDispatchId ?? undefined,
        checkpointCursor: payload.checkpointCursor ?? undefined
      })
  ) {
    return null
  }
  return {
    hubTaskId: run.hub_task_id,
    runId: run.id,
    event: payload.event,
    journalCursor: `orchestration:${run.id}:messages:${row.sequence}`,
    ...(payload.workerDispatchId ? { workerDispatchId: payload.workerDispatchId } : {}),
    ...(row.body ? { detail: row.body } : {})
  }
}

/** Reuse the execution message journal; these audit rows never enter an agent inbox. */
export function recordHubExecutionObservation(
  db: OrchestrationDb,
  input: OrchestrationObservationInput
): { observation: OrchestrationExecutionObservation; fresh: boolean } | null {
  const run = db.getRun(input.runId)
  if (!run?.hub_task_id) {
    return null
  }
  if (input.event === 'checkpoint_written' && !input.checkpointCursor) {
    throw new OrchestrationError('invalid_argument', 'A committed checkpoint cursor is required.')
  }
  if (input.workerDispatchId) {
    const dispatch = db.getDispatchContextById(input.workerDispatchId)
    if (dispatch?.run_id !== run.id || dispatch.hub_task_id !== run.hub_task_id) {
      throw new OrchestrationError('invalid_argument', 'Execution observation binding differs.')
    }
    if (
      input.event === 'stop_confirmed' &&
      db.getWorkerDispatch(input.workerDispatchId)?.state !== 'stopped'
    ) {
      throw new OrchestrationError('invalid_argument', 'The worker stop is not confirmed.')
    }
  } else if (input.event === 'stop_confirmed' || input.event === 'worker_exit') {
    throw new OrchestrationError('invalid_argument', 'An exact worker dispatch is required.')
  }
  const id = observationId(input)
  const previous = db.getMessageById(id)
  const payload = JSON.stringify({
    hubTaskId: run.hub_task_id,
    event: input.event,
    workerDispatchId: input.workerDispatchId ?? null,
    checkpointCursor: input.checkpointCursor ?? null
  })
  if (previous && (previous.run_id !== run.id || previous.payload !== payload)) {
    throw new OrchestrationError('invalid_argument', 'Execution observation identity was reused.')
  }
  const row =
    previous ??
    db.insertMessage({
      id,
      runId: run.id,
      from: 'runtime',
      to: `run:${run.id}`,
      subject: `OmniOS execution: ${input.event}`,
      body: input.detail ?? '',
      type: 'status',
      deliveryContract: 'audit_only',
      payload
    })
  return {
    fresh: !previous,
    observation: restoreHubExecutionObservation(db, row)!
  }
}
