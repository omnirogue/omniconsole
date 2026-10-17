import { getNextStepKeepGoingController } from '../next-steps/next-step-suggestion-slot'
import type { OrcaRuntimeService } from './omni-runtime'
import { drainPromptQueues } from './prompt-queue-drain'
import { resumeUpNextContinuations, upNextHoldsContinuation } from './up-next-continuation'
import { drainUpNextStagePrompts, upNextHoldsStagePrompts } from './up-next-stage-prompts'
import { runWorkerDispatchStallWatchdog } from './worker-dispatch-stall-watchdog'
import { advanceConversationCapacityRecovery } from './conversation-capacity-recovery'
import { retryRequestedWorkerTerminalReleases } from './orchestration/worker-terminal-release-retry'
import { recoverPersistedOutcomeWorkerAcceptance } from './session-outcome-worker-acceptance'

/**
 * The part of a host tick that owns no chain and no outcome, and the ownership question that ends
 * it. Both run before — and independently of — continuation ownership, because neither needs one:
 *
 * - the dispatch stall watchdog catches a dispatch left `ready` past its own recorded timeout,
 *   which is a step nobody will ever report on; it needs no chain, no outcome and no hook;
 * - a queued prompt is an ordinary message waiting for an ordinary conversation to go idle, and
 *   this is the loop that already asks every two seconds whether a source session has finished.
 *
 * Two things after the ownership question need it: a prompt the person added to a STAGE is
 * delivered by writing that stage's own step (admission first, then the receipt), and a
 * continuation held behind a person review commits a plan version when they reply.
 *
 * Neither throws: a failure here is logged and the tick goes on to the work that does own a chain.
 * `false` means this host may not touch outcomes yet, so the caller stops there.
 *
 * @param nowMs the pass's clock, handed to the stall watchdog so its verdicts are reproducible.
 */
export async function runSessionOutcomePreTickWork(
  runtime: OrcaRuntimeService,
  epoch: string,
  nowMs = Date.now()
): Promise<boolean> {
  runWorkerDispatchStallWatchdog(runtime, nowMs)
  retryRequestedWorkerTerminalReleases(runtime, nowMs)
  if (
    runtime.listConversationCapacityFailures?.().length ||
    Object.values(runtime.listPromptQueues?.() ?? {}).some(
      (queue) =>
        queue.recovery && !['held', 'cancelled', 'delivered'].includes(queue.recovery.phase)
    )
  ) {
    await advanceConversationCapacityRecovery(runtime, nowMs).catch((error) =>
      console.warn('[capacity-recovery]', error)
    )
  }
  // Before the drain: a Keep going round stopped by now is taken out of the queue unsent.
  const keepGoing = getNextStepKeepGoingController()
  try {
    keepGoing?.sweep()
  } catch (error) {
    // An unchecked tick must not send anything automatic: stop it everywhere before the drain.
    console.error('[next-steps] keep going sweep failed; stopping it', error)
    keepGoing?.stopAll('Keep going could not check this conversation, so it stopped.')
  }
  await drainPromptQueues(runtime, { epoch }).catch((error) =>
    console.warn('[prompt-queue]', error)
  )
  const owned = runtime.hasSessionOutcomeContinuation()
  if (owned) {
    recoverPersistedOutcomeWorkerAcceptance(runtime, nowMs)
  }
  // Both of these are ASKED synchronously and awaited only when there is really something
  // to do: an extra turn here reorders the launch work that follows, and the durable-restart
  // contract reads that as a different sequence
  // (`session-outcome-prepared-restart.integration.test.ts`).
  //
  // Delivering a stage prompt WRITES the chain's steps (admission, then the receipt), so it
  // is the owning host's to do even though the conversation it writes into is nobody's: a
  // host that may not touch these outcomes must not settle their deliveries either.
  if (owned && upNextHoldsStagePrompts(runtime)) {
    await drainUpNextStagePrompts(runtime, { epoch }).catch((error) =>
      console.warn('[up-next]', error)
    )
  }
  if (owned && upNextHoldsContinuation(runtime)) {
    // A continuation COMMITS a plan version, so it needs the ownership the drains above do
    // not: it runs only on the host that owns these outcomes.
    await resumeUpNextContinuations(runtime).catch((error) =>
      console.warn('[up-next] continuation', error)
    )
  }
  return owned
}
