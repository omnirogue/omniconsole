import { createHash } from 'node:crypto'
import type { ConsoleJobBinding, ConsoleWorkflowJson } from '../../../shared/console-workflow-types'
import { getConsoleJobBindingForDispatch } from './console-job-binding'
import type { OrchestrationDb } from './db/orchestration-db'
import type { MessageRow } from './types'

export type ConsoleJobResultObservation = {
  runId: string
  hubTaskId: string
  workerDispatchId: string
  journalCursor: string
  event: 'result'
  result: Record<string, ConsoleWorkflowJson>
}

export type ConsoleJobResultPublication = {
  binding: ConsoleJobBinding
  journalCursor: string
  idempotencyKey: string
  result: Record<string, ConsoleWorkflowJson>
}

function resultId(runId: string, workerDispatchId: string): string {
  return `omnios_result_${createHash('sha256')
    .update(JSON.stringify([runId, workerDispatchId]))
    .digest('hex')}`
}

function orderedJson(value: ConsoleWorkflowJson): ConsoleWorkflowJson {
  if (Array.isArray(value)) {
    return value.map(orderedJson)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, orderedJson(value[key])])
    )
  }
  return value
}

export function restoreConsoleJobResult(
  db: OrchestrationDb,
  row: MessageRow
): ConsoleJobResultObservation | null {
  if (row.delivery_contract !== 'audit_only' || row.from_handle !== 'runtime' || !row.payload) {
    return null
  }
  const payload = JSON.parse(row.payload) as {
    kind?: string
    hubTaskId?: string
    workerDispatchId?: string
    result?: Record<string, ConsoleWorkflowJson>
  }
  const run = db.getRun(row.run_id)
  if (
    payload.kind !== 'console_job_result' ||
    !run?.console_job ||
    !run.hub_task_id ||
    payload.hubTaskId !== run.hub_task_id ||
    !payload.workerDispatchId ||
    row.id !== resultId(run.id, payload.workerDispatchId) ||
    !payload.result ||
    typeof payload.result !== 'object' ||
    Array.isArray(payload.result)
  ) {
    return null
  }
  return {
    runId: run.id,
    hubTaskId: run.hub_task_id,
    workerDispatchId: payload.workerDispatchId,
    journalCursor: `orchestration:${run.id}:messages:${row.sequence}`,
    event: 'result',
    result: payload.result
  }
}

export function readConsoleJobResult(
  db: OrchestrationDb,
  runId: string,
  workerDispatchId: string
): ConsoleJobResultObservation | null {
  const row = db.getMessageById(resultId(runId, workerDispatchId))
  return row ? restoreConsoleJobResult(db, row) : null
}

export function recordConsoleJobResult(
  db: OrchestrationDb,
  input: { runId: string; workerDispatchId: string; result: Record<string, ConsoleWorkflowJson> },
  sanitize: (text: string) => string
): { observation: ConsoleJobResultObservation; fresh: boolean } {
  const binding = getConsoleJobBindingForDispatch(db, input.workerDispatchId)
  const dispatch = db.getDispatchContextById(input.workerDispatchId)
  if (!binding || dispatch?.run_id !== input.runId) {
    throw new Error('A terminal result requires its exact console job dispatch binding.')
  }
  let serialized = sanitize(JSON.stringify(input.result))
  for (const localId of [input.runId, input.workerDispatchId, dispatch.task_id]) {
    serialized = serialized.split(localId).join('[local reference]')
  }
  const result = JSON.parse(serialized) as Record<string, ConsoleWorkflowJson>
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Buffer.byteLength(serialized, 'utf8') > 1_048_576
  ) {
    throw new Error('A terminal result requires a bounded, sanitized JSON object.')
  }
  const id = resultId(input.runId, input.workerDispatchId)
  const payload = JSON.stringify({
    kind: 'console_job_result',
    hubTaskId: binding.taskId,
    workerDispatchId: input.workerDispatchId,
    result: orderedJson(result)
  })
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const previous = db.getMessageById(id)
    if (previous && (previous.run_id !== input.runId || previous.payload !== payload)) {
      throw new Error('The accepted terminal result is already frozen for this dispatch.')
    }
    const row =
      previous ??
      db.insertMessage({
        id,
        runId: input.runId,
        from: 'runtime',
        to: `run:${input.runId}`,
        subject: 'Console job terminal result',
        type: 'status',
        deliveryContract: 'audit_only',
        payload
      })
    const observation = restoreConsoleJobResult(db, row)
    if (!observation) {
      throw new Error('The accepted result could not be restored from its committed journal shape.')
    }
    db.db.exec('COMMIT')
    return { observation, fresh: !previous }
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
