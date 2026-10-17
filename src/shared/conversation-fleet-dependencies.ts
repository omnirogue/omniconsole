import { sessionChainPredecessors, type SessionChainStep } from './session-chain-types'

/** Agent predecessors provide artifacts; intervening deliveries also gate the next launch. */
export function conversationFleetStageDependencies(
  steps: SessionChainStep[],
  index: number,
  stageKeys: ReadonlyMap<string, readonly string[]>
): string[] {
  const dependencies = sessionChainPredecessors({ steps }, index).map((step) => step.id)
  const group = steps[index]?.group
  let cursor = index - 1
  while (cursor >= 0 && group && steps[cursor]?.group === group) {
    cursor -= 1
  }
  const previous = steps[cursor]
  if (previous) {
    const blockers = previous.group
      ? steps.filter((step) => step.group === previous.group)
      : [previous]
    for (const step of blockers) {
      if (step.kind === 'handoff') {
        dependencies.push(...(stageKeys.get(step.id) ?? []))
      }
    }
  }
  return [...new Set(dependencies)]
}
