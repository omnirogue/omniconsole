import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeCondition,
  type SessionOutcomeEvidence,
  type SessionOutcomeSet
} from '../../shared/session-outcome-types'

/** Proof is put back exactly as it was earned, or not at all: nothing here can mint a receipt. */
function putBack(set: SessionOutcomeSet, earned: SessionOutcomeEvidence | undefined) {
  if (!earned) {
    return set
  }
  try {
    return recordSessionOutcomeEvidence(set, earned)
  } catch {
    return set
  }
}

/**
 * An approval is of exact bytes. When the result is those bytes again — a read that failed and
 * recovered, a change that was undone — the approval the person already gave still stands, and
 * asking for it a second time would be asking them nothing new.
 */
export function restoreGrantedReview(
  set: SessionOutcomeSet,
  outcomeId: string,
  conditionId: string,
  version: string
): SessionOutcomeSet {
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)!
  const condition = outcome.conditions.find((entry) => entry.id === conditionId)!
  if (outcome.evidence.some((entry) => entry.conditionId === conditionId)) {
    return set
  }
  return putBack(
    set,
    (set.evidenceHistory ?? []).findLast(
      (entry) =>
        entry.outcomeId === outcomeId &&
        entry.conditionId === conditionId &&
        entry.outcomeRevision === outcome.revision &&
        entry.version === version &&
        entry.receipt === `user-review:${version}` &&
        entry.conditionKey === sessionOutcomeConditionKey(condition)
    )
  )
}

/**
 * Losing contact with a source observes nothing, so it never contradicted the receipt the source
 * had already earned — but an older host retired that receipt the moment the tab was closed, and
 * the run then waited for ever on a session nobody could reopen (`reports/handoff-diagnosis.md`,
 * chains `source_b3cefdb0…`, `source_4caddd31…`). While the source is STILL out of contact, the
 * newest receipt this exact condition earned at this exact outcome revision is put back — and only
 * the receipt of the source reading the run still holds: a finish commit that re-binds the source
 * clears that reading (`rebindSessionFinishSource`), and what it discarded stays discarded. A source
 * that can be read again is read instead, and decides for itself.
 */
export function restoreEarnedSourceReceipt(
  set: SessionOutcomeSet,
  outcomeId: string,
  condition: SessionOutcomeCondition
): SessionOutcomeSet {
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)!
  const held = set.continuation.sourceReady ? set.continuation.sourceVersion : undefined
  if (!held || outcome.evidence.some((entry) => entry.conditionId === condition.id)) {
    return set
  }
  return putBack(
    set,
    (set.evidenceHistory ?? []).findLast(
      (entry) =>
        entry.outcomeId === outcomeId &&
        entry.conditionId === condition.id &&
        entry.kind === condition.kind &&
        entry.version === held &&
        entry.outcomeRevision === outcome.revision &&
        entry.conditionKey === sessionOutcomeConditionKey(condition)
    )
  )
}
