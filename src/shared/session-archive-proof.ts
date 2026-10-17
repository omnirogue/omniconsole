import type { SessionChain } from './session-chain-types'
import { sessionOutcomeConditionKey } from './session-outcome-types'
import { sessionReviewReceiptReply } from './session-run-held-continuation'

/** Stable receipt identity: temporary host contact/ownership loss is not a new commitment. */
export function sessionCompletionIdentity(chain: SessionChain): string | null {
  const seal = chain.outcomeSet?.completion
  return seal
    ? JSON.stringify([chain.id, seal.planVersion ?? 1, seal.at, seal.outcomes, seal.evidenceIds])
    : null
}

/** A delivered draft is not a decision. Current and older hosts seal these as done-for-review. */
export function sessionStillNeedsOwnerReview(chain: SessionChain): boolean {
  return (
    chain.outcomeSet?.outcomes.some((outcome) =>
      outcome.evidence.some((entry) => entry.receipt.startsWith('done-for-review:'))
    ) ?? false
  )
}

/** Whole recorded commitment, not a successful turn, idle pane, or a completion sentence. */
export function sessionCommitmentProof(chain: SessionChain): string | null {
  const set = chain.outcomeSet
  const seal = set?.completion
  if (
    chain.state !== 'done' ||
    chain.quarantine ||
    !set ||
    !seal ||
    !set.outcomes.length ||
    !seal.evidenceIds.length ||
    set.continuation.state !== 'owned' ||
    !set.continuation.sourceVersion ||
    set.heldContinuation ||
    sessionStillNeedsOwnerReview(chain) ||
    set.attention?.some((request) => request.state === 'open') ||
    (seal.planVersion ?? 1) !== (chain.planVersion ?? 1) ||
    seal.outcomes.length !== set.outcomes.length ||
    set.attempts.some((attempt) => !['completed', 'superseded'].includes(attempt.state))
  ) {
    return null
  }
  for (const outcome of set.outcomes) {
    if (
      outcome.status !== 'satisfied' ||
      !outcome.conditions.length ||
      outcome.conditions.every((condition) => ['session', 'handoff'].includes(condition.kind)) ||
      !seal.outcomes.some(
        (entry) => entry.id === outcome.id && entry.revision === outcome.revision
      ) ||
      outcome.dependsOn.some(
        (id) => !set.outcomes.some((entry) => entry.id === id && entry.status === 'satisfied')
      ) ||
      outcome.conditions.some(
        (condition) =>
          !outcome.evidence.some(
            (entry) =>
              entry.outcomeId === outcome.id &&
              entry.outcomeRevision === outcome.revision &&
              entry.conditionId === condition.id &&
              entry.conditionKey === sessionOutcomeConditionKey(condition) &&
              entry.verifier === 'execution-host' &&
              (condition.kind !== 'pr' || entry.receipt.endsWith(':merged')) &&
              (condition.kind !== 'review' ||
                (condition.version && entry.receipt === `user-review:${condition.version}`) ||
                sessionReviewReceiptReply(entry.receipt)?.decision === 'approve') &&
              seal.evidenceIds.includes(entry.id)
          )
      )
    ) {
      return null
    }
  }
  return sessionCompletionIdentity(chain)
}

/** Saving/closing is a separate choice; automatic archive never competes with that choice. */
export function sessionArchiveProof(chain: SessionChain): string | null {
  const set = chain.outcomeSet
  if (
    (set?.sessionFinish && set.sessionFinish.action !== 'end') ||
    set?.disposition?.state !== 'applied' ||
    set.disposition.intent !== 'completed'
  ) {
    return null
  }
  return sessionCommitmentProof(chain)
}
