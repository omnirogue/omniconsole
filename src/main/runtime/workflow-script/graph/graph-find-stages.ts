import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowFind, WorkflowStep } from '../../../../shared/workflow-graph'
import { withVersionChecks } from './graph-find-check'
import { withGitHubFacts } from './graph-find-facts'
import type { FindOption } from './graph-find-pool'
import type { GraphCall, GraphCallView, GraphCheckResult, GraphOutcome } from './graph-plan-types'

export type FindPrepared = {
  /** The options the judges choose between. */
  pool: FindOption[]
  /** Options the person's check already placed below them, in check order. */
  rest: FindOption[]
  dependencies: string[]
  checks?: ReadonlyMap<string, GraphCheckResult>
}

/**
 * What happens to the pool before JEV screens it: complete versions run the person's check, and
 * a pool of repositories gets GitHub's facts. 'pending' while either is still at work.
 */
export function prepareFindPool(input: {
  find: WorkflowFind
  findRules?: number
  judge: WorkflowStep
  pool: FindOption[]
  dependencies: string[]
  outcomes: ReadonlyMap<string, GraphOutcome>
  trail: WorkflowFindTrail
  calls: GraphCall[]
  views: GraphCallView[]
}): FindPrepared | 'pending' {
  const { find, ...shared } = input
  if (find.versions && find.check) {
    const checked = withVersionChecks({ ...shared, check: find.check })
    if (checked === 'pending') {
      return 'pending'
    }
    return {
      pool: checked.contenders,
      rest: checked.rest,
      dependencies: [...input.dependencies, ...input.views.map((view) => view.id)],
      checks: checked.checks
    }
  }
  const withFacts = withGitHubFacts(shared)
  return withFacts === 'pending' ? 'pending' : { ...withFacts, rest: [] }
}
