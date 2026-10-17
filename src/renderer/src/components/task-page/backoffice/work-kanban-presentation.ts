import { translate } from '@/i18n/i18n'
import { dependencyBadge } from '@/components/tasks/task-dependencies-model'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import { isProposedTask } from '../../../../../shared/proposed-task'
import { taskStanding, TASK_STATES, type TaskState } from '../../../../../shared/task-state'

/**
 * A board column: the hub's six outcome states plus Proposed, a lane this client derives
 * from the `proposed` tag. It is not a seventh outcome state — a proposed card still has a
 * hub standing (backlog or ready) and returns to it the moment the tag is removed.
 */
export type WorkColumn = 'proposed' | TaskState
export const PROPOSED_COLUMN = 'proposed' satisfies WorkColumn
export const WORK_COLUMNS: readonly WorkColumn[] = [PROPOSED_COLUMN, ...TASK_STATES]

/** The standings a proposal may sit in; anything further along is real work and shows there. */
const PROPOSABLE_STANDINGS: readonly TaskState[] = ['backlog', 'ready']

/** The column a card renders in, given its hub standing. */
export function workColumnFor(card: Pick<WorkCard, 'tags'>, standing: TaskState): WorkColumn {
  return isProposedTask(card.tags) && PROPOSABLE_STANDINGS.includes(standing)
    ? PROPOSED_COLUMN
    : standing
}

export function workColumn(card: WorkCard): WorkColumn {
  return workColumnFor(
    card,
    taskStanding({
      status: card.status,
      kanbanStatus: card.kanban_status,
      triageState: card.triage_state,
      deferUntil: card.defer_until,
      pausedAt: card.paused_at,
      verifiedAt: card.verified_at,
      verificationFailedAt: card.verification_failed_at
    }).state
  )
}
export function workKanbanColumns() {
  const labels: Record<WorkColumn, [string, string]> = {
    proposed: [
      translate('workKanban.proposed', 'Proposed'),
      translate(
        'workKanban.proposedDescription',
        'Ideas filed from chat or here; not committed until moved to Backlog or Ready.'
      )
    ],
    backlog: [
      translate('workKanban.backlog', 'Backlog'),
      translate('workKanban.backlogDescription', 'Valid work, not ready or committed yet.')
    ],
    ready: [
      translate('workKanban.ready', 'Ready'),
      translate('workKanban.readyDescription', 'Actionable now; a human or agent can pick it up.')
    ],
    'in-progress': [
      translate('workKanban.inProgress', 'In Progress'),
      translate('workKanban.inProgressDescription', 'Humans or agents are pursuing the outcome.')
    ],
    waiting: [
      translate('workKanban.waiting', 'Waiting'),
      translate(
        'workKanban.waitingDescription',
        'Progress needs an external response, dependency or time.'
      )
    ],
    review: [
      translate('workKanban.review', 'Review'),
      translate(
        'workKanban.reviewDescription',
        'The result is ready for required verification or approval.'
      )
    ],
    done: [
      translate('workKanban.done', 'Done'),
      translate(
        'workKanban.doneDescription',
        'The outcome and its acceptance criteria are satisfied.'
      )
    ]
  }
  return WORK_COLUMNS.map((state) => ({
    state,
    label: labels[state][0],
    description: labels[state][1]
  }))
}

export function workKanbanLabel(state: WorkColumn): string {
  return workKanbanColumns().find((column) => column.state === state)!.label
}

export function workKanbanBadges(card: WorkCard, needsYou: boolean) {
  const badges = new Map((card.kanban_badges ?? []).map((badge) => [badge.kind, badge]))
  // Why conditional: WorkCardDependencyBadge only restates this badge — carrying its
  // cause-specific label — when the summary itself says the card cannot proceed. Dropping it
  // otherwise would lose the hub's reason behind a generic "unknown".
  if (dependencyBadge(card.dependency_summary)?.kind === 'unmeetable') {
    badges.delete('dependency_unmeetable')
  }
  if (needsYou && !['done', 'verified_complete', 'cancelled'].includes(card.status)) {
    badges.set('needs_you', {
      kind: 'needs_you',
      label: translate('workKanban.needsYou', 'Needs you')
    })
  }
  if (card.kanban_badges == null) {
    if (card.status === 'blocked') {
      badges.set('blocked', { kind: 'blocked', label: translate('workKanban.blocked', 'Blocked') })
    }
    if (card.status === 'awaiting_approval') {
      badges.set('awaiting_approval', {
        kind: 'awaiting_approval',
        label: translate('workKanban.awaitingApproval', 'Awaiting approval')
      })
    }
    if (card.execution_state === 'FAILED' || card.status === 'failed') {
      badges.set('failed_attempt', {
        kind: 'failed_attempt',
        label: translate('workKanban.failedAttempt', 'Failed attempt')
      })
    }
  }
  if (card.kanban_disposition === 'cancelled' || card.status === 'cancelled') {
    badges.set('cancelled', {
      kind: 'cancelled',
      label: translate('workKanban.cancelled', 'Cancelled')
    })
  }
  return [...badges.values()]
}
