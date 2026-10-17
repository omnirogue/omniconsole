import type { WorkflowRoute, WorkflowStepKind } from './workflow-graph'
import {
  isWorkflowModelTier,
  workflowTierLineup,
  type WorkflowModelDefaults,
  type WorkflowModelTiers
} from './workflow-model-tiers'

/** The person's tier lineups, so a described "cheap" or "frontier" becomes real models. */
export type WorkflowCompileModels = { tiers: WorkflowModelTiers; defaults?: WorkflowModelDefaults }

const KINDS: readonly string[] = ['do', 'review', 'rank', 'synthesize']

/** A step as written, its "tier" requests replaced by that lineup's models for this computer. */
export function withTierModels(
  step: Record<string, unknown>,
  available: readonly WorkflowRoute[],
  models: WorkflowCompileModels
): Record<string, unknown> {
  if (!Array.isArray(step.agents)) {
    return step
  }
  const kind = (KINDS.includes(step.kind as string) ? step.kind : 'do') as WorkflowStepKind
  return {
    ...step,
    agents: step.agents.map((entry: unknown, index: number) => {
      const agent = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
      const tier = isWorkflowModelTier(agent.tier) ? agent.tier : step.tier
      // A named family wins over the step's tier; an unknown tier leaves the app to choose.
      if (!isWorkflowModelTier(tier) || (agent.route && !isWorkflowModelTier(agent.tier))) {
        return entry
      }
      const lineup = workflowTierLineup(models.tiers[tier], kind, available)
      const chosen = lineup[index % Math.max(1, lineup.length)]
      if (!chosen) {
        return entry
      }
      const named = chosen.model !== models.defaults?.[chosen.route] ? chosen.model : undefined
      return { ...agent, route: chosen.route, model: named }
    })
  }
}
