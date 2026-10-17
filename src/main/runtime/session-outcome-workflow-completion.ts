import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import { hasSessionOutcomeCanonicalProjection } from './session-outcome-workflow-seal'
import { createHash } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import { sessionOutcomeActionKey } from '../../shared/session-outcome-types'
import type { SessionOutcomeService } from './session-outcome-service'
import type { ClosedSessionOutcomeStage } from './session-outcome-workflow-projection'
import { blockedSessionOutcome } from './session-outcome-hold-write'

type Stage = SessionOutcomeWorkflow['stages'][number]

export function currentSessionOutcomeStageBinding(
  chain: SessionChain,
  workflow: SessionOutcomeWorkflow
) {
  const set = chain.outcomeSet!
  const generations = [...(set.workflowHistory ?? []), ...(set.workflow ? [set.workflow] : [])]
  return (stage: Stage, outcomeId: string, kind: 'step' | 'action', id: string) => {
    const outcome = set.outcomes.find((entry) => entry.id === outcomeId)
    if (
      !outcome ||
      (kind === 'step'
        ? !outcome.stepIds?.includes(id) ||
          !chain.steps.some((step) => step.id === id && step.kind !== 'handoff')
        : !outcome.actions.some((action) => action.id === id))
    ) {
      return false
    }
    const latest = generations
      .flatMap((generation) =>
        generation.stages
          .filter(
            (entry) =>
              entry.outcomeIds.includes(outcomeId) &&
              (kind === 'step' ? entry.stepIds : entry.actionIds).includes(id)
          )
          .map((entry) => ({ generation, entry }))
      )
      .at(-1)
    return latest?.generation.operationId === workflow.operationId && latest.entry.key === stage.key
  }
}

/** Maps independent server stage receipts into the existing Next progress ledger. */
export function projectSessionOutcomeStageCompletion(
  service: SessionOutcomeService,
  chain: SessionChain,
  workflow: SessionOutcomeWorkflow,
  closed: ClosedSessionOutcomeStage[],
  verifiedJobs: ConsoleWorkflowJob[] = []
): SessionChain {
  let set = chain.outcomeSet!
  const complete = new Set(set.completedSteps ?? [])
  const current = currentSessionOutcomeStageBinding(chain, workflow)
  const currentSteps = (stage: Stage) =>
    stage.stepIds.filter((id) =>
      stage.outcomeIds.some((outcomeId) => current(stage, outcomeId, 'step', id))
    )
  const acceptedProducers = new Set<string>()
  const verifiedProducerReceipts: NonNullable<SessionOutcomeWorkflow['verifiedProducerReceipts']> =
    []
  for (const stage of workflow.stages) {
    const node = workflow.preview.graph.nodes.find(
      (entry) =>
        entry.key === stage.key &&
        entry.action === 'execute' &&
        entry.loop_stage?.role === 'producer' &&
        entry.loop_stage.round === 0
    )
    const producer = chain.steps.find(
      (step) =>
        currentSteps(stage).includes(step.id) &&
        step.kind !== 'handoff' &&
        !step.review &&
        !step.reviewRepair
    )
    if (
      !node ||
      !producer ||
      producer.kind === 'handoff' ||
      producer.agent !== node.provider ||
      producer.model !== node.model
    ) {
      continue
    }
    const accepted = workflow.receipts?.find((receipt) => {
      const job = verifiedJobs.find((entry) => entry.id === receipt.jobId)
      const projection = job?.policy.workflow.hub_projection
      return (
        receipt.key === node.key &&
        receipt.provider === node.provider &&
        receipt.model === node.model &&
        job?.task_id === receipt.taskId &&
        job.task_id !== set.continuation.taskId &&
        job.policy.workflow.key === node.key &&
        job.policy.workflow.digest === workflow.preview.digest &&
        job.policy.workflow.action === node.action &&
        job.actor_type === node.actor_type &&
        job.provider === receipt.provider &&
        job.model === receipt.model &&
        job.attempt === receipt.attempt &&
        job.lease_generation === receipt.leaseGeneration &&
        hasSessionOutcomeCanonicalProjection(projection, workflow.canonicalSeal) &&
        projection?.satisfied === true &&
        projection.verification_report_id === receipt.verificationReportId &&
        workflow.activations.some(
          (activation) =>
            activation.jobId === receipt.jobId &&
            activation.state === 'started' &&
            activation.dispatchId === receipt.dispatchId &&
            activation.runId === receipt.runId
        )
      )
    })
    if (accepted) {
      verifiedProducerReceipts.push(accepted)
      acceptedProducers.add(producer.id)
      complete.add(producer.id)
    }
  }
  if (
    JSON.stringify(workflow.verifiedProducerReceipts ?? []) !==
    JSON.stringify(verifiedProducerReceipts)
  ) {
    const refreshed = { ...workflow, verifiedProducerReceipts }
    set = {
      ...set,
      ...(set.workflow?.operationId === workflow.operationId
        ? { workflow: refreshed }
        : {
            workflowHistory: set.workflowHistory?.map((entry) =>
              entry.operationId === workflow.operationId ? refreshed : entry
            )
          })
    }
  }
  const closedKeys = new Set(closed.map((entry) => entry.key))
  const invalidated = workflow.stages.filter((stage) => !closedKeys.has(stage.key))
  const invalidatedSteps = new Set(
    invalidated.flatMap(currentSteps).filter((id) => !acceptedProducers.has(id))
  )
  const invalidatedOutcomes = new Set(
    invalidated.flatMap((stage) =>
      stage.outcomeIds.filter(
        (outcomeId) =>
          stage.stepIds.some(
            (id) => invalidatedSteps.has(id) && current(stage, outcomeId, 'step', id)
          ) || stage.actionIds.some((id) => current(stage, outcomeId, 'action', id))
      )
    )
  )
  for (const id of invalidatedSteps) {
    complete.delete(id)
  }
  const formerlyVerified = set.outcomes.filter(
    (outcome) => invalidatedOutcomes.has(outcome.id) && outcome.evidence.length
  )
  if (formerlyVerified.length) {
    set = {
      ...set,
      evidenceHistory: [
        ...(set.evidenceHistory ?? []),
        ...formerlyVerified.flatMap((outcome) => outcome.evidence)
      ],
      outcomes: set.outcomes.map((outcome) =>
        invalidatedOutcomes.has(outcome.id)
          ? blockedSessionOutcome(
              { ...outcome, evidence: [] },
              'Waiting for current canonical stage verification.',
              // The hub closes the stage and the next tick projects it: a wake, not a question.
              { class: 'waiting', code: 'stage-verification', wake: 'stage verification' },
              Date.now()
            )
          : outcome
      )
    }
  }
  let steps = chain.steps.map((step) =>
    acceptedProducers.has(step.id) && step.kind !== 'handoff'
      ? { ...step, status: 'launched' as const }
      : invalidatedSteps.has(step.id) && step.kind !== 'handoff'
        ? { ...step, status: 'queued' as const }
        : step
  )
  for (const closure of closed) {
    const stage = workflow.stages.find((entry) => entry.key === closure.key)
    if (!stage) {
      continue
    }
    const stepIds = currentSteps(stage)
    for (const id of stepIds) {
      complete.add(id)
    }
    steps = steps.map((step) => {
      if (!stepIds.includes(step.id) || step.kind === 'handoff') {
        return step
      }
      return {
        ...step,
        status:
          step.review && closure.round && step.review.round > closure.round
            ? ('skipped' as const)
            : ('launched' as const)
      }
    })
    for (const outcomeId of stage.outcomeIds) {
      const outcome = set.outcomes.find((entry) => entry.id === outcomeId)
      if (!outcome) {
        continue
      }
      for (const actionId of stage.actionIds) {
        const action = current(stage, outcomeId, 'action', actionId)
          ? outcome.actions.find((entry) => entry.id === actionId)
          : undefined
        if (!action) {
          continue
        }
        const receipt = workflow.receipts?.find((entry) => entry.key === stage.key)
        if (
          !receipt ||
          set.attempts.some(
            (attempt) =>
              attempt.actionId === action.id &&
              attempt.outcomeId === outcome.id &&
              attempt.actionKey === sessionOutcomeActionKey(action) &&
              attempt.state === 'completed'
          )
        ) {
          continue
        }
        set = {
          ...set,
          attempts: [
            ...set.attempts,
            {
              id: `canonical_${createHash('sha256')
                .update(`${receipt.jobId}:${receipt.eventId}`)
                .digest('hex')}`,
              actionId: action.id,
              actionKey: sessionOutcomeActionKey(action),
              outcomeId: outcome.id,
              outcomeRevision: outcome.revision,
              state: 'completed',
              dispatchId: receipt.dispatchId,
              runId: receipt.runId,
              taskId: receipt.taskId,
              resultMessageId: String(receipt.eventId),
              startedAt: Date.now(),
              updatedAt: Date.now()
            }
          ]
        }
      }
    }
  }
  const currentIndex = steps.findIndex((step) => !complete.has(step.id))
  const next = {
    ...chain,
    steps,
    currentIndex: currentIndex === -1 ? steps.length : currentIndex,
    outcomeSet: { ...set, completedSteps: [...complete] }
  }
  return JSON.stringify(next) === JSON.stringify(chain) ? chain : service.save(next, set.revision)
}
