import type { ConsoleTaskRecord } from './console-workflow-task-types'
import type { BackofficeTodoItem } from './backoffice-work-types'
import type {
  WorkFollowUpRow,
  WorkNextActor,
  WorkQueueThread,
  WorkRow,
  WorkRowKind
} from './backoffice-work-views'
import type { ConsoleWorkflowAction, ConsoleWorkflowJob } from './console-workflow-types'

/** One row per obligation, built from the read that owns it (Todo, handoff thread, saved rule). */

function todoKind(item: BackofficeTodoItem): WorkRowKind {
  if (item.kind === 'approval' || item.kind === 'decision' || item.kind === 'qa') {
    return item.kind
  }
  if (item.blocker?.kind === 'failed' || item.blocker?.kind === 'blocked') {
    return 'exception'
  }
  // Why: the hub's `fyi` is its catch-all for work that needs the viewer, not an unread note.
  return 'work'
}

function threadKind(thread: WorkQueueThread): WorkRowKind {
  switch (thread.action) {
    case 'approve':
      return 'approval'
    case 'decide':
      return 'decision'
    case 'edit':
      return 'edit'
    case 'fyi':
      return 'fyi'
    case 'review':
    case null:
      return 'review'
  }
}

export function todoRow(
  item: BackofficeTodoItem,
  employeeId: string | null,
  source: 'task' | 'awaiting-verification'
): WorkRow {
  const who = item.who?.trim()
  // Why: while a run is live the hub names its session or claimant, not a person, as next actor.
  const nextActor: WorkNextActor =
    !who || who === employeeId
      ? { kind: 'me' }
      : who.startsWith('emp_')
        ? { kind: 'person', id: who }
        : { kind: 'run', thenIds: [] }
  const repliesWaiting = item.replies_waiting_count ?? 0
  // Why: a returned reply is an action for this person even when the task waits on someone else.
  const needsYou = source === 'task' && (nextActor.kind === 'me' || repliesWaiting > 0)
  return {
    key: `todo:${item.task_id}:${item.role ?? ''}:${item.decision_id ?? ''}:${source}`,
    source,
    taskId: item.task_id,
    title: item.title,
    kind: repliesWaiting > 0 && nextActor.kind !== 'me' ? 'reply' : todoKind(item),
    nextActor,
    why: item.why ?? null,
    what: item.what ?? item.next_action ?? null,
    actionLabel: item.primary_action?.label ?? item.ask ?? null,
    state: item.status ?? null,
    dueAt: item.due_date ?? null,
    updatedAt: item.updated_at ?? null,
    repliesWaiting,
    needsYou,
    waitingFor: source === 'awaiting-verification' || (!needsYou && nextActor.kind !== 'me'),
    todo: item
  }
}

export function receivedRow(thread: WorkQueueThread): WorkRow {
  const unread = thread.unread_entries ?? 0
  const open = thread.state === 'open'
  return {
    key: `handoff:${thread.id}`,
    source: 'received-handoff',
    taskId: thread.board_task_id,
    title: thread.title,
    kind: !open && unread > 0 ? 'reply' : threadKind(thread),
    nextActor:
      open || unread > 0 ? { kind: 'me' } : { kind: 'person', id: thread.author_employee_id },
    why: null,
    what: null,
    actionLabel: thread.action,
    state: thread.state,
    dueAt: thread.due_at,
    updatedAt: thread.updated,
    repliesWaiting: unread,
    needsYou: open || unread > 0,
    waitingFor: false,
    thread
  }
}

export function sentRow(thread: WorkQueueThread): WorkRow {
  const unread = thread.unread_entries ?? 0
  // Why: a replied thread has an answer back from the recipient; that is this person's move.
  const answered = thread.state === 'replied' || unread > 0
  const open = thread.state === 'open'
  return {
    key: `handoff:${thread.id}`,
    source: 'sent-handoff',
    taskId: thread.board_task_id,
    title: thread.title,
    kind: answered ? 'reply' : threadKind(thread),
    nextActor: answered ? { kind: 'me' } : { kind: 'person', id: thread.recipient_employee_id },
    why: null,
    what: null,
    actionLabel: thread.action,
    state: thread.state,
    dueAt: thread.due_at,
    updatedAt: thread.updated,
    repliesWaiting: unread,
    needsYou: answered && thread.state !== 'resolved',
    waitingFor: open && !answered,
    thread
  }
}

/**
 * A Todo row counts only what no thread row on its task already carries: the task's unread
 * replies (when those threads hold all of them) and the wait on a person a sent request is
 * still open with. Its own move (next actor is me) always stays.
 */
export function withoutThreadObligations(row: WorkRow, threads: readonly WorkRow[]): WorkRow {
  if (!row.todo || row.nextActor.kind === 'me') {
    return row
  }
  const onTask = threads.filter((thread) => thread.taskId === row.taskId)
  const carriedReplies = onTask.reduce((sum, thread) => sum + thread.repliesWaiting, 0)
  const replyCarried = row.repliesWaiting > 0 && row.repliesWaiting <= carriedReplies
  const waitingOn = row.nextActor.kind === 'person' ? row.nextActor.id : null
  const waitCarried = onTask.some(
    (thread) =>
      thread.source === 'sent-handoff' &&
      thread.waitingFor &&
      thread.nextActor.kind === 'person' &&
      thread.nextActor.id === waitingOn
  )
  if (!replyCarried && !waitCarried) {
    return row
  }
  const needsYou = row.needsYou && !replyCarried
  return {
    ...row,
    kind: replyCarried ? todoKind(row.todo) : row.kind,
    // Why: the thread row shows the unread reply; showing it on the task too counts it twice.
    repliesWaiting: replyCarried ? 0 : row.repliesWaiting,
    needsYou,
    waitingFor: !needsYou && !waitCarried
  }
}

/**
 * Only the ask of its run's open request makes a follow-up the reader's to move: a rule that
 * failed is an exception row, never "needs you" (`docs/reference/session-run-lifecycle.md`).
 */
export function followUpRow(followUp: WorkFollowUpRow): WorkRow {
  const exception = followUp.state === 'exception'
  const pending = followUp.state === 'waiting-for-run' || followUp.state === 'delivering'
  const ask = followUp.ask?.trim() || null
  return {
    key: `follow-up:${followUp.id}`,
    source: 'follow-up',
    taskId: followUp.taskId,
    title: followUp.title,
    kind: exception ? 'exception' : followUp.action === 'fyi' ? 'fyi' : 'review',
    nextActor: ask
      ? { kind: 'me' }
      : pending || exception
        ? { kind: 'run', thenIds: followUp.recipientIds }
        : { kind: 'person', id: followUp.recipientIds[0] ?? '' },
    why: ask ?? followUp.detail,
    what: null,
    actionLabel: followUp.action,
    state: followUp.state,
    dueAt: followUp.dueAt,
    updatedAt: followUp.updatedAt,
    repliesWaiting: 0,
    needsYou: ask !== null,
    waitingFor: ask === null && (pending || followUp.state === 'delivered'),
    followUp
  }
}

function humanJobKind(action: ConsoleWorkflowAction): WorkRowKind {
  switch (action) {
    case 'approve':
      return 'approval'
    case 'decide':
      return 'decision'
    case 'review':
      return 'review'
    case 'check':
    case 'execute':
    case 'repair':
    case 'notify':
      return 'work'
  }
}

/**
 * A workflow stage assigned to this person. Keyed by the job, never the card: a card admitted
 * with two decision stages is two asks. Only a stage the server has opened for this person's
 * decision needs them; before that the run holds it.
 */
export function humanJobRow(job: ConsoleWorkflowJob): WorkRow {
  const mine = job.can_decide === true
  return {
    key: `job:${job.id}`,
    source: 'human-job',
    taskId: job.task_id,
    title: job.title,
    kind: humanJobKind(job.policy.workflow.action),
    nextActor: mine ? { kind: 'me' } : { kind: 'run', thenIds: [] },
    why: job.blockers.length > 0 ? job.blockers.join(' · ') : null,
    what: null,
    actionLabel: job.policy.workflow.action,
    state: job.workflow_state,
    dueAt: null,
    updatedAt: job.updated_at,
    repliesWaiting: 0,
    needsYou: mine,
    waitingFor: !mine,
    job
  }
}

export function cardRowKey(taskId: string): string {
  return `card:${taskId}`
}

/** A read-only row for a card that is not in the person's lists (a handoff on somebody else's card). */
export function cardRow(
  taskId: string,
  card: ConsoleTaskRecord | null,
  employeeId: string | null
): WorkRow {
  const owner = card?.owner_employee_id ?? null
  return {
    key: cardRowKey(taskId),
    source: 'task',
    taskId,
    title: card?.title ?? taskId,
    kind: 'work',
    nextActor: owner && owner !== employeeId ? { kind: 'person', id: owner } : { kind: 'me' },
    why: null,
    what: card?.next_action ?? null,
    actionLabel: null,
    state: card?.status ?? null,
    dueAt: card?.due_date ?? null,
    updatedAt: card?.updated_at ?? null,
    repliesWaiting: 0,
    needsYou: false,
    waitingFor: false,
    // Why: the same verbs as an owned row (use, complete, archive, hand off); the hub decides what this person may do.
    todo: card
      ? {
          task_id: card.id,
          title: card.title,
          status: card.status,
          kanban_status: card.kanban_status,
          kanban_reason: card.kanban_reason,
          kanban_disposition: card.kanban_disposition,
          kanban_eligible: card.kanban_eligible,
          parent_task_id: card.parent_task_id,
          verified_at: card.verified_at,
          verification_failed_at: card.verification_failed_at,
          state_revision: card.state_revision ?? null,
          owner_employee_id: owner,
          next_action: card.next_action ?? null,
          due_date: card.due_date ?? null,
          updated_at: card.updated_at ?? null,
          company_slug: card.company_slug ?? null,
          href: `/board/${card.id}`
        }
      : undefined,
    card
  }
}
