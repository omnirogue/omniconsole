import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { FindOption } from './graph-find-pool'
import type { FindScreen } from './graph-find-rows'

/**
 * Never lose the option that leads one of the person's own rubric lines (c1, c2, …never the
 * general rubric's built-in criteria), but never push the final past `cap`: a late leader
 * replaces the lowest-scoring pick that is not itself a kept leader, and if every seat is already
 * a leader, that later leader is named but left out rather than overflowing the judge step.
 */
export function keepCriterionLeaders(
  pool: FindOption[],
  overall: FindOption[],
  screen: FindScreen,
  trail: WorkflowFindTrail,
  criterionName: (criterion: FindScreen['criteria'][number]) => string,
  cap: number
): FindOption[] {
  trail.criterionLeaders = []
  const personal = screen.criteria.filter((criterion) => /^c\d+$/.test(criterion.id))
  let finalists = [...overall]
  const addedLeaders = new Set<FindOption>()
  for (const criterion of personal) {
    // Strictly greater wins; ties retain the earliest option in the original pool.
    let leader: FindOption | undefined
    for (const option of pool) {
      const score = criterion.scores[option.key]
      if (score !== undefined && (!leader || score > criterion.scores[leader.key]!)) {
        leader = option
      }
    }
    if (!leader) {
      continue
    }
    const alreadyKept = finalists.includes(leader)
    const entry: {
      key: string
      title: string
      criterion: string
      status: 'kept' | 'already' | 'omitted'
    } = {
      key: leader.key,
      title: leader.title.slice(0, 300),
      criterion: criterionName(criterion),
      status: alreadyKept ? 'already' : 'kept'
    }
    trail.criterionLeaders.push(entry)
    if (alreadyKept) {
      addedLeaders.add(leader)
      continue
    }
    if (finalists.length >= cap) {
      let worst: FindOption | undefined
      for (const candidate of finalists) {
        if (addedLeaders.has(candidate)) {
          continue
        }
        if (!worst || (screen.scores[candidate.key] ?? -1) < (screen.scores[worst.key] ?? -1)) {
          worst = candidate
        }
      }
      if (!worst) {
        // No seat left that is not already a protected leader: this one cannot fit within cap.
        entry.status = 'omitted'
        continue
      }
      finalists = finalists.filter((option) => option !== worst)
    }
    finalists = [...finalists, leader]
    addedLeaders.add(leader)
  }
  // Aggregate scores descend; equal or missing scores retain original pool order.
  return finalists.sort(
    (left, right) =>
      (screen.scores[right.key] ?? -1) - (screen.scores[left.key] ?? -1) ||
      pool.indexOf(left) - pool.indexOf(right)
  )
}
