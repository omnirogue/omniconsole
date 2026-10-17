import {
  isJournalTaskPublication,
  type JournalTaskPublication
} from '../native-chat/agent-session-journal/journal-task-publication'
import { createHash } from 'node:crypto'
import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import { isBoardTaskId } from '../../shared/board-task-id'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import {
  captureConsoleWorkflowPerson,
  sanitizeConsoleWorkflowText
} from './console-workflow-person'

export type BackofficeExecutionObservation = {
  hubTaskId: string
  runId: string
  /** A committed journal position, never a timestamp or an unconfirmed process state. */
  journalCursor: AgentJournalCursor | string
  event: 'run_started' | 'checkpoint_written' | 'stop_confirmed' | 'worker_exit'
  workerDispatchId?: string
  detail?: string
}

export type BackofficeObservationResult =
  | { ok: true; noteId: string }
  | { ok: false; message: string }

const OBSERVATION_LABELS = {
  run_started: 'IDE execution started',
  checkpoint_written: 'IDE execution checkpoint written',
  stop_confirmed: 'IDE execution stop confirmed',
  worker_exit: 'IDE worker process exited'
} as const

function boundedText(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    return false
  }
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) {
      return false
    }
  }
  return true
}

function cursorReference(cursor: BackofficeExecutionObservation['journalCursor']): string | null {
  if (typeof cursor === 'string') {
    return boundedText(cursor, 2000) ? cursor : null
  }
  if (
    !cursor ||
    !boundedText(cursor.epoch, 256) ||
    !Number.isSafeInteger(cursor.sequence) ||
    cursor.sequence < 1
  ) {
    return null
  }
  return JSON.stringify({ epoch: cursor.epoch, sequence: cursor.sequence })
}

/** The hub's closed progress schema carries execution references in evidence. */
export function buildBackofficeExecutionNote(observation: BackofficeExecutionObservation) {
  const cursor = cursorReference(observation.journalCursor)
  if (
    !isBoardTaskId(observation.hubTaskId) ||
    !boundedText(observation.runId, 256) ||
    !Object.hasOwn(OBSERVATION_LABELS, observation.event) ||
    !cursor ||
    (observation.workerDispatchId !== undefined &&
      !boundedText(observation.workerDispatchId, 256)) ||
    (observation.detail !== undefined && !boundedText(observation.detail, 1000))
  ) {
    throw new Error('An execution observation requires a card, run and committed journal cursor.')
  }
  const summary = OBSERVATION_LABELS[observation.event]
  const evidence = [
    { kind: 'text' as const, ref: observation.runId, label: 'IDE run id' },
    { kind: 'text' as const, ref: cursor, label: 'IDE journal cursor' },
    { kind: 'text' as const, ref: observation.event, label: 'IDE execution observation' }
  ]
  if (observation.workerDispatchId) {
    evidence.push({
      kind: 'text',
      ref: observation.workerDispatchId,
      label: 'IDE worker dispatch id'
    })
  }
  return {
    note: [summary, `Run: ${observation.runId}`, `Journal: ${cursor}`, observation.detail]
      .filter(Boolean)
      .join('\n'),
    source_event_id: `ide-observation-v1:${createHash('sha256')
      .update(
        JSON.stringify([
          observation.hubTaskId,
          observation.runId,
          cursor,
          observation.event,
          observation.workerDispatchId ?? null
        ])
      )
      .digest('hex')}`,
    note_kind: 'progress' as const,
    payload: { summary, done: [] as string[], evidence }
  }
}

function storedObservationId(
  value: unknown,
  taskId: string,
  expected: ReturnType<typeof buildBackofficeExecutionNote>
): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const row = value as Record<string, unknown>
  if (
    row.ok === false ||
    row.task_id !== taskId ||
    row.note_kind !== 'progress' ||
    row.note_replay_version !== 1 ||
    row.source_event_id !== expected.source_event_id ||
    row.note !== expected.note ||
    !boundedText(row.id, 256) ||
    !/^tve_[A-Za-z0-9_-]+$/.test(row.id) ||
    !row.payload ||
    typeof row.payload !== 'object'
  ) {
    return null
  }
  const payload = row.payload as { summary?: unknown; done?: unknown; evidence?: unknown }
  if (
    payload.summary !== expected.payload.summary ||
    !Array.isArray(payload.done) ||
    payload.done.length !== 0
  ) {
    return null
  }
  const evidence = payload.evidence
  if (!Array.isArray(evidence)) {
    return null
  }
  const matches = expected.payload.evidence.every((item) =>
    evidence.some(
      (stored) =>
        stored?.kind === item.kind && stored?.label === item.label && stored?.ref === item.ref
    )
  )
  return matches ? row.id : null
}

/** Project a committed execution observation; journal durability never depends on this request. */
export async function postBackofficeExecutionObservation(
  observation: BackofficeExecutionObservation,
  expected?: BackofficePublicationScope
): Promise<BackofficeObservationResult> {
  try {
    const body = buildBackofficeExecutionNote(observation)
    return await postExecutionNote(observation.hubTaskId, body, JSON.stringify(body), expected)
  } catch {
    return {
      ok: false,
      message: 'The shared save was not confirmed. Your local session is unchanged.'
    }
  }
}

export type BackofficePublicationScope = {
  profileKey?: string
  principal: string
  baseUrl: string
  isCurrent?: () => boolean
}

export async function postSavedBackofficeExecutionNote(
  saved: JournalTaskPublication,
  isCurrent: () => boolean
): Promise<BackofficeObservationResult> {
  if (!isJournalTaskPublication(saved) || !saved.profileKey || saved.noteId !== null) {
    return { ok: false, message: 'The pending task note is invalid.' }
  }
  const body = JSON.parse(saved.request) as ReturnType<typeof buildBackofficeExecutionNote>
  if (
    !boundedText(body.payload.summary, 1000) ||
    !Array.isArray(body.payload.done) ||
    body.payload.done.length !== 0 ||
    !Array.isArray(body.payload.evidence) ||
    body.payload.evidence.length > 8 ||
    !body.payload.evidence.every(
      (item) => item?.kind === 'text' && boundedText(item.ref, 2000) && boundedText(item.label, 256)
    )
  ) {
    return { ok: false, message: 'The pending task note has invalid execution evidence.' }
  }
  return postExecutionNote(saved.taskId, body, saved.request, { ...saved, isCurrent })
}

async function postExecutionNote(
  taskId: string,
  body: ReturnType<typeof buildBackofficeExecutionNote>,
  serialized: string,
  expected?: BackofficePublicationScope
): Promise<BackofficeObservationResult> {
  try {
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      return { ok: false, message: 'Sign in to save progress to your task.' }
    }
    const person = captured.data
    if (
      expected &&
      (person.principal !== expected.principal ||
        person.baseUrl !== expected.baseUrl ||
        (expected.profileKey !== undefined && person.profileKey !== expected.profileKey))
    ) {
      return {
        ok: false,
        message: 'Return to the original account and connection to save this progress.'
      }
    }
    if (sanitizeConsoleWorkflowText(serialized) !== serialized) {
      return {
        ok: false,
        message: 'This progress note needs private information removed before sharing.'
      }
    }
    if (!person.isCurrent() || expected?.isCurrent?.() === false) {
      return {
        ok: false,
        message: 'Your account or connection changed. The shared save is not confirmed.'
      }
    }
    // No renderer-controlled URL, actor, command, or completion verb crosses this door.
    const response = await fetch(`${person.baseUrl}/api/team/tasks/${taskId}/comment`, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${person.bearer}` },
      body: serialized
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, message: `Execution progress was refused (HTTP ${response.status}).` }
    }
    const reply = await readFetchResponseJsonWithinLimit<unknown>(response, 65_536)
    if (!person.isCurrent() || expected?.isCurrent?.() === false) {
      return {
        ok: false,
        message: 'Your account or connection changed. The shared save is not confirmed.'
      }
    }
    const noteId = storedObservationId(reply, taskId, body)
    return noteId
      ? { ok: true, noteId }
      : {
          ok: false,
          message: 'The backoffice did not confirm the stored execution progress note.'
        }
  } catch {
    return {
      ok: false,
      message: 'The shared save was not confirmed. Your local session is unchanged.'
    }
  }
}
