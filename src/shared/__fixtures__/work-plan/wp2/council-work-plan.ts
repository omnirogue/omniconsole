import { councilWorkPlan as authoringFixture } from '../council-work-plan'
import { WORK_PLAN_FIXTURE_ACTORS } from '../work-plan-context'
import type { WorkPlan } from '../../../work-plan-types'

export function councilWorkPlan(): WorkPlan {
  const plan = authoringFixture()
  plan.outcome.outcomeId = 'council'
  plan.nodes.splice(-1, 0, {
    kind: 'worker',
    id: 'verify',
    role: 'verify',
    actor: WORK_PLAN_FIXTURE_ACTORS.codex,
    instruction: '',
    readsFrom: ['winner'],
    verdict: {
      kind: 'verify',
      over: plan.outcome.doneWhen.map((entry) => entry.id),
      consumed: 'gate'
    }
  })
  return plan
}
