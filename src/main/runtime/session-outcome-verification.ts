import type { SessionChain } from '../../shared/session-chain-types'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import {
  sessionOutcomeConditionKey,
  type SessionOutcome,
  type SessionOutcomeCondition,
  type SessionOutcomeSet
} from '../../shared/session-outcome-types'
import { sessionPersonConditionThread } from '../../shared/session-review-ask'
import { sessionReviewReceiptReply } from '../../shared/session-run-held-continuation'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  sessionOutcomeVerifiedEvidence,
  verifySessionOutcomeCondition
} from './session-outcome-evidence'
import { sessionOutcomeReviewVersion } from './session-outcome-review-version'
import {
  sessionOutcomeReadEveryPass,
  withSessionOutcomeWaitFact
} from './session-outcome-wait-facts'

/** The receipt of an owner's review the run did not wait for: the result went to Done as-is. */
export const SESSION_OUTCOME_DONE_FOR_REVIEW = 'done-for-review:'
import { sessionOutcomePlanVersion } from '../../shared/session-outcome-plan-state'
import { blockedSessionOutcome } from './session-outcome-hold-write'
import { restoreEarnedSourceReceipt, restoreGrantedReview } from './session-outcome-earned-proof'
import { inconclusiveSessionOutcomeVerification } from './session-outcome-session-evidence'
import {
  SESSION_OUTCOME_AWAITING_EVIDENCE,
  SESSION_OUTCOME_OWN_REVIEW_REQUIRED,
  SESSION_OUTCOME_VERIFICATION_ERROR
} from './session-outcome-verification-hold'

const pollTimes = new WeakMap<OrcaRuntimeService, Map<string, number>>()

/**
 * A named person's review receipt read from a thread their condition no longer reads — a newer ask
 * of theirs replaced the one it answered (`session-review-ask.ts`) — moves to history, so their
 * answer is read again from the newest ask's own thread. A receipt read from that thread is never
 * retired while it stays the one read, so this cannot repeat on every pass.
 */
function retireStaleReviewReceipt(
  chain: SessionChain,
  outcomeId: string,
  condition: SessionOutcomeCondition
): SessionOutcomeSet {
  const set = chain.outcomeSet!
  const owner = set.outcomes.find((entry) => entry.id === outcomeId)!
  const prior = owner.evidence.find((entry) => entry.conditionId === condition.id)
  // Why only a hub reply: another receipt names no thread, so nothing says it answered an older ask.
  const reply = prior ? sessionReviewReceiptReply(prior.receipt) : null
  // Why the owner's steps: another Outcome's ask of the same person never replaces this one's.
  const thread = sessionPersonConditionThread(chain, condition, owner.stepIds)
  if (!prior || !reply || reply.threadId === thread) {
    return set
  }
  return {
    ...set,
    evidenceHistory: [...(set.evidenceHistory ?? []), prior],
    outcomes: set.outcomes.map((entry) =>
      entry.id === outcomeId
        ? {
            ...entry,
            status: 'pending',
            evidence: entry.evidence.filter((proof) => proof.id !== prior.id)
          }
        : entry
    )
  }
}

/** Recheck version-bound proof and invalidate dependent approvals when actual bytes change. */
async function verifyProgress(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  input: SessionOutcome,
  force: boolean,
  now: number
): Promise<{ set: SessionOutcomeSet; reason?: string }> {
  let set = chain.outcomeSet!,
    reason: string | undefined
  const polls = pollTimes.get(runtime) ?? new Map<string, number>()
  pollTimes.set(runtime, polls)
  for (const condition of input.conditions.filter((entry) => entry.kind !== 'review')) {
    const outcome = set.outcomes.find((entry) => entry.id === input.id)!
    const prior = outcome.evidence.find((entry) => entry.conditionId === condition.id)
    const key = `${chain.id}:${outcome.id}:${condition.id}:${sessionOutcomeConditionKey(condition)}`
    if (
      !force &&
      prior &&
      condition.kind !== 'file' &&
      condition.kind !== 'report' &&
      condition.kind !== 'session'
    ) {
      continue
    }
    if (!force && !sessionOutcomeReadEveryPass(condition) && now - (polls.get(key) ?? 0) < 30_000) {
      if (!prior) {
        reason ??= outcome.blockedReason ?? SESSION_OUTCOME_AWAITING_EVIDENCE
      }
      continue
    }
    polls.set(key, now)
    const result = await verifySessionOutcomeCondition(
      condition,
      chain.workspacePath,
      runtime,
      {
        ...chain,
        outcomeSet: set
      },
      outcome.id
    )
    set = withSessionOutcomeWaitFact(set, outcome.id, condition.id, result)
    const inconclusive = inconclusiveSessionOutcomeVerification(result)
    if (inconclusive) {
      // Nothing was observed, so nothing already earned is contradicted: the receipt and the
      // reviews given on it stand. Only a source that is out of contact gets back one an older
      // host retired this way; a live pane that is still settling will be read again.
      if (inconclusive === 'lost-contact') {
        set = restoreEarnedSourceReceipt(set, outcome.id, condition)
      }
      const kept = set.outcomes
        .find((entry) => entry.id === input.id)!
        .evidence.some((entry) => entry.conditionId === condition.id)
      if (!kept && !result.verified) {
        reason ??= result.reason
      }
      continue
    }
    const changed =
      prior &&
      (!result.verified ||
        prior.receipt !== result.receipt ||
        prior.version !== (result.version ?? condition.version))
    if (changed) {
      const invalid = outcome.evidence.filter(
        (entry) => entry.conditionId === condition.id || entry.kind === 'review'
      )
      set = {
        ...set,
        evidenceHistory: [...(set.evidenceHistory ?? []), ...invalid],
        outcomes: set.outcomes.map((entry) =>
          entry.id === outcome.id
            ? {
                ...entry,
                status: 'pending',
                evidence: entry.evidence.filter(
                  (proof) => !invalid.some((old) => old.id === proof.id)
                ),
                conditions: entry.conditions.map((candidate) =>
                  candidate.kind === 'review' && !candidate.recipientId
                    ? { ...candidate, version: undefined }
                    : candidate
                )
              }
            : entry
        )
      }
    }
    if (result.verified) {
      if (!prior || changed) {
        set = recordSessionOutcomeEvidence(
          set,
          sessionOutcomeVerifiedEvidence(
            set.outcomes.find((entry) => entry.id === input.id)!,
            condition,
            result.receipt,
            now,
            result.version,
            sessionOutcomePlanVersion(chain)
          )
        )
      }
    } else {
      reason ??= result.reason
    }
  }
  for (const condition of set.outcomes
    .find((entry) => entry.id === input.id)!
    .conditions.filter((entry) => entry.kind === 'review')) {
    if (condition.recipientId) {
      set = retireStaleReviewReceipt({ ...chain, outcomeSet: set }, input.id, condition)
    }
    const outcome = set.outcomes.find((entry) => entry.id === input.id)!
    if (condition.recipientId) {
      if (!force && outcome.evidence.some((entry) => entry.conditionId === condition.id)) {
        continue
      }
      const result = await verifySessionOutcomeCondition(
        condition,
        chain.workspacePath,
        runtime,
        {
          ...chain,
          outcomeSet: set
        },
        outcome.id
      )
      const prior = outcome.evidence.find((entry) => entry.conditionId === condition.id)
      set = withSessionOutcomeWaitFact(set, outcome.id, condition.id, result)
      if (result.verified && !prior) {
        set = recordSessionOutcomeEvidence(
          set,
          sessionOutcomeVerifiedEvidence(
            outcome,
            condition,
            result.receipt,
            now,
            undefined,
            sessionOutcomePlanVersion(chain)
          )
        )
      }
      if (!result.verified) {
        reason ??= result.reason
        if (prior) {
          set = {
            ...set,
            outcomes: set.outcomes.map((entry) =>
              entry.id === outcome.id
                ? {
                    ...entry,
                    status: 'pending',
                    evidence: entry.evidence.filter((proof) => proof.id !== prior.id)
                  }
                : entry
            ),
            evidenceHistory: [...(set.evidenceHistory ?? []), prior]
          }
        }
      }
      continue
    }
    const version = await sessionOutcomeReviewVersion(
      { ...chain, outcomeSet: set },
      outcome,
      runtime
    )
    if (condition.version !== version) {
      const old = outcome.evidence.filter((entry) => entry.conditionId === condition.id)
      set = {
        ...set,
        evidenceHistory: [...(set.evidenceHistory ?? []), ...old],
        outcomes: set.outcomes.map((entry) =>
          entry.id === outcome.id
            ? {
                ...entry,
                status: 'pending',
                evidence: entry.evidence.filter((proof) => proof.conditionId !== condition.id),
                conditions: entry.conditions.map((candidate) =>
                  candidate.id === condition.id ? { ...candidate, version } : candidate
                )
              }
            : entry
        )
      }
    }
    set = restoreGrantedReview(set, input.id, condition.id, version)
    const reviewed = set.outcomes.find((entry) => entry.id === input.id)!
    if (reviewed.evidence.some((entry) => entry.conditionId === condition.id)) {
      continue
    }
    // The condition as the set now carries it: its key includes the version pinned above.
    const pinned = reviewed.conditions.find((entry) => entry.id === condition.id)!
    // "I review the result" is where finished work GOES, not a question it asks (Sal,
    // 2026-09-19): once every other criterion is proven the run completes and sits in Done for
    // the owner to look at. The receipt names the version that was handed over, so an approval
    // of these exact bytes is still recordable and a change after the seal is still visible.
    if (!reason && version) {
      set = recordSessionOutcomeEvidence(
        set,
        sessionOutcomeVerifiedEvidence(
          reviewed,
          pinned,
          `${SESSION_OUTCOME_DONE_FOR_REVIEW}${version}`,
          now,
          version,
          sessionOutcomePlanVersion(chain)
        )
      )
      continue
    }
    reason ??= SESSION_OUTCOME_OWN_REVIEW_REQUIRED
  }
  return { set, ...(reason ? { reason } : {}) }
}

export async function verifySessionOutcomeProgress(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  input: SessionOutcome,
  force = false,
  now = Date.now()
): Promise<{ set: SessionOutcomeSet; reason?: string }> {
  // A sealed run is read exactly as it was proven; later drift is about the world, not this run.
  if (chain.outcomeSet!.completion) {
    return { set: chain.outcomeSet! }
  }
  try {
    return await verifyProgress(runtime, chain, input, force, now)
  } catch (error) {
    const reason = `${SESSION_OUTCOME_VERIFICATION_ERROR} ${error instanceof Error ? error.message : String(error)}`
    return {
      reason,
      set: {
        ...chain.outcomeSet!,
        evidenceHistory: [...(chain.outcomeSet!.evidenceHistory ?? []), ...input.evidence],
        outcomes: chain.outcomeSet!.outcomes.map((outcome) =>
          outcome.id === input.id
            ? blockedSessionOutcome(
                { ...outcome, evidence: [] },
                reason,
                // The verifier is asked again on the next pass; nothing a person can answer.
                { class: 'recovering', code: 'verification-error' },
                now
              )
            : outcome
        )
      }
    }
  }
}
