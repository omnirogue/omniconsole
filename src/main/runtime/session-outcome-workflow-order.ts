import { nextOutcomeParallelGroupKey } from '../../shared/next-outcome-compile'
import type { ConsoleWorkflowStep } from '../../shared/console-workflow-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeWorkflow } from '../../shared/session-outcome-workflow'

/**
 * Order work within each outcome and preserve only its declared cross-outcome dependencies.
 * Independent outcomes remain independent server roots. Extracted from the compiler so the
 * parallel-group wiring has room to be read on its own; the graph it writes is unchanged.
 */
export function orderSessionOutcomeStages(args: {
  chain: SessionChain
  bindings: SessionOutcomeWorkflow['stages']
  stages: ConsoleWorkflowStep[]
}): void {
  const { chain, bindings, stages } = args
  const set = chain.outcomeSet!
  const groups = bindings.map((binding) => {
    const first = chain.steps.find((step) => step.id === binding.stepIds[0])
    const outcomeId = binding.outcomeIds[0]
    return first?.kind !== 'handoff' &&
      outcomeId &&
      first?.group?.startsWith(nextOutcomeParallelGroupKey(outcomeId, ''))
      ? first.group
      : undefined
  })
  // Parallel implementers share one predecessor set; whatever follows waits on every member.
  const lastWork = (before: number, outcomeId: string, ownGroup?: string): string[] => {
    const at = bindings
      .slice(0, before)
      .findLastIndex(
        (entry, position) =>
          entry.outcomeIds.includes(outcomeId) && (!ownGroup || groups[position] !== ownGroup)
      )
    const group = groups[at]
    if (at === -1) {
      return []
    }
    return group
      ? bindings.flatMap((entry, position) =>
          position <= at && groups[position] === group ? [entry.key] : []
        )
      : [bindings[at]!.key]
  }
  for (const [index, binding] of bindings.entries()) {
    const predecessors = new Set<string>()
    for (const outcomeId of binding.outcomeIds) {
      lastWork(index, outcomeId, groups[index]).forEach((key) => predecessors.add(key))
      const outcome = set.outcomes.find((entry) => entry.id === outcomeId)!
      for (const dependency of outcome.dependsOn) {
        lastWork(bindings.length, dependency)
          .filter((key) => key !== binding.key)
          .forEach((key) => predecessors.add(key))
      }
    }
    stages[index]!.after = [...predecessors]
    if (groups[index]) {
      stages[index]!.parallel_group = groups[index]
    }
  }
}
