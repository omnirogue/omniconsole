import type { WorkPlan, WorkPlanNode } from '../../../../../shared/work-plan-types'

/**
 * A plan with its node names and its seats taken out: what is left is the graph the person drew
 * — the actions, the widths, the reading edges and the verdicts. Two plans that are equal here
 * are the same chain, whichever agents this host happened to have and whatever the ids were
 * called. Used by the acceptance tests, which build Sal's example through the dialog's controls
 * and compare it to the frozen fixture.
 */
export function canonicalWorkPlanNodes(plan: WorkPlan): unknown[] {
  const names = new Map(plan.nodes.map((node, index) => [node.id, `n${index + 1}`]))
  const name = (id: string): string => names.get(id) ?? id
  return plan.nodes.map((node: WorkPlanNode) => {
    const entry = { ...node } as Record<string, unknown> & WorkPlanNode
    entry.id = name(node.id)
    delete (entry as { actor?: unknown }).actor
    delete (entry as { seats?: unknown }).seats
    if (node.kind !== 'finish') {
      if (node.readsFrom) {
        ;(entry as { readsFrom?: string[] }).readsFrom = node.readsFrom.map(name)
      }
      if (node.verdict) {
        ;(entry as { verdict?: unknown }).verdict = {
          ...node.verdict,
          over: node.verdict.over.map((id) => (names.has(id) ? name(id) : id))
        }
      }
      if (node.kind === 'worker' && node.readsWinnerOf) {
        ;(entry as { readsWinnerOf?: string }).readsWinnerOf = name(node.readsWinnerOf)
      }
      if (node.kind === 'worker' && node.group) {
        ;(entry as { group?: string }).group = 'group'
      }
    }
    return entry
  })
}
