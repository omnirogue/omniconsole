import { createHash } from 'node:crypto'
import { serializeConsoleWorkflowRequest } from '../../backoffice/console-workflow-redaction'
import { redactValue } from '../../observability/redactor'
import { getConsoleJobBindingForDispatch } from './console-job-binding'
import {
  ConsoleJobProcessEventSchema,
  consoleJobProcessPhases,
  normalizeConsoleJobProcessIdentity,
  type ConsoleJobProcessEvent,
  type ConsoleJobProcessEventInput,
  type ConsoleJobProcessIdentity,
  type ConsoleJobProcessRecord
} from './console-job-process-record'
import type { OrchestrationDb } from './db/orchestration-db'

export type {
  ConsoleJobProcessIdentity,
  ConsoleJobProcessRecord,
  ConsoleJobProcessEvent,
  ConsoleJobProcessEventInput,
  ConsoleJobPhysicalExit
} from './console-job-process-record'

export type ConsoleJobProcessHandshake = {
  gate: ConsoleJobProcessEvent['gate']
  prepared: ConsoleJobProcessRecord
  startAcknowledgement?: string
  startAcknowledged?: ConsoleJobProcessRecord
  releaseIntent?: ConsoleJobProcessRecord
  released?: ConsoleJobProcessRecord
  exitIntent?: ConsoleJobProcessRecord
  physicalExit?: ConsoleJobProcessRecord
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function recordId(identity: ConsoleJobProcessIdentity, phase: ConsoleJobProcessEvent['phase']) {
  return `omnios_process_${digest([identity.runId, identity.dispatchId, phase])}`
}

function payload(
  identity: ConsoleJobProcessIdentity,
  event: ConsoleJobProcessEvent,
  redact: (value: unknown) => unknown = (value) => value
): string {
  return serializeConsoleWorkflowRequest(
    { kind: 'console_job_process_handshake', version: 1, identity, event },
    '',
    (value) => redactValue(redact(value))
  )
}

function startReference(db: OrchestrationDb, identity: ConsoleJobProcessIdentity): string {
  const binding = getConsoleJobBindingForDispatch(db, identity.dispatchId)
  if (
    !db.getRun(identity.runId)?.console_job_start_receipt ||
    !binding?.sessionId ||
    !binding.attemptId
  ) {
    throw new Error('Persist the canonical start receipt before acknowledging the process gate.')
  }
  return `sha256:${digest([identity, binding])}`
}

function readRecords(
  db: OrchestrationDb,
  identity: ConsoleJobProcessIdentity
): Partial<Record<ConsoleJobProcessEvent['phase'], ConsoleJobProcessRecord>> {
  const records: Partial<Record<ConsoleJobProcessEvent['phase'], ConsoleJobProcessRecord>> = {}
  for (const phase of consoleJobProcessPhases) {
    const row = db.getMessageById(recordId(identity, phase))
    if (!row) {
      continue
    }
    const parsed = row.payload ? JSON.parse(row.payload) : null
    const event = ConsoleJobProcessEventSchema.parse(parsed?.event)
    if (
      row.run_id !== identity.runId ||
      row.from_handle !== 'runtime' ||
      row.to_handle !== `run:${identity.runId}` ||
      row.delivery_contract !== 'audit_only' ||
      row.type !== 'status' ||
      event.phase !== phase ||
      row.payload !== payload(identity, event)
    ) {
      throw new Error('The stored process receipt does not match its immutable journal identity.')
    }
    records[phase] = {
      identity,
      sequence: row.sequence,
      journalCursor: `orchestration:${identity.runId}:messages:${row.sequence}`,
      event
    }
  }
  return records
}

function restoreHandshake(
  db: OrchestrationDb,
  identity: ConsoleJobProcessIdentity
): ConsoleJobProcessHandshake | null {
  const records = readRecords(db, identity)
  const prepared = records.prepared
  if (!prepared) {
    if (Object.keys(records).length) {
      throw new Error('The process journal is missing its prepared gate receipt.')
    }
    return null
  }
  const previous = {
    start_acknowledged: 'prepared',
    release_intent: 'start_acknowledged',
    released: 'release_intent',
    exit_intent: 'released',
    physical_exit: 'prepared'
  } as const
  for (const phase of consoleJobProcessPhases.slice(1)) {
    const record = records[phase]
    if (!record || phase === 'prepared') {
      continue
    }
    const predecessor = records[previous[phase]]
    if (
      !predecessor ||
      predecessor.sequence >= record.sequence ||
      JSON.stringify(record.event.gate) !== JSON.stringify(prepared.event.gate) ||
      (records.physical_exit &&
        phase !== 'physical_exit' &&
        record.sequence >= records.physical_exit.sequence)
    ) {
      throw new Error('The process receipt lacks its exact gate or committed predecessor.')
    }
    const event = record.event
    if (
      (event.phase === 'start_acknowledged' || event.phase === 'release_intent') &&
      event.startAcknowledgement !== startReference(db, identity)
    ) {
      throw new Error('The gate acknowledgement does not reference its canonical start receipt.')
    }
    if (
      event.phase === 'released' &&
      (event.released.gateId !== event.gate.gateId ||
        event.released.startAcknowledgement !== startReference(db, identity))
    ) {
      throw new Error('The host release acknowledgement identifies another gate or start.')
    }
    if (
      event.phase === 'physical_exit' &&
      Date.parse(event.exit.observedAt) < event.gate.processStartTimeMs
    ) {
      throw new Error('The physical exit predates the registered process birth.')
    }
  }
  return {
    gate: prepared.event.gate,
    prepared,
    ...(records.start_acknowledged?.event.phase === 'start_acknowledged'
      ? { startAcknowledgement: records.start_acknowledged.event.startAcknowledgement }
      : {}),
    startAcknowledged: records.start_acknowledged,
    releaseIntent: records.release_intent,
    released: records.released,
    exitIntent: records.exit_intent,
    physicalExit: records.physical_exit
  }
}

/** Host audit receipts are not publication events and confer no session, attempt or card authority. */
export function readConsoleJobProcessHandshake(
  db: OrchestrationDb,
  input: ConsoleJobProcessIdentity
): ConsoleJobProcessHandshake | null {
  return restoreHandshake(db, normalizeConsoleJobProcessIdentity(db, input))
}

export function recordConsoleJobProcessHandshake(
  db: OrchestrationDb,
  input: ConsoleJobProcessIdentity,
  eventInput: ConsoleJobProcessEventInput,
  redact?: (value: unknown) => unknown
): { record: ConsoleJobProcessRecord; fresh: boolean } {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const identity = normalizeConsoleJobProcessIdentity(db, input)
    const event = ConsoleJobProcessEventSchema.parse(
      eventInput.phase === 'start_acknowledged'
        ? { ...eventInput, startAcknowledgement: startReference(db, identity) }
        : eventInput
    )
    const state = restoreHandshake(db, identity)
    const id = recordId(identity, event.phase)
    const serialized = payload(identity, event, redact)
    const previous = db.getMessageById(id)
    if (previous && previous.payload !== serialized) {
      throw new Error('The process receipt is already frozen for this Dispatch and phase.')
    }
    if (!previous) {
      if (state?.physicalExit) {
        throw new Error('An observed process exit cannot authorize another lifecycle action.')
      }
      if (event.phase === 'prepared' && db.getRun(identity.runId)?.console_job_start_receipt) {
        throw new Error('Persist the prepared gate before attaching the canonical start receipt.')
      }
      db.insertMessage({
        id,
        runId: identity.runId,
        from: 'runtime',
        to: `run:${identity.runId}`,
        subject: 'Console job process handshake',
        type: 'status',
        deliveryContract: 'audit_only',
        payload: serialized
      })
    }
    restoreHandshake(db, identity)
    const record = readRecords(db, identity)[event.phase]!
    db.db.exec('COMMIT')
    return { record, fresh: !previous }
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
