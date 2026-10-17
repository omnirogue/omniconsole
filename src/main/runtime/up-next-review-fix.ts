/**
 * A reviewer's "needs changes", acted on by the host — once per reply, in the run's own lane.
 *
 * A reply asking for changes releases nothing held behind the review, and finishes no run that
 * holds nothing: every ticked Review gates its run (`up-next-held-gates.ts`). Once every reviewer
 * of the round has answered, the notes of every such reply go to THIS conversation's own agent as
 * one prompt — the prompt queue's own record through the person's own send door
 * (`conversation-prompt-now.ts`), sent when the agent's last turn has ended — and when the turn
 * that answers it ends, EVERY reviewer of the round is asked again on the fixed version
 * (`session-review-reask.ts`): an approval counts only for the work it approved.
 *
 * Exactly once across ticks and restarts, because each step is durable before the next: a reply
 * becomes a fix record keyed by its receipt; the prompt id and the ending it follows are saved
 * before the prompt is admitted; the queue's `sending` receipt is flushed before a byte moves.
 * A send whose result is unknown — a restart mid-send, or bytes that moved — is settled as failed
 * and never sent again; a send the door refused before any byte moved is sent again, under a new
 * prompt id, as a refusal that goes stale like any other.
 */

import { createHash, randomUUID } from 'node:crypto'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import {
  openSessionReviewFixes,
  type SessionRunReviewFix
} from '../../shared/session-run-held-continuation'
import { reaskSessionReview } from '../../shared/session-review-reask'
import { observeConversationReadiness } from './conversation-readiness'
import { sendConversationPromptNow } from './conversation-prompt-now'
import type { OrcaRuntimeService } from './omni-runtime'
import { isPromptQueueSendingOnConversation } from './prompt-queue-drain'
import { sameConversationSource } from './session-outcome-conversation-turn'
import {
  clearUpNextContinuationRefusal,
  recordUpNextContinuationRefusal,
  upNextHeldContinuation,
  upNextUnfinishedBesideReview
} from './up-next-held-gates'
import { upNextReviewAnswered, upNextReviewAnswers } from './up-next-person-facts'
import { upNextReviewNote } from './up-next-review-brief'

export type UpNextReviewFixAccess = {
  runtime: OrcaRuntimeService
  read: () => SessionChain
  save: (chain: SessionChain) => void
  /** This host's epoch: the prompt queue's receipt names the process that sent it. */
  epoch: string
  /** The pass's clock. */
  now: number
}

export const UP_NEXT_REVIEW_FIX_NO_CONVERSATION =
  'The conversation this work belongs to is no longer open, so the reviewer’s notes cannot be given to its agent.'
export const UP_NEXT_REVIEW_FIX_UNDELIVERED =
  'The reviewer’s notes could not be given to the agent.'

function reviewStep(chain: SessionChain, stepId: string): SessionChainHandoffStep | undefined {
  const step = chain.steps.find((entry) => entry.id === stepId)
  return step?.kind === 'handoff' ? step : undefined
}

function withFixes(
  chain: SessionChain,
  stepId: string,
  update: (fixes: SessionRunReviewFix[]) => SessionRunReviewFix[]
): SessionChain {
  const set = chain.outcomeSet!
  const hold = set.heldContinuation
  // The gates, the stale clock and the refusal are the terminal writer's to derive; fixes are ours.
  return {
    ...chain,
    outcomeSet: {
      ...set,
      heldContinuation: {
        ...hold,
        reviewStepIds: hold?.reviewStepIds ?? [stepId],
        fixes: update(hold?.fixes ?? [])
      }
    }
  }
}

/** Every "needs changes" reply to this review that the run has no record of yet, with its note. */
async function recordChangeRequests(access: UpNextReviewFixAccess, stepId: string): Promise<void> {
  const chain = access.read()
  const step = reviewStep(chain, stepId)
  const known = new Set((chain.outcomeSet?.heldContinuation?.fixes ?? []).map((fix) => fix.receipt))
  const asked = upNextReviewAnswers(chain, stepId).filter(
    (answer) => answer.decision === 'request_changes' && !known.has(answer.receipt)
  )
  if (!step || !asked.length) {
    return
  }
  const added: SessionRunReviewFix[] = []
  for (const answer of asked) {
    // A reply is never acted on without its words: an unreadable note refuses, and is asked again.
    const note = await upNextReviewNote(answer.receipt)
    added.push({
      receipt: answer.receipt,
      stepId,
      employeeId: answer.employeeId,
      round:
        step.handoff.recipients.find((person) => person.employeeId === answer.employeeId)?.round ??
        1,
      ...(note ? { note } : {}),
      at: access.now
    })
  }
  clearUpNextContinuationRefusal(access.runtime, chain.id, stepId)
  access.save(withFixes(access.read(), stepId, (fixes) => [...fixes, ...added]))
}

function fixPrompt(
  step: SessionChainHandoffStep,
  fixes: readonly SessionRunReviewFix[],
  holdsWork: boolean
): string {
  const name = (fix: SessionRunReviewFix): string =>
    step.handoff.recipients.find((person) => person.employeeId === fix.employeeId)?.name ??
    fix.employeeId
  const people = [...new Set(step.handoff.recipients.map((person) => person.name))].join(' and ')
  return [
    // Why two wordings: a last-block review holds no queued work, only the run's own finish.
    holdsWork
      ? 'Changes were requested in review. The work queued after that review waits until they are made.'
      : 'Changes were requested in review. This work is not finished until they approve the new version.',
    ...fixes.flatMap((fix) => [
      '',
      `${name(fix)} asked for changes (round ${fix.round}):`,
      fix.note ?? 'They did not write a note.'
    ]),
    '',
    `Make these changes here. When this turn ends, ${people} will be asked to review the new version.`
  ].join('\n')
}

/** The notes' prompt id: one per batch of replies, and a new one after a send that moved nothing. */
function fixPromptId(batch: readonly SessionRunReviewFix[], after?: string): string {
  const key = [...batch.map((fix) => fix.receipt), ...(after ? [after] : [])].join('\n')
  return `review-fix-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

/** What the prompt queue says became of the notes, written onto every fix they carried. */
function settleFixes(
  access: UpNextReviewFixAccess,
  stepId: string,
  promptId: string,
  entry: PromptQueueEntry | undefined
): void {
  const outcome: Partial<SessionRunReviewFix> =
    entry?.state === 'delivered'
      ? { deliveredAt: entry.deliveredAt ?? access.now }
      : { failed: (entry?.reason ?? UP_NEXT_REVIEW_FIX_UNDELIVERED).slice(0, 1_000) }
  access.save(
    withFixes(access.read(), stepId, (fixes) =>
      fixes.map((fix) => (fix.promptId === promptId ? { ...fix, ...outcome } : fix))
    )
  )
}

async function advanceFix(access: UpNextReviewFixAccess, stepId: string): Promise<void> {
  const chain = access.read()
  const step = reviewStep(chain, stepId)
  const open = openSessionReviewFixes(chain.outcomeSet?.heldContinuation).filter(
    (fix) => fix.stepId === stepId
  )
  // Everyone of the round answers first, so the agent fixes what all of them asked for, once.
  if (
    !step ||
    !open.length ||
    open.some((fix) => fix.failed) ||
    !upNextReviewAnswered(chain, stepId) ||
    upNextUnfinishedBesideReview(chain)
  ) {
    return
  }
  const source = sameConversationSource(access.runtime, chain)
  if (!source) {
    throw new Error(UP_NEXT_REVIEW_FIX_NO_CONVERSATION)
  }
  const readiness = await observeConversationReadiness(access.runtime, source)
  if (readiness.unverifiable) {
    throw new Error(readiness.reason ?? UP_NEXT_REVIEW_FIX_NO_CONVERSATION)
  }
  // Every way out of this pass but a send clears a refusal; a send clears it only once it lands,
  // so a door that keeps refusing keeps one refusal, and its clock (`up-next-held-gates.ts`).
  const clearRefusal = (): void => clearUpNextContinuationRefusal(access.runtime, chain.id, stepId)
  const sent = open.find((fix) => fix.promptId)
  const batch = sent ? open.filter((fix) => fix.promptId === sent.promptId) : open
  if (sent?.deliveredAt !== undefined) {
    clearRefusal()
    // The fix turn is the NEXT ending of this conversation after the one the notes followed.
    if (
      readiness.ready &&
      readiness.version &&
      readiness.version.slice(0, 500) !== sent.turnVersion
    ) {
      const current = access.read()
      // OWNER-EQUIVALENT DECISION (2026-09-18): an approval counts only for the work it approved.
      // The fix turn changed the work, so EVERY reviewer of this round is asked again (round + 1,
      // same thread, fresh key) and every answer of the round, approvals included, becomes
      // history: the held work waits for each person's approval of THIS version.
      const retired = upNextReviewAnswers(current, stepId).map((answer) => answer.receipt)
      access.save(reaskSessionReview(current, stepId, batch, retired, randomUUID, access.now))
    }
    return
  }
  const rowKey = conversationSourceRowKey(source)
  const entry = sent
    ? access.runtime.readPromptQueue(rowKey)?.entries.find((row) => row.id === sent.promptId)
    : undefined
  if (sent?.promptId && (entry?.state === 'delivered' || entry?.state === 'failed')) {
    clearRefusal()
    settleFixes(access, stepId, sent.promptId, entry)
    return
  }
  // Sending right now, or a send a restart left behind that the queue drain settles as unconfirmed.
  if (entry?.state === 'sending') {
    return
  }
  // A finished turn with an identity: that ending is what the fix turn is told apart from.
  if (
    !readiness.ready ||
    !readiness.version ||
    isPromptQueueSendingOnConversation(access.runtime, source)
  ) {
    clearRefusal()
    return
  }
  const promptId = sent?.promptId ?? fixPromptId(batch)
  const turnVersion = readiness.version.slice(0, 500)
  // Durable before the prompt is admitted: a restart knows which prompt, and which ending it follows.
  access.save(
    withFixes(access.read(), stepId, (fixes) =>
      fixes.map((fix) =>
        batch.some((own) => own.receipt === fix.receipt) ? { ...fix, promptId, turnVersion } : fix
      )
    )
  )
  const holdsWork = (access.runtime.readUpNextDrafts?.(chain.sourceRowKey)?.entries ?? []).some(
    (entry) => entry.held?.reviewStepId === stepId
  )
  const result = await sendConversationPromptNow(
    access.runtime,
    source,
    { id: promptId, text: fixPrompt(step, batch, holdsWork) },
    access.epoch
  )
  if (result.notSent) {
    // Nothing moved: the entry is withdrawn and the notes get a new prompt id, sent next pass.
    access.runtime.removePromptQueueEntry(rowKey, promptId)
    const next = fixPromptId(batch, promptId)
    access.save(
      withFixes(access.read(), stepId, (fixes) =>
        fixes.map((fix) => (fix.promptId === promptId ? { ...fix, promptId: next } : fix))
      )
    )
    throw new Error(result.entry?.reason ?? UP_NEXT_REVIEW_FIX_UNDELIVERED)
  }
  clearRefusal()
  settleFixes(access, stepId, promptId, result.entry)
}

/**
 * One pass over the person reviews that hold this run — work held behind them or not. It never
 * throws: a step it cannot take is the run's `refused` state (recovering, then failed), asked
 * again next pass.
 */
export async function advanceUpNextHeldReviews(access: UpNextReviewFixAccess): Promise<void> {
  const chain = access.read()
  // A sealed run is final: a reply an older build sealed it on is not acted on now.
  if (chain.outcomeSet?.completion) {
    return
  }
  const held = upNextHeldContinuation(access.runtime, chain, access.runtime.listSessionChains())
  for (const stepId of held?.reviewStepIds ?? []) {
    try {
      await recordChangeRequests(access, stepId)
      await advanceFix(access, stepId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      recordUpNextContinuationRefusal(access.runtime, chain.id, stepId, reason, access.now)
      console.warn('[up-next] review notes not handed over yet', chain.id, error)
    }
  }
}
