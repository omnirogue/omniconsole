import type { ConversationFleetSidebarRow } from './conversation-fleet-sidebar'
import { conversationFleetProgress } from './conversation-fleet-progress'
import type { SessionFolder } from './session-folders'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import { cardsForSession } from './session-pane-cards'
import { rowNeedsPerson } from './session-sidebar-tree-order'
import type { SessionSidebarTreeInput } from './session-sidebar-tree-rows'
import { sessionFolderGroupKey } from './session-sidebar-view'

/** A fleet run waiting on a decision or review from the person. */
export function fleetRowNeedsPerson({ run }: ConversationFleetSidebarRow): boolean {
  return (
    run.admission !== 'pending' &&
    conversationFleetProgress(run.jobs, run.verified).phase === 'needs-you'
  )
}

/**
 * Rows that ask but that the tree's groups leave out or put away: archived rows (their pane's
 * question is read back, since an archived row carries none), hidden rows, and rows in a hidden
 * folder or under one. Only Needs you counts them.
 */
export function sessionPutAwayAsks(input: {
  listed: readonly SessionSidebarTreeRow[]
  hiddenRows: readonly SessionSidebarTreeRow[]
  hiddenKeys: ReadonlySet<string>
  folders: readonly SessionFolder[]
  snapshot: SessionSidebarTreeInput['snapshot']
}): SessionSidebarTreeRow[] {
  const parents = new Map(input.folders.map((folder) => [folder.id, folder.parentId]))
  const inHiddenFolder = (folderId: string): boolean => {
    const seen = new Set<string>()
    for (let id: string | undefined = folderId; id && !seen.has(id); id = parents.get(id)) {
      if (input.hiddenKeys.has(sessionFolderGroupKey(id))) {
        return true
      }
      seen.add(id)
    }
    return false
  }
  return [
    ...input.hiddenRows.filter(rowNeedsPerson),
    ...input.listed.flatMap((row) => {
      if (!row.archived) {
        return row.folderId && inHiddenFolder(row.folderId) && rowNeedsPerson(row) ? [row] : []
      }
      const ask = cardsForSession(row.session, input.snapshot).attention
      // Why not a run's request: that is read from the run's own row, never a worker's.
      return ask && !ask.run ? [{ ...row, attention: ask }] : []
    })
  ]
}
