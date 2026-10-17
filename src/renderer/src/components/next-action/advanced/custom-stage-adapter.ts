import { composerStages } from '@/components/work-plan/composer/work-plan-composer-stages'
import {
  WORK_PLAN_ROLES,
  type WorkPlan,
  type WorkPlanActor,
  type WorkPlanRole
} from '../../../../../shared/work-plan-types'
import {
  UP_NEXT_MAX_SEATS_PER_STAGE,
  type UpNextAgentBlock,
  type UpNextBlockPatch
} from '../../../../../shared/up-next-types'

export function stagePlan(block: UpNextAgentBlock, actor: WorkPlanActor): WorkPlan {
  const role = WORK_PLAN_ROLES.includes(block.template as WorkPlanRole)
    ? (block.template as WorkPlanRole)
    : 'implement'
  return {
    outcome: { title: block.instruction, outputKind: 'work', doneWhen: [] },
    nodes: [
      {
        kind: 'worker',
        id: block.id,
        role,
        instruction: block.instruction,
        actor: { ...actor, model: block.advanced.model, effort: block.advanced.effort },
        count: block.n,
        seats: Array.from({ length: block.n }, () => ({
          ...actor,
          model: block.advanced.model,
          effort: block.advanced.effort
        })),
        ...(role === 'review' || role === 'verify' || role === 'judge' || role === 'critique'
          ? { verdict: { kind: role, consumed: 'record', over: [] } }
          : {})
      },
      { kind: 'finish', id: 'finish', how: block.advanced.endOnSuccess ? 'complete' : 'my-review' }
    ]
  }
}

export type StagePatchResult =
  | { patch: UpNextBlockPatch }
  | { reason: 'multiStage' | 'unsupported' }
export function customStagePatch(
  plan: WorkPlan,
  block: UpNextAgentBlock,
  agent: string
): StagePatchResult {
  const stages = composerStages(plan)
  if (stages.length !== 1) {
    return { reason: 'multiStage' }
  }
  const nodes = stages[0]!.nodes
  const node = nodes[0]!
  // TODO(NA-2): arbitrary topology and per-seat actors need a lossless UpNextBlockPatch contract.
  if (
    nodes.length !== 1 ||
    node.kind !== 'worker' ||
    node.actor.agent !== agent ||
    (node.route && node.route !== 'new-session') ||
    node.enabledBy ||
    node.readsWinnerOf ||
    node.onFail ||
    node.seats?.some(
      (seat) =>
        seat.agent !== node.actor.agent ||
        seat.model !== node.actor.model ||
        seat.effort !== node.actor.effort ||
        seat.accountChoiceId ||
        seat.openrouterCandidates
    ) ||
    (node.count ?? 1) > UP_NEXT_MAX_SEATS_PER_STAGE ||
    node.actor.accountChoiceId ||
    node.actor.openrouterCandidates ||
    node.readsFrom?.length
  ) {
    return { reason: 'unsupported' }
  }
  return {
    patch: {
      kind: 'agent',
      shape: (node.count ?? 1) > 1 ? 'parallel' : 'solo',
      n: node.count ?? 1,
      template: node.role,
      instruction: node.instruction,
      advanced: {
        ...block.advanced,
        model: node.actor.model,
        effort: node.actor.effort,
        endOnSuccess: plan.nodes.some(
          (entry) => entry.kind === 'finish' && entry.how === 'complete'
        )
      }
    }
  }
}
