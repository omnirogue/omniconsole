import type { SessionChain } from './session-chain-types'

export const SESSION_OUTCOME_HOST_REVIEW_REASON =
  'These reviewers check work that already finished in this session. The hub can only review a stage it ran itself, so this host runs the reviewers and records their verdicts.'

/**
 * Why a card-attached plan runs on this host's executor instead of an admitted hub workflow,
 * derived from the saved plan so no new persisted field reaches older clients.
 */
export function sessionOutcomeHostRouteReason(
  chain: Pick<SessionChain, 'steps' | 'outcomeSet'>
): string | null {
  const set = chain.outcomeSet
  if (!set?.continuation?.taskId || set.workflow || set.workflowHistory?.length) {
    return null
  }
  // #284 (720690b3e) taught the hub to name a captured source snapshot as the review predecessor,
  // so once that snapshot exists this plan is admissible and the host route no longer applies.
  if (set.continuation.initialSource) {
    return null
  }
  // An outcome whose first agent work is a review has no admitted producer to attach it to.
  const reviewFirst = set.outcomes.some((outcome) => {
    const first = (outcome.stepIds ?? [])
      .map((id) => chain.steps.find((step) => step.id === id))
      .find((step) => step && step.kind !== 'handoff')
    return Boolean(first && first.kind !== 'handoff' && first.review)
  })
  return reviewFirst ? SESSION_OUTCOME_HOST_REVIEW_REASON : null
}
