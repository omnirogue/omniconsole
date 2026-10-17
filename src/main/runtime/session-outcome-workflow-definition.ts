import { createHash } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeDefinition } from '../../shared/session-outcome-types'
import { sessionOutcomeStepSignature } from './session-outcome-revision'

export function sessionOutcomeWorkflowDefinition(
  outcome: Parameters<typeof sessionOutcomeDefinition>[0]
) {
  const value = sessionOutcomeDefinition(outcome)
  return {
    ...value,
    conditions: value.conditions.map((condition) =>
      condition.kind === 'review' && !condition.recipientId
        ? { ...condition, version: undefined }
        : condition
    )
  }
}
export function sessionOutcomeWorkflowDefinitionHash(chain: SessionChain): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        outcomes: chain.outcomeSet!.outcomes.map(sessionOutcomeWorkflowDefinition),
        steps: chain.steps.map((step) => [step.id, sessionOutcomeStepSignature(step)]),
        workspace: chain.workspacePath,
        worktree: chain.worktreeId,
        principal: chain.outcomeSet!.continuation.principal,
        taskId: chain.outcomeSet!.continuation.taskId
      })
    )
    .digest('hex')
}
