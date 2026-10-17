import { sessionOutcomeResultBody as resultBody } from './session-outcome-result'
import {
  executeSessionOutcomeHandoff,
  sessionOutcomeHandoffBlocker
} from './session-outcome-handoff'
import { consumeSessionReviewRepair } from '../../shared/session-chain-review-transition'
import { finishReviewRound, sameReviewRound } from './session-outcome-review-round'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import {
  blockOutcome,
  markSteps,
  setStepStatus,
  type OutcomeStepAccess
} from './session-outcome-step-progress'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'
import { launchStepCohort, sessionOutcomeStepCohort } from './session-outcome-step-cohort'
import { consumeVerdictForStep } from './session-outcome-verdict-hook'
import { sessionAttemptFailureCode } from '../../shared/session-attempt-recovery'
import { isCurrentStoppedAttempt } from './session-outcome-attempt-recovery'
import { sessionOutcomeHoldBlock, type SessionOutcomeHold } from './session-outcome-hold-block'
import {
  sessionOutcomeBarrierStep,
  sessionOutcomeReviewPlanHold,
  sessionOutcomeStepAttempt as stepAttempt
} from './session-outcome-review-plan-hold'

/** What one advance did: `acted` ends a solo outcome's turn; `launched` counts started agents. */
export type SessionOutcomeStepAdvance = { acted: boolean; launched: number }

const IDLE: SessionOutcomeStepAdvance = { acted: false, launched: 0 }
const ACTED: SessionOutcomeStepAdvance = { acted: true, launched: 0 }

/** The step runner's access, with the pass's one clock; absent means the wall clock. */
export type SessionOutcomeStepRunAccess = OutcomeStepAccess & { now?: number }

/**
 * Hold an outcome for a reason that is not a stopped attempt, classified where holds are
 * classified. The requests such a hold asks of a person are opened by the status recompute, which
 * is the one place that may: opening them here too would ask — and announce — twice.
 */
function holdOutcome(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  hold: SessionOutcomeHold,
  now: number
): void {
  const chain = access.read()
  const live = chain.outcomeSet!.outcomes.find((entry) => entry.id === outcome.id) ?? outcome
  const { block } = sessionOutcomeHoldBlock(chain, chain.outcomeSet!, live, hold, now)
  blockOutcome(access, outcome.id, hold.reason.trim() || 'This outcome is held.', block, now)
}

/**
 * Advance one outcome's next step. The step's cohort — its review round, its parallel group, or
 * only itself — starts within `budget`; the seats past the budget are recorded as waiting. A
 * blocked outcome does not block its siblings.
 */
export async function advanceSessionOutcomeSteps(
  access: SessionOutcomeStepRunAccess,
  outcome: SessionOutcome,
  budget = 1
): Promise<SessionOutcomeStepAdvance> {
  let chain = access.read()
  const now = access.now ?? Date.now()
  const step = sessionOutcomeBarrierStep(chain, outcome)
  if (!step) {
    return IDLE
  }
  // The status recompute asks the same question every pass and keeps such an outcome blocked, so
  // this is the guard for a plan that reaches the runner before a recompute has read it.
  const planHold = await sessionOutcomeReviewPlanHold(chain, outcome)
  if (planHold) {
    holdOutcome(access, outcome, planHold, now)
    return ACTED
  }
  if (step.kind === 'handoff') {
    try {
      const held = sessionOutcomeHandoffBlocker(step, now)
      if (held) {
        throw new Error(held)
      }
      const summary = [
        outcome.title,
        ...chain
          .outcomeSet!.attempts.filter(
            (attempt) => attempt.outcomeId === outcome.id && attempt.state === 'completed'
          )
          .map((attempt) => resultBody(access.runtime, attempt))
      ].join('\n\n')
      await executeSessionOutcomeHandoff({
        chain,
        step,
        summary,
        read: access.read,
        save: access.save,
        now
      })
      markSteps(access, [step.id])
    } catch (error) {
      holdOutcome(
        access,
        outcome,
        {
          kind: 'handoff',
          stepId: step.id,
          reason: error instanceof Error ? error.message : String(error)
        },
        now
      )
    }
    return ACTED
  }
  const existing = stepAttempt(chain.outcomeSet!.attempts, step.id)
  if (existing) {
    if (existing.state !== 'completed') {
      // A live attempt's `error` is a diagnostic (a readiness warning, say), never a stop.
      if (existing.state === 'blocked' || existing.state === 'unverifiable') {
        // Why: `blocked` is the only settled failure here — an agent that is merely asking the
        // person something is `running` with `awaiting`, and that step is very much alive. Only
        // the settled one may mark the step failed.
        if (existing.state === 'blocked') {
          setStepStatus(access, step.id, 'failed')
        }
        // A current attempt is the recovery ladder's: the host's next pass settles, replaces or
        // fails it. One from an older revision is nobody's, and reads as the failure it is.
        blockOutcome(
          access,
          outcome.id,
          existing.error ?? 'The action stopped before it finished.',
          isCurrentStoppedAttempt(chain, chain.outcomeSet!, existing)
            ? { class: 'recovering', code: sessionAttemptFailureCode(existing) }
            : undefined,
          now
        )
        return ACTED
      }
      // Cohort seats an earlier budget held back start beside the running one.
      const started = await launchStepCohort(access, access.read(), outcome, step, budget, now)
      return { acted: true, launched: started.launched.length }
    }
    if (step.review) {
      const spent = await consumeVerdictForStep(access, access.read(), outcome, step, existing, now)
      // A refused verdict has blocked the outcome and a re-asked one is not back yet: judging the
      // round now would count the very verdict the consumer turned away.
      if (spent === 'failed' || spent === 'reasked') {
        return ACTED
      }
      await finishReviewRound(access, outcome, step, now)
      return ACTED
    }
    if (step.reviewRepair) {
      // An unchanged candidate was held above; what is left is a repair that did revise it.
      const actual = await sessionOutcomeCandidateVersion(
        chain.workspacePath,
        sessionOutcomeCandidatePaths(outcome, chain)
      )
      const repair = step.reviewRepair
      chain = {
        ...chain,
        reviewLoop: {
          groups: chain.reviewLoop!.groups.map((group) =>
            group.id === repair.groupId
              ? {
                  ...group,
                  rounds: group.rounds.map((round) =>
                    round.index === repair.afterRound ? { ...round, revisedVersion: actual } : round
                  )
                }
              : group
          )
        }
      }
      access.save(chain)
    }
    // Every seat of the cohort that has finished is marked together, so the seat after the group
    // does not wait one tick per sibling for a barrier that is already satisfied.
    const finished = sessionOutcomeStepCohort(chain, outcome, step).filter(
      (member) =>
        member.id === step.id ||
        stepAttempt(chain.outcomeSet!.attempts, member.id)?.state === 'completed'
    )
    // A verdict seat's completion is its DECISION, and the consumer is what records that: it marks
    // its own step once the receipt is persisted, and leaves the step incomplete when the envelope
    // could not be trusted. So this arm marks only the seats the consumer did not speak for —
    // marking a refused verdict seat complete here would put it in `completedSteps` with no
    // receipt, which is exactly what the tick's invariant blocks on.
    const ours: string[] = []
    for (const member of finished) {
      const spent = await consumeVerdictForStep(
        access,
        access.read(),
        outcome,
        member,
        stepAttempt(chain.outcomeSet!.attempts, member.id)!,
        now
      )
      if (spent === 'unwired') {
        ours.push(member.id)
      }
    }
    markSteps(access, ours)
    return ACTED
  }
  if (step.review) {
    const pinned = chain.steps.some(
      (candidate) =>
        sameReviewRound(candidate, step) && stepAttempt(chain.outcomeSet!.attempts, candidate.id)
    )
    if (!pinned) {
      const version = await sessionOutcomeCandidateVersion(
        chain.workspacePath,
        sessionOutcomeCandidatePaths(outcome, chain)
      )
      chain = {
        ...chain,
        steps: chain.steps.map((candidate) =>
          sameReviewRound(candidate, step)
            ? { ...candidate, review: { ...candidate.review!, candidateVersion: version } }
            : candidate
        )
      }
      access.save(chain)
    }
  }
  if (step.reviewRepair) {
    // Unauthorized and already-spent repairs were held above, so this consumption is the launch's.
    chain = {
      ...chain,
      reviewLoop: consumeSessionReviewRepair(chain.reviewLoop!, step.reviewRepair).loop
    }
    access.save(chain)
  }
  const started = await launchStepCohort(access, access.read(), outcome, step, budget, now)
  return { acted: true, launched: started.launched.length }
}
