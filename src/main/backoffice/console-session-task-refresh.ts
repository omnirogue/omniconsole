import { readJiraSessionTask } from './console-jira-session'
import { z } from 'zod'
import {
  sessionTaskContextRequest,
  type ConsoleSessionTaskContextRequest
} from '../../shared/console-session-task-binding'
import { LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'
import type {
  ConsoleSessionAttachResult,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow as request, validated, failure } from './console-workflow-transport'
import { readAttachedTaskContext } from './console-session-task-context'
import { readConsoleLedgerSessionBinding } from './console-ledger-session-binding'

const hubBinding = z.object({
  id: z.string().regex(/^ses_[A-Za-z0-9]{4,64}$/),
  board_task_id: z.string().nullable()
})

/** Refresh only while the same person's canonical session still serves this task. */
export function readConsoleSessionTaskContext(
  args: ConsoleSessionTaskContextRequest
): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>> {
  return validated(args, sessionTaskContextRequest, async (input) => {
    if (input.taskId.startsWith('jira:')) {
      const result = await readJiraSessionTask({ sourceKey: input.sourceKey ?? input.sessionId! })
      if (!result.ok) {
        return result
      }
      return result.data.taskId === input.taskId &&
        (!input.sessionId || input.sessionId === result.data.sessionId)
        ? result
        : failure('binding_changed', 'This session is no longer attached to that Jira task.')
    }
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok) {
      return person
    }
    const source = input.sourceKey
      ? ledgerSourceForSession(input.sourceKey, person.data.principal)
      : null
    if (input.sourceKey && (!source || (input.sessionId && input.sessionId !== source.ledgerId))) {
      return failure(
        'binding_changed',
        'The source conversation has no confirmed session identity.'
      )
    }
    const sessionId = source?.ledgerId ?? input.sessionId!
    const sourceIsCurrent = () =>
      person.data.isCurrent() &&
      (!source ||
        JSON.stringify(ledgerSourceForSession(input.sourceKey!, person.data.principal)) ===
          JSON.stringify(source))
    const readBinding = () =>
      LEDGER_ID_PATTERN.test(sessionId)
        ? readConsoleLedgerSessionBinding(sessionId, person.data.principal, sourceIsCurrent)
        : request(
            `/api/gtd/hub/api/sessions/${sessionId}`,
            'GET',
            hubBinding,
            undefined,
            15_000,
            false,
            person.data.principal,
            sourceIsCurrent
          )
    const matches = (value: z.infer<typeof hubBinding>) =>
      value.id === sessionId && value.board_task_id === input.taskId
    const before = await readBinding()
    if (!before.ok) {
      return before
    }
    if (!matches(before.data)) {
      return failure('binding_changed', 'This session is no longer attached to that task.')
    }
    const context = await readAttachedTaskContext(
      input.taskId,
      person.data.principal,
      sourceIsCurrent
    )
    if (!context.context) {
      return failure('context_unavailable', 'The task context could not be refreshed. Try again.')
    }
    const after = await readBinding()
    if (!after.ok) {
      return after
    }
    if (!matches(after.data) || !sourceIsCurrent()) {
      return failure('binding_changed', 'The session or signed-in person changed. Try again.')
    }
    return { ok: true, data: { ok: true, sessionId, taskId: input.taskId, ...context } }
  })
}
