import type { AgentDotState } from '@/components/AgentStateDot'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationState } from '@/lib/conversation-state'
import type { ConversationCompletion } from '@/lib/conversation-retention'
import type { SessionChainSummary } from '@/lib/session-chain-summary'
import type { PursuitSidebarTreeRow } from '@/lib/session-sidebar-tree-rows'
import type { SessionWorkerSummary } from '@/lib/session-sidebar-group-model'
import type { SessionRunRowState } from '@/lib/session-run-row-state'
import type { SessionFolderColor } from '@/lib/session-folder-colors'
import type { SessionChain } from '../../../../../shared/session-chain-types'

/** What one Conversations row is told about its session, its plan and its place in the list. */
export type SessionSidebarRowProps = {
  unreadCompletion?: boolean
  activityUnverifiable?: boolean
  pursuitState?: ConversationState
  technical?: boolean
  session: SidebarSession
  current: boolean
  /** On the main screen beside the focused conversation (a grid pane or another split). */
  onScreen?: boolean
  queued: boolean
  /** The chain queued after this session, when one is live. */
  chain?: SessionChainRowInfo | null
  /** The outcome plan this row owns; its notation, seats and history live in the details block. */
  pursuitChain?: SessionChain | null
  /** That plan as the one classifier reads it: the row's line, highlight and count come from here. */
  run?: SessionRunRowState | null
  /** The plan's seats, listed under Seats and plan history. */
  seats?: readonly PursuitSidebarTreeRow[]
  onOpenSeat?: (row: PursuitSidebarTreeRow) => void
  /** Sessions this one dispatched as workers; absent when it launched none. */
  workers?: SessionWorkerSummary
  /** True only when durable orchestration lineage identifies this row as a worker. */
  subagent?: boolean
  workerDispatchId?: string
  workerProcessIncarnation?: string
  onToggleWorkers?: () => void
  state?: AgentDotState | null
  /** Background tasks a `monitoring` row waits on, when the provider counted them. */
  backgroundTaskCount?: number
  attention?: AttentionPane | null
  /** The plan ended with ↩ Back to me: the results are ready and the row is the person's again. */
  returned?: boolean
  /** The plan needs the person: an open request of its run, or a queue waiting for their click. */
  planNeedsYou?: boolean
  /** ISO return time when the person asked this session to wait. */
  waitingUntil?: string | null
  /** The plan running after this session; the row is locked while it runs. */
  locked?: Pick<SessionChainSummary, 'summary' | 'current' | 'placement'> | null
  /** Why the row sits under Completed, when it does. */
  completed?: ConversationCompletion | null
  archived?: boolean
  /** Saved or archived: done is why it is there, so it takes its folder's color, not orange. */
  putAway?: boolean
  /** The color of the folder the row is listed in, own or inherited. */
  color?: SessionFolderColor | null
  /** Part of the list's multi-selection — distinct from `current`, the open conversation. */
  selected?: boolean
  /** Carries the roving tabIndex; undefined outside a selectable list. */
  focused?: boolean
  onOpen: () => void
  /** True when the click was a selection gesture; the row then does not open. */
  onSelect?: (event: React.MouseEvent<HTMLElement>) => boolean
  /** Manual name; null returns to the generated one. Absent when the row cannot be renamed. */
  onRename?: (title: string | null) => void
  onCancelQueue: () => void
  /** Explicit start of a chain that resumed from a restart and is waiting for a click. */
  onStartChain?: () => void
  onDropRow?: (key: string) => void
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void
  /** Clock for the snooze caption; the list passes it only to rows that show one. */
  now?: number
}
