import { sessionOutcomeVerifiedProducer } from './session-outcome-workflow-producer-proof'
import { sessionOutcomeReviewerIdentity } from './session-outcome-reviewer-identity'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import { sessionOutcomeConditionKey } from '../../shared/session-outcome-types'
import { sessionOutcomeLineage } from './session-outcome-workflow-lineage'

type Binding = SessionOutcomeWorkflow['stages'][number]
type Selection = {
  workflow: SessionOutcomeWorkflow
  binding: Binding
  stepIds: Set<string>
  legacy: boolean
}
const identity = (receipt: NonNullable<SessionOutcomeWorkflow['receipts']>[number]) =>
  JSON.stringify([receipt.branch, receipt.candidateSha, receipt.prUrl])

function requiredStages(chain: SessionChain, outcomeIds: Set<string>): Selection[] {
  const workflows = [
    ...(chain.outcomeSet!.workflowHistory ?? []),
    ...(chain.outcomeSet!.workflow ? [chain.outcomeSet!.workflow] : [])
  ]
  const selected = new Map<Binding, Selection>()
  for (const outcome of chain.outcomeSet!.outcomes.filter((entry) => outcomeIds.has(entry.id))) {
    const requirements = [
      ...(outcome.stepIds ?? [])
        .filter((id) => chain.steps.find((step) => step.id === id)?.kind !== 'handoff')
        .map((id) => ({ id, kind: 'step' as const })),
      ...outcome.actions.map((action) => ({ id: action.id, kind: 'action' as const }))
    ]
    const bindings = workflows.flatMap((workflow) =>
      workflow.stages
        .filter((binding) => binding.outcomeIds.includes(outcome.id))
        .map((binding) => ({ workflow, binding }))
    )
    for (const requirement of requirements) {
      const latest = bindings.findLast(({ binding }) =>
        (requirement.kind === 'step' ? binding.stepIds : binding.actionIds).includes(requirement.id)
      )
      if (!latest) {
        throw new Error('The current outcome still requires an admitted stage before publication.')
      }
      const entry = selected.get(latest.binding) ?? {
        ...latest,
        stepIds: new Set<string>(),
        legacy: false
      }
      if (requirement.kind === 'step') {
        entry.stepIds.add(requirement.id)
      }
      selected.set(latest.binding, entry)
    }
    // Older plans omitted authored stepIds; retain their latest frozen outcome generation.
    if (!requirements.length && outcome.stepIds === undefined) {
      const latestWorkflow = bindings.at(-1)?.workflow
      for (const entry of bindings.filter((entry) => entry.workflow === latestWorkflow)) {
        selected.set(entry.binding, { ...entry, stepIds: new Set(), legacy: true })
      }
    }
  }
  return [...selected.values()].sort(
    (a, b) =>
      workflows.indexOf(a.workflow) - workflows.indexOf(b.workflow) ||
      a.workflow.stages.indexOf(a.binding) - b.workflow.stages.indexOf(b.binding)
  )
}

/** Current obligations choose the accepted candidate; retained obsolete generations are audit history. */
export function sessionOutcomeWorkflowTarget(
  chain: SessionChain,
  condition: SessionOutcomeCondition,
  owningOutcomeId?: string
) {
  const matching = chain.outcomeSet!.outcomes.filter(
    (outcome) =>
      (owningOutcomeId === undefined || outcome.id === owningOutcomeId) &&
      outcome.conditions.some(
        (entry) => sessionOutcomeConditionKey(entry) === sessionOutcomeConditionKey(condition)
      )
  )
  if (matching.length !== 1) {
    throw new Error('The publication condition must identify one owning outcome.')
  }
  const scope = sessionOutcomeLineage(
    chain,
    matching.map((outcome) => outcome.id)
  )
  const selections = requiredStages(chain, scope)
  const candidates = selections.map(({ workflow, binding, stepIds, legacy }) => {
    const closed = workflow.closedStages?.find((entry) => entry.key === binding.key)
    if (!closed) {
      const receipt = !legacy
        ? sessionOutcomeVerifiedProducer(chain, workflow, binding, stepIds)
        : undefined
      if (!receipt?.candidateSha || !receipt.branch || !receipt.prUrl) {
        throw new Error('The current outcome still requires a closed stage before publication.')
      }
      return { workflow, closed: undefined, receipt, reviews: [], outcomeIds: binding.outcomeIds }
    }
    const stageNode = workflow.preview.graph.nodes.find((node) => node.key === closed.key)
    if (stageNode && !stageNode.loop_stage) {
      // Why: a stage without a review loop (action, or step without reviewers) closes on its own
      // hub receipt; a closed action that produced no Git candidate satisfies its obligation only.
      const own = (workflow.receipts ?? []).find(
        (entry) =>
          entry.key === closed.key && entry.verificationReportId === closed.verificationReportId
      )
      if (!own) {
        throw new Error('The closed stage does not retain its accepted receipt.')
      }
      const candidate = Boolean(own.branch && own.candidateSha && own.prUrl)
      if (!candidate && stepIds.size) {
        throw new Error('The outcome does not identify an accepted Git candidate.')
      }
      // Why: a stage with no stepIds (a pure finish/action stage) has no reviewer roster of its own;
      // it never supplies the published candidate, even when its own receipt carries a Git candidate,
      // so a reviewed producer elsewhere in the outcome cannot be silently replaced by an unreviewed push.
      return {
        workflow,
        closed,
        receipt: candidate && stepIds.size ? own : undefined,
        reviews: [],
        outcomeIds: binding.outcomeIds
      }
    }
    const participants = workflow.preview.graph.nodes.filter(
      (node) =>
        node.loop_stage?.stage_key === closed.key &&
        node.loop_stage?.role === 'participant' &&
        node.loop_stage?.round === closed.round
    )
    const accepted = closed.reviewJobIds.map((id) =>
      workflow.receipts?.find((receipt) => receipt.jobId === id)
    )
    if (
      participants.length !== accepted.length ||
      new Set(closed.reviewJobIds).size !== accepted.length ||
      participants.some(
        (node) =>
          accepted.filter(
            (receipt) =>
              receipt?.key === node.key &&
              receipt.provider === node.provider &&
              receipt.model === node.model
          ).length !== 1
      )
    ) {
      throw new Error('The closed stage does not retain its exact frozen review roster.')
    }
    const sourceWorkflows = [...(chain.outcomeSet!.workflowHistory ?? []), workflow]
    const producerReceipts = sourceWorkflows.flatMap((source) => source.receipts ?? [])
    const receipt = closed.producerJobId
      ? producerReceipts.find((entry) => entry.jobId === closed.producerJobId)
      : undefined
    const producerNode = sourceWorkflows
      .flatMap((source) => source.preview.graph.nodes)
      .find(
        (node) =>
          node.key === receipt?.key &&
          node.provider === receipt.provider &&
          node.model === receipt.model &&
          (node.loop_stage?.role === 'producer' || node.loop_stage?.role === 'repair')
      )
    const legacyProducerNodes = workflow.preview.graph.nodes.filter(
      (node) =>
        node.loop_stage?.stage_key === closed.key &&
        (node.loop_stage.role === 'producer' || node.loop_stage.role === 'repair') &&
        node.loop_stage.round === Number(closed.round) - 1
    )
    const legacyReceipt =
      !closed.producerJobId && legacyProducerNodes.length === 1
        ? (workflow.receipts ?? []).find(
            (entry) =>
              entry.key === legacyProducerNodes[0]!.key &&
              entry.provider === legacyProducerNodes[0]!.provider &&
              entry.model === legacyProducerNodes[0]!.model
          )
        : undefined
    const acceptedProducer = receipt ?? legacyReceipt
    const acceptedProducerNode = producerNode ?? legacyProducerNodes[0]
    if (
      !acceptedProducerNode ||
      participants.some(
        (node) =>
          node.repo !== acceptedProducerNode.repo ||
          node.base_branch !== acceptedProducerNode.base_branch
      )
    ) {
      throw new Error('The closed review set differs from its frozen producer repository.')
    }
    if (!acceptedProducer?.branch || !acceptedProducer.candidateSha || !acceptedProducer.prUrl) {
      throw new Error('The outcome does not identify an accepted Git candidate.')
    }
    const producerCandidateSha = acceptedProducer.candidateSha
    if (
      accepted.some(
        (entry) =>
          !entry ||
          entry.candidateSha !== producerCandidateSha ||
          entry.verdict?.verdict !== 'agree' ||
          entry.verdict.blockers.length ||
          entry.verdict.gaps.length ||
          !entry.verdict.notes.includes(producerCandidateSha)
      )
    ) {
      throw new Error('The closed review set does not prove its exact candidate.')
    }
    const requiredReviews = chain.steps.filter(
      (step) =>
        stepIds.has(step.id) && step.kind !== 'handoff' && step.review && step.review.round === 1
    )
    for (const step of requiredReviews) {
      if (
        step.kind === 'handoff' ||
        !step.review ||
        step.review.groupId !== binding.reviewGroupId ||
        !participants.some(
          (node) =>
            node.provider === step.agent &&
            node.model === step.model &&
            (!node.loop_stage?.participant_id ||
              node.loop_stage.participant_id === sessionOutcomeReviewerIdentity(step.review!))
        )
      ) {
        throw new Error('The current review requirement differs from its frozen participant.')
      }
    }
    const reviews = participants
      .filter(
        (node) =>
          legacy ||
          requiredReviews.some(
            (step) =>
              step.kind !== 'handoff' &&
              step.agent === node.provider &&
              step.model === node.model &&
              (!node.loop_stage?.participant_id ||
                (step.review &&
                  node.loop_stage.participant_id === sessionOutcomeReviewerIdentity(step.review)))
          )
      )
      .map((node) => ({
        workflow,
        closed,
        receipt: accepted.find((entry) => entry?.key === node.key)!,
        reviewerId: `${workflow.preview.workflow_id}:${node.key}:${node.provider}/${node.model}`
      }))
    return {
      workflow,
      closed,
      receipt: acceptedProducer,
      reviews,
      outcomeIds: binding.outcomeIds
    }
  })
  type Candidate = (typeof candidates)[number] & {
    receipt: NonNullable<(typeof candidates)[number]['receipt']>
  }
  const latestByOutcome = new Map<string, Candidate>()
  for (const entry of candidates) {
    if (!entry.receipt) {
      continue
    }
    entry.outcomeIds
      .filter((id) => scope.has(id))
      .forEach((id) => latestByOutcome.set(id, entry as Candidate))
  }
  const tips = [...latestByOutcome.entries()].filter(
    ([id]) =>
      ![...latestByOutcome.keys()].some(
        (other) => other !== id && sessionOutcomeLineage(chain, [other]).has(id)
      )
  )
  if (new Set(tips.map(([, entry]) => identity(entry.receipt))).size > 1) {
    throw new Error('The outcome dependencies identify different accepted Git candidates.')
  }
  const candidate = tips.at(-1)?.[1]
  if (!candidate?.closed) {
    throw new Error('The outcome does not identify one accepted Git candidate.')
  }
  const reviews = candidates.flatMap((entry) => entry.reviews)
  if (reviews.some((review) => review.receipt.candidateSha !== candidate.receipt.candidateSha)) {
    throw new Error('The current required reviews do not all prove the selected candidate.')
  }
  if (
    (condition.branch && condition.branch !== candidate.receipt.branch) ||
    (condition.version && condition.version !== candidate.receipt.candidateSha) ||
    (condition.target.startsWith('https:') && condition.target !== candidate.receipt.prUrl)
  ) {
    throw new Error('The accepted candidate differs from the saved branch, version or PR target.')
  }
  return {
    workflow: candidate.workflow,
    closed: candidate.closed,
    receipt: candidate.receipt,
    reviews,
    expectedReviewerIds: reviews.map((review) => review.reviewerId)
  }
}
