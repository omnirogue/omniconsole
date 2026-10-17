import type {
  SessionChain,
  SessionChainStepStatus,
  SessionChainStepWait
} from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  sessionOutcomeBlock,
  UNCLASSIFIED_BLOCK_CODE,
  type SessionOutcomeBlockInput
} from '../../shared/session-outcome-block'
import type { SessionOutcomeLaunchDetach } from './session-outcome-launch-detach'
import type { OrcaRuntimeService } from './omni-runtime'

export type OutcomeStepAccess = {
  runtime: OrcaRuntimeService
  read(): SessionChain
  save(chain: SessionChain): void
  persistAttempt(attempt: SessionOutcomeAttempt): void
  /** Absent means the readiness wait is awaited inside the tick, as it was before WP-4a. */
  detach?: SessionOutcomeLaunchDetach
}

/**
 * The one place a step enters `completedSteps`, so its own `status` is settled here too. The set is
 * what the host reads, but the panel, the sidebar count and the plan summary read `status`: a stage
 * that ran and produced its output still said `queued`, "still to come". A finished agent step is
 * `launched`, a closed one `skipped`; a handoff keeps the `delivered` its own delivery wrote, and a
 * step already skipped stays skipped.
 */
export function markSteps(access: OutcomeStepAccess, ids: string[], skipped = false): void {
  const chain = access.read(),
    set = chain.outcomeSet!
  const completedSteps = [...new Set([...(set.completedSteps ?? []), ...ids])]
  const currentIndex = chain.steps.findIndex((step) => !completedSteps.includes(step.id))
  const settled: SessionChainStepStatus = skipped ? 'skipped' : 'launched'
  access.save({
    ...chain,
    currentIndex: currentIndex === -1 ? chain.steps.length : currentIndex,
    steps: chain.steps.map((step) =>
      ids.includes(step.id) &&
      step.kind !== 'handoff' &&
      step.status !== 'skipped' &&
      step.status !== settled
        ? { ...step, status: settled }
        : step
    ),
    outcomeSet: { ...set, completedSteps }
  })
}

/**
 * Mark one step's own state. Why: an outcome-bound step carried no status transitions at all, so a
 * step whose agent died (a quota wall nine seconds in) stayed `queued` — the plan read as "still to
 * come" while nothing was running. `queued` is written back when the step launches again, so a
 * resumed step is never left reported as failed.
 */
export function setStepStatus(
  access: OutcomeStepAccess,
  stepId: string,
  status: SessionChainStepStatus
): void {
  const chain = access.read()
  const current = chain.steps.find((step) => step.id === stepId)
  if (!current || current.kind === 'handoff' || current.status === status) {
    return
  }
  access.save({
    ...chain,
    steps: chain.steps.map((step) =>
      step.id === stepId && step.kind !== 'handoff' ? { ...step, status } : step
    )
  })
}

/**
 * Block one outcome. `block` says WHY by class (`session-outcome-block.ts`): without it the block
 * reads as an unclassified operational failure, never as a request for a person. `reason` is the
 * diagnostic prose shown under Details.
 */
export function blockOutcome(
  access: OutcomeStepAccess,
  outcomeId: string,
  reason: string,
  block?: SessionOutcomeBlockInput,
  now = Date.now()
): void {
  const chain = access.read()
  access.save({
    ...chain,
    outcomeSet: {
      ...chain.outcomeSet!,
      outcomes: chain.outcomeSet!.outcomes.map((outcome) =>
        outcome.id === outcomeId
          ? {
              ...outcome,
              status: 'blocked',
              blockedReason: reason,
              block: sessionOutcomeBlock(
                block ?? { class: 'failed', code: UNCLASSIFIED_BLOCK_CODE },
                outcome.block,
                now
              )
            }
          : outcome
      )
    }
  })
}

/**
 * Why a ready step has not launched, so `queued` is honest about it. `null` clears the wait; the
 * step's own status is untouched, because waiting is not a status transition.
 */
export function setStepWait(
  access: OutcomeStepAccess,
  chainId: string,
  stepId: string,
  wait: SessionChainStepWait | null
): void {
  const chain = access.read()
  const current = chain.steps.find((step) => step.id === stepId)
  if (chain.id !== chainId || !current || current.kind === 'handoff') {
    return
  }
  const held = current.wait
  if (wait ? held?.reason === wait.reason && held.ref === wait.ref : !held) {
    // Rewriting an unchanged wait would move `since`, which is how long the step has waited.
    return
  }
  access.save({
    ...chain,
    steps: chain.steps.map((step) => {
      if (step.id !== stepId || step.kind === 'handoff') {
        return step
      }
      const { wait: _cleared, ...rest } = step
      return wait ? { ...rest, wait } : rest
    })
  })
}
