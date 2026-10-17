import {
  followUpRow,
  humanJobRow,
  receivedRow,
  sentRow,
  todoRow,
  withoutThreadObligations
} from './backoffice-work-rows'
export { cardRow, cardRowKey } from './backoffice-work-rows'
import type { BackofficeTodoItem } from './backoffice-work-types'
import { messageRow } from './backoffice-work-message-rows'
import type { ConsoleTaskRecord } from './console-workflow-task-types'
import type { HandoffQueue } from './console-handoff-contract'
import type { ConsoleWorkflowJob } from './console-workflow-types'
import type { PeerMessageThread } from './peer-message-contract'

/**
 * Needs You / Waiting For / All over the obligations the hub already owns: the
 * person's Todo projection, their task-file handoff threads and the follow-ups they
 * saved. Pure: one projection so Tasks, Inbox links and the Attention summary count
 * the same rows. It never invents an obligation and names every missing feed.
 */
export type WorkQueueThread = HandoffQueue['threads'][number]

export type WorkRowKind =
  | 'decision'
  | 'approval'
  | 'qa'
  | 'review'
  | 'edit'
  | 'reply'
  | 'exception'
  | 'work'
  | 'fyi'

export type WorkRowSource =
  | 'task'
  | 'received-handoff'
  | 'sent-handoff'
  | 'awaiting-verification'
  | 'follow-up'
  /** A workflow stage assigned to this person to approve, decide or review. */
  | 'human-job'
  /** A peer message asked of this person, or one they asked; read-only from the desktop. */
  | 'message'

/** Who moves next: this person, a named person, or a run that has to finish first. */
export type WorkNextActor =
  | { kind: 'me' }
  | { kind: 'person'; id: string }
  | { kind: 'run'; thenIds: readonly string[] }

export type WorkFollowUpState =
  | 'waiting-for-run'
  | 'delivering'
  | 'delivered'
  | 'exception'
  | 'cancelled'

/** A saved "when this run finishes, send …" rule as the views see it. */
export type WorkFollowUpRow = {
  id: string
  taskId: string | null
  title: string
  recipientIds: readonly string[]
  /** Derived from the saved rule; omitted by older projections that did not distinguish agents. */
  hasAgentRecipients?: boolean
  /** What the people were asked for; null when the work says it. */
  action: string | null
  state: WorkFollowUpState
  /** Threads the delivery created, one per acknowledged recipient. */
  threadIds: readonly string[]
  detail: string | null
  /**
   * What the run's open request asks of the reader; absent or null when nothing is asked. Only
   * this makes a follow-up theirs to move (`docs/reference/session-run-lifecycle.md`).
   */
  ask?: string | null
  dueAt: string | null
  updatedAt: string | null
}

export type WorkRow = {
  key: string
  source: WorkRowSource
  taskId: string | null
  title: string
  kind: WorkRowKind
  nextActor: WorkNextActor
  why: string | null
  what: string | null
  /** Descriptive only; supported actions run through the existing typed verbs. */
  actionLabel: string | null
  state: string | null
  dueAt: string | null
  updatedAt: string | null
  repliesWaiting: number
  needsYou: boolean
  waitingFor: boolean
  todo?: BackofficeTodoItem
  thread?: WorkQueueThread
  followUp?: WorkFollowUpRow
  job?: ConsoleWorkflowJob
  message?: PeerMessageThread
  /** Which way a message went: to this person, or from them. Only message rows carry it. */
  direction?: 'received' | 'sent'
  /** A card read by id because it is not one of this person's rows; null while it loads. */
  card?: ConsoleTaskRecord | null
}

export type WorkViewGap =
  | 'todo-unavailable'
  | 'todo-truncated'
  | 'verification-not-served'
  | 'received-unavailable'
  | 'history-unavailable'
  | 'sent-not-served'
  | 'sent-unavailable'
  | 'received-truncated'
  | 'history-truncated'
  | 'sent-truncated'
  | 'human-jobs-unavailable'
  | 'human-jobs-not-served'
  | 'messages-unavailable'
  | 'messages-not-served'
  /** Messages exist but no feed named the viewer, so none can be filed as theirs. */
  | 'viewer-unknown'

export type WorkViewsInput = {
  employeeId: string | null
  /** Null when the Todo feed failed or is not loaded. */
  todo: {
    items: readonly BackofficeTodoItem[]
    awaitingVerification: readonly BackofficeTodoItem[] | null
    truncated: boolean
  } | null
  /** Threads handed to this person: the open queue and the finished history. Null = unavailable. */
  received: { open: readonly WorkQueueThread[] | null; history: readonly WorkQueueThread[] | null }
  /** Threads this person sent; null while the server serves no author-side view, or the read failed. */
  sent: readonly WorkQueueThread[] | null
  /** The sent read failed (network, server error or a refusal), so a null `sent` is not "not served". */
  sentFailed?: boolean
  /** A list the client stopped paging with more still on the server. */
  truncated?: { received?: boolean; history?: boolean; sent?: boolean }
  followUps: readonly WorkFollowUpRow[]
  /** Workflow stages assigned to this person; null while the server serves no such read, or it failed. */
  humanJobs: readonly ConsoleWorkflowJob[] | null
  /** The human-jobs read failed (network, server error or a refusal), so a null is not "not served". */
  humanJobsFailed?: boolean
  /** Peer messages in this person's shared projects; null while the server serves no such read, or it failed. */
  messages: readonly PeerMessageThread[] | null
  /** The messages read failed (network, server error or a refusal), so a null is not "not served". */
  messagesFailed?: boolean
}

export type WorkViews = {
  needsYou: WorkRow[]
  waitingFor: WorkRow[]
  all: WorkRow[]
  counts: { needsYou: number; decisions: number; waitingFor: number }
  gaps: WorkViewGap[]
}

export const DECISION_KINDS: ReadonlySet<WorkRowKind> = new Set([
  'decision',
  'approval',
  'qa',
  'review'
])

/**
 * Needs You lists people's handoffs only: a thread a person handed to this reader, a
 * reply that came back on a thread they sent, or the Todo row that IS such a thread's
 * decision. Decisions the hub derived from mail, workflow stages, peer messages,
 * follow-up rules and plain cards may still name the reader next, but they are not a
 * person asking them for something; they stay in All (and in the hub) untouched.
 */
export function isHumanHandoffRow(row: WorkRow): boolean {
  if (row.source === 'received-handoff' || row.source === 'sent-handoff') {
    return true
  }
  if (row.source === 'message') {
    return row.message?.task_id === null
  }
  // Why: a Todo row is a person's ask only when the hub ties it to a handoff thread, or a
  // person's reply is waiting on the task; a derived decision (mail, workflow) has neither.
  return (
    row.source === 'task' &&
    (typeof row.todo?.primary_action?.handoff_thread_id === 'string' || row.repliesWaiting > 0)
  )
}

function byDueThenFreshest(left: WorkRow, right: WorkRow): number {
  if (left.dueAt && right.dueAt && left.dueAt !== right.dueAt) {
    return left.dueAt < right.dueAt ? -1 : 1
  }
  if (Boolean(left.dueAt) !== Boolean(right.dueAt)) {
    return left.dueAt ? -1 : 1
  }
  return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
}

function decisionsFirst(left: WorkRow, right: WorkRow): number {
  const rank = (row: WorkRow) =>
    DECISION_KINDS.has(row.kind) ? 0 : row.kind === 'exception' ? 1 : 2
  return rank(left) - rank(right) || byDueThenFreshest(left, right)
}

export function buildWorkViews(input: WorkViewsInput): WorkViews {
  const rows = new Map<string, WorkRow>()
  const add = (row: WorkRow): void => {
    if (!rows.has(row.key)) {
      rows.set(row.key, row)
    }
  }
  const gaps: WorkViewGap[] = []
  const threadIdsOnTodo = new Set<string>()
  const decisionsOnTodo = new Set<string>()

  if (!input.todo) {
    gaps.push('todo-unavailable')
  } else {
    if (input.todo.truncated) {
      gaps.push('todo-truncated')
    }
    for (const item of input.todo.items) {
      const threadId = item.primary_action?.handoff_thread_id
      if (threadId) {
        threadIdsOnTodo.add(threadId)
      }
      if (item.decision_id) {
        decisionsOnTodo.add(`${item.task_id}:${item.decision_id}`)
      }
      add(todoRow(item, input.employeeId, 'task'))
    }
    if (input.todo.awaitingVerification === null) {
      gaps.push('verification-not-served')
    } else {
      for (const item of input.todo.awaitingVerification) {
        add(todoRow(item, input.employeeId, 'awaiting-verification'))
      }
    }
  }

  if (input.humanJobs === null) {
    gaps.push(input.humanJobsFailed ? 'human-jobs-unavailable' : 'human-jobs-not-served')
  } else {
    for (const job of input.humanJobs) {
      // Why: a stage the Todo already lists as that card's decision is the same ask; a card with two
      // decision stages is two rows, keyed by the job, never folded by task.
      if (decisionsOnTodo.has(`${job.task_id}:${job.id}`)) {
        continue
      }
      add(humanJobRow(job))
    }
  }

  if (input.messages === null) {
    gaps.push(input.messagesFailed ? 'messages-unavailable' : 'messages-not-served')
  } else {
    if (input.messages.length > 0 && input.employeeId === null) {
      gaps.push('viewer-unknown')
    }
    for (const thread of input.messages) {
      add(messageRow(thread, input.employeeId))
    }
  }

  const received = [...(input.received.open ?? []), ...(input.received.history ?? [])]
  if (input.received.open === null) {
    gaps.push('received-unavailable')
  }
  if (input.received.history === null) {
    gaps.push('history-unavailable')
  }
  if (input.received.open !== null && input.truncated?.received) {
    gaps.push('received-truncated')
  }
  if (input.received.history !== null && input.truncated?.history) {
    gaps.push('history-truncated')
  }
  for (const thread of received) {
    // Why: a thread this person sent to themselves is their own bookkeeping — a chain step
    // mirrored into Waiting For. The hub's attention list already excludes it, but this view is
    // first-wins per thread id, so a received row would claim the key and put a running step in
    // Needs You. The rule is enforced on both sides, never on the server's predicate alone.
    if (thread.author_employee_id === thread.recipient_employee_id) {
      continue
    }
    // Why: a handoff decision already on the Todo is the same ask; attach, never count twice.
    const onTodo = threadIdsOnTodo.has(thread.id)
    if (onTodo) {
      for (const row of rows.values()) {
        if (row.todo?.primary_action?.handoff_thread_id === thread.id) {
          row.thread = thread
        }
      }
      continue
    }
    add(receivedRow(thread))
  }

  const sentThreadIds = new Set<string>()
  if (input.sent === null) {
    gaps.push(input.sentFailed ? 'sent-unavailable' : 'sent-not-served')
  } else {
    if (input.truncated?.sent) {
      gaps.push('sent-truncated')
    }
    for (const thread of input.sent) {
      sentThreadIds.add(thread.id)
      add(sentRow(thread))
    }
  }

  for (const followUp of input.followUps) {
    const delivered = followUp.state === 'delivered'
    const acknowledgedHumanDelivery =
      input.sent !== null &&
      followUp.hasAgentRecipients === false &&
      followUp.recipientIds.length > 0 &&
      followUp.threadIds.length === followUp.recipientIds.length &&
      new Set(followUp.threadIds).size === followUp.threadIds.length
    // Canonical threads own a completed human delivery; archive must not resurrect its saved rule.
    if (
      delivered &&
      followUp.threadIds.length > 0 &&
      (acknowledgedHumanDelivery || followUp.threadIds.every((id) => sentThreadIds.has(id)))
    ) {
      continue
    }
    add(followUpRow(followUp))
  }

  // Why: a reply or wait a thread row on the same task already carries is one obligation, not two.
  const threadRows = [...rows.values()].filter(
    (row) => row.source === 'received-handoff' || row.source === 'sent-handoff'
  )
  for (const [key, row] of rows) {
    rows.set(key, withoutThreadObligations(row, threadRows))
  }

  const all = [...rows.values()].sort((left, right) =>
    (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
  )
  const needsYou = all.filter((row) => row.needsYou && isHumanHandoffRow(row)).sort(decisionsFirst)
  const waitingFor = all.filter((row) => row.waitingFor && !row.needsYou).sort(byDueThenFreshest)
  return {
    needsYou,
    waitingFor,
    all,
    counts: {
      needsYou: needsYou.length,
      decisions: needsYou.filter((row) => DECISION_KINDS.has(row.kind)).length,
      waitingFor: waitingFor.length
    },
    gaps
  }
}
