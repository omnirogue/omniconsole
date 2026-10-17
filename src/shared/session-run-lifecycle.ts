import { openHumanAttentionRequests, type HumanAttentionRequest } from './session-human-attention'
import {
  SESSION_RECOVERING_MAX_MS,
  effectiveSessionOutcomeBlock,
  type SessionOutcomeBlock
} from './session-outcome-block'
import { reconcileSessionOutcomeSet } from './session-outcome-revise'
import type { SessionRunCompletion, SessionRunDisposition } from './session-run-completion'
import {
  readSessionRunHeldContinuation,
  sessionReviewFixRunning,
  type SessionRunHeldContinuation
} from './session-run-held-continuation'
import type { SessionOutcomeLifecycle, SessionOutcomeSet } from './session-outcome-types'

/**
 * THE reading of what a pursued session is doing. Every writer and every projection takes the phase
 * from here; none of them derives "needs you", "blocked" or "done" on its own
 * (`docs/reference/session-run-lifecycle.md`).
 */
export const SESSION_RUN_PHASES = [
  'active',
  'recovering',
  'waiting',
  'needs-you',
  'failed',
  'completed'
] as const
export type SessionRunPhase = (typeof SESSION_RUN_PHASES)[number]

export type SessionRunReading = {
  phase: SessionRunPhase
  /** The coarse reading older callers take: only `needs-you` and `complete` mean what they say. */
  lifecycle: SessionOutcomeLifecycle
  satisfied: number
  total: number
  /** Valid open requests addressed to the owner: the whole of "needs you". */
  attention: HumanAttentionRequest[]
  /** Valid open requests addressed to someone else: what the run is waiting on, nobody's alarm here. */
  awaitingOthers: HumanAttentionRequest[]
  /** Diagnostic prose for Details. Never decides the phase. */
  reasons: string[]
  failure?: { outcomeId: string; code: string; reason?: string }
  /** When the host next acts by itself, while `recovering`. */
  recoveringUntil?: number
  /** What a `waiting` run is waiting for. */
  wake?: string
  completion?: SessionRunCompletion
  disposition?: SessionRunDisposition
}

const LIFECYCLE: Record<SessionRunPhase, SessionOutcomeLifecycle> = {
  active: 'waiting',
  recovering: 'waiting',
  waiting: 'waiting',
  failed: 'waiting',
  'needs-you': 'needs-you',
  completed: 'complete'
}

export const UNVERIFIABLE_HOST_REASON = 'Execution host continuation is unverifiable.'

/**
 * An `attention` block none of whose requests is open any more: the person answered, or the run
 * moved on, and the host's next pass re-derives the block. It reads as recovering from the moment
 * the last request settled, and as failed once that pass has evidently not come.
 */
function answeredAttentionBlock(
  block: SessionOutcomeBlock,
  requests: readonly HumanAttentionRequest[] | undefined,
  openIds: ReadonlySet<string>,
  now: number
): SessionOutcomeBlock {
  if (block.class !== 'attention' || block.attentionIds?.some((id) => openIds.has(id))) {
    return block
  }
  const settledAt = (requests ?? []).flatMap((entry) =>
    block.attentionIds?.includes(entry.id) && entry.resolvedAt !== undefined
      ? [entry.resolvedAt]
      : []
  )
  const since = settledAt.length ? Math.max(...settledAt) : block.since
  return { ...block, class: now - since > SESSION_RECOVERING_MAX_MS ? 'failed' : 'recovering' }
}

/**
 * A run whose outcomes are proven while work queued behind its own review has not run yet: the host
 * continues it by itself — the reviewer's notes to the agent, or the held work into the run — so it
 * is never `completed` and never `needs-you`.
 */
function heldContinuationReading(
  hold: SessionRunHeldContinuation,
  set: SessionOutcomeSet,
  reading: (phase: SessionRunPhase, extra?: Partial<SessionRunReading>) => SessionRunReading,
  now: number
): SessionRunReading {
  const held = readSessionRunHeldContinuation(hold, now)
  if (held.phase === 'active') {
    return reading('active')
  }
  const reasons = held.reason ? [held.reason] : []
  if (held.phase === 'recovering') {
    return reading('recovering', { reasons })
  }
  // The outcome that owns the review the work waits behind is the one the failure is about.
  const owner =
    set.outcomes.find((outcome) =>
      hold.reviewStepIds.some((stepId) => outcome.stepIds?.includes(stepId))
    ) ?? set.outcomes[0]!
  return reading('failed', {
    reasons,
    failure: {
      outcomeId: owner.id,
      code: held.code,
      ...(held.reason ? { reason: held.reason } : {})
    }
  })
}

export function readSessionRun(
  set: SessionOutcomeSet,
  options: { now?: number; planVersion?: number } = {}
): SessionRunReading {
  const now = options.now ?? Date.now()
  const normalized = reconcileSessionOutcomeSet(set)
  const total = normalized.outcomes.length
  const satisfied = normalized.outcomes.filter((outcome) => outcome.status === 'satisfied').length
  const owned = set.continuation.state === 'owned'
  const reasons = normalized.outcomes
    .filter((outcome) => outcome.status === 'blocked' && outcome.blockedReason)
    .map((outcome) => `${outcome.title}: ${outcome.blockedReason}`)
  if (!owned && !set.completion) {
    reasons.push(UNVERIFIABLE_HOST_REASON)
  }
  const reading = (
    phase: SessionRunPhase,
    extra: Partial<SessionRunReading> = {}
  ): SessionRunReading => ({
    phase,
    lifecycle: LIFECYCLE[phase],
    satisfied,
    total,
    attention: [],
    awaitingOthers: [],
    reasons,
    ...(set.completion ? { completion: set.completion } : {}),
    ...(set.disposition ? { disposition: set.disposition } : {}),
    ...extra
  })
  // Sealed success is final: nothing observed afterwards is about this run any more.
  if (set.completion) {
    return reading('completed', { satisfied: total, reasons: [] })
  }
  if (satisfied === total && owned) {
    return set.heldContinuation
      ? heldContinuationReading(set.heldContinuation, normalized, reading, now)
      : reading('completed')
  }
  const open = openHumanAttentionRequests(normalized, options.planVersion)
  const attention = open.filter((entry) => entry.recipient.type === 'owner')
  const awaitingOthers = open.filter((entry) => entry.recipient.type !== 'owner')
  if (attention.length) {
    return reading('needs-you', { attention, awaitingOthers })
  }
  if (!owned) {
    // Lost contact proves nothing about the work; the host takes ownership back when it can.
    return reading('waiting', { awaitingOthers, wake: 'execution host' })
  }
  // The agent is fixing what a reviewer asked for: the run is working, not waiting on anyone.
  if (sessionReviewFixRunning(set.heldContinuation)) {
    return reading('active', { awaitingOthers })
  }
  const openIds = new Set(open.map((entry) => entry.id))
  const blocks = new Map<string, SessionOutcomeBlock>()
  for (const outcome of normalized.outcomes) {
    const block = effectiveSessionOutcomeBlock(outcome, now)
    if (block) {
      blocks.set(outcome.id, answeredAttentionBlock(block, normalized.attention, openIds, now))
    }
  }
  const failedIds = new Set(
    [...blocks].filter(([, block]) => block.class === 'failed').map(([outcomeId]) => outcomeId)
  )
  const byId = new Map(normalized.outcomes.map((outcome) => [outcome.id, outcome]))
  // Pending behind a blocked outcome — directly or through another pending one — is that block's
  // state, not progress of its own.
  const held = (outcomeId: string, seen: Set<string>): boolean => {
    if (blocks.has(outcomeId)) {
      return true
    }
    if (seen.has(outcomeId)) {
      return false
    }
    seen.add(outcomeId)
    return (byId.get(outcomeId)?.dependsOn ?? []).some((dep) => held(dep, seen))
  }
  const progressing = normalized.outcomes.some(
    (outcome) =>
      outcome.status === 'running' || (outcome.status === 'pending' && !held(outcome.id, new Set()))
  )
  if (progressing) {
    return reading('active', { awaitingOthers })
  }
  const classes = [...blocks.values()]
  const recovering = classes.filter((block) => block.class === 'recovering')
  if (recovering.length) {
    const untils = recovering.flatMap((block) => (block.until === undefined ? [] : [block.until]))
    return reading('recovering', {
      awaitingOthers,
      ...(untils.length ? { recoveringUntil: Math.min(...untils) } : {})
    })
  }
  const waiting = classes.find((block) => block.class === 'waiting')
  if (waiting || awaitingOthers.length) {
    const person = awaitingOthers[0]?.recipient
    return reading('waiting', {
      awaitingOthers,
      wake:
        waiting?.wake ??
        (person?.type === 'person' ? (person.name ?? person.employeeId) : undefined) ??
        'evidence'
    })
  }
  const failed = normalized.outcomes.find((outcome) => failedIds.has(outcome.id))
  if (failed) {
    return reading('failed', {
      failure: {
        outcomeId: failed.id,
        code: blocks.get(failed.id)!.code,
        ...(failed.blockedReason ? { reason: failed.blockedReason } : {})
      }
    })
  }
  return reading('active', { awaitingOthers })
}

/** Whether nothing more will happen to this run by itself: sealed, or honestly failed. */
export function isSettledSessionRun(reading: Pick<SessionRunReading, 'phase'>): boolean {
  return reading.phase === 'completed' || reading.phase === 'failed'
}
