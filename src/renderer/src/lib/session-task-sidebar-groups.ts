import type { SessionChain } from '../../../shared/session-chain-types'
import { taskOutcomeCounts } from '../../../shared/task-outcome-rows'
import { conversationGroupLabel } from './conversation-state'
import { translate } from '@/i18n/i18n'
import { isSessionGroupCollapsed, type SessionSidebarView } from './session-sidebar-view'
import type {
  SessionSidebarGroup,
  SessionSidebarGroupKind,
  SessionSidebarTreeRow,
  SessionTaskGroupCounts
} from './session-sidebar-group-model'
import { rowNeedsPerson } from './session-sidebar-tree-order'
import type { SessionTaskLinks } from './session-task-link'
import { sidebarSessionSourceIdentity } from './sidebar-session-source-identity'
import type { SidebarSession } from './sidebar-sessions'

export type { SessionTaskGroupCounts } from './session-sidebar-group-model'

export type SessionTaskRef = { taskId: string; title?: string }

export const SESSION_TASK_GROUP_PREFIX = 'task:'

export function sessionTaskGroupKey(taskId: string): string {
  return `${SESSION_TASK_GROUP_PREFIX}${taskId}`
}

/** The task a row serves: the link this device made, else the ledger's card for its pane. */
export function sessionTaskRef(
  session: SidebarSession,
  links: SessionTaskLinks,
  ledgerCardByPane: ReadonlyMap<string, string>
): SessionTaskRef | null {
  const identity = sidebarSessionSourceIdentity(session)
  const link = identity ? links[identity.sourceKey] : undefined
  if (link) {
    return { taskId: link.taskId, ...(link.title ? { title: link.title } : {}) }
  }
  const cardId = session.paneKey ? ledgerCardByPane.get(session.paneKey) : undefined
  return cardId ? { taskId: cardId } : null
}

/** A task this device knows only as a hub card id still reads as a task, not as a raw id. */
export function taskGroupFallbackLabel(taskId: string): string {
  return translate('conversations.taskGroupFallback', 'Task {{id}}', { id: taskId })
}

// Explicit folders keep their placement even when the automatic view groups by task.
const TASKABLE_KINDS = new Set<SessionSidebarGroupKind>([
  'workspace',
  'drafts',
  'waiting',
  'completed'
])

/** The automatic groups that are named by their count, and go away once task groups empty them. */
function isCountedGroup(kind: SessionSidebarGroupKind): kind is 'drafts' | 'waiting' | 'completed' {
  return kind === 'drafts' || kind === 'waiting' || kind === 'completed'
}

export function sessionTaskRowState(
  row: SessionSidebarTreeRow,
  kind: SessionSidebarGroupKind
): Exclude<keyof SessionTaskGroupCounts, 'outcomes'> {
  if (row.pursuitState) {
    if (row.pursuitState === 'working' || row.pursuitState === 'running') {
      return 'running'
    }
    if (row.pursuitState === 'needs-you') {
      return 'needsYou'
    }
    return row.pursuitState === 'done' || row.pursuitState === 'inactive' ? 'done' : 'waiting'
  }
  if (rowNeedsPerson(row)) {
    return 'needsYou'
  }
  // Why: a finished run is done whatever its pane last said; only fresh work makes it run again.
  if (
    kind === 'completed' ||
    row.state === 'done' ||
    (row.run?.phase === 'completed' && row.state !== 'working')
  ) {
    return 'done'
  }
  // Why: a snoozed row is waiting on its time, whatever its pane last reported.
  if (row.waitingUntil) {
    return 'waiting'
  }
  // Why: a failed, recovering or waiting run asks nothing of anyone, so it is never "need you".
  return row.state === 'working' || row.run?.running ? 'running' : 'waiting'
}

/**
 * Group by task: every unfiled tasked row leaves Active, Drafts, Waiting or Done for one
 * group per task, placed right after Needs you. Un-tasked rows stay where they were.
 */
export function addSessionTaskGroups(args: {
  groups: readonly SessionSidebarGroup[]
  taskFor: (session: SidebarSession) => SessionTaskRef | null
  view: SessionSidebarView
  query: string
  chains?: readonly SessionChain[]
}): SessionSidebarGroup[] {
  const query = args.query.trim()
  const tasks = new Map<string, SessionSidebarGroup & { taskCounts: SessionTaskGroupCounts }>()
  const taken = new Set<string>()
  const remaining: SessionSidebarGroup[] = []
  const hasFolders = args.groups.some((group) => group.kind === 'folder')
  for (const group of args.groups) {
    if (!TASKABLE_KINDS.has(group.kind) || group.hidden) {
      remaining.push(group)
      continue
    }
    const rows = group.rows.filter((row) => {
      const task = args.taskFor(row.session)
      if (!task) {
        return true
      }
      const key = sessionTaskGroupKey(task.taskId)
      let taskGroup = tasks.get(task.taskId)
      if (!taskGroup) {
        taskGroup = {
          key,
          kind: 'task',
          label: task.title || taskGroupFallbackLabel(task.taskId),
          taskCounts: {
            running: 0,
            waiting: 0,
            needsYou: 0,
            done: 0,
            ...(args.chains ? { outcomes: taskOutcomeCounts(args.chains, task.taskId) } : {})
          },
          rows: [],
          collapsed: !query && isSessionGroupCollapsed(args.view, key),
          hidden: false,
          attentionCount: 0,
          canReorder: false,
          canHide: false
        }
        tasks.set(task.taskId, taskGroup)
      } else if (taskGroup.label === taskGroupFallbackLabel(task.taskId) && task.title) {
        taskGroup.label = task.title
      }
      if (!taken.has(row.session.rowKey)) {
        taken.add(row.session.rowKey)
        taskGroup.rows.push(row)
        taskGroup.taskCounts[sessionTaskRowState(row, group.kind)] += 1
      }
      return false
    })
    if (rows.length === group.rows.length) {
      remaining.push(group)
      continue
    }
    const emptied = rows.length === 0
    if (emptied && (isCountedGroup(group.kind) || (group.kind === 'workspace' && !hasFolders))) {
      continue
    }
    const kept = new Set(rows)
    const moved = new Set(group.rows.filter((row) => !kept.has(row)))
    remaining.push({
      ...group,
      rows,
      // Why: a row the task lens moved out must not linger under the folded folder it left.
      peekRows: group.peekRows?.filter((row) => !moved.has(row)),
      attentionCount: rows.filter(rowNeedsPerson).length,
      ...(isCountedGroup(group.kind)
        ? { label: conversationGroupLabel(group.kind, rows.length) }
        : {})
    })
  }
  if (tasks.size === 0) {
    return remaining
  }
  for (const taskGroup of tasks.values()) {
    taskGroup.attentionCount = taskGroup.taskCounts.needsYou
  }
  const at = remaining[0]?.kind === 'attention' ? 1 : 0
  return [...remaining.slice(0, at), ...tasks.values(), ...remaining.slice(at)]
}
