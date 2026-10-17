import type { SessionVerdict } from '../../shared/session-chain-verdict'
import { sessionVerdictPassedIds } from '../../shared/session-chain-verdict-checks'
import {
  isSessionVerdictStep,
  sessionVerdictFailRoute,
  sessionVerdictSkipReceipt
} from '../../shared/session-chain-verdict-receipts'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainVerdictReceipt
} from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import { sessionOutcomeGateVerdictReason } from './session-outcome-gate-hold'
import { sessionOutcomeVerdictReceiptId } from './session-outcome-report-evidence'
import { markSteps, type OutcomeStepAccess } from './session-outcome-step-progress'

/**
 * `refused` means the verdict could not be spent at all (the seat failed); `blocked` means it was
 * spent and what it says stops the outcome. The difference matters: a blocked outcome has a real
 * decision behind it, a refused one has none.
 */
export type SessionOutcomeVerdictApplication = {
  refused?: string
  /** `cause` is what a writer classifies; `reason` is only the diagnostic beside it. */
  blocked?: { reason: string; cause: 'insufficient-evidence' | 'gate-failed' }
}

function agentSteps(chain: SessionChain): SessionChainAgentStep[] {
  return chain.steps.filter((step): step is SessionChainAgentStep => step.kind !== 'handoff')
}

/** A seat closed without running is completed AND receipted, so the tick invariant still holds. */
function closeSeats(
  access: OutcomeStepAccess,
  steps: readonly SessionChainAgentStep[],
  reason: string,
  now: number
): void {
  if (!steps.length) {
    return
  }
  const chain = access.read()
  const receipts = steps
    .filter((step) => isSessionVerdictStep(step))
    .map((step) => sessionVerdictSkipReceipt(step, undefined, reason, now))
    .filter(
      (receipt) => !(chain.verdicts ?? []).some((e) => e.consumptionKey === receipt.consumptionKey)
    )
  access.save({ ...chain, verdicts: [...(chain.verdicts ?? []), ...receipts] })
  markSteps(
    access,
    steps.map((step) => step.id),
    true
  )
}

/**
 * The winner's seats keep running and the losers' stop. Pairing is by seat number when the plan
 * lowered one, and by declared order otherwise; a fan-out the host cannot pair is refused rather
 * than guessed, because guessing skips the winner's own downstream work.
 */
function applySelectWinner(
  access: OutcomeStepAccess,
  step: SessionChainAgentStep,
  verdict: SessionVerdict,
  now: number
): SessionOutcomeVerdictApplication {
  const chain = access.read()
  const over = step.verdict!.over
  const winner = verdict.winnerId!
  const enabled = agentSteps(chain).filter((entry) => entry.enabledBy?.verdict === step.id)
  if (enabled.length && !enabled.every((entry) => entry.seat) && enabled.length !== over.length) {
    return {
      refused: `The seats waiting on ${step.id} cannot be matched to the candidates it judged. Recompile the plan before running it.`
    }
  }
  const winnerSeat = over.indexOf(winner) + 1
  const losers = enabled.filter((entry, at) => (entry.seat?.index ?? at + 1) !== winnerSeat)
  const readers = agentSteps(chain).filter((entry) => entry.readsWinnerOf === step.id)
  if (readers.length) {
    access.save({
      ...chain,
      steps: chain.steps.map((entry) =>
        entry.kind !== 'handoff' && entry.readsWinnerOf === step.id
          ? { ...entry, readsFrom: [winner] }
          : entry
      )
    })
  }
  closeSeats(access, losers, `not selected by ${step.id}`, now)
  return {}
}

/**
 * One `report` receipt per done-when entry this gate decides, and only for entries it targets. A
 * per-line verdict receipts only the lines whose own check passed, never the whole list at once.
 */
function mintGateEvidence(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  verdict: SessionVerdict,
  receipt: SessionChainVerdictReceipt,
  now: number
): string | null {
  const chain = access.read()
  let set = chain.outcomeSet!
  const passed = verdict.checks ? sessionVerdictPassedIds(verdict.checks) : null
  for (const id of step.verdict!.over) {
    if (passed && !passed.has(id)) {
      continue
    }
    const current = set.outcomes.find((entry) => entry.id === outcome.id)!
    const condition = current.conditions.find((entry) => entry.id === id)
    // A done-when entry the host verifies itself (a file, a command) is not a gate's to mint.
    if (
      !condition ||
      condition.kind !== 'report' ||
      condition.target !== step.id ||
      current.evidence.some((entry) => entry.conditionId === id)
    ) {
      continue
    }
    try {
      set = recordSessionOutcomeEvidence(
        set,
        sessionOutcomeVerifiedEvidence(
          current,
          condition,
          sessionOutcomeVerdictReceiptId(receipt.attemptId, receipt),
          now,
          verdict.candidateVersion
        )
      )
    } catch (error) {
      return `This gate could not record its evidence: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  access.save({ ...chain, outcomeSet: set })
  return null
}

/** The seats of the node a failure routes to; a pass closes them, a failure runs them. */
function failRouteSeats(
  chain: SessionChain,
  step: SessionChainAgentStep,
  outcome: SessionOutcome
): { seats: SessionChainAgentStep[]; between: SessionChainAgentStep[] } | null {
  const route = sessionVerdictFailRoute(step)
  const ids = outcome.stepIds ?? []
  const at = ids.indexOf(step.id)
  const to = route ? ids.indexOf(route) : -1
  const completed = chain.outcomeSet!.completedSteps ?? []
  if (!route || to === -1 || to <= at || completed.includes(route)) {
    return null
  }
  const target = agentSteps(chain).find((entry) => entry.id === route)!
  const node = target.planNodeId
  return {
    seats: agentSteps(chain).filter(
      (entry) =>
        !completed.includes(entry.id) &&
        (entry.id === route || (Boolean(node) && entry.planNodeId === node))
    ),
    between: agentSteps(chain).filter(
      (entry) =>
        !completed.includes(entry.id) && ids.indexOf(entry.id) > at && ids.indexOf(entry.id) < to
    )
  }
}

function applyGate(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  verdict: SessionVerdict,
  receipt: SessionChainVerdictReceipt,
  now: number
): SessionOutcomeVerdictApplication {
  const route = failRouteSeats(access.read(), step, outcome)
  if (verdict.status === 'pass') {
    const problem = mintGateEvidence(access, outcome, step, verdict, receipt, now)
    if (problem) {
      return { refused: problem }
    }
    // A passed gate has nothing to repair, so the repair it would have routed to never runs.
    closeSeats(access, route?.seats ?? [], `not needed: ${step.id} passed`, now)
    return {}
  }
  const reason = sessionOutcomeGateVerdictReason(verdict.status, verdict.blockingFindings)
  // Never a repair and never a pass: the verifier is saying it could not judge at all.
  if (verdict.status === 'insufficient_evidence') {
    return { blocked: { reason, cause: 'insufficient-evidence' } }
  }
  if (!route) {
    return { blocked: { reason, cause: 'gate-failed' } }
  }
  // Route: everything between the gate and its repair is closed, so the run continues at the repair.
  closeSeats(access, route.between, `skipped by the failed gate ${step.id}`, now)
  return {}
}

/**
 * Whether this verdict stops its outcome with nowhere to go: a gate that did not pass and that the
 * plan routes to no repair (or that could not judge at all, which is never routed). Asked BEFORE
 * the verdict is applied, of the same chain the application reads, so both always agree.
 */
export function sessionOutcomeGateDeadEnd(
  chain: SessionChain,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  verdict: Pick<SessionVerdict, 'status'>
): boolean {
  if (step.verdict?.consumed !== 'gate' || verdict.status === 'pass') {
    return false
  }
  return verdict.status === 'insufficient_evidence' || !failRouteSeats(chain, step, outcome)
}

/** Spend one already-receipted verdict: pick the winner, gate what follows, or only record it. */
export function applySessionOutcomeVerdict(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  verdict: SessionVerdict,
  receipt: SessionChainVerdictReceipt,
  now = Date.now()
): SessionOutcomeVerdictApplication {
  if (step.verdict!.consumed === 'select-winner') {
    return applySelectWinner(access, step, verdict, now)
  }
  return step.verdict!.consumed === 'gate'
    ? applyGate(access, outcome, step, verdict, receipt, now)
    : // `record`: the receipt IS the consumption; a later seat reads it.
      {}
}
