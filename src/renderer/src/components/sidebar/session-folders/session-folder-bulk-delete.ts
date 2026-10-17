import { translate } from '@/i18n/i18n'
import type { SessionFolder, SessionFolderMetadata } from '@/lib/session-folders'
import { sessionFolderSubtreeIds } from '@/lib/session-folder-tree'
import { deleteFolderByPerson } from '@/lib/session-organization-person-changes'

export type SessionFolderBulkDeletePlan = {
  /** Picked folders not inside another picked folder: what the person chose to delete. */
  topIds: string[]
  /** Every folder that goes, deepest first, so each one's sessions climb one level at a time. */
  deleteOrder: string[]
  subfolderCount: number
  /** Sessions filed anywhere in the deleted folders; they move up, never deleted. */
  keptSessionCount: number
}

function depthOf(byId: ReadonlyMap<string, SessionFolder>, id: string): number {
  let depth = 0
  const seen = new Set([id])
  let parent = byId.get(id)?.parentId
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    depth += 1
    parent = byId.get(parent)?.parentId
  }
  return depth
}

/**
 * What deleting the picked folders does: each goes with the folders nested in it (a picked
 * child inside a picked parent counts once), and every session filed in them moves up to the
 * nearest folder that stays — Saved Sessions or Unfiled at the top.
 */
export function sessionFolderBulkDeletePlan(
  metadata: {
    folders: readonly SessionFolder[]
    membership: Readonly<SessionFolderMetadata['membership']>
  },
  pickedIds: Iterable<string>,
  /** Sessions the same action deletes, so they are not also counted as kept. */
  deletedSessionKeys: ReadonlySet<string> = new Set()
): SessionFolderBulkDeletePlan {
  const byId = new Map(metadata.folders.map((folder) => [folder.id, folder]))
  const picked = [...new Set(pickedIds)].filter((id) => byId.has(id))
  const doomed = new Set<string>()
  for (const id of picked) {
    for (const nested of sessionFolderSubtreeIds(metadata.folders, id)) {
      doomed.add(nested)
    }
  }
  const topIds = picked.filter((id) => {
    const parent = byId.get(id)?.parentId
    return !parent || !doomed.has(parent)
  })
  const deleteOrder = [...doomed].sort((a, b) => depthOf(byId, b) - depthOf(byId, a))
  const keptSessionCount = Object.entries(metadata.membership).filter(
    ([key, folderId]) => doomed.has(folderId) && !deletedSessionKeys.has(key)
  ).length
  return {
    topIds,
    deleteOrder,
    subfolderCount: doomed.size - topIds.length,
    keptSessionCount
  }
}

/** The confirm dialog's words: how much goes, and where the sessions inside end up. */
export function sessionFolderBulkDeleteCopy(
  plan: SessionFolderBulkDeletePlan,
  deletedSessionCount: number
): { title: string; description: string; confirmLabel: string } {
  const folders = plan.topIds.length
  const parts = [
    translate('conversations.bulkDeleteFoldersOnly', 'Deletes {{count}} folders.', {
      count: folders
    })
  ]
  if (plan.subfolderCount > 0) {
    parts.push(
      translate(
        'conversations.bulkDeleteFoldersSubfolders',
        'The {{count}} subfolders inside them go too.',
        { count: plan.subfolderCount }
      )
    )
  }
  parts.push(
    plan.keptSessionCount > 0
      ? translate(
          'conversations.bulkDeleteFoldersKeepSessions',
          'The {{count}} sessions inside are kept and move up to the parent folder (Saved Sessions or Unfiled at the top level); none are deleted or archived.',
          { count: plan.keptSessionCount }
        )
      : translate('conversations.bulkDeleteFoldersEmpty', 'No sessions are filed in them.')
  )
  if (deletedSessionCount > 0) {
    parts.push(
      translate(
        'conversations.bulkDeleteFoldersAlsoSessions',
        'The {{count}} selected sessions are deleted too; Undo on the notice brings them back.',
        { count: deletedSessionCount }
      )
    )
  }
  return {
    title:
      deletedSessionCount > 0
        ? translate('conversations.bulkDeleteMixedTitle', 'Delete {{count}} selected items?', {
            count: folders + deletedSessionCount
          })
        : translate('conversations.bulkDeleteFoldersTitle', 'Delete {{count}} folders?', {
            count: folders
          }),
    description: parts.join(' '),
    confirmLabel: translate('conversations.bulkDeleteFoldersConfirm', 'Delete')
  }
}

/** Deletes the plan's folders deepest first, each a recorded change; the ids that went. */
export function deleteSessionFoldersByPerson(plan: SessionFolderBulkDeletePlan): string[] {
  return plan.deleteOrder.filter((id) => deleteFolderByPerson(id))
}
