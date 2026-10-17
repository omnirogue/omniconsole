import type { SessionChain } from './session-chain-types'
import { sessionReviewReceiptReply } from './session-run-held-continuation'

export type SessionSealWake = 'merge' | 'review' | 'handoff'

/**
 * What a sealed run still waits on outside its conversation, or null when its seal leaves nothing
 * for anyone else: a PR receipt that has not reached `:merged`, a review another party answered
 * with anything but approve, or an outcome whose only conditions are a handoff and the source
 * turn. The owner's own `done-for-review:` receipt is where finished work goes, not a wait
 * (Sal, 2026-09-19), and a seal with no receipt at all is simply unproven, which is Done.
 */
export function sessionSealAwaitsOthers(chain: SessionChain): SessionSealWake | null {
  const set = chain.outcomeSet
  if (!set?.completion) {
    return null
  }
  for (const outcome of set.outcomes) {
    if (
      outcome.conditions.some((condition) => condition.kind === 'handoff') &&
      outcome.conditions.every(
        (condition) => condition.kind === 'handoff' || condition.kind === 'session'
      )
    ) {
      return 'handoff'
    }
    for (const condition of outcome.conditions) {
      const receipts = outcome.evidence.filter(
        (entry) => entry.outcomeId === outcome.id && entry.conditionId === condition.id
      )
      if (condition.kind === 'pr' && receipts.some((entry) => !entry.receipt.endsWith(':merged'))) {
        return 'merge'
      }
      if (
        condition.kind === 'review' &&
        receipts.some((entry) => {
          const reply = sessionReviewReceiptReply(entry.receipt)
          return reply !== null && reply.decision !== 'approve'
        })
      ) {
        return 'review'
      }
    }
  }
  return null
}
