import type { z } from 'zod'
import {
  handoffArchive,
  handoffArchiveReceipt,
  handoffDetail,
  handoffQueue,
  type ConsoleHandoffApi,
  type HandoffQueue,
  type HandoffThread
} from '../../shared/console-handoff-contract'
import { consoleMe } from '../../shared/console-companies-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { failure, requestConsoleWorkflow, validated } from './console-workflow-transport'

const ROOT = '/api/gtd/hub/api/handoffs'
type SignedRequest = <T>(
  path: string,
  method: 'GET' | 'POST',
  schema: z.ZodType<T>,
  body?: unknown
) => Promise<ConsoleWorkflowResult<T>>

export async function withHandoffViewer<T>(
  perform: (employeeId: string, request: SignedRequest) => Promise<ConsoleWorkflowResult<T>>
): Promise<ConsoleWorkflowResult<T>> {
  const captured = await captureConsoleWorkflowPerson()
  if (!captured.ok) {
    return captured
  }
  const { principal, isCurrent } = captured.data
  const request: SignedRequest = (path, method, schema, body) =>
    requestConsoleWorkflow(path, method, schema, body, 15_000, false, principal, isCurrent)
  const me = await request('/api/me', 'GET', consoleMe)
  if (!me.ok) {
    return me
  }
  const employee = handoffArchiveReceipt.shape.employee_id.safeParse(me.data.user?.employee_id)
  if (!employee.success) {
    return failure(
      'identity_unavailable',
      'Refresh your signed-in account before changing handoffs.'
    )
  }
  return perform(employee.data, request)
}

function isParticipant(thread: HandoffThread, employeeId: string): boolean {
  return [thread.author_employee_id, thread.recipient_employee_id].includes(employeeId)
}

export const archiveHandoff: ConsoleHandoffApi['archive'] = (args) =>
  validated(args, handoffArchive, (input) =>
    withHandoffViewer(async (employeeId, request) => {
      const detail = await request(
        `${ROOT}/${input.threadId}`,
        'GET',
        handoffDetail.refine(({ thread }) => thread.id === input.threadId)
      )
      if (!detail.ok) {
        return detail
      }
      if (!isParticipant(detail.data.thread, employeeId)) {
        return failure('forbidden', 'Only your own sent or received handoffs can be archived.', 403)
      }
      return request(
        `${ROOT}/${input.threadId}/archive`,
        'POST',
        handoffArchiveReceipt.refine(
          (receipt) => receipt.thread_id === input.threadId && receipt.employee_id === employeeId
        ),
        { archived: input.archived, idempotency_key: input.operationId }
      )
    })
  )

export function readArchivedHandoffs(path: string): Promise<ConsoleWorkflowResult<HandoffQueue>> {
  return withHandoffViewer((employeeId, request) =>
    request(
      path,
      'GET',
      handoffQueue.refine(
        (queue) =>
          queue.view === 'archived' &&
          queue.assignee === employeeId &&
          queue.threads.every((thread) => isParticipant(thread, employeeId))
      )
    )
  )
}
