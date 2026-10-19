import { translate } from '@/i18n/i18n'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import { sessionFolderSubtreeIds, sessionFolderTree } from './session-folder-tree'
import { isSessionGroupCollapsed, sessionFolderGroupKey } from './session-sidebar-view'
import { rowNeedsPerson } from './session-sidebar-tree-order'
import type {
  SessionSidebarGroup,
  SessionSidebarTreeInput,
  SessionSidebarTreeRow
} from './session-sidebar-tree'

export function addSavedSessionGroups(
  groups: SessionSidebarGroup[],
  savedRows: SessionSidebarTreeRow[],
  input: SessionSidebarTreeInput
): void {
  const query = input.query.trim().toLowerCase()
  const isCollapsed = (key: string): boolean => !query && isSessionGroupCollapsed(input.view, key)
  const savedFolders = input.metadata.folders.filter((folder) => folder.section === 'saved')
  const savedCollapsed = !query && isSessionGroupCollapsed(input.view, SAVED_SESSIONS_FOLDER_ID)
  const savedGroups: SessionSidebarGroup[] = [
    {
      key: SAVED_SESSIONS_FOLDER_ID,
      kind: 'saved',
      label: translate('conversations.savedSessions', 'Saved Sessions'),
      rows: savedRows.filter((row) => row.folderId === SAVED_SESSIONS_FOLDER_ID),
      childRowCount: savedRows.filter((row) => row.folderId !== SAVED_SESSIONS_FOLDER_ID).length,
      collapsed: savedCollapsed,
      peekRows: savedCollapsed ? savedRows.filter(rowNeedsPerson) : undefined,
      hidden: false,
      attentionCount: savedRows.filter(rowNeedsPerson).length,
      canReorder: false,
      canHide: false
    }
  ]
  if (!savedCollapsed) {
    const byId = new Map(savedFolders.map((folder) => [folder.id, folder]))
    for (const { folder, depth } of sessionFolderTree(savedFolders)) {
      // Why: a folded folder folds everything nested in it, as a file browser does.
      if (hasCollapsedAncestor(folder, byId, isCollapsed)) {
        continue
      }
      const subtree = sessionFolderSubtreeIds(savedFolders, folder.id)
      const folderRows = savedRows.filter((row) => row.folderId === folder.id)
      const nestedRows = savedRows.filter(
        (row) => row.folderId !== folder.id && row.folderId !== null && subtree.has(row.folderId)
      )
      // Why: a search keeps a folder whose own name or anything below it matches, so a hit deep
      // in the tree still shows the path of folders leading to it.
      if (
        query &&
        !folderRows.length &&
        !nestedRows.length &&
        !savedFolders.some(
          (entry) => subtree.has(entry.id) && entry.name.toLowerCase().includes(query)
        )
      ) {
        continue
      }
      const collapsed = isCollapsed(sessionFolderGroupKey(folder.id))
      savedGroups.push({
        key: sessionFolderGroupKey(folder.id),
        kind: 'folder',
        label: folder.name,
        folder,
        rows: folderRows,
        childRowCount: nestedRows.length,
        depth,
        collapsed,
        peekRows: collapsed ? [...folderRows, ...nestedRows].filter(rowNeedsPerson) : undefined,
        hidden: false,
        attentionCount: [...folderRows, ...nestedRows].filter(rowNeedsPerson).length,
        canReorder: false,
        canHide: false
      })
    }
  }
  // Why (Sal, 2026-10-19): Agent sessions sit under the person's own sessions, Saved included.
  const savedPosition = groups.findIndex(
    (group) => group.kind === 'workers' || group.kind === 'hidden' || group.kind === 'archived'
  )
  if (!query || savedRows.length || savedGroups.length > 1) {
    groups.splice(savedPosition === -1 ? groups.length : savedPosition, 0, ...savedGroups)
  }
}

function hasCollapsedAncestor(
  folder: SessionFolder,
  byId: ReadonlyMap<string, SessionFolder>,
  isCollapsed: (key: string) => boolean
): boolean {
  const seen = new Set([folder.id])
  let parent = folder.parentId ? byId.get(folder.parentId) : undefined
  while (parent && !seen.has(parent.id)) {
    if (isCollapsed(sessionFolderGroupKey(parent.id))) {
      return true
    }
    seen.add(parent.id)
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return false
}

export function allSessionGroupKeys(
  groups: readonly SessionSidebarGroup[],
  folders: readonly SessionFolder[]
): string[] {
  return [
    ...new Set([
      ...groups.map((group) => group.key),
      ...folders.map((folder) => sessionFolderGroupKey(folder.id))
    ])
  ]
}
