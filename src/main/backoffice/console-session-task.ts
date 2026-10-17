import { z } from 'zod'
import type {
  ConsoleSessionAttachRequest,
  ConsoleSessionAttachResult,
  ConsoleSessionIngestRequest,
  ConsoleSessionRecord,
  ConsoleTaskCard,
  ConsoleTaskSession,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import {
  sessionAttachRequest,
  sessionIngestRequest,
  taskCardRequest
} from '../../shared/console-workflow-schemas'
import { requestConsoleWorkflow as request, validated, failure } from './console-workflow-transport'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { readAttachedTaskContext } from './console-session-task-context'
import { workCard } from '../../shared/console-work-home-contract'
import { LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'
import { readConsoleLedgerSessionBinding } from './console-ledger-session-binding'

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{4,64}$/
const sessionId = z.string().regex(SESSION_ID_PATTERN)
const nullableText = z.string().nullable().optional()

/**
 * The hub answers ingest with the canonical session row; only its id matters to the
 * desktop, which keys everything else off its own pane. The live hub answers
 * `{ok, session_id}` and — since person ingest stopped keeping a ledger copy — echoes back
 * whatever ref it was given rather than minting a `ses_` row, so the id is read, not trusted.
 */
const ingestAnswer = z.union([
  z.object({ session: z.object({ id: sessionId }).passthrough() }).transform((a) => a.session.id),
  z.object({ id: sessionId }).transform((a) => a.id),
  z
    .object({ ok: z.boolean().optional(), session_id: z.string() })
    .passthrough()
    .transform((a) => a.session_id)
])
const attachAnswer = z.object({ session_id: sessionId, board_task_id: z.string() })
const sessionBinding = z.object({ id: sessionId, board_task_id: z.string().nullable() })
const sourceSessionBinding = sessionBinding.extend({ session_ref: z.string().min(1) })
const cardAnswer = z
  .object({
    ok: z.boolean().optional(),
    card: z
      .object({
        id: z.string(),
        title: nullableText,
        status: nullableText,
        owner_employee_id: nullableText,
        company_slug: nullableText,
        next_action: nullableText,
        description: nullableText,
        due_date: nullableText,
        updated_at: nullableText,
        blocked: workCard.shape.blocked.transform((value) =>
          typeof value === 'boolean'
            ? value
            : Boolean(typeof value === 'string' ? value.trim() : value?.text.trim())
        )
      })
      .passthrough()
  })
  .passthrough()
const sessionsAnswer = z
  .object({
    ok: z.boolean().optional(),
    sessions: z
      .array(
        z
          .object({
            id: z.string(),
            title: nullableText,
            state: nullableText,
            model: nullableText,
            provider: nullableText,
            machine_id: nullableText,
            started_at: nullableText,
            updated_at: nullableText
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough()

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * A conversation reports itself to the hub so a task can hold it. The hub's ingest
 * route never gates: a session with no company and no task is recorded as an
 * observation, which is exactly what a conversation is until someone commits to it.
 */
export function ingestConsoleSession(
  args: ConsoleSessionIngestRequest
): Promise<ConsoleWorkflowResult<ConsoleSessionRecord>> {
  return validated(args, sessionIngestRequest, async (input) => {
    const answered = await request('/api/gtd/hub/api/sessions/ingest', 'POST', ingestAnswer, {
      session_id: input.sessionRef,
      session_ref: input.sessionRef,
      cwd: input.cwd,
      provider: input.provider,
      state: 'running',
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.description === undefined ? {} : { description: input.description })
    })
    if (!answered.ok) {
      return answered
    }
    if (!SESSION_ID_PATTERN.test(answered.data)) {
      // Why: the hub echoed this desktop's own pane ref, so there is no hub session to attach
      // a task to — `/api/sessions/<ref>/attach` would 404. The link belongs on the session
      // ledger instead, which the caller writes whatever this answers.
      return failure(
        'hub_session_unavailable',
        'This conversation has no hub session; its task link lives on the session ledger.'
      )
    }
    return { ok: true, data: { sessionId: answered.data } }
  })
}

/** The durable link: this session serves that task. Refused on a closed card. */
export function attachConsoleSession(
  args: ConsoleSessionAttachRequest
): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>> {
  return validated(args, sessionAttachRequest, async (input) => {
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok) {
      return person
    }
    const attached = await request(
      `/api/gtd/hub/api/sessions/${input.sessionId}/attach`,
      'POST',
      attachAnswer,
      { board_task_id: input.taskId },
      15_000,
      false,
      person.data.principal,
      person.data.isCurrent
    )
    if (!attached.ok) {
      return attached
    }
    if (
      attached.data.session_id !== input.sessionId ||
      attached.data.board_task_id !== input.taskId
    ) {
      return failure('invalid_response', 'The backoffice confirmed a different session or task.')
    }
    const context = await readAttachedTaskContext(
      input.taskId,
      person.data.principal,
      person.data.isCurrent
    )
    if (!person.data.isCurrent()) {
      return failure(
        'connection_changed',
        'The signed-in person changed; refresh the recorded attachment.'
      )
    }
    return {
      ok: true,
      data: { ok: true, sessionId: input.sessionId, taskId: input.taskId, ...context }
    }
  })
}

export { readConsoleSessionTaskContext } from './console-session-task-refresh'

/** Read the server's source identity under the exact signed person before adopting a task attachment. */
export function readConsoleSourceSessionBinding(session: string, principal: string) {
  if (LEDGER_ID_PATTERN.test(session)) {
    return readConsoleLedgerSessionBinding(session, principal)
  }
  return request(
    `/api/gtd/hub/api/sessions/${sessionId.parse(session)}`,
    'GET',
    sourceSessionBinding,
    undefined,
    15_000,
    false,
    principal
  )
}

/** One task, read whole. */
export function readConsoleTaskCard(args: {
  taskId: string
}): Promise<ConsoleWorkflowResult<ConsoleTaskCard>> {
  return validated(args, taskCardRequest, (input) =>
    request(
      `/api/work/card/${input.taskId}`,
      'GET',
      cardAnswer.transform((answer) => ({
        id: answer.card.id,
        title: text(answer.card.title) ?? input.taskId,
        status: text(answer.card.status),
        ownerEmployeeId: text(answer.card.owner_employee_id),
        companySlug: text(answer.card.company_slug),
        nextAction: text(answer.card.next_action),
        description: text(answer.card.description),
        dueDate: text(answer.card.due_date),
        updatedAt: text(answer.card.updated_at),
        blocked: answer.card.blocked === true
      }))
    )
  )
}

/** Every session that has worked this task — the Task-holds-Sessions read. */
export function readConsoleTaskSessions(args: {
  taskId: string
}): Promise<ConsoleWorkflowResult<{ sessions: ConsoleTaskSession[] }>> {
  return validated(args, taskCardRequest, (input) =>
    request(
      `/api/work/card/${input.taskId}/sessions`,
      'GET',
      sessionsAnswer.transform((answer) => ({
        sessions: answer.sessions.map((row) => ({
          id: row.id,
          title: text(row.title),
          state: text(row.state),
          model: text(row.model),
          provider: text(row.provider),
          machineId: text(row.machine_id),
          startedAt: text(row.started_at),
          updatedAt: text(row.updated_at)
        }))
      }))
    )
  )
}
