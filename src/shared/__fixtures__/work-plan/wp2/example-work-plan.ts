import { samWorkPlan as authoringFixture } from '../example-work-plan'
import type { WorkPlan } from '../../../work-plan-types'

/** WP-2's executable fixture uses the worker gate required by the merged validator. */
export function samWorkPlan(): WorkPlan {
  const plan = authoringFixture()
  plan.outcome.outcomeId = 'sal-launch'
  plan.nodes = plan.nodes.map((node) =>
    node.id === 'verify' && node.kind !== 'finish'
      ? {
          kind: 'worker',
          id: node.id,
          role: 'verify',
          actor: node.actor,
          instruction: '',
          readsFrom: ['improve'],
          verdict: {
            kind: 'verify',
            over: plan.outcome.doneWhen.map((d) => d.id),
            consumed: 'gate'
          }
        }
      : node
  )
  return plan
}
