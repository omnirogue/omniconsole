/**
 * What the runtime says about one stage — read from attempts, never from a click.
 *
 * A stage is one plan node: its seats are the compiled steps that share it. Its state
 * is the fold of their attempts (`session-outcome-types.ts`), which is the same
 * evidence the plan report reads (`rpc/methods/work-plan-view.ts:93-117`). Settlement
 * is not progress: `completed` here means the seat finished, and nothing more — Done
 * When receipts are counted elsewhere (`docs/outcome-model-frozen.md` §5 invariant 4).
 */

import {
  isSessionChainAgentStep,
  sessionChainStepOutputDir,
  type SessionChain
} from '../../shared/session-chain-types'
import {
  lastSessionVerdictReceipt,
  sessionVerdictFailRoute,
  sessionVerdictOfReceipt
} from '../../shared/session-chain-verdict-receipts'
import {
  openHumanAttentionRequests,
  type HumanAttentionRequest
} from '../../shared/session-human-attention'
import { effectiveSessionOutcomeBlock } from '../../shared/session-outcome-block'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import type {
  UpNextAgentProgress,
  UpNextAgentSeat,
  UpNextBlockState
} from '../../shared/up-next-types'

/** A step id and the seats it stands for, with the reading the view shows. */
export type UpNextStepReading = {
  state: UpNextBlockState
  locked: boolean
  progress?: UpNextAgentProgress
}

type SeatStep = { id: string; planVersion?: number; status?: string; wait?: unknown }

/**
 * The outcome THIS stage is running on. A host runs many tracks at once and "a blocked
 * outcome does not block its siblings" (`session-outcome-steps.ts`), so a stop may only ever
 * be read from the stage's own: the outcome its attempt names, the one whose `stepIds` hold
 * one of its seats, or — on a chain with a single track — that one. Unresolvable means this
 * reading says nothing about a stop, rather than borrowing a stranger's.
 */
function stageOutcome(
  chain: SessionChain,
  seats: readonly SeatStep[],
  attempts: readonly (SessionOutcomeAttempt | null)[]
): SessionOutcome | undefined {
  const outcomes = chain.outcomeSet?.outcomes ?? []
  const named = new Set(
    attempts.flatMap((attempt) => (attempt?.outcomeId ? [attempt.outcomeId] : []))
  )
  const own = new Set(seats.map((seat) => seat.id))
  return (
    outcomes.find((outcome) => named.has(outcome.id)) ??
    outcomes.find((outcome) => (outcome.stepIds ?? []).some((id) => own.has(id))) ??
    (outcomes.length === 1 ? outcomes[0] : undefined)
  )
}

/**
 * Did this seat's own decision stop the track? A non-pass verdict is not a stop when the gate
 * ROUTED it: the run continues at the repair (`session-outcome-verdict-apply.ts`), so what
 * blocked the outcome was something further along, and naming this stage would put the wrong
 * one in the Now row. `insufficient_evidence` blocks whatever the route says, because the
 * verifier could not judge at all.
 */
function seatStopped(chain: SessionChain, seat: SeatStep): boolean {
  const verdict = sessionVerdictOfReceipt(lastSessionVerdictReceipt(chain, seat.id))
  if (!verdict || verdict.status === 'pass') {
    return false
  }
  const step = chain.steps.find((entry) => entry.id === seat.id)
  const route = step && isSessionChainAgentStep(step) ? sessionVerdictFailRoute(step) : undefined
  return !(verdict.status === 'fail' && route)
}

/** The last attempt of this seat at the chain's CURRENT plan version. */
export function upNextSeatAttempt(
  chain: SessionChain,
  step: SeatStep
): SessionOutcomeAttempt | null {
  const version = chain.planVersion ?? 1
  return (
    chain.outcomeSet?.attempts.findLast(
      (attempt) =>
        attempt.actionId === sessionOutcomeStepActionId(step.id) &&
        attempt.state !== 'superseded' &&
        (attempt.planVersion ?? step.planVersion ?? 1) === version
    ) ?? null
  )
}

function seatState(attempt: SessionOutcomeAttempt): UpNextAgentSeat['state'] {
  switch (attempt.state) {
    case 'completed':
      return 'done'
    case 'blocked':
      return 'failed'
    // `retryable` is work the engine relaunches itself (`session-outcome-resume.ts`): it is
    // not failed, and it is not in flight either — nothing is running, which is why the tick
    // skips it (`session-outcome-tick.ts`), the pending reading offers the action again
    // (`session-outcome-state.ts`) and the plan report calls it queued
    // (`rpc/methods/work-plan-view.ts`). The stage aggregate says queued too, so the seat row
    // says the same thing rather than the one word that would lock a stage nothing is using.
    case 'retryable':
      return 'queued'
    case 'prepared':
    case 'launching':
    case 'running':
    case 'unverifiable':
    case 'superseded':
      // In flight, as far as a person is concerned. `superseded` never reaches here:
      // the attempt reader above drops it before the fold.
      return 'running'
  }
}

/** The verdict's own one-liner, when the envelope carries one. Never invented. */
function verdictSummary(chain: SessionChain, stepIds: readonly string[]): string | undefined {
  for (const receipt of chain.verdicts ?? []) {
    if (!stepIds.includes(receipt.stepId) || receipt.skipped) {
      continue
    }
    const verdict = receipt.verdict
    if (verdict && typeof verdict === 'object') {
      const record = verdict as Record<string, unknown>
      for (const key of ['summary', 'status', 'verdict']) {
        if (typeof record[key] === 'string' && record[key]) {
          return record[key] as string
        }
      }
    }
  }
  return undefined
}

/**
 * Did this stage STOP the track? Settlement is not the answer: a gate seat that returned
 * `fail` or `insufficient_evidence` with no repair route settles as `completed` and is
 * marked done (`session-outcome-verdict.ts` marks the step before it blocks the outcome),
 * so the only evidence left is the receipt it spent and the outcome it blocked. A non-pass
 * verdict whose gate DID route is not a stop: the run continues at the repair, the outcome
 * stays pending, and this reading says nothing.
 */
function stageStopped(
  chain: SessionChain,
  seats: readonly SeatStep[],
  attempts: readonly (SessionOutcomeAttempt | null)[],
  outcome: SessionOutcome | undefined,
  failed: boolean
): boolean {
  // A proven outcome is final: an attempt that stopped on the way there is history, not a stop.
  if (outcome?.status === 'satisfied') {
    return false
  }
  if (failed || attempts.some((attempt) => attempt?.state === 'blocked')) {
    return true
  }
  if (outcome?.status !== 'blocked') {
    return false
  }
  return seats.some((seat) => seatStopped(chain, seat))
}

/** Why a stage the track stopped at cannot continue, in the one policy's classes. */
type UpNextStopState = Extract<UpNextBlockState, 'recovering' | 'waiting' | 'needs-you' | 'failed'>

/** The valid open requests of this run; a request is the ONLY thing that reads as needs-you. */
function openRequests(chain: SessionChain): HumanAttentionRequest[] {
  return chain.outcomeSet
    ? openHumanAttentionRequests(chain.outcomeSet, chain.planVersion ?? 1)
    : []
}

/** Requests about THIS stage: they name one of its seats or one of its attempts. */
function stageRequests(
  chain: SessionChain,
  seats: readonly SeatStep[],
  attempts: readonly (SessionOutcomeAttempt | null)[]
): HumanAttentionRequest[] {
  const steps = new Set(seats.map((seat) => seat.id))
  const tries = new Set(attempts.flatMap((attempt) => (attempt ? [attempt.id] : [])))
  return openRequests(chain).filter(
    (request) =>
      (request.scope.stepId !== undefined && steps.has(request.scope.stepId)) ||
      (request.scope.attemptId !== undefined && tries.has(request.scope.attemptId))
  )
}

const toOwner = (request: HumanAttentionRequest): boolean => request.recipient.type === 'owner'

/**
 * The class of a stop, from the block its WRITER classified (`session-outcome-block.ts`). The
 * reason text never decides it: an unclassified or stale block is an honest failure, and only an
 * open request addressed to the owner is needs-you.
 */
function stopState(
  chain: SessionChain,
  outcome: SessionOutcome | undefined,
  own: readonly HumanAttentionRequest[],
  now: number
): UpNextStopState {
  if (own.some(toOwner)) {
    return 'needs-you'
  }
  const block = outcome ? effectiveSessionOutcomeBlock(outcome, now) : null
  if (!block) {
    // A stopped attempt whose outcome is not blocked yet is the host's next pass to classify;
    // with no outcome to read, nothing says the host will ever act on it.
    return outcome && outcome.status !== 'satisfied' ? 'recovering' : 'failed'
  }
  if (block.class !== 'attention') {
    return block.class
  }
  const asked = openRequests(chain).filter((request) => request.scope.outcomeId === outcome!.id)
  if (asked.some(toOwner)) {
    return 'needs-you'
  }
  // Someone else's reply is a wait; a request that is gone is re-derived by the host's next pass.
  return asked.length ? 'waiting' : 'recovering'
}

function stageState(
  chain: SessionChain,
  seats: readonly SeatStep[],
  attempts: readonly (SessionOutcomeAttempt | null)[],
  outcome: SessionOutcome | undefined,
  failed: boolean,
  now: number
): { state: UpNextBlockState; stopped: boolean } {
  // `seats.every` is vacuously true, so a stage with no seats would read as done and lock
  // itself. Unreachable from `up-next-blocks.ts` (a stage always includes its head step),
  // and fail-open rather than claim a finished stage that never ran.
  if (!seats.length) {
    return { state: 'queued', stopped: false }
  }
  const own = stageRequests(chain, seats, attempts)
  // Stops are read BEFORE settlement: a failed Verify seat is settled AND stopped, and
  // the person has to see the stop (v3 amendments 1 and 7), not a tick.
  if (stageStopped(chain, seats, attempts, outcome, failed)) {
    return { state: stopState(chain, outcome, own, now), stopped: true }
  }
  const completed = chain.outcomeSet?.completedSteps ?? []
  const finished = seats.every(
    (seat, index) => completed.includes(seat.id) || attempts[index]?.state === 'completed'
  )
  if (finished) {
    return { state: 'done', stopped: false }
  }
  // A live agent asking its person something is not stopped, and it is not merely running.
  if (own.some(toOwner)) {
    return { state: 'needs-you', stopped: false }
  }
  const settled = outcome?.status === 'satisfied'
  const inFlight = (attempt: SessionOutcomeAttempt | null): boolean =>
    Boolean(attempt) && attempt!.state !== 'retryable' && !(settled && attempt!.state === 'blocked')
  if (attempts.some(inFlight)) {
    return { state: 'running', stopped: false }
  }
  return { state: seats.some((seat) => Boolean(seat.wait)) ? 'waiting' : 'queued', stopped: false }
}

/**
 * The stage's state, whether the person may still edit it, and the facts behind it.
 * A running, stopped or finished stage is LOCKED: configuring it appends a copy after
 * it rather than mutating what is already in flight (frozen model, invariant 7).
 */
export function upNextStepReading(
  chain: SessionChain,
  seats: readonly SeatStep[],
  now: number
): UpNextStepReading {
  const attempts = seats.map((seat) => upNextSeatAttempt(chain, seat))
  const live = attempts.filter((attempt): attempt is SessionOutcomeAttempt => attempt !== null)
  const outcome = stageOutcome(chain, seats, attempts)
  const { state, stopped } = stageState(
    chain,
    seats,
    attempts,
    outcome,
    seats.some((seat) => seat.status === 'failed'),
    now
  )
  const locked = stopped || state === 'running' || state === 'done' || state === 'needs-you'
  // A seat that settled and then blocked the outcome carries no error of its own: the reason
  // the track stopped is the one THIS stage's outcome recorded. It is a DIAGNOSTIC for Details;
  // a sibling outcome's copy would answer a question nobody asked.
  const failedAttempt = live.find((attempt) => attempt.state === 'blocked')
  const blockedReason =
    failedAttempt?.error ??
    (stopped && outcome?.status === 'blocked' ? outcome.blockedReason : undefined)
  const stopCode = stopped
    ? ((outcome ? effectiveSessionOutcomeBlock(outcome, now)?.code : undefined) ??
      failedAttempt?.failure?.code)
    : undefined
  const stop = {
    ...(blockedReason ? { blockedReason } : {}),
    ...(stopCode ? { stopCode } : {})
  }
  if (!live.length) {
    return stopped
      ? { state, locked, progress: { ...stop, stoppedAt: chain.outcomeSet?.updatedAt ?? now } }
      : { state, locked }
  }
  const startedAt = Math.min(...live.map((attempt) => attempt.startedAt))
  const updatedAt = Math.max(...live.map((attempt) => attempt.updatedAt))
  // Keyed on the SEAT, not on the position in the filtered attempt list: a stage where the
  // second of three seats has not started yet folded the third seat's attempt onto the second
  // seat's id, so the panel showed the wrong seat running and the wrong seat's verdict — and
  // `up-next-blocks.ts` then dropped the row whose id no longer belonged to the stage.
  const seatFacts: UpNextAgentSeat[] = seats.flatMap((seat, index) => {
    const attempt = attempts[index]
    if (!attempt) {
      return []
    }
    const summary = verdictSummary(chain, [seat.id])
    return [{ id: seat.id, state: seatState(attempt), ...(summary ? { verdict: summary } : {}) }]
  })
  const summary = verdictSummary(
    chain,
    seats.map((seat) => seat.id)
  )
  return {
    state,
    locked,
    progress: {
      startedAt,
      seats: seatFacts,
      ...(state === 'running' ? { elapsedMs: Math.max(0, now - startedAt) } : {}),
      ...(state === 'done' ? { durationMs: Math.max(0, updatedAt - startedAt) } : {}),
      ...(summary ? { verdictSummary: summary } : {}),
      receiptRef: sessionChainStepOutputDir(chain.workspacePath, chain.id, seats[0]!.id),
      ...stop,
      ...(stopped ? { stoppedAt: updatedAt } : {})
    }
  }
}
