import type { SessionOutcomeWaitFact } from '../../shared/session-outcome-event'
import type { SessionOutcomeCondition, SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { SessionOutcomeWaitReading } from './session-outcome-event-evidence'

/** The wait reading a verifier attached to its result, if it is a wait at all. */
export function sessionOutcomeWaitReadingOf(
  result: unknown
): SessionOutcomeWaitReading | undefined {
  const wait = (result as { wait?: SessionOutcomeWaitReading } | null)?.wait
  return wait && typeof wait.status === 'string' ? wait : undefined
}

function sameReading(prior: SessionOutcomeWaitFact, next: SessionOutcomeWaitReading): boolean {
  return (
    prior.status === next.status &&
    prior.reason === next.reason &&
    prior.excerpt === next.excerpt &&
    prior.link === next.link &&
    prior.by === next.by &&
    prior.at === next.at &&
    prior.answerId === next.answerId
  )
}

/**
 * Write one condition's latest reading onto its outcome, keeping the owner's re-arm. Facts of
 * conditions the outcome no longer has are dropped here, so a revision never leaves a stale row.
 */
export function recordSessionOutcomeWaitFact(
  set: SessionOutcomeSet,
  outcomeId: string,
  conditionId: string,
  reading: SessionOutcomeWaitReading
): SessionOutcomeSet {
  const prior = set.outcomes
    .find((outcome) => outcome.id === outcomeId)
    ?.waits?.find((entry) => entry.conditionId === conditionId)
  // An unchanged reading refreshes "checked N s ago" at most every 30 s: a clock read every pass
  // must not rewrite the plan on disk every pass.
  if (prior && reading.checkedAt - prior.checkedAt < 30_000 && sameReading(prior, reading)) {
    return set
  }
  return {
    ...set,
    outcomes: set.outcomes.map((outcome) => {
      if (outcome.id !== outcomeId) {
        return outcome
      }
      const fact: SessionOutcomeWaitFact = {
        conditionId,
        ...reading,
        ...(prior?.rearmedAt !== undefined ? { rearmedAt: prior.rearmedAt } : {})
      }
      const kept = (outcome.waits ?? []).filter(
        (entry) =>
          entry.conditionId !== conditionId &&
          outcome.conditions.some((condition) => condition.id === entry.conditionId)
      )
      return { ...outcome, waits: [...kept, fact].slice(-64) }
    })
  }
}

/** `set` with the wait reading a verifier result carries recorded, or unchanged when it has none. */
export function withSessionOutcomeWaitFact(
  set: SessionOutcomeSet,
  outcomeId: string,
  conditionId: string,
  result: unknown
): SessionOutcomeSet {
  const wait = sessionOutcomeWaitReadingOf(result)
  return wait ? recordSessionOutcomeWaitFact(set, outcomeId, conditionId, wait) : set
}

/**
 * Local reads the 30 s throttle does not apply to: a clock is free, so a time wait clears on time,
 * and another session's result is read from this host's own records.
 */
export function sessionOutcomeReadEveryPass(condition: SessionOutcomeCondition): boolean {
  return (
    condition.kind === 'file' ||
    condition.kind === 'session' ||
    condition.event?.source === 'time' ||
    condition.event?.source === 'session'
  )
}
