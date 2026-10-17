import type { SessionChain, SessionChainHandoffStep, SessionChainStep } from './session-chain-types'
import { sessionFollowUpDisposition } from './session-follow-up-rule'
import type { SessionOutcomeCondition } from './session-outcome-types'

type Steps = Pick<SessionChain, 'steps'> | null | undefined

/** A ticked Review ("Wait for their OK") that is, or will be, asked: one a newer ask can replace. */
export function isSessionReviewAsk(step: SessionChainStep): step is SessionChainHandoffStep {
  return (
    step.kind === 'handoff' &&
    // A retired ask is never delivered, so it cannot be the one they answer.
    step.status !== 'skipped' &&
    sessionFollowUpDisposition(step.handoff) === 'feedback'
  )
}

/**
 * Which ask of a named person their review answers NOW (`docs/reference/session-run-lifecycle.md`).
 *
 * One person has ONE `review` condition on the Outcome however often they are asked, so a second
 * ticked Review of the same person — released into the same run after the first — replaces the
 * first ask: their condition is read from the newest ask's own thread, an answer that came back to
 * an older ask is history (`session-outcome-verification.ts`), and the older ask gates nothing
 * (`up-next-person-facts.ts`). The verifier, the retirement and the gate read this one answer.
 *
 * Only the asks among `stepIds` — the steps of the Outcome that owns the condition — are read: a
 * Review of the same person that another Outcome asks is that Outcome's, and replaces nothing
 * here. Without `stepIds` (an Outcome that names no steps) the whole run is read.
 */
export function sessionReviewLatestAsk(
  chain: Steps,
  employeeId: string,
  stepIds?: readonly string[]
): SessionChainHandoffStep | undefined {
  let latest: SessionChainHandoffStep | undefined
  for (const step of chain?.steps ?? []) {
    if (
      isSessionReviewAsk(step) &&
      (!stepIds || stepIds.includes(step.id)) &&
      step.handoff.recipients.some((person) => person.employeeId === employeeId) &&
      // Why `>=`: equal stamps are read in plan order, the later step being the later ask.
      (!latest || step.handoff.savedAt >= latest.handoff.savedAt)
    ) {
      latest = step
    }
  }
  return latest
}

/**
 * The hub thread a named person's condition is read from: the thread it names, else — for a
 * review — the thread their newest ask among `stepIds` (the owning Outcome's steps) reached them
 * on, none before that request was delivered. A record with no ticked Review of theirs there is
 * read as it always was: the first request that reached them.
 */
export function sessionPersonConditionThread(
  chain: Steps,
  condition: Pick<SessionOutcomeCondition, 'kind' | 'target' | 'recipientId'>,
  stepIds?: readonly string[]
): string | undefined {
  if (condition.target.startsWith('hth_')) {
    return condition.target
  }
  const ask =
    condition.kind === 'review' && condition.recipientId
      ? sessionReviewLatestAsk(chain, condition.recipientId, stepIds)
      : undefined
  const person = ask
    ? ask.handoff.recipients.find((entry) => entry.employeeId === condition.recipientId)
    : chain?.steps
        .flatMap((step) => (step.kind === 'handoff' ? step.handoff.recipients : []))
        .find((entry) => entry.employeeId === condition.recipientId && entry.delivery === 'sent')
  return person?.delivery === 'sent' ? person.threadId : undefined
}
