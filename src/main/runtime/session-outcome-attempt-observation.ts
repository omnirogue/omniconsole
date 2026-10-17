import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { advanceSameConversationTurn } from './session-outcome-conversation-turn'
import {
  observeSessionOutcomeAttempt,
  sessionOutcomeExecutionBrief
} from './session-outcome-executor'
import { failedSessionOutcomeAttempt } from './session-outcome-local-launch'
import type { SessionOutcomeService } from './session-outcome-service'
import { verifySourcePacketFiles } from './session-outcome-source-packet-files'
import {
  continueSessionOutcomeTask,
  sessionOutcomeAttemptAction
} from './session-outcome-task-continuation'

/**
 * Read every unsettled attempt of a chain back from its receipts, once per host pass. Split out of
 * `advanceSessionOutcomes` to keep that function under its line budget.
 *
 * @returns the steps whose worker settled failed in this pass: from here on the plan row must say
 * so, whatever the recovery ladder does about the outcome.
 */
export async function observeSessionOutcomeAttempts(input: {
  service: SessionOutcomeService
  read: () => SessionChain
  persistAttempt: (attempt: SessionOutcomeAttempt) => void
  now: number
}): Promise<string[]> {
  const { service, read, persistAttempt, now } = input
  const failedSteps: string[] = []
  for (const attempt of read().outcomeSet!.attempts) {
    if (
      attempt.state === 'completed' ||
      attempt.state === 'blocked' ||
      attempt.state === 'retryable' ||
      attempt.state === 'superseded' ||
      // A launch this host is still waiting on is alive; its silence is not a failed launch.
      service.launches.inFlight(attempt.id)
    ) {
      continue
    }
    const chain = read()
    if (
      attempt.continuationTaskId &&
      !attempt.nativeContinuation &&
      !attempt.dispatchId &&
      !attempt.error
    ) {
      try {
        await verifySourcePacketFiles(chain)
        persistAttempt(
          await continueSessionOutcomeTask(
            service.runtime,
            chain,
            sessionOutcomeAttemptAction(attempt),
            attempt,
            sessionOutcomeExecutionBrief(chain, sessionOutcomeAttemptAction(attempt), attempt.id)
          )
        )
      } catch (error) {
        persistAttempt(failedSessionOutcomeAttempt(attempt, error, now))
      }
      continue
    }
    // A continued turn of the original conversation has no Dispatch to read: its own advance
    // delivers when the conversation is free and settles on the ending that answered.
    const observed = attempt.conversationTurn
      ? await advanceSameConversationTurn({
          runtime: service.runtime,
          chain,
          attempt,
          brief: () =>
            sessionOutcomeExecutionBrief(chain, sessionOutcomeAttemptAction(attempt), attempt.id),
          persist: persistAttempt
        })
      : observeSessionOutcomeAttempt(service.runtime, attempt, now)
    if (JSON.stringify(observed) !== JSON.stringify(attempt)) {
      persistAttempt(observed)
    }
    // A seat whose worker settled failed reads as failed on the plan from here on; a replacement
    // the ladder starts writes `queued` back when it launches (`prepareOutcomeStep`).
    const step =
      observed.state === 'blocked' &&
      read().steps.find(
        (entry) =>
          entry.kind !== 'handoff' &&
          sessionOutcomeStepActionId(entry.id) === observed.actionId &&
          entry.status !== 'failed'
      )
    if (step) {
      failedSteps.push(step.id)
    }
  }
  return failedSteps
}
