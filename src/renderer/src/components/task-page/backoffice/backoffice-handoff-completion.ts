import { handoffApi } from '@/components/handoffs/handoff-client'
import {
  clearPendingHandoff,
  readPendingHandoff,
  retainPendingHandoff
} from '@/components/handoffs/handoff-request-memory'
import { newOperationId } from '@/components/next-step/next-step-action-result'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import { sessionRequestBodyOf } from '@/lib/session-request-thread'
import type { HandoffDetail } from '../../../../../shared/console-handoff-contract'

export type WorkActionOwner = { scope: string; viewer: string | null }

export function assertWorkActionCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new Error(
      translate('workActions.accountChanged', 'Your account changed. Reopen this list to continue.')
    )
  }
}

/** Reads never mark a request opened; the exact owner must still match before a bulk write. */
export async function readOwnedWorkHandoff(
  threadId: string,
  owner: WorkActionOwner,
  isCurrent: () => boolean
): Promise<HandoffDetail> {
  assertWorkActionCurrent(isCurrent)
  const detail = workflowData(await handoffApi().get({ threadId }))
  assertWorkActionCurrent(isCurrent)
  if (
    detail.thread.id !== threadId ||
    !owner.viewer ||
    ![detail.thread.author_employee_id, detail.thread.recipient_employee_id].includes(owner.viewer)
  ) {
    throw new Error(
      translate(
        'workActions.threadNotYours',
        'This handoff does not belong to your current account.'
      )
    )
  }
  return detail
}

/** Shares the detail reply's saved operation; a successful done entry alone is not completion. */
export async function completeWorkHandoff(
  threadId: string,
  owner: WorkActionOwner,
  isCurrent: () => boolean
): Promise<{ ok: boolean; message: string }> {
  const target = `reply:${threadId}`
  const saved = readPendingHandoff(owner.scope, target)
  if (
    saved &&
    (saved.kind !== 'respond' || saved.body.kind !== 'done' || saved.body.threadId !== threadId)
  ) {
    throw new Error(
      translate('workActions.pendingReply', 'Open this handoff and retry its saved action first.')
    )
  }
  const detail = await readOwnedWorkHandoff(threadId, owner, isCurrent)
  if (detail.thread.state === 'resolved') {
    if (saved) {
      clearPendingHandoff(owner.scope, target, saved.body.operationId)
    }
    return { ok: true, message: translate('handoffs.completed', 'Completed') }
  }
  if (sessionRequestBodyOf(detail)) {
    throw new Error(
      translate(
        'workActions.openSessionRequest',
        'Open this session request to finish its handoff.'
      )
    )
  }
  const intent = saved ?? {
    kind: 'respond' as const,
    body: {
      threadId,
      kind: 'done' as const,
      note: translate('handoffs.markedComplete', 'Marked complete.'),
      operationId: newOperationId()
    }
  }
  assertWorkActionCurrent(isCurrent)
  retainPendingHandoff(owner.scope, target, intent)
  const receipt = workflowData(await handoffApi().respond(intent.body))
  if (receipt.thread_id !== threadId) {
    throw new Error(
      translate(
        'workActions.completionUnconfirmed',
        'Completion was not confirmed. Retry this action.'
      )
    )
  }
  const updated = await readOwnedWorkHandoff(threadId, owner, isCurrent)
  clearPendingHandoff(owner.scope, target, intent.body.operationId)
  return updated.thread.state === 'resolved'
    ? { ok: true, message: translate('handoffs.completed', 'Completed') }
    : {
        ok: false,
        message: translate(
          'workActions.handoffStillOpen',
          'This handoff remains open. Open it to finish its outstanding requests.'
        )
      }
}
