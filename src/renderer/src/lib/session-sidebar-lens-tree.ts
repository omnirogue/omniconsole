import { translate } from '@/i18n/i18n'
import { conversationGroupLabel } from './conversation-state'
import {
  emptySessionFolderTally,
  sessionFolderRowState,
  type SessionFolderTally
} from './session-folder-rollup'
import type { SessionFolder } from './session-folders'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-group-model'
import {
  sessionLensClassifier,
  sessionLensGroupKey,
  type SessionLensBucket,
  type SessionSidebarLens
} from './session-sidebar-lens'
import type { SessionSidebarTreeInput } from './session-sidebar-tree-rows'
import { newestArchivedFirst, rowNeedsPerson } from './session-sidebar-tree-order'
import {
  isSessionGroupCollapsed,
  sessionFolderGroupKey,
  SESSION_HIDDEN_GROUP_KEY
} from './session-sidebar-view'

export type SessionLensTree = {
  groups: SessionSidebarGroup[]
  reorderableKeys: string[]
  archivedCount: number
  hiddenCount: number
  attentionCount: number
  totalRows: number
}

function tallyOf(
  rows: readonly SessionSidebarTreeRow[],
  classificationOf: (row: SessionSidebarTreeRow) => string | undefined
): SessionFolderTally {
  const tally = emptySessionFolderTally()
  for (const row of rows) {
    const state = sessionFolderRowState(row, classificationOf(row))
    if (state) {
      tally[state] += 1
    }
    tally.total += 1
  }
  return tally
}

/** Folders the person hid, with everything nested under them. */
function hiddenFolderIds(
  folders: readonly SessionFolder[],
  hiddenKeys: ReadonlySet<string>
): Set<string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const hidden = new Set<string>()
  for (const folder of folders) {
    const seen = new Set<string>()
    for (let at: SessionFolder | undefined = folder; at && !seen.has(at.id);) {
      seen.add(at.id)
      if (hiddenKeys.has(sessionFolderGroupKey(at.id))) {
        hidden.add(folder.id)
        break
      }
      at = at.parentId ? byId.get(at.parentId) : undefined
    }
  }
  return hidden
}

/**
 * The tree under a Group-by view: Needs you (every row that asks, wherever it is filed), one group
 * per bucket of the lens, then Hidden and Archived. Folders only feed the buckets; nothing here
 * changes where a session is filed.
 */
export function buildSessionLensTree(args: {
  lens: SessionSidebarLens
  input: Pick<
    SessionSidebarTreeInput,
    'view' | 'metadata' | 'lensContext' | 'showArchived' | 'showHidden'
  >
  query: string
  /** Every row, and the ones not hidden by the person (archived ones included). */
  rows: readonly SessionSidebarTreeRow[]
  listed: readonly SessionSidebarTreeRow[]
  hiddenRows: readonly SessionSidebarTreeRow[]
  /** The rows the status tree lists under Needs you. */
  attentionRows: readonly SessionSidebarTreeRow[]
  classifications: ReadonlyMap<string, string>
  hiddenKeys: ReadonlySet<string>
}): SessionLensTree {
  const { lens, query } = args
  const { view, showHidden } = args.input
  const folders = args.input.metadata.folders
  const classificationOf = (row: SessionSidebarTreeRow): string | undefined =>
    args.classifications.get(row.session.rowKey)
  const activeFolders = folders.filter((folder) => folder.section !== 'saved')
  const hiddenFolders = hiddenFolderIds(activeFolders, args.hiddenKeys)
  // Why Status lists hidden folders' rows: it finds a session wherever it is filed.
  const withHidden = showHidden || lens === 'state'
  const current = args.listed.filter(
    (row) =>
      !row.archived &&
      classificationOf(row) !== 'archived' &&
      (withHidden || !row.folderId || !hiddenFolders.has(row.folderId))
  )
  const asking = new Set(args.attentionRows)
  const attention = current.filter((row) => asking.has(row) || rowNeedsPerson(row))
  const attentionSet = new Set(attention)
  const classify = sessionLensClassifier(lens, {
    folders,
    context: args.input.lensContext ?? {},
    classificationOf
  })
  const buckets = new Map<string, { bucket: SessionLensBucket; rows: SessionSidebarTreeRow[] }>()
  for (const row of current) {
    if (attentionSet.has(row)) {
      continue
    }
    const bucket = classify(row)
    const entry = buckets.get(bucket.id) ?? { bucket, rows: [] }
    entry.rows.push(row)
    buckets.set(bucket.id, entry)
  }
  const groups: SessionSidebarGroup[] = []
  if (attention.length > 0) {
    groups.push({
      key: 'attention',
      kind: 'attention',
      label: translate('auto.components.SessionSidebar.needsYouGroup', 'Needs you'),
      rows: attention,
      collapsed: !query && view.collapsed.includes('attention'),
      hidden: false,
      attentionCount: attention.length,
      canReorder: false,
      canHide: false
    })
  }
  const ordered = [...buckets.values()].sort(
    (a, b) => a.bucket.order - b.bucket.order || a.bucket.label.localeCompare(b.bucket.label)
  )
  for (const { bucket, rows } of ordered) {
    const key = sessionLensGroupKey(lens, bucket.id)
    const collapsed = !query && isSessionGroupCollapsed(view, key)
    const asks = rows.filter(rowNeedsPerson)
    groups.push({
      key,
      kind: lens,
      label: bucket.label,
      rows,
      collapsed,
      ...(collapsed && asks.length ? { peekRows: asks } : {}),
      folderTally: tallyOf(rows, classificationOf),
      hidden: false,
      attentionCount: asks.length,
      canReorder: false,
      canHide: false
    })
  }
  const archived = args.listed.filter((row) => row.archived)
  const tail = [
    { kind: 'hidden' as const, key: SESSION_HIDDEN_GROUP_KEY, rows: [...args.hiddenRows] },
    {
      kind: 'archived' as const,
      key: 'archived',
      rows: args.input.showArchived || query ? newestArchivedFirst(archived, view.archivedAt) : []
    }
  ]
  for (const { kind, key, rows } of tail) {
    if (rows.length) {
      groups.push({
        key,
        kind,
        label: conversationGroupLabel(kind, rows.length),
        rows,
        collapsed: !query && isSessionGroupCollapsed(view, key),
        hidden: false,
        attentionCount: 0,
        canReorder: false,
        canHide: false
      })
    }
  }
  return {
    groups,
    reorderableKeys: [],
    archivedCount: args.rows.filter((row) => row.archived).length,
    hiddenCount: activeFolders.filter((folder) =>
      args.hiddenKeys.has(sessionFolderGroupKey(folder.id))
    ).length,
    attentionCount: args.listed.filter(rowNeedsPerson).length,
    totalRows: args.rows.length
  }
}
