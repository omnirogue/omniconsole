import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-group-model'
import { conversationGroupLabel } from './conversation-state'
import { newestArchivedFirst } from './session-sidebar-tree-order'
import {
  isSessionGroupCollapsed,
  SESSION_HIDDEN_GROUP_KEY,
  type SessionSidebarView
} from './session-sidebar-view'
import { SESSION_WORKERS_GROUP_KEY } from './session-sidebar-worker-keys'

const ORPHAN_WORKER_CLASSES = new Set([
  'conversations',
  'drafts',
  'waiting',
  'stopped',
  'completed'
])

// Why: Hidden sits after Completed — put away on purpose, not aged out like Archived. Drafts
// lead: they are the person's own, still being written. Agent sessions sit with the done work.
const STATUS_KINDS = [
  'drafts',
  'waiting',
  'stopped',
  'completed',
  'workers',
  'hidden',
  'archived'
] as const

const STATUS_GROUP_KEYS: Partial<Record<(typeof STATUS_KINDS)[number], string>> = {
  hidden: SESSION_HIDDEN_GROUP_KEY,
  workers: SESSION_WORKERS_GROUP_KEY
}

/**
 * The Active rows and the status groups (Drafts … Archived) of the Status view. A worker whose
 * launcher is gone waits folded in Agent sessions, not among the person's own.
 */
export function sessionStatusGroups(args: {
  automaticRows: readonly SessionSidebarTreeRow[]
  hiddenRows: SessionSidebarTreeRow[]
  listed: readonly SessionSidebarTreeRow[]
  classifications: ReadonlyMap<string, string>
  orphanRowKeys: ReadonlySet<string>
  view: SessionSidebarView
  showArchived: boolean
  query: string
}): { conversations: SessionSidebarTreeRow[]; groups: SessionSidebarGroup[] } {
  const { automaticRows, classifications, view, query } = args
  const classOf = (row: SessionSidebarTreeRow): string =>
    classifications.get(row.session.rowKey) ?? ''
  const orphan = (row: SessionSidebarTreeRow): boolean =>
    args.orphanRowKeys.has(row.session.rowKey) &&
    !row.archived &&
    ORPHAN_WORKER_CLASSES.has(classOf(row))
  const inGroup = (kind: string) =>
    automaticRows.filter((row) => classOf(row) === kind && !orphan(row))
  const grouped = {
    drafts: inGroup('drafts'),
    waiting: inGroup('waiting'),
    stopped: inGroup('stopped'),
    completed: inGroup('completed'),
    workers: automaticRows.filter(orphan),
    hidden: args.hiddenRows,
    archived: newestArchivedFirst(
      args.listed.filter((row) => row.archived),
      view.archivedAt
    )
  }
  const groups: SessionSidebarGroup[] = []
  for (const kind of STATUS_KINDS) {
    const groupRows = grouped[kind]
    if (!groupRows.length || (kind === 'archived' && !args.showArchived && !query)) {
      continue
    }
    const key = STATUS_GROUP_KEYS[kind] ?? kind
    groups.push({
      key,
      kind,
      label: conversationGroupLabel(kind, groupRows.length),
      rows: groupRows,
      collapsed: !query && isSessionGroupCollapsed(view, key),
      hidden: false,
      attentionCount: kind === 'waiting' ? groupRows.filter((row) => row.planNeedsYou).length : 0,
      canReorder: kind !== 'hidden' && kind !== 'archived' && kind !== 'workers',
      canHide: false
    })
  }
  return { conversations: inGroup('conversations'), groups }
}
