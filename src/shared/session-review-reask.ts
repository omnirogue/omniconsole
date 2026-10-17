import type { SessionChain } from './session-chain-types'
import type { SessionFollowUpRule } from './session-follow-up-rule'
import {
  SESSION_RUN_SUPERSEDED_MAX,
  type SessionRunReviewFix
} from './session-run-held-continuation'

/**
 * Ask the named recipients of a review again, after the agent fixed what they asked for.
 *
 * The contract both halves of a re-ask agree on (the step's ordinary delivery sends it, on the same
 * thread once the delivery reads `reask` and `round`): the thread is kept, the delivery goes back
 * to `pending` under a FRESH idempotency key, the round goes up by one, and the rule says it is a
 * re-ask. The capture starts over so the summary and files are the fixed version — only the
 * summary's name is kept, so it can arrive as a new version of the same file.
 */
export function reaskSessionFollowUpRecipients(
  rule: SessionFollowUpRule,
  employeeIds: readonly string[],
  mintOperationId: () => string
): SessionFollowUpRule {
  const { capturedAt: _captured, files: _files, summaryMarkdown: _summary, ...kept } = rule
  return {
    ...kept,
    reask: true,
    recipients: rule.recipients.map((recipient) => {
      if (!employeeIds.includes(recipient.employeeId)) {
        return recipient
      }
      const { error: _error, ...rest } = recipient
      return {
        ...rest,
        delivery: 'pending' as const,
        round: (recipient.round ?? 1) + 1,
        operationId: mintOperationId()
      }
    })
  }
}

/**
 * The run after its fix turn ended: the review step is due again for EVERY reviewer of the round,
 * each answer the round counted (`answered`, approvals included) is history — so every condition
 * waits for a new answer on the new version — and each fix is marked as asked again. The retired
 * receipts are also named on the hold, so the verifier cannot find an old answer and count it.
 */
export function reaskSessionReview(
  chain: SessionChain,
  stepId: string,
  fixes: readonly SessionRunReviewFix[],
  answered: readonly string[],
  mintOperationId: () => string,
  now: number
): SessionChain {
  const set = chain.outcomeSet!
  const fixed = new Set(fixes.map((fix) => fix.receipt))
  const retired = new Set([...fixed, ...answered])
  const steps = chain.steps.map((step) =>
    step.id === stepId && step.kind === 'handoff'
      ? {
          ...step,
          status: 'queued' as const,
          handoff: reaskSessionFollowUpRecipients(
            step.handoff,
            step.handoff.recipients.map((recipient) => recipient.employeeId),
            mintOperationId
          )
        }
      : step
  )
  const completedSteps = (set.completedSteps ?? []).filter((id) => id !== stepId)
  const currentIndex = steps.findIndex((step) => !completedSteps.includes(step.id))
  const hold = set.heldContinuation
  // A fixed reply is spent by its own record (`reaskedAt`); only the other answers are named here.
  const superseded = [
    ...new Set([...(hold?.superseded ?? []), ...answered.filter((receipt) => !fixed.has(receipt))])
  ].slice(-SESSION_RUN_SUPERSEDED_MAX)
  return {
    ...chain,
    steps,
    currentIndex: currentIndex === -1 ? steps.length : currentIndex,
    outcomeSet: {
      ...set,
      completedSteps,
      evidenceHistory: [
        ...(set.evidenceHistory ?? []),
        ...set.outcomes.flatMap((outcome) =>
          outcome.evidence.filter((entry) => retired.has(entry.receipt))
        )
      ],
      outcomes: set.outcomes.map((outcome) =>
        outcome.evidence.some((entry) => retired.has(entry.receipt))
          ? {
              ...outcome,
              status: outcome.status === 'satisfied' ? 'pending' : outcome.status,
              evidence: outcome.evidence.filter((entry) => !retired.has(entry.receipt))
            }
          : outcome
      ),
      ...(hold
        ? {
            heldContinuation: {
              ...hold,
              fixes: (hold.fixes ?? []).map((fix) =>
                fixed.has(fix.receipt) ? { ...fix, reaskedAt: now } : fix
              ),
              ...(superseded.length ? { superseded } : {})
            }
          }
        : {})
    }
  }
}
