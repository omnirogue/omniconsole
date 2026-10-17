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
import {
  assertWorkActionCurrent,
  readOwnedWorkHandoff,
  type WorkActionOwner
} from './backoffice-handoff-completion'

async function submitArchiveIntent(
  intent: Extract<PendingHandoffRequest, { kind: 'archive' }>,
  owner: WorkActionOwner,
  isCurrent: () => boolean
): Promise<boolean> {
  assertWorkActionCurrent(isCurrent)
  const target = `archive:${intent.body.threadId}`
  retainPendingHandoff(owner.scope, target, intent)
  const receipt = workflowData(await handoffApi().archive(intent.body))
  if (
    receipt.thread_id !== intent.body.threadId ||
    receipt.employee_id !== owner.viewer ||
    typeof receipt.archived !== 'boolean'
  ) {
    throw new Error(
      translate(
        'workActions.archiveUnconfirmed',
        'The archive change was not confirmed. Retry this action.'
      )
    )
  }
  clearPendingHandoff(owner.scope, target, intent.body.operationId)
  return receipt.archived
}

/** Archive changes only this person's filing; retries keep the original direction and operation. */
export async function archiveWorkHandoff(
  threadId: string,
  archived: boolean,
  owner: WorkActionOwner,
  isCurrent: () => boolean
): Promise<{ ok: boolean; message: string }> {
  assertWorkActionCurrent(isCurrent)
  const target = `archive:${threadId}`
  const saved = readPendingHandoff(owner.scope, target)
  if (saved && (saved.kind !== 'archive' || saved.body.threadId !== threadId)) {
    throw new Error(
      translate('workActions.retryArchiveFirst', 'Retry the saved archive or restore action first.')
    )
  }
  await readOwnedWorkHandoff(threadId, owner, isCurrent)
  const success = {
    ok: true,
    message: archived
      ? translate('workActions.archivedForYou', 'Archived for you.')
      : translate('workActions.restoredForYou', 'Restored for you.')
  }
  // A lost archive receipt can leave the row only in Archived; reconcile it before an explicit Restore.
  if (
    saved &&
    saved.body.archived !== archived &&
    (await submitArchiveIntent(saved, owner, isCurrent)) === archived
  ) {
    return success
  }
  const intent =
    saved?.body.archived === archived
      ? saved
      : {
          kind: 'archive' as const,
          body: { threadId, archived, operationId: newOperationId() }
        }
  const effectiveArchived = await submitArchiveIntent(intent, owner, isCurrent)
  if (effectiveArchived !== archived) {
    return {
      ok: false,
      message: effectiveArchived
        ? translate(
            'workActions.archivedAgain',
            'This handoff was archived again. Retry Restore to bring it back.'
          )
        : translate(
            'workActions.archiveResurfaced',
            'This handoff has returned to your list. Review its new activity before archiving again.'
          )
    }
  }
  return success
}
