import { SESSION_RECOVERY_MAX_AUTO_RETRIES } from '../../shared/session-attempt-recovery'
import { sessionReviewBlockCause } from '../../shared/session-chain-review'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeActionStepId,
  sessionOutcomeStepActionId
} from '../../shared/session-outcome-identity'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { retrySessionOutcomeAttempt } from './session-outcome-attempt-recovery'
import type { OutcomeStepAccess } from './session-outcome-step-progress'

/**
 * A seat that finished without a verdict the host can read is asked again before it is anything
 * else: a missing verdict is not a rejection, and never a question for a person. The bound is the
 * recovery ladder's, counted from the attempts this seat already gave back at this outcome revision
 * and plan version — so a restart, or a second reader of the same round, counts the same number.
 */
export function sessionOutcomeVerdictReasksLeft(
  chain: SessionChain,
  outcome: SessionOutcome,
  stepId: string
): number {
  const planVersion = chain.planVersion ?? 1
  const used = chain.outcomeSet!.attempts.filter(
    (attempt) =>
      attempt.outcomeId === outcome.id &&
      attempt.actionId === sessionOutcomeStepActionId(stepId) &&
      attempt.state === 'retryable' &&
      attempt.outcomeRevision === outcome.revision &&
      (attempt.planVersion ?? 1) === planVersion
  ).length
  return Math.max(0, SESSION_RECOVERY_MAX_AUTO_RETRIES - used)
}

/**
 * The chain with these attempts given back through the ladder's own `retryable` flip, so exactly
 * their seats launch again and the seats beside them keep their results. A seat its round had
 * parked as complete (it finished while a sibling was still running) is reopened with it: a seat
 * left in `completedSteps` is never started, and its round would then never be judged at all.
 */
function givenBack(chain: SessionChain, attempts: readonly SessionOutcomeAttempt[]): SessionChain {
  const reopened = new Set(
    attempts.flatMap((attempt) => sessionOutcomeActionStepId(attempt.actionId) ?? [])
  )
  const set = attempts.reduce(
    (next, attempt) => retrySessionOutcomeAttempt(next, attempt.id, attempt.outcomeId),
    chain.outcomeSet!
  )
  const completedSteps = (set.completedSteps ?? []).filter((id) => !reopened.has(id))
  const currentIndex = chain.steps.findIndex((step) => !completedSteps.includes(step.id))
  return {
    ...chain,
    currentIndex: currentIndex === -1 ? chain.steps.length : currentIndex,
    outcomeSet: { ...set, completedSteps }
  }
}

/** Ask these seats again. Answers whether anything was given back: an attempt this set does not
 * hold as completed cannot be asked again. */
export function reaskSessionOutcomeVerdicts(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  attemptIds: readonly string[]
): boolean {
  const chain = access.read()
  const set = chain.outcomeSet!
  const held = set.attempts.filter(
    (entry) =>
      entry.outcomeId === outcome.id && attemptIds.includes(entry.id) && entry.state === 'completed'
  )
  if (set.completion || !held.length) {
    return false
  }
  access.save(givenBack(chain, held))
  return true
}

/**
 * A person's Resume on a round that stopped for a missing verdict. It is the same re-ask with the
 * bound lifted once: the silent seats give their attempts back, their round reads `reviewing`
 * again, and the outcomes they held are released. A round that stopped for findings is a decision
 * already in front of the person, and is left exactly as it is.
 */
export function resumeSessionReviewVerdicts(chain: SessionChain): SessionChain {
  const set = chain.outcomeSet
  if (!set || set.completion || !chain.reviewLoop) {
    return chain
  }
  const silent = new Set<string>()
  const groups = chain.reviewLoop.groups.map((group) => {
    const judged = group.rounds.find((round) => round.index === group.currentRound)
    if (
      group.status !== 'blocked' ||
      !judged ||
      sessionReviewBlockCause(judged.receipts) !== 'no-verdict'
    ) {
      return group
    }
    for (const receipt of judged.receipts.filter((entry) => entry.status === 'crashed')) {
      silent.add(receipt.stepId)
    }
    return {
      ...group,
      status: 'reviewing' as const,
      rounds: group.rounds.map((round) =>
        round === judged
          ? { ...round, receipts: round.receipts.filter((entry) => entry.status !== 'crashed') }
          : round
      )
    }
  })
  // The attempt each silent seat judged from: its newest completed one.
  const last = new Map<string, SessionOutcomeAttempt>()
  for (const attempt of set.attempts) {
    const stepId = sessionOutcomeActionStepId(attempt.actionId)
    if (stepId && silent.has(stepId) && attempt.state === 'completed') {
      last.set(stepId, attempt)
    }
  }
  if (!last.size) {
    return chain
  }
  return givenBack({ ...chain, reviewLoop: { groups } }, [...last.values()])
}
