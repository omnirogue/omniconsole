import { addSavedSessionGroups } from './saved-session-sidebar-groups'
import { nestActiveFolderGroups } from './active-folder-sidebar-groups'
import { sessionFolderTallies, settledBatchFolderIds } from './session-folder-rollup'
import { sessionFolderTree } from './session-folder-tree'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-group-model'
import { translate } from '@/i18n/i18n'
import { sessionSidebarLens } from './session-sidebar-lens'
import { buildSessionLensTree } from './session-sidebar-lens-tree'
import { sessionPutAwayAsks } from './session-focus-asks'
import {
  isSessionGroupCollapsed,
  sessionFolderGroupKey,
  orderSessionGroupKeys,
  SESSION_WAITING_GROUP_KEY
} from './session-sidebar-view'
import { listWorkerRows } from './session-sidebar-worker-rows'
import { sessionStatusGroups } from './session-sidebar-status-groups'
import { sessionSidebarSort } from './session-sidebar-sort'
import type { SidebarSession } from './sidebar-sessions'
import {
  compareRows,
  matchesQuery,
  rowNeedsPerson,
  sortSessionSidebarRows
} from './session-sidebar-tree-order'
import {
  conversationViewKey,
  isPersonalRowHiddenNow,
  isSessionRowDeleted
} from './conversation-view'
import {
  buildSessionSidebarTreeRows,
  type SessionSidebarTreeInput
} from './session-sidebar-tree-rows'
import { readOnlyOwnerFolders } from './mirrored-conversation-folders'

export { sessionGroupListedRows } from './session-sidebar-group-model'

export type {
  SessionSidebarBatchOrigin,
  SessionSidebarGroup,
  SessionSidebarGroupKind,
  SessionSidebarTreeRow,
  SessionTaskGroupCounts
} from './session-sidebar-group-model'

export const SESSION_ATTENTION_GROUP_KEY = 'attention'

export { sessionFolderGroupKey } from './session-sidebar-view'

export const SESSION_OTHER_GROUP_KEY = 'workspace:other'

// Why: preserve the drag contract for unfiling across workspaces.
export function sessionWorkspaceGroupKey(
  _session: Pick<SidebarSession, 'hostId' | 'worktreeId'>
): string {
  return SESSION_OTHER_GROUP_KEY
}

export type SessionSidebarTree = {
  groups: SessionSidebarGroup[]
  reorderableKeys: string[]
  archivedCount: number
  hiddenCount: number
  attentionCount: number
  totalRows: number
  /** Rows that ask from where the groups leave them out (session-focus-asks); Focus counts them. */
  putAwayAsks?: SessionSidebarTreeRow[]
}

export { SESSION_WAITING_GROUP_KEY }

export type { SessionSidebarTreeInput } from './session-sidebar-tree-rows'

export function buildSessionSidebarTree(input: SessionSidebarTreeInput): SessionSidebarTree {
  const now = input.now ?? Date.now()
  const query = input.query.trim().toLowerCase()
  const collapsedKeys = new Set(query ? [] : input.view.collapsed)
  const hiddenKeys = new Set(input.view.hidden)
  const built = buildSessionSidebarTreeRows(input, now)
  const { classifications } = built
  const deleted = new Set(input.view.deleted ?? [])
  const rows = deleted.size
    ? built.rows.filter((row) => !isSessionRowDeleted(deleted, row.session))
    : built.rows
  sortSessionSidebarRows(rows, {
    sort: sessionSidebarSort(input.view),
    rowOrder: input.view.rowOrder,
    hostLabel: (hostId) => input.lensContext?.hosts?.get(hostId)?.label
  })
  const withWorkers = listWorkerRows(rows, {
    workersByRowKey: built.workersByRowKey,
    classifications,
    compare: compareRows,
    searching: Boolean(query),
    viewKey: (row) => conversationViewKey(row.session)
  })
  const matching = withWorkers.filter((row) =>
    matchesQuery(row.session, query, input.searchText?.(row.session))
  )
  // Why: a hidden row leaves every group for Hidden, but never while its tab is open. Archived wins:
  // archiving is the one-click way to put a row away, so an archived row sits under Archived (where
  // it can be deleted) even if it was hidden first.
  const isHidden = (row: (typeof matching)[number]): boolean =>
    !row.archived &&
    (isPersonalRowHiddenNow(input.view, row.session) ||
      // Benchmarks stay controllable while running; settled unfiled runs belong in Hidden.
      (row.session.workflow?.origin === 'benchmark' &&
        ['done', 'failed', 'stopped'].includes(row.session.workflow.status) &&
        row.folderId === null &&
        !rowNeedsPerson(row)))
  const hiddenRows = matching.filter(isHidden)
  const listed = matching.filter((row) => !isHidden(row))
  // Why: an owner files rows in a folder before account sync brings it here (graft 2).
  const ownerFolders = readOnlyOwnerFolders(input.metadata.folders, rows)
  const ownerFolderIds = new Set(ownerFolders.map((folder) => folder.id))
  const activeFolders = [
    ...input.metadata.folders.filter((folder) => folder.section !== 'saved'),
    ...ownerFolders
  ]
  const batchOrigins = input.batchOrigins ?? {}
  // Why: a finished batch leaves the default view with its rows; Show archived brings both back.
  const settled = input.showArchived
    ? new Set<string>()
    : settledBatchFolderIds(activeFolders, rows, new Set(Object.keys(batchOrigins)))
  const tallies = sessionFolderTallies(activeFolders, rows, classifications)
  const folderGroups = new Map<string, SessionSidebarGroup>()
  for (const { folder, depth } of sessionFolderTree(
    activeFolders.filter((folder) => !settled.has(folder.id))
  )) {
    const key = sessionFolderGroupKey(folder.id)
    const origin = batchOrigins[folder.id]
    folderGroups.set(folder.id, {
      key,
      kind: 'folder',
      label: folder.name,
      folder,
      folderTally: tallies.get(folder.id),
      ...(origin ? { batchOrigin: origin } : {}),
      rows: [],
      collapsed: !query && isSessionGroupCollapsed(input.view, key),
      hidden: hiddenKeys.has(key),
      attentionCount: 0,
      depth,
      // Why: order is kept among top-level folders; a subfolder sits under its parent.
      canReorder: depth === 0 && !ownerFolderIds.has(folder.id),
      canHide: true,
      ...(ownerFolderIds.has(folder.id) ? { readOnlyOwnerFolder: true as const } : {})
    })
  }
  // Why: workspace kind preserves the existing unfile drop target.
  const otherGroup: SessionSidebarGroup = {
    key: SESSION_OTHER_GROUP_KEY,
    kind: 'workspace',
    label: translate('conversations.activeGroup', 'Active'),
    rows: [],
    collapsed: collapsedKeys.has(SESSION_OTHER_GROUP_KEY),
    hidden: hiddenKeys.has(SESSION_OTHER_GROUP_KEY),
    attentionCount: 0,
    canReorder: true,
    // Why: once every open conversation is filed, this is the one place left
    // cluttering the list — the same "declutter once it's empty-ish" case a
    // folder gets hidden for, so it gets the same control.
    canHide: true
  }
  const savedFolderIds = new Set(
    input.metadata.folders.filter((folder) => folder.section === 'saved').map((folder) => folder.id)
  )
  const savedFolderRows: SessionSidebarTreeRow[] = []
  // Filing chooses location; the row keeps its runtime status and request indicators.
  const automaticRows = listed.filter((row) => {
    if (row.archived) {
      return true
    }
    const folderGroup = row.folderId ? folderGroups.get(row.folderId) : undefined
    if (folderGroup) {
      folderGroup.rows.push(row)
      return false
    }
    // Why (Sal, 2026-09-23): a saved session that needs a person surfaces in Needs you, as a
    // hidden one does; it returns to its folder once handled.
    if (row.folderId && savedFolderIds.has(row.folderId) && !rowNeedsPerson(row)) {
      savedFolderRows.push(row)
      return false
    }
    return true
  })
  const attentionRows = automaticRows.filter(
    (row) =>
      classifications.get(row.session.rowKey) === 'attention' ||
      (classifications.get(row.session.rowKey) === 'saved' && rowNeedsPerson(row)) ||
      (row.folderId !== null && savedFolderIds.has(row.folderId) && rowNeedsPerson(row))
  )
  const putAwayAsks = sessionPutAwayAsks({
    listed,
    hiddenRows,
    hiddenKeys,
    folders: activeFolders,
    snapshot: input.snapshot
  })
  const lens = sessionSidebarLens(input.view)
  if (lens) {
    const lensRows = { rows, listed, hiddenRows, attentionRows, classifications, hiddenKeys }
    return { ...buildSessionLensTree({ lens, input, query, ...lensRows }), putAwayAsks }
  }
  const status = sessionStatusGroups({
    automaticRows,
    hiddenRows,
    listed,
    classifications,
    orphanRowKeys: built.orphanRowKeys,
    view: input.view,
    showArchived: Boolean(input.showArchived),
    query
  })
  otherGroup.rows = status.conversations

  let hiddenCount = 0
  const groups: SessionSidebarGroup[] = []
  if (attentionRows.length > 0) {
    groups.push({
      key: SESSION_ATTENTION_GROUP_KEY,
      kind: 'attention',
      label: translate('auto.components.SessionSidebar.needsYouGroup', 'Needs you'),
      rows: attentionRows,
      collapsed: collapsedKeys.has(SESSION_ATTENTION_GROUP_KEY),
      hidden: false,
      attentionCount: attentionRows.filter((row) => !row.workerOf).length,
      canReorder: false,
      canHide: false
    })
  }
  const nestedFolders = nestActiveFolderGroups(folderGroups)
  for (const group of nestedFolders.nested) {
    if (group.hidden) {
      hiddenCount += 1
    }
  }
  otherGroup.attentionCount = otherGroup.rows.filter(rowNeedsPerson).length
  if (otherGroup.collapsed && otherGroup.attentionCount > 0) {
    otherGroup.peekRows = otherGroup.rows.filter(rowNeedsPerson)
  }
  for (const group of [...nestedFolders.roots, otherGroup]) {
    // Why: an empty folder still renders (it is a drop target); an empty remainder group has nothing to show.
    if (group.kind === 'workspace' && group.rows.length === 0 && folderGroups.size === 0) {
      continue
    }
    if (
      query &&
      (group === otherGroup ? group.rows : nestedFolders.subtreeRows(group)).length === 0
    ) {
      continue
    }
    if (group.hidden) {
      hiddenCount += 1
      if (!input.showHidden) {
        continue
      }
    }
    groups.push(group)
  }
  groups.push(...status.groups)
  const byKey = new Map(
    groups.filter((group) => group.canReorder).map((group) => [group.key, group])
  )
  const ordered = orderSessionGroupKeys([...byKey.keys()], input.view.order)
  let index = 0
  const orderedGroups = groups
    .map((group) => (group.canReorder ? byKey.get(ordered[index++]!)! : group))
    .flatMap((group) =>
      group.kind === 'folder' && group.folder && folderGroups.get(group.folder.id) === group
        ? [
            group,
            ...nestedFolders.visibleDescendants(group, {
              query: Boolean(query),
              showHidden: Boolean(input.showHidden)
            })
          ]
        : [group]
    )
  addSavedSessionGroups(
    orderedGroups,
    [
      ...automaticRows.filter(
        (row) => classifications.get(row.session.rowKey) === 'saved' && !rowNeedsPerson(row)
      ),
      ...savedFolderRows
    ],
    input
  )
  return {
    groups: orderedGroups,
    reorderableKeys: orderedGroups.filter((group) => group.canReorder).map((group) => group.key),
    archivedCount: rows.filter((row) => row.archived).length,
    hiddenCount,
    attentionCount: listed.filter(rowNeedsPerson).length,
    totalRows: rows.length,
    putAwayAsks
  }
}
