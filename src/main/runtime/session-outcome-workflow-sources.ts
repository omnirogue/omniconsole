import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'
import type { SessionOutcomePredecessor } from './session-outcome-workflow-compile'
import { sessionOutcomeLineage } from './session-outcome-workflow-lineage'

export function sessionOutcomeAmendmentSources(
  chain: SessionChain,
  steps: SessionChain['steps'],
  generations: SessionOutcomeWorkflow[]
): Map<string, SessionOutcomePredecessor> {
  const sources = new Map<string, SessionOutcomePredecessor>()
  for (const step of steps) {
    if (step.kind === 'handoff') {
      continue
    }
    const owners = chain.outcomeSet!.outcomes.filter((outcome) =>
      outcome.stepIds?.includes(step.id)
    )
    const ownerIds = new Set(owners.map((outcome) => outcome.id))
    const lineage = sessionOutcomeLineage(chain, ownerIds)
    const preceding = new Set([
      ...chain.steps
        .slice(
          0,
          chain.steps.findIndex((entry) => entry.id === step.id)
        )
        .map((entry) => entry.id),
      step.replacedStepId ?? step.id
    ])
    const candidates = generations.flatMap((workflow, generation) =>
      (workflow.receipts ?? []).flatMap((receipt) => {
        const node = workflow.preview.graph.nodes.find((entry) => entry.key === receipt.key)
        const stage = workflow.stages.find(
          (entry) => entry.key === (node?.loop_stage?.stage_key ?? node?.key)
        )
        if (
          !node ||
          !stage ||
          !['execute', 'repair'].includes(node.action) ||
          !receipt.candidateSha ||
          !receipt.branch ||
          !receipt.prUrl ||
          node.provider !== receipt.provider ||
          node.model !== receipt.model ||
          !stage.outcomeIds.some((id) => lineage.has(id))
        ) {
          return []
        }
        const own = stage.outcomeIds.some((id) => ownerIds.has(id))
        if (own && !stage.stepIds.some((id) => preceding.has(id))) {
          return []
        }
        return [
          {
            receipt,
            effort: node.effort ?? undefined,
            generation,
            own,
            stageIndex: workflow.stages.indexOf(stage),
            round: Number(node.loop_stage?.round ?? 0),
            outcomes: stage.outcomeIds
          }
        ]
      })
    )
    const own = candidates.filter((candidate) => candidate.own)
    const eligible = own.length ? own : candidates
    if (!eligible.length) {
      continue
    }
    // Independent dependency branches have no implicit "last" candidate.
    const latestByOutcome = new Map<string, (typeof eligible)[number]>()
    for (const candidate of eligible.toSorted(
      (a, b) =>
        a.generation - b.generation ||
        a.stageIndex - b.stageIndex ||
        a.round - b.round ||
        a.receipt.eventId - b.receipt.eventId
    )) {
      for (const id of candidate.outcomes.filter((id) => lineage.has(id))) {
        latestByOutcome.set(id, candidate)
      }
    }
    const tips = [...latestByOutcome.entries()].filter(
      ([id]) =>
        ![...latestByOutcome.keys()].some(
          (other) => other !== id && sessionOutcomeLineage(chain, [other]).has(id)
        )
    )
    if (
      new Set(
        tips.map(([, candidate]) =>
          JSON.stringify([
            candidate.receipt.candidateSha,
            candidate.receipt.branch,
            candidate.receipt.prUrl
          ])
        )
      ).size > 1
    ) {
      throw new Error('The outcome dependencies identify different accepted source candidates.')
    }
    const source = tips.at(-1)?.[1]
    if (source) {
      sources.set(step.id, { receipt: source.receipt, effort: source.effort })
    }
  }
  return sources
}
