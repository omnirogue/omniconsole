import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { finishNextStep } from '@/components/next-step/next-step-actions'
import { translate } from '@/i18n/i18n'
import { completeWorkHandoff, type WorkActionOwner } from './backoffice-handoff-completion'
import { archiveWorkHandoff } from './backoffice-handoff-archive'
import { archiveWorkMessage } from './backoffice-message-archive'

export type BulkWorkAction = 'archive' | 'complete' | 'restore'
export type BulkWorkResult = { key: string; title: string; ok: boolean; message: string }

export function workActionThreadId(row: WorkRow): string | null {
  return row.thread?.id ?? row.todo?.primary_action?.handoff_thread_id ?? null
}

export function canSelectWorkRow(row: WorkRow, viewer: string | null): boolean {
  if (row.message) {
    return (
      !!viewer &&
      [row.message.sender_employee_id, row.message.recipient_employee_id].includes(viewer)
    )
  }
  if (row.thread) {
    return (
      !!viewer && [row.thread.author_employee_id, row.thread.recipient_employee_id].includes(viewer)
    )
  }
  return !!row.todo
}

/** Each obligation keeps its own receipt and refusal; distinct handoffs on one card stay distinct. */
export async function runBulkWorkAction(
  rows: readonly WorkRow[],
  action: BulkWorkAction,
  isCurrent: () => boolean,
  owner?: WorkActionOwner
): Promise<BulkWorkResult[]> {
  const results: BulkWorkResult[] = []
  const outcomes = new Map<string, { ok: boolean; message: string }>()
  const keys = new Set<string>()
  for (const row of rows) {
    if (!isCurrent()) {
      break
    }
    const threadId = workActionThreadId(row)
    const target = row.message
      ? `message:${row.message.id}`
      : threadId
        ? `thread:${threadId}`
        : row.todo
          ? `task:${row.todo.task_id}`
          : null
    if (!target || keys.has(row.key)) {
      continue
    }
    keys.add(row.key)
    try {
      let result = outcomes.get(target)
      if (!result) {
        if (row.message) {
          if (!owner || !canSelectWorkRow(row, owner.viewer)) {
            throw new Error(
              translate('workActions.viewerUnknown', 'Reopen this list to confirm your account.')
            )
          }
          if (action === 'complete') {
            throw new Error(
              translate('inbox.messageCompletion', 'Open this message to reply or resolve it.')
            )
          }
          result = await archiveWorkMessage(row.message.id, action === 'archive', owner, isCurrent)
        } else if (threadId) {
          if (!owner) {
            throw new Error(
              translate('workActions.viewerUnknown', 'Reopen this list to confirm your account.')
            )
          }
          result =
            action !== 'complete'
              ? await archiveWorkHandoff(threadId, action === 'archive', owner, isCurrent)
              : await completeWorkHandoff(threadId, owner, isCurrent)
        } else if (row.todo) {
          if (action === 'restore') {
            throw new Error(
              translate(
                'workActions.restoreHandoffsOnly',
                'Restore is available for archived handoffs.'
              )
            )
          }
          const updated =
            action === 'archive'
              ? await window.api.backoffice.archiveTask({ taskId: row.todo.task_id })
              : await finishNextStep({ kind: 'card', item: row.todo }, null)
          result = { ok: updated.ok, message: 'message' in updated ? updated.message : '' }
        }
      }
      if (result) {
        outcomes.set(target, result)
        results.push({ key: row.key, title: row.title, ...result })
      }
    } catch (error) {
      const result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
      outcomes.set(target, result)
      results.push({ key: row.key, title: row.title, ...result })
    }
  }
  return results
}
