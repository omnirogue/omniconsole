import { sessionOutcomeAmendmentSources } from './session-outcome-workflow-sources'
import { randomUUID } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import type { OutcomeAmendmentIntent } from '../../shared/outcome-amendment-cancellation'
import type { OrcaRuntimeService } from './omni-runtime'
import { sessionOutcomeActionKey } from '../../shared/session-outcome-types'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import { sessionOutcomeStepSignature } from './session-outcome-revision'
import {
  sessionOutcomeWorkflowDefinition,
  type SessionOutcomePredecessor
} from './session-outcome-workflow-compile'

/** Select remaining user-authored work. Old jobs stay sealed and their actual receipts stay retained. */
export async function prepareSessionOutcomeAmendment(
  _runtime: OrcaRuntimeService,
  chain: SessionChain,
  previous: SessionChain
): Promise<{
  compileChain: SessionChain
  history: SessionOutcomeWorkflow[]
  sources: Map<string, SessionOutcomePredecessor>
  intent?: OutcomeAmendmentIntent
  prerequisites: string[]
}> {
  const set = chain.outcomeSet!,
    priorSet = previous.outcomeSet!
  if (priorSet.amendment && priorSet.amendment.state !== 'ready') {
    throw new Error('The prior saved amendment is still reconciling its exact execution receipts.')
  }
  const generations = [...(priorSet.workflowHistory ?? []), priorSet.workflow!]
  const changed =
    previous.steps.some((old) => {
      const current = chain.steps.find((step) => step.id === old.id)
      return !current || sessionOutcomeStepSignature(old) !== sessionOutcomeStepSignature(current)
    }) ||
    priorSet.outcomes.some((old) => {
      const current = set.outcomes.find((outcome) => outcome.id === old.id)
      return (
        !current ||
        JSON.stringify(sessionOutcomeWorkflowDefinition(old)) !==
          JSON.stringify(sessionOutcomeWorkflowDefinition(current))
      )
    })
  const oldStepIds = new Set(previous.steps.map((step) => step.id))
  const steps = chain.steps.filter((step) =>
    changed ? !set.completedSteps?.includes(step.id) : !oldStepIds.has(step.id)
  )
  const remainingIds = new Set(steps.map((step) => step.id))
  const outcomes = set.outcomes
    .map((outcome) => ({
      ...outcome,
      stepIds: outcome.stepIds?.filter((id) => remainingIds.has(id)),
      actions: outcome.actions.filter(
        (action) =>
          !priorSet.outcomes.some(
            (old) =>
              old.id === outcome.id &&
              old.actions.some(
                (prior) => sessionOutcomeActionKey(prior) === sessionOutcomeActionKey(action)
              )
          ) ||
          (changed &&
            !priorSet.attempts.some(
              (attempt) =>
                attempt.outcomeId === outcome.id &&
                attempt.actionKey === sessionOutcomeActionKey(action) &&
                attempt.state === 'completed'
            ))
      )
    }))
    .filter((outcome) => outcome.stepIds?.length || outcome.actions.length)
  const sources = sessionOutcomeAmendmentSources(chain, steps, generations)
  let intent: OutcomeAmendmentIntent | undefined
  if (changed) {
    const active = generations.filter((workflow) => !workflow.retired)
    const jobs: OutcomeAmendmentIntent['jobs'] = []
    for (const workflow of active) {
      const response = await sessionOutcomeWorkflowPort().observe(
        workflow.preview.workflow_id,
        set.continuation.principal!
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      if (response.data.workflow_id !== workflow.preview.workflow_id) {
        throw new Error('The old workflow changed before amendment review.')
      }
      for (const job of response.data.jobs.filter((entry) => entry.actor_type === 'ai')) {
        if (
          job.policy.workflow.digest !== workflow.preview.digest ||
          !workflow.preview.graph.nodes.some((node) => node.key === job.policy.workflow.key)
        ) {
          throw new Error('The old stage changed before cancellation could be saved.')
        }
        const activation = workflow.activations.find((entry) => entry.jobId === job.id)
        jobs.push({
          jobId: job.id,
          workflowId: workflow.preview.workflow_id,
          approvedDigest: workflow.preview.digest,
          taskId: job.task_id,
          expectedAttempt: job.attempt || null,
          expectedLeaseGeneration: job.lease_generation || null,
          state: 'pending',
          ...(activation?.dispatchId
            ? { dispatchId: activation.dispatchId, runId: activation.runId }
            : {})
        })
      }
    }
    intent = {
      id: randomUUID(),
      principal: set.continuation.principal!,
      sourceOperationIds: active.map((workflow) => workflow.operationId),
      state: 'prepared',
      jobs
    }
  }
  const owned = new Set(outcomes.map((outcome) => outcome.id))
  return {
    compileChain: { ...chain, steps, outcomeSet: { ...set, outcomes } },
    history: generations,
    sources,
    intent,
    prerequisites: [
      ...new Set(outcomes.flatMap((outcome) => outcome.dependsOn).filter((id) => !owned.has(id)))
    ]
  }
}
