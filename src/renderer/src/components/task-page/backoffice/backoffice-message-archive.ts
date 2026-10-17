import { handoffApi } from '@/components/handoffs/handoff-client'
import {
  clearPendingHandoff,
  readPendingHandoff,
  retainPendingHandoff,
  type PendingHandoffRequest
} from '@/components/handoffs/handoff-request-memory'
import { newOperationId } from '@/components/next-step/next-step-action-result'
import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import { assertWorkActionCurrent, type WorkActionOwner } from './backoffice-handoff-completion'

async function submit(
  intent: Extract<PendingHandoffRequest, { kind: 'peer-archive' }>,
  owner: WorkActionOwner,
  isCurrent: () => boolean
): Promise<boolean> {
  assertWorkActionCurrent(isCurrent)
  const target = `peer-archive:${intent.body.messageId}`
  retainPendingHandoff(owner.scope, target, intent)
  const receipt = workflowData(await handoffApi().archiveMessage(intent.body))
  assertWorkActionCurrent(isCurrent)
  if (
    receipt.message_id !== intent.body.messageId ||
    receipt.employee_id !== owner.viewer ||
    typeof receipt.archived !== 'boolean'
  ) {
    throw new Error(
      translate('inbox.deleteUnconfirmed', 'The inbox change was not confirmed. Retry this action.')
    )
  }
  clearPendingHandoff(owner.scope, target, intent.body.operationId)
  return receipt.archived
}

/** Delete files a message for this viewer; an unanswered receipt keeps the original operation. */
export async function archiveWorkMessage(
  messageId: string,
  archived: boolean,
  owner: WorkActionOwner,
  isCurrent: () => boolean
): Promise<{ ok: boolean; message: string }> {
  assertWorkActionCurrent(isCurrent)
  const saved = readPendingHandoff(owner.scope, `peer-archive:${messageId}`)
  if (saved && (saved.kind !== 'peer-archive' || saved.body.messageId !== messageId)) {
    throw new Error(translate('inbox.retryDeleteFirst', 'Retry the saved Delete or Restore first.'))
  }
  if (!owner.viewer) {
    throw new Error(
      translate('workActions.viewerUnknown', 'Reopen this list to confirm your account.')
    )
  }
  const success = { ok: true, message: '' }
  if (
    saved &&
    saved.body.archived !== archived &&
    (await submit(saved, owner, isCurrent)) === archived
  ) {
    return success
  }
  const intent =
    saved?.body.archived === archived
      ? saved
      : {
          kind: 'peer-archive' as const,
          body: { messageId, archived, operationId: newOperationId() }
        }
  const effective = await submit(intent, owner, isCurrent)
  return effective === archived
    ? success
    : {
        ok: false,
        message: effective
          ? translate('inbox.deletedAgain', 'This message was deleted again. Retry Restore.')
          : translate(
              'inbox.newMessageActivity',
              'This message has new activity. Review it before deleting again.'
            )
      }
}
