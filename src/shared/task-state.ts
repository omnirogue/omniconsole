/** Outcome states; session and attempt conditions belong in badges. */
export type TaskState = 'backlog' | 'ready' | 'in-progress' | 'waiting' | 'review' | 'done'

export const TASK_STATES: readonly TaskState[] = [
  'backlog',
  'ready',
  'in-progress',
  'waiting',
  'review',
  'done'
]

export type TaskStanding = {
  state: TaskState
  needsYou: boolean
}

export type TaskStandingInput = {
  status?: string | null
  kanbanStatus?: string | null
  triageState?: string | null
  needsYou?: boolean
  deferUntil?: string | null
  pausedAt?: string | null
  verifiedAt?: string | null
  verificationFailedAt?: string | null
  now?: number
}

const STATE_BY_STATUS: Readonly<Record<string, TaskState>> = {
  backlog: 'backlog',
  draft: 'backlog',
  contracted: 'backlog',
  pending: 'backlog',
  open: 'ready',
  ready: 'ready',
  eligible: 'ready',
  repair_required: 'ready',
  failed: 'ready',
  claimed: 'in-progress',
  assigned: 'in-progress',
  in_progress: 'in-progress',
  running: 'in-progress',
  waiting: 'waiting',
  blocked: 'waiting',
  awaiting_approval: 'waiting',
  candidate_complete: 'review',
  awaiting_verification: 'review',
  verifying: 'review',
  review: 'review',
  verified_complete: 'done'
}

function returnsLater(value: string | null | undefined, now: number): boolean {
  if (!value) {
    return false
  }
  const at = Date.parse(value)
  return Number.isFinite(at) && at > now
}

export function taskStanding(input: TaskStandingInput): TaskStanding {
  const authoritative = input.kanbanStatus?.replaceAll('_', '-')
  if (TASK_STATES.includes(authoritative as TaskState)) {
    const state = authoritative as TaskState
    return { state, needsYou: state !== 'done' && Boolean(input.needsYou) }
  }
  const status = (input.status ?? '').trim().toLowerCase()
  let state = STATE_BY_STATUS[status] ?? 'backlog'
  if (status === 'done') {
    state = input.verificationFailedAt ? 'ready' : input.verifiedAt ? 'done' : 'review'
  } else if (!['review', 'done'].includes(state)) {
    if (returnsLater(input.deferUntil, input.now ?? Date.now()) || input.pausedAt) {
      state = 'waiting'
    } else if (['inbox', 'someday', 'reference'].includes(input.triageState ?? '')) {
      state = 'backlog'
    }
  }
  return { state, needsYou: state !== 'done' && Boolean(input.needsYou) }
}

/** Attention is an overlay; within it preserve the task's outcome stage. */
export function taskStandingRank(standing: TaskStanding): number {
  return (standing.needsYou ? 0 : TASK_STATES.length) + TASK_STATES.indexOf(standing.state)
}

export function isClosedTaskStatus(status: string | null | undefined): boolean {
  return ['verified_complete', 'cancelled'].includes((status ?? '').trim().toLowerCase())
}
