import type { SessionOutcomeBlock } from '../../shared/session-outcome-block'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'

/**
 * When each outcome's block began, as a pass found it. The status recompute clears a block it cannot
 * re-derive so the step runner may try again (a handoff whose files are still missing, a verdict
 * receipt still not there), and the runner writes it back when nothing changed. That is the SAME
 * block, not a new one: without this its `since` restarted every tick, and a `recovering` block
 * could never be seen to have gone stale (`effectiveSessionOutcomeBlock`).
 */
export type SessionOutcomeBlocksBegan = ReadonlyMap<string, SessionOutcomeBlock>

export function rememberSessionOutcomeBlocks(set: SessionOutcomeSet): SessionOutcomeBlocksBegan {
  return new Map(
    set.outcomes.flatMap((outcome) =>
      outcome.status === 'blocked' && outcome.block ? [[outcome.id, outcome.block] as const] : []
    )
  )
}

/**
 * The recompute that follows the step runner (to verify what a stage just proved) cannot re-derive
 * a hold the runner found only by trying — files still missing, a verdict it refused — so it would
 * clear it, and the outcome would read as running until the next pass found the same hold again.
 * A hold the runner wrote this pass therefore stands unless that recompute settled or re-held the
 * outcome itself. A request-bearing hold is never put back: the recompute is where those live.
 */
export function keepStepRunnerHolds(
  recomputed: SessionOutcomeSet,
  ran: SessionOutcomeSet,
  beforeRun: SessionOutcomeSet
): SessionOutcomeSet {
  const written = new Map(
    ran.outcomes.flatMap((outcome) =>
      outcome.status === 'blocked' &&
      outcome.block?.class !== 'attention' &&
      beforeRun.outcomes.find((entry) => entry.id === outcome.id)?.status !== 'blocked'
        ? [[outcome.id, outcome] as const]
        : []
    )
  )
  const cleared = (outcome: SessionOutcomeSet['outcomes'][number]): boolean =>
    written.has(outcome.id) && (outcome.status === 'pending' || outcome.status === 'running')
  if (recomputed.completion || !recomputed.outcomes.some(cleared)) {
    return recomputed
  }
  return {
    ...recomputed,
    outcomes: recomputed.outcomes.map((outcome) => {
      const held = written.get(outcome.id)
      return held && cleared(outcome)
        ? {
            ...outcome,
            status: 'blocked' as const,
            blockedReason: held.blockedReason,
            block: held.block
          }
        : outcome
    })
  }
}

/** The set with every block this pass wrote back under its old class and code keeping its start. */
export function keepSessionOutcomeBlockSince(
  set: SessionOutcomeSet,
  began: SessionOutcomeBlocksBegan
): SessionOutcomeSet {
  const restarted = (outcome: SessionOutcomeSet['outcomes'][number]): number | undefined => {
    const before = began.get(outcome.id)
    const block = outcome.status === 'blocked' ? outcome.block : undefined
    return before &&
      block &&
      before.class === block.class &&
      before.code === block.code &&
      before.since < block.since
      ? before.since
      : undefined
  }
  if (!set.outcomes.some((outcome) => restarted(outcome) !== undefined)) {
    return set
  }
  return {
    ...set,
    outcomes: set.outcomes.map((outcome) => {
      const since = restarted(outcome)
      return since === undefined ? outcome : { ...outcome, block: { ...outcome.block!, since } }
    })
  }
}
