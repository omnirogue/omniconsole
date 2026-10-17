import { sessionOutcomeResultBody } from './session-outcome-result'
import { createHash } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'

/** Bind the human decision to actual candidate bytes and execution-owned result reports. */
export async function sessionOutcomeReviewVersion(
  chain: SessionChain,
  outcome: SessionOutcome,
  runtime: OrcaRuntimeService
): Promise<string> {
  const digest = createHash('sha256')
  digest.update(
    await sessionOutcomeCandidateVersion(
      chain.workspacePath,
      sessionOutcomeCandidatePaths(outcome, chain)
    )
  )
  digest.update(chain.outcomeSet!.continuation.sourceVersion ?? '')
  for (const proof of outcome.evidence.filter((entry) => entry.kind !== 'review')) {
    digest.update(JSON.stringify([proof.conditionId, proof.receipt, proof.version]))
  }
  for (const attempt of chain.outcomeSet!.attempts.filter(
    (entry) => entry.outcomeId === outcome.id && entry.state === 'completed'
  )) {
    digest.update(attempt.id)
    if (attempt.conversationTurn) {
      // A continued turn has no Task row; its report on disk is the only thing that can change.
      digest.update(attempt.conversationTurn.reportPath ?? '')
      digest.update(sessionOutcomeResultBody(runtime, attempt))
    } else if (attempt.nativeContinuation) {
      digest.update(attempt.dispatchId ?? '')
      digest.update(attempt.resultMessageId ?? '')
      digest.update(sessionOutcomeResultBody(runtime, attempt))
    } else if (attempt.taskId) {
      digest.update(runtime.getOrchestrationDb().getTask(attempt.taskId)?.result ?? '')
    }
  }
  return digest.digest('hex')
}
