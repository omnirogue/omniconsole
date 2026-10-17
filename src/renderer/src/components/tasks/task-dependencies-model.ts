import { translate } from '@/i18n/i18n'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import { isClosedTaskStatus } from '../../../../shared/task-state'
import type { WorkCard } from '../../../../shared/console-work-home-contract'
import type {
  TaskDependencyCondition,
  TaskDependencyEdge,
  TaskDependencyGraph,
  TaskDependencySummary
} from '../../../../shared/task-dependencies-contract'

export type DependencyChip = { tone: 'muted' | 'done' | 'destructive'; label: string }

export function dependencyChip(edge: Pick<TaskDependencyEdge, 'state'>): DependencyChip {
  switch (edge.state) {
    case 'satisfied':
      return { tone: 'done', label: translate('taskDependencies.stateDone', 'Done') }
    case 'unmeetable':
      return {
        tone: 'destructive',
        label: translate('taskDependencies.stateUnmeetable', "Can't be met")
      }
    case 'missing':
      return { tone: 'destructive', label: translate('taskDependencies.stateMissing', 'Missing') }
    case 'waiting':
      return { tone: 'muted', label: translate('taskDependencies.stateWaiting', 'Waiting') }
    // The hub can send an edge with no state at all (a read it could not complete); that is
    // reported as unknown, never guessed as done or waiting.
    case null:
    case undefined:
      return { tone: 'muted', label: translate('taskDependencies.stateUnknown', 'Unknown') }
  }
}

/** A condition the console could not read says so; it is never assumed to be "when done". */
export function dependencyConditionLabel(condition: TaskDependencyCondition | null | undefined) {
  if (condition === 'VERIFIED') {
    return translate('taskDependencies.whenVerified', 'when verified')
  }
  if (condition === 'DONE') {
    return translate('taskDependencies.whenDone', 'when done')
  }
  return translate('taskDependencies.whenUnknown', 'condition unknown')
}

/** An edge the hub or console could not fully read: shown as unknown, never as a met one. */
export function dependencyEdgeDegraded(
  edge: Pick<TaskDependencyEdge, 'condition' | 'state'>
): boolean {
  return edge.condition == null || edge.state == null
}

/**
 * Whether every edge of this task is known. A truncated list or a direction that could not
 * be read hides linked tasks, so nothing can be called safe to add against it.
 */
export function dependencyLinkageComplete(graph: TaskDependencyGraph | null | undefined): boolean {
  return (
    !!graph && graph.truncated !== true && graph.depends_on !== null && graph.dependents !== null
  )
}

/** Tasks a person may add as a prerequisite: open, not this task, not already linked either way. */
export function dependencyCandidates(
  cards: readonly WorkCard[],
  taskId: string,
  graph: TaskDependencyGraph | null,
  query: string
): WorkCard[] {
  // Why nothing: an unknown remainder means "unlinked" cannot be inferred, and the hub
  // answers dependency_exists for a task that is already linked out of sight.
  if (!dependencyLinkageComplete(graph)) {
    return []
  }
  const linked = new Set([
    taskId,
    ...(graph?.depends_on ?? []).map((edge) => edge.task_id),
    ...(graph?.dependents ?? []).map((edge) => edge.task_id)
  ])
  const q = query.trim().toLowerCase()
  return cards
    .filter((card) => !linked.has(card.id) && !isClosedTaskStatus(card.status))
    .filter((card) => (q ? card.title.toLowerCase().includes(q) : true))
    .slice(0, 40)
}

export function withAddedDependency(
  graph: TaskDependencyGraph,
  edge: TaskDependencyEdge
): TaskDependencyGraph {
  const rest = (graph.depends_on ?? []).filter((entry) => entry.task_id !== edge.task_id)
  return { ...graph, depends_on: [...rest, edge] }
}

export function withoutDependency(
  graph: TaskDependencyGraph,
  otherId: string
): TaskDependencyGraph {
  return {
    ...graph,
    depends_on: (graph.depends_on ?? []).filter((entry) => entry.task_id !== otherId)
  }
}

/** Put a removed edge back where it was, unless a refresh already restored it. */
export function withRestoredDependency(
  graph: TaskDependencyGraph,
  edge: TaskDependencyEdge,
  index: number
): TaskDependencyGraph {
  const list = graph.depends_on ?? []
  if (list.some((entry) => entry.task_id === edge.task_id)) {
    return graph
  }
  const next = [...list]
  next.splice(Math.min(index, next.length), 0, edge)
  return { ...graph, depends_on: next }
}

export type DependencyBadge = { kind: 'waiting' | 'unmeetable' | 'unknown'; count: number }

/**
 * The Kanban card's badge: can't-proceed wins over waiting; nothing when all are met. A count
 * the console could not read is `unknown`, never a silent zero, unless a known count already
 * says the card cannot proceed or is waiting. An explicit `null` summary is the console saying
 * it could not read one at all, so it is unknown too; only an absent field (a console with no
 * dependency feature) stays silent.
 */
export function dependencyBadge(
  summary: TaskDependencySummary | null | undefined
): DependencyBadge | null {
  if (summary === undefined) {
    return null
  }
  if (summary === null) {
    return { kind: 'unknown', count: 0 }
  }
  const blocked = (summary.unmeetable ?? 0) + (summary.missing ?? 0)
  if (blocked > 0) {
    return { kind: 'unmeetable', count: blocked }
  }
  const waiting = summary.waiting ?? 0
  if (waiting > 0) {
    return { kind: 'waiting', count: waiting }
  }
  const unread = [summary.waiting, summary.unmeetable, summary.missing].some(
    (value) => value === null || value === undefined
  )
  return unread ? { kind: 'unknown', count: 0 } : null
}

/** The hub's own badge text names the cause; ours only says that it cannot proceed. */
export function dependencyBadgeLabel(
  badge: DependencyBadge,
  kanbanBadges?: readonly { kind: string; label: string }[] | null
): string {
  if (badge.kind === 'unmeetable') {
    const hub = (kanbanBadges ?? []).find((entry) => entry.kind === 'dependency_unmeetable')
    return hub?.label.trim() || translate('taskDependencies.cantProceed', "Can't proceed")
  }
  if (badge.kind === 'unknown') {
    return translate('taskDependencies.summaryUnknown', 'Dependencies unknown')
  }
  return translate('taskDependencies.waitingOn', 'Waiting on {{count}}', { count: badge.count })
}

// The hub changes dependency inputs only while the card is open (collab/store.py:855, 3157);
// every other status answers 400 validation. Listed, not inverted: an unfamiliar status stays
// enabled so the hub — not a guess here — has the last word.
const STATUS_CLOSED_TO_DEPENDENCY_EDITS = [
  'pending',
  'claimed',
  'in_progress',
  'awaiting_approval',
  'blocked',
  'done',
  'cancelled',
  'verified_complete'
]

/** Why adding a dependency would be refused for this task's status, or null when it may be tried. */
export function dependencyAddRefusal(status: string | null | undefined): string | null {
  const value = (status ?? '').trim().toLowerCase()
  if (!STATUS_CLOSED_TO_DEPENDENCY_EDITS.includes(value)) {
    return null
  }
  return isClosedTaskStatus(value) || value === 'done' || value === 'cancelled'
    ? translate(
        'taskDependencies.addClosed',
        'This task is closed, so it can no longer be given a dependency.'
      )
    : translate(
        'taskDependencies.addNotOpen',
        'A dependency can only be added while the task is open, and this one is {{status}}.',
        { status: value }
      )
}

/** Plain English for the refusals a dependency change can meet; the hub's words otherwise. */
export function taskDependencyRefusalMessage(error: unknown): string {
  if (!(error instanceof WorkflowRequestError)) {
    return error instanceof Error ? error.message : String(error)
  }
  const { code, status, message } = error.detail
  if (code === 'dependency_cycle') {
    return translate(
      'taskDependencies.refusedCycle',
      'That would make these tasks wait on each other, so the dependency was not added.'
    )
  }
  if (code === 'card-not-ours' || code === 'card-ownership-unknown') {
    return translate(
      'taskDependencies.refusedOtherConsole',
      'This task is managed from another console, so its dependencies cannot be changed here.'
    )
  }
  if (code === 'dependency_sealed') {
    return translate(
      'taskDependencies.refusedSealed',
      'This task belongs to a sealed workflow, so its dependencies cannot change.'
    )
  }
  if (status === 403) {
    return translate(
      'taskDependencies.refusedForbidden',
      'You do not have access to one of these tasks, so the dependency cannot be changed.'
    )
  }
  if (code === 'validation' && /while card is open/i.test(message)) {
    return translate(
      'taskDependencies.refusedNotOpen',
      'A dependency can only be added while the task is open.'
    )
  }
  if (status === 404 || code === 'not_found') {
    return translate('taskDependencies.refusedMissing', 'One of these tasks no longer exists.')
  }
  return message
}
