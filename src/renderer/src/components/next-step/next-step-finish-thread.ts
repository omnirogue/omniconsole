import { handoffApi } from '@/components/handoffs/handoff-client'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import { acceptSessionRequest } from '@/lib/session-request-actions'
import { sessionRequestBodyOf } from '@/lib/session-request-thread'
import { invalidateBackofficeWork } from '@/components/task-page/backoffice/backoffice-work-store'
import { isThreadRecipient, type NextStepSubject } from './next-step-subject'
import { doneRefusal, newOperationId, type NextStepActionResult } from './next-step-action-result'

/**
 * ✓ Done on a thread handed to this person.
 *
 * Two different things wear the same tick. On an ordinary handoff it records the `done` entry that
 * resolves the thread. On somebody's request for this session it means "yes, take it": the work in
 * progress is committed, pushed and handed over, and only then is the request answered.
 */
export async function finishThread(
  subject: Extract<NextStepSubject, { kind: 'thread' }>
): Promise<NextStepActionResult> {
  if (!isThreadRecipient(subject)) {
    return { ok: false, message: doneRefusal(subject, null) ?? '' }
  }
  // Someone asking for this session is a request, not a note: ✓ here means "yes, take it", so
  // the work in progress is committed and handed over before the request is marked answered.
  const requestBody = sessionRequestBodyOf(subject.detail)
  if (requestBody) {
    const accepted = await acceptSessionRequest({
      threadId: subject.detail.thread.id,
      requesterEmployeeId: subject.detail.thread.author_employee_id,
      ownerName: subject.viewer ?? 'The owner',
      requestBody
    })
    if (!accepted.ok) {
      return { ok: false, message: accepted.message }
    }
    invalidateBackofficeWork()
    return {
      ok: true,
      message: translate(
        'nextStep.sessionHandedOver',
        'Handed over. The work in progress is on {{branch}}.',
        { branch: accepted.data.branch ?? 'the handoff branch' }
      )
    }
  }
  try {
    workflowData(
      await handoffApi().respond({
        threadId: subject.detail.thread.id,
        kind: 'done',
        note: translate('nextStep.doneNote', 'Done.'),
        operationId: newOperationId()
      })
    )
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  invalidateBackofficeWork()
  return { ok: true, message: translate('nextStep.threadDone', 'Marked done on the thread.') }
}
