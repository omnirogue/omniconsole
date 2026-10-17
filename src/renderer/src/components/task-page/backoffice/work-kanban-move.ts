import { translate } from '@/i18n/i18n'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import type { TaskLifecycleAction } from '../../../../../shared/console-task-lifecycle'
import type { TaskState } from '../../../../../shared/task-state'
import { PROPOSED_COLUMN, type WorkColumn } from './work-kanban-presentation'

/**
 * The column a person drops a card into, translated into the hub's canonical verb.
 *
 * `done` is absent on purpose: finishing is not a rail move. It runs through the board
 * PATCH and the hub's evidence gate, so the menu routes Done to the completion path
 * instead of inventing a seventh verb the hub would refuse.
 */
const ACTION_BY_COLUMN: Readonly<Partial<Record<TaskState, TaskLifecycleAction>>> = {
  backlog: 'backlog',
  ready: 'ready',
  'in-progress': 'start',
  waiting: 'wait',
  review: 'submit_for_review'
}

/** The verb that moves a card from `from` into `to`, or null when no verb does. */
export function lifecycleActionFor(from: WorkColumn, to: TaskState): TaskLifecycleAction | null {
  // Why resume: a card leaving Waiting is resumed, not started again — `start` on a
  // waiting card is the hub's own distinction and it answers differently.
  if (to === 'in-progress') {
    return from === 'waiting' ? 'resume' : 'start'
  }
  return ACTION_BY_COLUMN[to] ?? null
}

/**
 * A move as the hub sees it. Proposed is a tag, not a state: entering it adds the tag,
 * leaving it removes the tag, and only then does the outcome verb run. A proposal keeps a
 * hub standing (backlog or ready) underneath, so leaving for the lane it already stands in
 * needs no verb, while leaving for the other one does — otherwise a ready-standing proposal
 * dropped on Backlog would surface in Ready.
 */
export type WorkCardMovePlan = {
  /** Set the `proposed` tag to this value before any verb; absent when the tag is unchanged. */
  setProposed?: boolean
  action: TaskLifecycleAction | null
}

export function planWorkCardMove(
  from: WorkColumn,
  to: WorkColumn,
  /** The card's hub standing underneath a Proposed lane; ignored elsewhere. */
  standing?: TaskState
): WorkCardMovePlan | null {
  if (from === to) {
    return null
  }
  if (to === PROPOSED_COLUMN) {
    return { setProposed: true, action: null }
  }
  if (from === PROPOSED_COLUMN) {
    return { setProposed: false, action: to === standing ? null : lifecycleActionFor(from, to) }
  }
  const action = lifecycleActionFor(from, to)
  return action ? { action } : null
}

export type MoveRefusal =
  /** The card is on the canonical rail; the hub names what has to happen first. */
  | 'canonical-rail'
  /** Another console owns this card's writes (`card-not-ours` / `card-ownership-unknown`). */
  | 'other-console'
  /** The expected revision was stale; one refetch and one retry is worth it. */
  | 'stale-revision'
  | 'other'

const OTHER_CONSOLE_CODES = ['card-not-ours', 'card-ownership-unknown']

/** Which recovery a refusal allows. Code first: three different 409s mean three things. */
export function classifyMoveRefusal(error: unknown): MoveRefusal {
  if (!(error instanceof WorkflowRequestError)) {
    return 'other'
  }
  const { code } = error.detail
  if (code === 'canonical_lifecycle_required') {
    return 'canonical-rail'
  }
  if (OTHER_CONSOLE_CODES.includes(code)) {
    return 'other-console'
  }
  return [
    'task_changed',
    'stale_snapshot',
    'stale_revision',
    'revision_required',
    'revision_conflict'
  ].includes(code)
    ? 'stale-revision'
    : 'other'
}

/** What the card says after a refusal. The hub's own words are kept where it supplied them. */
export function moveRefusalMessage(refusal: MoveRefusal, hubMessage: string): string {
  switch (refusal) {
    case 'canonical-rail':
      return hubMessage
    case 'other-console':
      return translate('workKanban.moveOtherConsole', 'This task is managed from another console.')
    case 'stale-revision':
      return translate(
        'workKanban.moveStale',
        'This task changed while the board was open. It has been re-read; try the move again.'
      )
    case 'other':
      return hubMessage
  }
}

/** Why a card cannot be moved from here, or null when it can. */
export function moveIneligibilityHint(kanbanReason: string | null | undefined): string {
  return (
    kanbanReason ?? translate('workKanban.moveIneligible', 'This task is not moved from the board.')
  )
}
