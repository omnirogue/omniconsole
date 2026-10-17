import { parseSessionVerdict, type SessionVerdict } from '../../shared/session-chain-verdict'
import {
  isVerifyGateStep,
  readSessionVerdictChecks,
  sessionVerdictCheckGaps
} from '../../shared/session-chain-verdict-checks'
import {
  recordSessionVerdictReceipt,
  sessionVerdictConsumptionKey,
  verdictInvariantProblems
} from '../../shared/session-chain-verdict-receipts'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStepVerdict,
  SessionChainVerdictReceipt
} from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'
import { sessionOutcomeResultBody as resultBody } from './session-outcome-result'
import {
  blockOutcome,
  markSteps,
  setStepStatus,
  type OutcomeStepAccess
} from './session-outcome-step-progress'
import type { SessionOutcomeBlockInput } from '../../shared/session-outcome-block'
import {
  applySessionOutcomeVerdict,
  sessionOutcomeGateDeadEnd
} from './session-outcome-verdict-apply'
import { holdStepsForGateDecision } from './session-outcome-gate-hold'
import { blockOutcomeForReading } from './session-outcome-hold-write'
import { VERDICT_RECEIPT_MISSING_BLOCK } from './session-outcome-verdict-invariant'
import {
  reaskSessionOutcomeVerdicts,
  sessionOutcomeVerdictReasksLeft
} from './session-outcome-verdict-reask'
import { sessionOutcomeGateFailureHold } from './session-outcome-verification-hold'

/**
 * `applied` spent the verdict, `replayed` found it already spent, `failed` refused it: the seat is
 * failed and the outcome blocked. `reasked` gave the attempt back, because the seat returned nothing
 * the host can read and may still be asked again. There is no silent pass — a verdict the host
 * cannot read never counts, and a missing one is never worded as a rejection.
 */
export type SessionOutcomeVerdictConsumption = 'applied' | 'replayed' | 'failed' | 'reasked'

const UNREADABLE =
  'This verdict seat returned no verdict line the host can read. A missing or malformed verdict never passes.'
const AMBIGUOUS =
  'This report carries more than one verdict line. A verdict is the final line of a report and appears exactly once.'
const IDENTITY =
  'This verdict identity differs from its attempt. Re-run the seat and let it issue its own verdict.'
const LEGACY_GATE =
  'This verify receipt has no check for every Done When line. Add Verify again so each line is checked.'
const CANDIDATE_MOVED =
  'The candidate changed while it was being judged. Reconcile the revision before continuing.'

type Refusal = { access: OutcomeStepAccess; outcome: SessionOutcome; step: SessionChainAgentStep }

function refuse(
  at: Refusal,
  reason: string,
  block: SessionOutcomeBlockInput,
  now: number
): SessionOutcomeVerdictConsumption {
  setStepStatus(at.access, at.step.id, 'failed')
  blockOutcome(at.access, at.outcome.id, reason, block, now)
  return 'failed'
}

/**
 * What the SEAT returned is at fault, so the seat is asked again first, within the ladder's bound;
 * only then is it an honest failure. Never a request: no person can supply another agent's verdict.
 */
function reaskOrRefuse(
  at: Refusal,
  attempt: SessionOutcomeAttempt,
  reason: string,
  now: number
): SessionOutcomeVerdictConsumption {
  if (
    sessionOutcomeVerdictReasksLeft(at.access.read(), at.outcome, at.step.id) > 0 &&
    reaskSessionOutcomeVerdicts(at.access, at.outcome, [attempt.id])
  ) {
    return 'reasked'
  }
  return refuse(at, reason, { class: 'failed', code: 'verdict-unreadable' }, now)
}

/** A stored gate receipt that does not carry a valid check for every line it decides. */
function storedLinesProblem(over: readonly string[], verdict: unknown): boolean {
  if (!over.length) {
    return false
  }
  const checks = readSessionVerdictChecks((verdict as { checks?: unknown } | null)?.checks)
  return !checks || sessionVerdictCheckGaps(over, checks).missing.length > 0
}

/** A verify gate answers every Done When line it was given, by id, and nothing else. */
function perLineProblem(
  over: readonly string[],
  verdict: SessionVerdict
): { reason: string; plan: boolean } | null {
  if (!over.length) {
    return null
  }
  const gaps = sessionVerdictCheckGaps(over, verdict.checks)
  if (gaps.missing.length) {
    return {
      plan: false,
      reason: `This verify verdict gives no pass, fail or unknown for ${gaps.missing.join(', ')}. Check every Done When line yourself and report each one in "checks".`
    }
  }
  return gaps.unknown.length
    ? {
        plan: false,
        reason: `This verify verdict checks ${gaps.unknown.join(', ')}, which it was not asked to decide.`
      }
    : null
}

/**
 * A judge ranges over the seats it read; a gate ranges over the Done When entries it decides.
 * `plan` problems are the plan's own wiring and no re-run fixes them; the rest are what the seat said.
 */
function scopeProblem(
  declared: SessionChainStepVerdict,
  verdict: SessionVerdict,
  outcome: SessionOutcome,
  chain: SessionChain
): { reason: string; plan: boolean } | null {
  const over = new Set(declared.over)
  const named = [verdict.winnerId, ...(verdict.ranking ?? [])].filter(
    (id): id is string => typeof id === 'string'
  )
  const outside = named.find((id) => !over.has(id))
  if (outside) {
    return {
      plan: false,
      reason: `This verdict names ${outside}, which is not one of the things it judges.`
    }
  }
  if (declared.consumed === 'gate') {
    const stated = new Set(outcome.conditions.map((condition) => condition.id))
    const unknown = declared.over.find((id) => !stated.has(id))
    if (unknown) {
      return {
        plan: true,
        reason: `This gate decides ${unknown}, which is not one of this outcome's done-when entries.`
      }
    }
    return declared.kind === 'verify' ? perLineProblem(declared.over, verdict) : null
  }
  const missing = declared.over.find((id) => !chain.steps.some((entry) => entry.id === id))
  if (missing) {
    return {
      plan: true,
      reason: `This verdict judges ${missing}, which is not a step of this plan.`
    }
  }
  if (declared.consumed !== 'select-winner') {
    return null
  }
  const scored = verdict.scores?.map((entry) => entry.candidateId) ?? []
  const complete =
    scored.length === declared.over.length && declared.over.every((id) => scored.includes(id))
  return complete && verdict.winnerId
    ? null
    : {
        plan: false,
        reason:
          'This verdict picks a winner without scoring every candidate exactly once. Score each candidate with a distinct whole number and name the highest.'
      }
}

/**
 * The one consumer of a verdict seat, called from the completed-attempt arm of
 * `advanceSessionOutcomeSteps`. Order matters and is the point of the function: parse, bind the
 * envelope to the attempt that issued it, re-pin the candidate, check the verdict ranges over what
 * the plan said it would, PERSIST the receipt, and only then act on it.
 */
export async function consumeSessionOutcomeVerdict(
  access: OutcomeStepAccess,
  chain: SessionChain,
  outcome: SessionOutcome,
  step: SessionChainAgentStep,
  attempt: SessionOutcomeAttempt,
  now = Date.now()
): Promise<SessionOutcomeVerdictConsumption> {
  const at: Refusal = { access, outcome, step }
  const declared = step.verdict
  if (!declared) {
    return refuse(
      at,
      'This step carries no verdict for the host to consume.',
      { class: 'failed', code: 'verdict-unwired' },
      now
    )
  }
  const key = sessionVerdictConsumptionKey(step.id, attempt.id)
  const stored = (access.read().verdicts ?? []).find((entry) => entry.consumptionKey === key)
  if (stored) {
    // A gate receipt written before per-line checks is never replayed as decided.
    if (isVerifyGateStep(step) && storedLinesProblem(declared.over, stored.verdict)) {
      return refuse(at, LEGACY_GATE, { class: 'failed', code: 'verdict-unreadable' }, now)
    }
    markSteps(access, [step.id])
    return 'replayed'
  }
  const parsed = parseSessionVerdict(resultBody(access.runtime, attempt))
  if (parsed === null || parsed === 'ambiguous') {
    return reaskOrRefuse(at, attempt, parsed === 'ambiguous' ? AMBIGUOUS : UNREADABLE, now)
  }
  const pinned = step.review?.candidateVersion
  const actual = await sessionOutcomeCandidateVersion(
    chain.workspacePath,
    sessionOutcomeCandidatePaths(outcome, chain),
    { folderPin: isVerifyGateStep(step) }
  )
  if (pinned && pinned !== actual) {
    // A review seat keeps its round's pin, so asking it again would judge the same moved bytes.
    return refuse(at, CANDIDATE_MOVED, { class: 'failed', code: 'review-candidate-changed' }, now)
  }
  // Identity binding (hub `canonical_contract.py:1542-1600`): a marker copied from a candidate
  // carries that candidate's seat and attempt, and a candidate cannot know the judge's attempt id.
  if (
    parsed.stepId !== step.id ||
    parsed.attemptId !== attempt.id ||
    parsed.candidateVersion !== (pinned ?? actual)
  ) {
    // A seat pinned at launch is pinned again when it is asked again, so a moved candidate clears.
    return reaskOrRefuse(at, attempt, IDENTITY, now)
  }
  const scope = scopeProblem(declared, parsed, outcome, access.read())
  if (scope) {
    return scope.plan
      ? refuse(at, scope.reason, { class: 'failed', code: 'verdict-plan-scope' }, now)
      : reaskOrRefuse(at, attempt, scope.reason, now)
  }
  const receipt: SessionChainVerdictReceipt = {
    stepId: step.id,
    attemptId: attempt.id,
    verdict: parsed,
    consumptionKey: key,
    consumedAt: now
  }
  const before = access.read()
  const recorded = recordSessionVerdictReceipt(before, receipt)
  if (recorded.replayed) {
    markSteps(access, [step.id])
    return 'replayed'
  }
  // A gate that stops its outcome with nowhere to go holds the seats behind it in the same write
  // as its receipt, so a host that dies before acting on it still comes back to the stop.
  access.save(
    sessionOutcomeGateDeadEnd(before, outcome, step, parsed)
      ? holdStepsForGateDecision(recorded.chain, outcome, step.id, now)
      : recorded.chain
  )
  const applied = applySessionOutcomeVerdict(access, outcome, step, parsed, receipt, now)
  if (applied.refused) {
    return refuse(at, applied.refused, { class: 'failed', code: 'verdict-not-applied' }, now)
  }
  markSteps(access, [step.id])
  if (applied.blocked?.cause === 'gate-failed') {
    // A real decision with nowhere to go: the plan names no repair, so the owner chooses one. The
    // status recompute re-derives this same request on every pass — from the stop recorded above
    // while stages remain, from the unproven entry once none do — so it is asked exactly once.
    blockOutcomeForReading(
      access,
      outcome.id,
      applied.blocked.reason,
      sessionOutcomeGateFailureHold(access.read(), outcome, step.id, parsed.blockingFindings),
      now
    )
    return 'applied'
  }
  if (applied.blocked) {
    blockOutcome(
      access,
      outcome.id,
      applied.blocked.reason,
      { class: 'failed', code: 'review-insufficient-evidence' },
      now
    )
    return 'applied'
  }
  const problems = verdictInvariantProblems(access.read())
  if (problems.length) {
    blockOutcome(access, outcome.id, problems[0]!, VERDICT_RECEIPT_MISSING_BLOCK, now)
  }
  return 'applied'
}
