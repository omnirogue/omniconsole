/**
 * `orchestration run-show --queue`: where each unfinished Task of one Run stands, in one bounded
 * read. Two facts are kept apart on purpose: what the Dispatch record says (the lifecycle the
 * coordinator settles) and what the worker's session shows (whether an agent is still there).
 * A Dispatch the watchdog failed can sit on a session that is live and working.
 */

export const ORCHESTRATION_RUN_QUEUE_DEFAULT_LIMIT = 20
export const ORCHESTRATION_RUN_QUEUE_MAX_LIMIT = 50

/**
 * Silence the heartbeat protocol itself tolerates (a heartbeat every five minutes, the hung-worker
 * alert at ten). Past it a live worker is `quiet`, which is still not a verdict about its process.
 */
export const ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS = 10 * 60_000

/** The same statuses `worker-show` reports, so both commands describe one session one way. */
export type RunQueueSessionStatus =
  | 'live'
  | 'unverifiable'
  | 'exited'
  | 'missing'
  | 'identity_changed'
  | 'unattached'

export type RunQueueSession = {
  status: RunQueueSessionStatus
  /** Set with `unverifiable`: what contact was lost with. */
  reason?: string
  /** An object: parked on a prompt only a person can answer. Null: looked, none. Absent: not looked. */
  agentWait?: { source: string; reason?: string } | null
  /** The agent's own last reported state. Absent when this host holds no fresh report. */
  agentState?: 'working' | 'blocked' | 'waiting' | 'done'
  /** True when its last turn ended on a provider usage limit. Absent when not evaluated. */
  providerLimited?: boolean
  /** Epoch ms of the terminal's last output. Absent when this host cannot see the terminal. */
  lastOutputAt?: number | null
}

export type RunQueueAttention =
  | 'not-started'
  | 'blocked'
  | 'starting'
  | 'working'
  | 'quiet'
  | 'waiting-on-human'
  | 'waiting-on-coordinator'
  | 'provider-limited'
  | 'idle-unreported'
  | 'unverifiable'
  | 'exited-unreported'
  | 'outcome-unknown'
  | 'failed'
  | 'failed-session-live'

export type RunQueueDispatch = {
  id: string
  status: string
  workerState: string
  stage: string
  lastError: string | null
  dispatchedAt: string | null
  lastHeartbeatAt: string | null
  updatedAt: string | null
  terminalHandle: string | null
  /** The connected server that runs the worker; null when it runs on the Run home. */
  server: string | null
}

export type RunQueueRow = {
  taskId: string
  title: string
  taskStatus: string
  /** Every Dispatch this Task has had, retries included. */
  attempts: number
  /** The newest Dispatch, or null when the Task was never dispatched. */
  dispatch: RunQueueDispatch | null
  /** Null when there was no session to look at (never dispatched, or already released). */
  session: RunQueueSession | null
  openQuestions: number
  attention: RunQueueAttention
  detail: string
}

export type RunQueueSummary = {
  runId: string
  generatedAt: string
  /** Every Task of the Run by status, completed ones included. */
  taskCounts: Record<string, number>
  /** Unfinished Tasks beyond `limit`; they are counted in taskCounts and not listed. */
  omitted: number
  limit: number
  rows: RunQueueRow[]
}

export type RunQueueFacts = {
  taskStatus: string
  dispatchStatus: string | null
  workerState: string | null
  stage: string | null
  session: RunQueueSession | null
  openQuestions: number
  /** Latest of the Dispatch's own progress, its heartbeat and its terminal output; null if none. */
  lastActivityAtMs: number | null
  nowMs: number
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} min`
}

function unverifiableDetail(session: RunQueueSession | null): string {
  if (!session) {
    return 'Its session could not be looked at from this computer. Unknown is not finished: keep it.'
  }
  if (session.status === 'unverifiable') {
    return `Contact was lost${session.reason ? ` (${session.reason})` : ''}. That is not an exit: keep it.`
  }
  if (session.status === 'identity_changed') {
    return 'Its terminal now runs a different process, so this worker cannot be read here.'
  }
  if (session.status === 'missing') {
    return 'Its terminal is not on this computer any more; nothing here says how it ended.'
  }
  return 'It has no terminal attached, so nothing can be observed.'
}

/**
 * One row's label. Every rule errs toward "keep": silence, lost contact and a failed Dispatch are
 * each named for what they are and never promoted to "dead".
 */
export function deriveRunQueueAttention(facts: RunQueueFacts): {
  attention: RunQueueAttention
  detail: string
} {
  const { session } = facts
  if (!facts.dispatchStatus) {
    if (facts.taskStatus === 'blocked') {
      return { attention: 'blocked', detail: 'A Task it depends on failed or is unfinished.' }
    }
    return facts.taskStatus === 'failed'
      ? { attention: 'failed', detail: 'It failed without a Dispatch.' }
      : { attention: 'not-started', detail: 'No worker has been started for it.' }
  }
  if (facts.dispatchStatus === 'failed' || facts.dispatchStatus === 'circuit_broken') {
    const stage = facts.stage ?? 'unknown stage'
    if (session?.status === 'live') {
      return {
        attention: 'failed-session-live',
        detail: `The Dispatch failed (${stage}) but its session is live. A failed Dispatch is not a dead session: read it with worker-read before retrying.`
      }
    }
    // Why: a Task put back to ready is waiting for its next attempt, not sitting failed.
    return facts.taskStatus === 'ready' || facts.taskStatus === 'pending'
      ? {
          attention: 'not-started',
          detail: `Its last Dispatch failed (${stage}); no worker has been started for the next attempt.`
        }
      : { attention: 'failed', detail: `The Dispatch failed (${stage}).` }
  }
  if (facts.dispatchStatus === 'completed') {
    return {
      attention: 'outcome-unknown',
      detail: 'Its last Dispatch completed but the Task is still open; check task-list.'
    }
  }
  if (facts.workerState === 'starting') {
    return { attention: 'starting', detail: 'The worker is still starting.' }
  }
  if (
    facts.workerState === 'start_unknown' ||
    facts.workerState === 'stop_unknown' ||
    facts.workerState === 'stopping'
  ) {
    return {
      attention: 'outcome-unknown',
      detail: `Worker state is ${facts.workerState}; inspect with worker-show before acting.`
    }
  }
  if (!session || session.status !== 'live') {
    return session?.status === 'exited'
      ? {
          attention: 'exited-unreported',
          detail:
            'Its agent exited without a report. Nothing was retried or stopped: decide with worker-show.'
        }
      : { attention: 'unverifiable', detail: unverifiableDetail(session) }
  }
  // Why both: a pane read and the agent's own report can each see a prompt the other missed.
  if (session.agentWait || session.agentState === 'blocked' || session.agentState === 'waiting') {
    const reason =
      session.agentWait?.reason ?? (session.agentState === 'blocked' ? 'permission' : undefined)
    return {
      attention: 'waiting-on-human',
      detail: `It is parked on a prompt only a person can answer${reason ? ` (${reason})` : ''}.`
    }
  }
  if (facts.openQuestions > 0) {
    return {
      attention: 'waiting-on-coordinator',
      detail: 'It asked the coordinator a question and is waiting for the reply.'
    }
  }
  if (session.providerLimited) {
    return {
      attention: 'provider-limited',
      detail:
        'Its last turn stopped on a provider usage limit; it can continue when the limit resets.'
    }
  }
  if (session.agentState === 'working') {
    return { attention: 'working', detail: 'Its agent reports it is working.' }
  }
  if (session.agentState === 'done') {
    return {
      attention: 'idle-unreported',
      detail:
        'Its agent ended its turn without a worker_done. Read it or ask it; do not assume it finished.'
    }
  }
  const silentMs = facts.lastActivityAtMs === null ? null : facts.nowMs - facts.lastActivityAtMs
  if (silentMs !== null && silentMs <= ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS) {
    return { attention: 'working', detail: `Live, last activity ${minutes(silentMs)} ago.` }
  }
  return {
    attention: 'quiet',
    detail:
      silentMs === null
        ? 'Live, with no heartbeat or output recorded yet. Quiet is not dead.'
        : `Live, but no heartbeat or output for ${minutes(silentMs)}. Quiet is not dead: a long tool run reports nothing.`
  }
}
