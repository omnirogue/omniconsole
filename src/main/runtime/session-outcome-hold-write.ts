import { openHumanAttention } from '../../shared/session-human-attention'
import {
  sessionOutcomeBlock,
  type SessionOutcomeBlockInput
} from '../../shared/session-outcome-block'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  sessionOutcomeHoldBlock,
  type SessionOutcomeHold,
  type SessionOutcomeHoldReading
} from './session-outcome-hold-block'
import type { OutcomeStepAccess } from './session-outcome-step-progress'

/** One blocked outcome as it is persisted: the diagnostic, and the class that decides the phase. */
export function blockedSessionOutcome(
  outcome: SessionOutcome,
  reason: string,
  block: SessionOutcomeBlockInput,
  now: number
): SessionOutcome {
  return {
    ...outcome,
    status: 'blocked',
    blockedReason: reason,
    block: sessionOutcomeBlock(block, outcome.block, now)
  }
}

/** Block the outcomes a set-wide failure affects. A sealed run is never touched by a later failure. */
export function blockSessionOutcomes(
  set: SessionOutcomeSet,
  affected: (outcome: SessionOutcome) => boolean,
  reason: string,
  block: SessionOutcomeBlockInput,
  now: number
): SessionOutcomeSet {
  if (set.completion) {
    return set
  }
  return {
    ...set,
    outcomes: set.outcomes.map((outcome) =>
      affected(outcome) ? blockedSessionOutcome(outcome, reason, block, now) : outcome
    )
  }
}

/** Write one classified hold: its requests are opened first, so the block can name them. */
export function applySessionOutcomeHoldReading(
  set: SessionOutcomeSet,
  outcomeId: string,
  reason: string,
  reading: SessionOutcomeHoldReading,
  now: number
): SessionOutcomeSet {
  if (set.completion) {
    return set
  }
  let next = set
  const attentionIds: string[] = []
  for (const draft of reading.attention) {
    try {
      const opened = openHumanAttention(next, draft, now)
      next = opened.set
      attentionIds.push(opened.id)
    } catch {
      // A request the schema refuses must cost the ask, never the record of why the run stopped.
    }
  }
  return blockSessionOutcomes(
    next,
    (outcome) => outcome.id === outcomeId,
    reason,
    { ...reading.block, ...(attentionIds.length ? { attentionIds } : {}) },
    now
  )
}

export function holdSessionOutcome(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcomeId: string,
  hold: SessionOutcomeHold,
  now: number
): SessionOutcomeSet {
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)
  return outcome
    ? applySessionOutcomeHoldReading(
        set,
        outcomeId,
        hold.reason,
        sessionOutcomeHoldBlock(chain, set, outcome, hold, now),
        now
      )
    : set
}

/** The step runner's form of the same write, for a hold its own tick just observed. */
export function blockOutcomeForReading(
  access: OutcomeStepAccess,
  outcomeId: string,
  reason: string,
  reading: SessionOutcomeHoldReading,
  now: number
): void {
  const chain = access.read()
  const set = chain.outcomeSet!
  if (set.completion) {
    return
  }
  access.save({
    ...chain,
    outcomeSet: applySessionOutcomeHoldReading(set, outcomeId, reason, reading, now)
  })
}

export function blockOutcomeForHold(
  access: OutcomeStepAccess,
  outcomeId: string,
  hold: SessionOutcomeHold,
  now: number
): void {
  const chain = access.read()
  const outcome = chain.outcomeSet!.outcomes.find((entry) => entry.id === outcomeId)
  if (outcome) {
    blockOutcomeForReading(
      access,
      outcomeId,
      hold.reason,
      sessionOutcomeHoldBlock(chain, chain.outcomeSet!, outcome, hold, now),
      now
    )
  }
}
