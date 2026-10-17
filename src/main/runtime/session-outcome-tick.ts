import { advanceSessionOutcomeWorkflow } from './session-outcome-workflow-tick'
import { preparePendingSessionOutcomeWorkflow } from './session-outcome-planning-ready'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { prepareSessionOutcomeSourcePacket } from './session-outcome-source-packet'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { launchSessionOutcomeWork, sessionOutcomeSlots } from './session-outcome-concurrency'
import { prepareSessionOutcomeSourceRepairs } from './session-outcome-source-repair-prepare'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { observeSessionOutcomeAttempts } from './session-outcome-attempt-observation'
import {
  recoverSessionOutcomeAttempts,
  sessionOutcomePassClock
} from './session-outcome-attempt-recovery'
import {
  blockForContinuation,
  blockForPrincipal,
  CONTINUATION_BLOCK,
  liftContinuationBlocks,
  sourceContinuationBlock
} from './session-outcome-continuation-block'
import {
  keepSessionOutcomeBlockSince,
  keepStepRunnerHolds,
  rememberSessionOutcomeBlocks
} from './session-outcome-block-since'
import { releaseDecidedGateWaits } from './session-outcome-gate-hold'
import type { SessionOutcomeService } from './session-outcome-service'
import { recomputeSessionOutcomeStatuses } from './session-outcome-status-recompute'
import type { SessionOutcomeStepRunAccess } from './session-outcome-steps'
import { blockOutcomesForTickFailure } from './session-outcome-tick-failure'
import { blockOutcomesWithoutVerdictReceipt } from './session-outcome-verdict-invariant'
import { registerSessionOutcomeVerdictHandling } from './session-outcome-verdict-register'
import { upNextCarriedStagePrompts, upNextStampedSeatPanes } from './up-next-stage-seat'
import { advanceUpNextHeldReviews } from './up-next-review-fix'

// Host start: the verdict package is wired in here, where the tick that spends a verdict lives, so
// no host can reach the completed-attempt arm with the consumer or the marker suffix unregistered.
registerSessionOutcomeVerdictHandling()

/**
 * One host pass over one chain, inside that chain's lane: observe its attempts, run the bounded
 * recovery ladder, derive every outcome's status, then start what may run. `at` is the pass's one
 * clock — every backoff, grace period and block is measured from it, so a test can inject it.
 */
export async function advanceSessionOutcomes(
  service: SessionOutcomeService,
  initial: SessionChain,
  at?: number
): Promise<void> {
  let chain = initial
  let set = chain.outcomeSet!
  // A sealed or cancelled run is finished business: nothing observed afterwards is about it.
  if (set.completion || chain.state === 'cancelled') {
    return
  }
  const now = sessionOutcomePassClock(service, at)
  // A block this pass clears and writes back unchanged is the same block: it keeps its start.
  const began = rememberSessionOutcomeBlocks(set)
  // Whole-chain save from a snapshot this tick has been holding across its awaits. Stage
  // prompts are written outside this lane and this tick never owns them, so they are read
  // back from the live record instead of being rolled back to the snapshot's copy. The pane
  // each host-launched seat was assigned rides the same save: this tick is the only writer
  // that can see the Dispatch, and the panel readers join panes to steps by that field.
  const save = (): void => {
    set = keepSessionOutcomeBlockSince(set, began)
    chain = service.save(
      upNextStampedSeatPanes(
        service.runtime,
        upNextCarriedStagePrompts(service.runtime, { ...chain, outcomeSet: set })
      ),
      set.revision
    )
    set = chain.outcomeSet!
  }
  const persistAttempt = (attempt: SessionOutcomeAttempt): void => {
    set = {
      ...set,
      attempts: set.attempts.some((entry) => entry.id === attempt.id)
        ? set.attempts.map((entry) => (entry.id === attempt.id ? attempt : entry))
        : [...set.attempts, attempt]
    }
    save()
  }
  const pass = async (): Promise<void> => {
    try {
      await assertSessionOutcomeExecutionScope(service.runtime, chain)
    } catch (error) {
      // Lost contact proves nothing about the work: the run waits for its host, and says so.
      set = blockForContinuation(
        { ...set, continuation: { ...set.continuation, state: 'unverifiable' } },
        error instanceof Error ? error.message : String(error),
        { class: 'waiting', code: CONTINUATION_BLOCK.host, wake: 'execution host' },
        now
      )
      save()
      return
    }
    set = liftContinuationBlocks(set, [CONTINUATION_BLOCK.host])
    if (set.continuation.state !== 'owned') {
      set = { ...set, continuation: { ...set.continuation, state: 'owned' } }
    }
    if (
      set.continuation.principal &&
      (await readSessionOutcomePrincipal()) !== set.continuation.principal
    ) {
      // Only the person can sign back in: a request, and the one block class that names it.
      set = blockForPrincipal(chain, set, now)
      save()
      return
    }
    // Lifting the block is what closes the request: the recompute below no longer keeps it.
    set = liftContinuationBlocks(set, [CONTINUATION_BLOCK.principal])
    if (set.continuation.sourceReady) {
      // Another writer (a commit that bound the source) may have earned the reading: a block that
      // waits for it must not outlive it, because nothing below asks about a ready source again.
      set = liftContinuationBlocks(set, [
        CONTINUATION_BLOCK.sourceNotReady,
        CONTINUATION_BLOCK.sourceGone
      ])
    }
    if (set.continuation.epoch !== service.epoch) {
      set = { ...set, continuation: { ...set.continuation, epoch: service.epoch, state: 'owned' } }
      // A wait records this host's live budget, not the plan: a restart never inherits one.
      chain = {
        ...chain,
        steps: chain.steps.map((step) => {
          // A stop that waits for the owner's decision is the plan's, not this host's budget.
          if (step.kind === 'handoff' || !step.wait || step.wait.reason === 'human_decision') {
            return step
          }
          const { wait: _cleared, ...rest } = step
          return rest
        })
      }
      save()
    }
    if (set.workflow) {
      await advanceSessionOutcomeWorkflow(service, { ...chain, outcomeSet: set })
      return
    }
    if (
      set.continuation.planningSource &&
      (chain.steps.some((step) => step.kind !== 'handoff') ||
        set.outcomes.some((outcome) => outcome.actions.length))
    ) {
      const prepared = await preparePendingSessionOutcomeWorkflow(
        service,
        { ...chain, outcomeSet: set },
        now
      )
      if (prepared?.outcomeSet?.workflow) {
        await advanceSessionOutcomeWorkflow(service, prepared)
      }
      return
    }
    const failedSteps = await observeSessionOutcomeAttempts({
      service,
      read: () => ({ ...chain, outcomeSet: set }),
      persistAttempt,
      now
    })
    if (failedSteps.length) {
      chain = {
        ...chain,
        steps: chain.steps.map((step) =>
          failedSteps.includes(step.id) && step.kind !== 'handoff'
            ? { ...step, status: 'failed' }
            : step
        )
      }
      save()
    }
    // The recovery ladder, before anything is derived: work that is already proven settles, and a
    // provably dead or never-started attempt is replaced within the ladder's bounds.
    const recovered = await recoverSessionOutcomeAttempts({
      runtime: service.runtime,
      chain,
      set,
      now,
      inFlight: (attemptId) => service.launches.inFlight(attemptId)
    })
    if (recovered !== set) {
      set = recovered
      save()
    }
    set = await recomputeSessionOutcomeStatuses(service.runtime, chain, set, [], now)
    chain = releaseDecidedGateWaits(chain, set)
    save()
    // The verdict invariant, every tick: a verdict seat in `completedSteps` with no receipt decided
    // nothing, so this outcome does not advance — and is not read as complete either.
    const unproven = blockOutcomesWithoutVerdictReceipt(chain, set, now)
    if (unproven) {
      set = unproven
      save()
      return
    }
    // A reviewer's "needs changes" goes to this conversation's agent, and they are asked again
    // when that turn ends (`up-next-review-fix.ts`); a re-ask reopens the review step below.
    await advanceUpNextHeldReviews({
      runtime: service.runtime,
      read: () => ({ ...chain, outcomeSet: set }),
      save: (updated) => {
        chain = updated
        set = updated.outcomeSet!
        save()
      },
      epoch: service.epoch,
      now
    })
    // Proven work has nothing to launch; work held behind its review is the pre-tick's to commit.
    const progress = sessionOutcomeProgress(set)
    if (progress.lifecycle === 'complete' || progress.satisfied === progress.total) {
      return
    }
    const slots = sessionOutcomeSlots(service.runtime, { ...chain, outcomeSet: set })
    if (!slots) {
      return
    }
    // An unverifiable action still holds its slot; only the capacity left over admits new work.
    //
    // `rebound` remembers that this tick is the one that EARNED the source reading back. The only
    // things that clear `sourceReady` on a live set are the first binding and a finish commit
    // (`rebindSessionFinishSource` drops the session receipt with it), so in both cases the set is
    // carrying a criterion with no receipt that nothing else will ever come back for: the status
    // recompute below runs on step completions, and a pursuit whose steps are all done has none
    // left. Live, that is why a recorded `Done → Close` never ended the tab.
    let rebound = false
    if (!set.continuation.sourceReady) {
      const source = await observeSessionOutcomeSource(
        service.runtime,
        chain,
        set.continuation.planningSource ? { successfulOnly: true } : undefined
      )
      const held = sourceContinuationBlock(service.runtime, chain, source)
      const gone = held?.block.code === CONTINUATION_BLOCK.sourceGone
      set = {
        ...set,
        continuation: {
          ...set.continuation,
          // A source that is gone for good is a failure of this run, not lost contact with its host.
          state: source.unverifiable && !gone ? 'unverifiable' : 'owned',
          ...(source.ready ? { sourceReady: true, sourceVersion: source.version } : {})
        }
      }
      set = held
        ? blockForContinuation(set, held.reason, held.block, now)
        : liftContinuationBlocks(set, [
            CONTINUATION_BLOCK.sourceNotReady,
            CONTINUATION_BLOCK.sourceGone
          ])
      save()
      if (!source.ready) {
        return
      }
      rebound = true
    }
    // Capturing the source packet and materializing authorized source repairs happens before any
    // work starts, and a failure to capture blocks the chain instead of running against an
    // unverified source.
    try {
      chain = await prepareSessionOutcomeSourcePacket(service.runtime, {
        ...chain,
        outcomeSet: set
      })
      chain = await prepareSessionOutcomeSourceRepairs(service.runtime, chain)
      set = liftContinuationBlocks(chain.outcomeSet!, [CONTINUATION_BLOCK.sourceCapture])
      save()
    } catch (error) {
      // Tried again on every pass; a capture that never succeeds goes stale and reads as failed.
      set = blockForContinuation(
        set,
        error instanceof Error ? error.message : String(error),
        { class: 'recovering', code: CONTINUATION_BLOCK.sourceCapture },
        now
      )
      save()
      return
    }
    const completedBefore = new Set(set.completedSteps ?? [])
    const beforeRun = set
    const access: SessionOutcomeStepRunAccess = {
      runtime: service.runtime,
      read: () => ({ ...chain, outcomeSet: set }),
      save: (updated) => {
        chain = updated
        set = updated.outcomeSet!
        save()
      },
      persistAttempt,
      detach: service.launchedDetach(chain.id),
      now
    }
    await launchSessionOutcomeWork(access, slots)
    // Verify after EVERY step completion, not only when the whole outcome is done: k/n Done When
    // rises stage by stage, and a stage that already proved something says so before the next starts.
    // A tick that re-earned the source reading verifies too, whether or not a step moved: that is
    // the tick the finish's own source receipt is waiting for, and the same pass clears a block an
    // earlier refusal left behind once the reason for it is gone.
    const staged = (set.completedSteps ?? []).filter((id) => !completedBefore.has(id))
    if (staged.length || rebound) {
      const ran = set
      set = keepStepRunnerHolds(
        await recomputeSessionOutcomeStatuses(service.runtime, chain, set, staged, now),
        ran,
        beforeRun
      )
      save()
    }
  }
  try {
    await pass()
  } catch (error) {
    // Recorded here, where the pass still remembers when its blocks began; the service's own record
    // of the same failure then finds this block in place and changes nothing.
    blockOutcomesForTickFailure(service, chain.id, error, now, began)
    throw error
  }
}
