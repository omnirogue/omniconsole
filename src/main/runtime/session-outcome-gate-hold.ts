import type { SessionVerdict } from '../../shared/session-chain-verdict'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import {
  lastSessionVerdictReceipt,
  sessionVerdictOfReceipt
} from '../../shared/session-chain-verdict-receipts'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'

/**
 * A gate that did not pass, and that the plan routes nowhere, stops its outcome until the owner
 * decides what happens next (`docs/reference/session-run-lifecycle.md`): nothing after it starts,
 * and one decision request stands for as long as the stop does.
 *
 * The stop is recorded where the plan already says "a person must decide first": the gate and
 * every seat after it carry `wait: human_decision`, naming the gate. That is what makes the
 * decision readable from the record alone, on every pass and after a restart — the owner's answer
 * is a plan the stop did not write: a stage it never marked (added or rewritten after the verdict),
 * a redefined outcome (its revision moved on), or a superseding plan version. A commit carries an
 * unchanged step over exactly as the host holds it, so the marks survive one; a new stage has none.
 */
export type SessionOutcomeGateHold = { kind: 'gate'; stepId: string; reason: string }

const COULD_NOT_JUDGE =
  'The verifier could not judge; supply the evidence it named and verify again.'
const DID_NOT_PASS = 'The verification did not pass.'

/** The diagnostic a gate that did not pass leaves on its outcome; the same words on every pass. */
export function sessionOutcomeGateVerdictReason(
  status: SessionVerdict['status'],
  findings: readonly string[]
): string {
  return status === 'insufficient_evidence'
    ? COULD_NOT_JUDGE
    : `${DID_NOT_PASS} ${findings.join(' ')}`.trim()
}

/** The findings a stored verdict carries, read back defensively: the envelope is kept as read. */
export function storedSessionVerdictFindings(verdict: unknown): string[] {
  const findings = (verdict as { blockingFindings?: unknown } | null)?.blockingFindings
  return Array.isArray(findings)
    ? findings.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function heldForGate(step: SessionChainStep | undefined, gateId: string): boolean {
  return Boolean(
    step &&
    step.kind !== 'handoff' &&
    step.wait?.reason === 'human_decision' &&
    step.wait.ref === gateId
  )
}

function agentStepsOf(chain: SessionChain, outcome: SessionOutcome): SessionChainAgentStep[] {
  return (outcome.stepIds ?? []).flatMap((id) => {
    const step = chain.steps.find((entry) => entry.id === id)
    return step && step.kind !== 'handoff' ? [step] : []
  })
}

/** The seats the plan still means to run after this gate; a seat closed without running is not one. */
function seatsAfter(
  chain: SessionChain,
  outcome: SessionOutcome,
  gateId: string
): SessionChainAgentStep[] {
  const seats = agentStepsOf(chain, outcome)
  return seats
    .slice(seats.findIndex((entry) => entry.id === gateId) + 1)
    .filter((entry) => entry.status !== 'skipped')
}

/**
 * Record the stop, in the same write as the verdict receipt that caused it: a host that dies
 * between the two would otherwise come back to a failed gate with nothing held behind it. A seat
 * behind the gate that already finished is marked too, so an unmarked one can only be a stage the
 * owner added afterwards — never one that merely ran before the verdict.
 */
export function holdStepsForGateDecision(
  chain: SessionChain,
  outcome: SessionOutcome,
  gateId: string,
  now: number
): SessionChain {
  const held = new Set([gateId, ...seatsAfter(chain, outcome, gateId).map((entry) => entry.id)])
  return {
    ...chain,
    steps: chain.steps.map((step) =>
      step.kind !== 'handoff' && held.has(step.id)
        ? { ...step, wait: { reason: 'human_decision', since: now, ref: gateId } }
        : step
    )
  }
}

/**
 * Where this gate's stop stands: `standing` until the owner answers it, `decided` once the plan or
 * the outcome moved on past it, undefined for a gate that never stopped the run. A gate at the end
 * of the plan has nothing behind it to mark, so its stop stands until the outcome is redefined or
 * a stage is added after it.
 */
function gateStop(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  gate: SessionChainAgentStep
): 'standing' | 'decided' | undefined {
  const completed = new Set(set.completedSteps ?? [])
  if (gate.verdict?.consumed !== 'gate' || !completed.has(gate.id) || !heldForGate(gate, gate.id)) {
    return undefined
  }
  const receipt = lastSessionVerdictReceipt(chain, gate.id)
  const status = sessionVerdictOfReceipt(receipt)?.status
  if (!status || status === 'pass') {
    return undefined
  }
  const judged = set.attempts.find((entry) => entry.id === receipt?.attemptId)
  const standing =
    (gate.planVersion ?? 1) >= (chain.planVersion ?? 1) &&
    // A verdict about an outcome the owner has since redefined no longer stops it.
    !(judged && judged.outcomeRevision !== outcome.revision) &&
    seatsAfter(chain, outcome, gate.id).every((entry) => heldForGate(entry, gate.id))
  return standing ? 'standing' : 'decided'
}

/** The gates whose stop stands right now, whether or not anything is left for them to hold back. */
function standingGates(chain: SessionChain, set: SessionOutcomeSet): Set<string> {
  return new Set(
    set.outcomes.flatMap((outcome) =>
      agentStepsOf(chain, outcome)
        .filter((step) => gateStop(chain, set, outcome, step) === 'standing')
        .map((step) => step.id)
    )
  )
}

/** The stop this outcome is under, read from the record; undefined once the owner has decided. */
export function sessionOutcomeGateHold(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome
): SessionOutcomeGateHold | undefined {
  const completed = new Set(set.completedSteps ?? [])
  if ((outcome.stepIds ?? []).every((id) => completed.has(id))) {
    // Nothing is left to hold back: an unproven entry is the finished outcome's verification hold.
    return undefined
  }
  const gate = agentStepsOf(chain, outcome).find(
    (step) => gateStop(chain, set, outcome, step) === 'standing'
  )
  if (!gate) {
    return undefined
  }
  const receipt = lastSessionVerdictReceipt(chain, gate.id)
  return {
    kind: 'gate',
    stepId: gate.id,
    reason: sessionOutcomeGateVerdictReason(
      sessionVerdictOfReceipt(receipt)!.status,
      storedSessionVerdictFindings(receipt?.verdict)
    )
  }
}

/**
 * Whether the owner already answered this gate's stop. Its Done When entry stays unproven — the
 * gate never passed — but that failure was asked about once, so the finish does not ask again.
 */
export function sessionOutcomeGateDecided(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome,
  gateId: string
): boolean {
  const gate = agentStepsOf(chain, outcome).find((step) => step.id === gateId)
  return gate ? gateStop(chain, set, outcome, gate) === 'decided' : false
}

/**
 * Take the marks off the seats of a stop that no longer stands, so a decided plan does not read as
 * still waiting for its decision. The gate keeps its own mark: that the question was asked is what
 * keeps it from being asked again. The same chain back when there is nothing to release.
 */
export function releaseDecidedGateWaits(chain: SessionChain, set: SessionOutcomeSet): SessionChain {
  const standing = standingGates(chain, set)
  const completed = new Set(set.completedSteps ?? [])
  const stale = (step: SessionChainStep): boolean =>
    step.kind !== 'handoff' &&
    step.wait?.reason === 'human_decision' &&
    step.wait.ref !== undefined &&
    step.wait.ref !== step.id &&
    !standing.has(step.wait.ref) &&
    // A gate whose verdict is receipted but not yet marked complete (a host that died in between)
    // has not been read as a stop yet: its marks are what the replay will find.
    (completed.has(step.wait.ref) || !chain.steps.some((entry) => entry.id === step.wait!.ref))
  if (!chain.steps.some(stale)) {
    return chain
  }
  return {
    ...chain,
    steps: chain.steps.map((step) => {
      if (step.kind === 'handoff' || !stale(step)) {
        return step
      }
      const { wait: _decided, ...rest } = step
      return rest
    })
  }
}
