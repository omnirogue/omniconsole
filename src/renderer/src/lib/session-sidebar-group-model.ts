import type { SessionChain } from '../../../shared/session-chain-types'
import type { ConversationState } from './conversation-state'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { ConversationCompletion } from './conversation-retention'
import type { SessionChainSummary } from './session-chain-summary'
import type { SessionFolder } from './session-folders'
import type { SessionFolderTally } from './session-folder-rollup'
import type { SessionRunRowState } from './session-run-row-state'
import type { SidebarSession } from './sidebar-sessions'

export type SessionSidebarGroupKind =
  | 'attention'
  | 'folder'
  | 'workspace'
  | 'drafts'
  | 'waiting'
  | 'stopped'
  | 'completed'
  | 'saved'
  | 'archived'
  | 'hidden'
  /** Workers whose launcher is gone: kept together, folded, instead of among the person's own. */
  | 'workers'
  | 'task'
  /** A heading of search results; drawn only while the filter is typed. */
  | 'search'
  | SessionSidebarLensGroupKind

/** Group-by views (session-sidebar-lens): regrouped rows, never a place a session is filed. */
export type SessionSidebarLensGroupKind =
  | 'state'
  | 'request'
  | 'project'
  | 'company'
  | 'computer'
  | 'blocking'

const LENS_GROUP_KINDS: ReadonlySet<string> = new Set<SessionSidebarLensGroupKind>([
  'state',
  'request',
  'project',
  'company',
  'computer',
  'blocking'
])

export function isSessionLensGroupKind(kind: string): kind is SessionSidebarLensGroupKind {
  return LENS_GROUP_KINDS.has(kind)
}

export type SessionSidebarTreeRow = {
  unreadCompletion?: boolean
  activityUnverifiable?: boolean
  pursuitState?: ConversationState
  pursuitChain?: SessionChain
  children?: SessionSidebarTreeRow[]
  childrenCollapsed?: boolean
  /** Sessions this one dispatched as workers, listed under it only while expanded. */
  workers?: SessionWorkerSummary
  /** Set from the durable orchestration worker lineage, independently of the session title. */
  subagent?: boolean
  /** Fresh, owner-authenticated dispatch id for an exact worker retention action. */
  workerDispatchId?: string
  /** Exact process incarnation verified by current local lineage for worker retention. */
  workerProcessIncarnation?: string
  /** Set on a worker listed under its launcher: the launcher's view key. */
  workerOf?: string
  session: SidebarSession
  folderId: string | null
  attention: AttentionPane | null
  state: AgentDotState | null
  /** Background tasks a `monitoring` row waits on, when the provider counted them. */
  backgroundTaskCount?: number
  locked?: Pick<SessionChainSummary, 'summary' | 'current' | 'placement'> | null
  /** The plan ended with ↩ Back to me: the row is the person's again. */
  returned?: boolean
  /**
   * The plan on this row needs the person: an outcome run with an open request addressed to them,
   * or a queue that waits for their click or on a pane that asked. A failed plan never does.
   */
  planNeedsYou?: boolean
  /** The outcome run this row owns, as the one classifier reads it. */
  run?: SessionRunRowState
  completed?: ConversationCompletion | null
  archived?: boolean
  waitingUntil: string | null
}

export type SessionWorkerSummary = { count: number; running: number; expanded: boolean }

/** How a task group's sessions stand right now. */
export type SessionTaskGroupCounts = {
  running: number
  waiting: number
  needsYou: number
  done: number
  outcomes?: { satisfied: number; total: number }
}

export type SessionSidebarGroup = {
  key: string
  kind: SessionSidebarGroupKind
  label: string
  folder?: SessionFolder
  rows: SessionSidebarTreeRow[]
  /** Rows held in folders nested below this group, counted on its heading. */
  childRowCount?: number
  /** Rows in the unhidden folders nested below this one, listed or folded away. */
  nestedRows?: SessionSidebarTreeRow[]
  /** How deep a saved folder sits under Saved Sessions; 0 for one directly under it. */
  depth?: number
  collapsed: boolean
  /**
   * What a folded group still lists: the rows in it (or nested below it) that need the person,
   * so folding a folder never hides a question. Absent or empty lists nothing.
   */
  peekRows?: SessionSidebarTreeRow[]
  /**
   * What an open group lists while it is folded down to the conversation in use: that row and
   * anything that needs the person (see session-group-focus). Absent lists every row.
   */
  focusRows?: SessionSidebarTreeRow[]
  hidden: boolean
  attentionCount: number
  canReorder: boolean
  canHide: boolean
  /** Set on a `task` group only. */
  taskCounts?: SessionTaskGroupCounts
  /** An Active folder's state counts over everything filed in it, archived rows included. */
  folderTally?: SessionFolderTally
  /** The request that launched this folder's batch, when this device recorded one. */
  batchOrigin?: SessionSidebarBatchOrigin
  /**
   * A paired owner's folder this computer has not received yet (graft 2): its rows list in it,
   * read-only — no rename, move or delete — until account sync delivers the folder.
   */
  readOnlyOwnerFolder?: true
}

export type SessionSidebarBatchOrigin = { requestExcerpt: string; createdAt: number }

/**
 * The rows a group lists right now: all of them open (or only the focused ones while it is
 * folded down to focus), only its peek rows folded.
 */
export function sessionGroupListedRows(
  group: Pick<SessionSidebarGroup, 'rows' | 'collapsed' | 'peekRows' | 'focusRows'>
): readonly SessionSidebarTreeRow[] {
  return group.collapsed ? (group.peekRows ?? []) : (group.focusRows ?? group.rows)
}
