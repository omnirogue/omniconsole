// ─── Is this dispatch dead, or just quiet? ───────────────────────────────────
// The whole decision lives here, with no database and no runtime, because the cost of getting it
// wrong is asymmetric: failing a step that is genuinely working destroys real work, while failing a
// dead one late merely repeats the silence a little longer. So every rule below errs toward "keep",
// and a dispatch is only ever failed on its OWN recorded budget.

import {
  describeAgentTurnFailure,
  describeWorkerDispatchStall
} from '../../../shared/agent-turn-failure'
import type { AgentStatusState } from '../../../shared/agent-status-types'

/** What the dispatch row itself says, in wall-clock ms. */
export type WorkerDispatchStallSubject = {
  dispatchId: string
  stage: string
  /** Last time anything moved this dispatch forward. The clock the budget is measured from. */
  updatedAtMs: number
  /** The dispatch's own recorded readiness budget; null disables the watchdog for this row. */
  timeoutMs: number | null
  /**
   * The worker's last accepted lifecycle heartbeat (`dispatch_contexts.last_heartbeat_at`). The
   * dispatch preamble makes this THE liveness signal a worker owes; it is activity like any other.
   */
  heartbeatAtMs?: number | null
  /**
   * When this runtime began observing hooks. A runtime that restarted cannot see the turn its
   * worker was already inside: restored `working` rows are unconfirmed until the agent reports
   * again, and a tool call that spans the restart reports nothing until it ends.
   */
  observedSinceMs?: number | null
}

/**
 * The silence the heartbeat protocol itself tolerates. A worker is asked for a heartbeat every five
 * minutes and the hung-worker alert speaks at ten, so the watchdog never fails a worker that has
 * shown it keeps that contract, or one a restart hid from view, any sooner than that.
 */
export const HEARTBEAT_PROTOCOL_SILENCE_MS = 10 * 60_000

/** The pane's live hook row, or null when no fresh status exists for the worker's terminal. */
export type WorkerDispatchStallObservation = {
  state: AgentStatusState
  updatedAt: number
  /** Provider-reported turn failure (Claude StopFailure). */
  failed?: boolean
  failureReason?: string
  /** A cancellation. Parks, never fails — chains have always treated an interrupt as "the person decides". */
  interrupted?: boolean
} | null

/**
 * Whether the worker's pane is visibly parked on an interactive prompt (a permission dialog, a
 * question, a startup approval) — the runtime's own `agentWait` reading. `waiting` is a live agent
 * asking its person something, never a dead one; `pending` means the reading is not in yet, and a
 * dispatch is never failed on a question that has not been answered.
 */
export type WorkerDispatchInteractiveWait = 'waiting' | 'none' | 'pending'

export type WorkerDispatchStallVerdict =
  | { kind: 'keep' }
  | { kind: 'fail'; stage: string; reason: string }

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** A turn that ended in failure is only this dispatch's failure if it happened after its last progress. */
function failureBelongsToDispatch(
  subject: WorkerDispatchStallSubject,
  observation: NonNullable<WorkerDispatchStallObservation>
): boolean {
  return observation.updatedAt >= subject.updatedAtMs
}

/** A verdict that came from silence rather than from the agent's own word; only these may be held. */
export function isWorkerDispatchStallVerdict(verdict: WorkerDispatchStallVerdict): boolean {
  return verdict.kind === 'fail' && verdict.stage.endsWith('_stalled')
}

export function judgeWorkerDispatchStall(
  subject: WorkerDispatchStallSubject,
  observation: WorkerDispatchStallObservation,
  nowMs: number,
  interactiveWait: WorkerDispatchInteractiveWait = 'none'
): WorkerDispatchStallVerdict {
  if (observation?.interrupted === true) {
    // Why: `done` + `interrupted` has always parked a plan — the person stopped it and owns what
    // happens next. Nothing here may convert that into a failure.
    return { kind: 'keep' }
  }
  if (observation?.failed === true && failureBelongsToDispatch(subject, observation)) {
    // Why: the agent itself said this turn died. No budget needs to expire for that to be true,
    // and this is the only path that can surface a cause (a quota wall, an expired sign-in).
    return {
      kind: 'fail',
      stage: `${subject.stage}_agent_failed`,
      reason: describeAgentTurnFailure(observation.failureReason)
    }
  }
  if (observation && observation.state !== 'done') {
    // Why: working, waiting and blocked are all live agents. A ten-minute test run emits no hook
    // events at all, so quiet is NOT evidence of death while the pane's last word was "not idle".
    return { kind: 'keep' }
  }
  if (subject.timeoutMs === null) {
    return { kind: 'keep' }
  }
  // Real activity resets the clock: the dispatch's own progress, the worker's own heartbeat, and
  // an idle row that is still being re-observed. Only when all of them have been silent for the
  // whole recorded budget does the watchdog speak — the case no hook ever reports (Sal's chain:
  // ready/input_accepted forever).
  const lastActivityAt = Math.max(
    subject.updatedAtMs,
    finiteOr(subject.heartbeatAtMs, subject.updatedAtMs),
    observation ? observation.updatedAt : subject.updatedAtMs
  )
  const observedSinceMs = finiteOr(subject.observedSinceMs, Number.NEGATIVE_INFINITY)
  // Why: activity that predates this runtime was followed by a stretch it could not see
  // (2026-09-22: a live worker failed one second after a restart, its heartbeat 62s old). Silence
  // is then counted only from when this runtime started listening.
  const sinceRestart = lastActivityAt < observedSinceMs
  const silenceStartedAt = sinceRestart ? observedSinceMs : lastActivityAt
  // Why: `timeoutMs` is the worker-start READINESS budget (60s by default). It is the right bound
  // for a worker that never proved it was alive (a quota wall seconds after the prompt), and the
  // wrong one for a worker keeping the five-minute heartbeat contract, or one a restart hid.
  const heartbeated = Number.isFinite(finiteOr(subject.heartbeatAtMs, Number.NaN))
  const budgetMs =
    sinceRestart || heartbeated
      ? Math.max(subject.timeoutMs, HEARTBEAT_PROTOCOL_SILENCE_MS)
      : subject.timeoutMs
  if (nowMs - silenceStartedAt <= budgetMs) {
    return { kind: 'keep' }
  }
  if (interactiveWait !== 'none') {
    // Why: an agent with no hook row at all (Codex drops untrusted hooks) can still be sitting at a
    // prompt only a person may answer. That is silence with a cause on the screen, not a death.
    return { kind: 'keep' }
  }
  return {
    kind: 'fail',
    stage: `${subject.stage}_stalled`,
    reason: describeWorkerDispatchStall({
      timeoutMs: budgetMs,
      agentTurnEnded: observation !== null,
      reason: observation?.failureReason
    })
  }
}
