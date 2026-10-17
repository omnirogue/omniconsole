import {
  appendWorkPlanFragment,
  fragmentAvailable,
  type WorkPlanFragment
} from '../../../../../shared/work-plan-fragments'
import { workPlanFromShape } from '../../../../../shared/work-plan-shapes'
import { workPlanProblems } from '../../../../../shared/work-plan-validate'
import {
  WORK_PLAN_READ_ONLY_ROLES,
  type WorkPlan,
  type WorkPlanContext
} from '../../../../../shared/work-plan-types'

export function proposeNextWorkPlan(
  plan: WorkPlan,
  anchorNodeId: string | null,
  fragment: WorkPlanFragment,
  ctx: WorkPlanContext
): { plan: WorkPlan } | { reason: string } {
  try {
    if (anchorNodeId) {
      const available = fragmentAvailable(plan, anchorNodeId, fragment, ctx)
      if (!available.ok) {
        return { reason: available.reason ?? 'This fragment is unavailable.' }
      }
      return { plan: appendWorkPlanFragment(plan, anchorNodeId, fragment) }
    }
    if (['judge', 'synthesize', 'compare'].includes(fragment.action)) {
      return { reason: 'Choose existing candidates first.' }
    }
    const created = workPlanFromShape(fragment.topology, {
      prompt: fragment.instruction ?? '',
      outcome: plan.outcome,
      planMode: false,
      ctx: {
        ...ctx,
        usableAgents: [
          {
            agent: fragment.actor.agent,
            models: fragment.actor.model
              ? [
                  {
                    id: fragment.actor.model,
                    label: fragment.actor.model,
                    efforts: fragment.actor.effort ? [fragment.actor.effort] : []
                  }
                ]
              : []
          },
          ...ctx.usableAgents.filter((entry) => entry.agent !== fragment.actor.agent)
        ]
      }
    })
    const proposed: WorkPlan = {
      ...created,
      nodes: created.nodes.map((node) => {
        if (node.kind === 'finish') {
          return { ...node, how: 'my-review', route: 'human' }
        }
        const route = fragment.route === 'human' ? 'new-session' : fragment.route
        if (node.kind !== 'worker' || node.readsFrom?.length) {
          return { ...node, route }
        }
        return {
          ...node,
          role: fragment.action,
          instruction: fragment.instruction ?? '',
          route,
          writes:
            WORK_PLAN_READ_ONLY_ROLES.some((role) => role === fragment.action) ||
            (node.count ?? 1) > 1 ||
            node.group
              ? 'own-output-dir'
              : 'workspace',
          ...(fragment.action === 'verify'
            ? {
                verdict: {
                  kind: 'verify' as const,
                  over: plan.outcome.doneWhen.map((d) => d.id),
                  consumed: 'gate' as const
                }
              }
            : {})
        }
      })
    }
    const problem = workPlanProblems(proposed, ctx).find((p) => p.severity === 'block')
    return problem ? { reason: problem.message } : { plan: proposed }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}
